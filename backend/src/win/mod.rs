// Windows-only parts, straight on the Windows APIs (no PowerShell): drives, attributes, shortcuts, the clipboard
// with Explorer, the shell (open, Open with, Properties, verbs, Recycle Bin, network, phones), thumbnails and
// icons, file locks, protected secrets and copying with progress.
pub mod dialogjump;
pub mod mtp;
pub mod reg;
pub mod shellx;
pub mod thumbs;

use crate::ops::{Cancelled, Job, JR};
use serde_json::{json, Value};
use shellx::*;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::Com::*;
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;

/// COM on this thread (single-threaded apartment, which the shell wants); harmless to call again
pub fn com_init() {
    thread_local!(static INIT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
    INIT.with(|i| {
        if !i.get() {
            unsafe {
                let _ = CoInitializeEx(None, COINIT(COINIT_APARTMENTTHREADED.0 | COINIT_DISABLE_OLE1DDE.0));
            }
            i.set(true);
        }
    });
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
fn from_wide(b: &[u16]) -> String {
    let n = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf16_lossy(&b[..n])
}
fn null_hwnd() -> HWND {
    HWND(std::ptr::null_mut())
}
pub fn main_hwnd() -> HWND {
    let h = crate::st();
    h.host.main_windows().first().and_then(|w| h.host.native_window_handle(w)).map(|x| HWND(x as *mut _)).unwrap_or(null_hwnd())
}

// ---------------- drives ----------------
pub fn list_drives() -> Vec<Value> {
    unsafe {
        let _ = windows::Win32::System::Diagnostics::Debug::SetErrorMode(windows::Win32::System::Diagnostics::Debug::SEM_FAILCRITICALERRORS);
    }
    let mask = unsafe { GetLogicalDrives() };
    let mut out = vec![];
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = format!("{}:", (b'A' + i as u8) as char);
        let root = format!("{letter}\\");
        let hroot = HSTRING::from(root.as_str());
        let t = unsafe { GetDriveTypeW(&hroot) };
        let ty = match t {
            2 => "removable",
            3 => "fixed",
            4 => "network",
            5 => "optical",
            6 => "ram",
            _ => "fixed",
        };
        let mut label = [0u16; 261];
        let mut fsname = [0u16; 261];
        // an empty card reader / DVD drive answers slowly or not at all: only ask fixed and network drives
        let ready = t == 3 || t == 4 || t == 2;
        let ok = ready && unsafe { GetVolumeInformationW(&hroot, Some(&mut label), None, None, None, Some(&mut fsname)) }.is_ok();
        let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
        if ok || t == 4 {
            let _ = unsafe { GetDiskFreeSpaceExW(&hroot, Some(&mut avail), Some(&mut total), Some(&mut free)) };
        }
        let label = from_wide(&label);
        let mut provider = String::new();
        if t == 4 {
            let mut buf = [0u16; 520];
            let mut n = buf.len() as u32;
            let r = unsafe { windows::Win32::NetworkManagement::WNet::WNetGetConnectionW(&HSTRING::from(letter.as_str()), PWSTR(buf.as_mut_ptr()), &mut n) };
            if r == NO_ERROR {
                provider = from_wide(&buf);
            }
        }
        let shown = if !label.is_empty() {
            label.clone()
        } else {
            match t {
                3 => "Local Disk".into(),
                4 => if provider.is_empty() { "Network".to_string() } else { provider.clone() },
                2 => "USB Drive".into(),
                5 => "DVD Drive".into(),
                _ => "Drive".into(),
            }
        };
        if !ok && t != 3 && t != 4 && total == 0 {
            // no disc / no card: still listed, like Explorer
        }
        out.push(json!({ "path": root, "letter": letter, "label": label, "type": ty, "total": total, "free": avail, "fs": from_wide(&fsname), "provider": provider, "name": format!("{shown} ({letter})") }));
    }
    out
}
/// phones, cameras, media players: in "This PC" but not drive letters
pub fn portable_devices() -> Vec<Value> {
    com_init();
    let Ok(pc) = known_item(&FOLDERID_ComputerFolder) else { return vec![] };
    children(&pc)
        .into_iter()
        .filter(|c| is_folder(c) && !is_filesystem(c))
        .map(|c| {
            let name = display_name(&c, SIGDN_NORMALDISPLAY);
            let ty = prop_string(&c, &windows::Win32::Storage::EnhancedStorage::PKEY_ItemTypeText);
            json!({ "path": format!("atlas:mtp|{name}|"), "name": name, "label": name, "type": "portable", "devType": if ty.is_empty() { "Portable device".to_string() } else { ty }, "total": 0, "free": 0 })
        })
        .filter(|v| v["name"].as_str().map(|n| !n.is_empty()).unwrap_or(false))
        .collect()
}
pub fn eject(letter: &str) -> Result<(), String> {
    com_init();
    let root = format!("{}\\", letter.trim_end_matches('\\'));
    let it = item(&root).map_err(|e| e.to_string())?;
    invoke_verb_name(&it, "eject", true).map_err(|e| e.to_string())
}

// ---------------- attributes, times, links ----------------
pub fn set_attributes(p: &str, at: &Value) -> Result<(), String> {
    let h = HSTRING::from(p);
    let cur = unsafe { GetFileAttributesW(&h) };
    if cur == INVALID_FILE_ATTRIBUTES {
        return Err("This item could not be found".into());
    }
    let mut a = cur;
    for (k, f) in [("readonly", FILE_ATTRIBUTE_READONLY.0), ("hidden", FILE_ATTRIBUTE_HIDDEN.0), ("system", FILE_ATTRIBUTE_SYSTEM.0), ("archive", FILE_ATTRIBUTE_ARCHIVE.0)] {
        if let Some(on) = at.get(k).and_then(|v| v.as_bool()) {
            if on { a |= f } else { a &= !f }
        }
    }
    // only settable bits
    a &= FILE_ATTRIBUTE_READONLY.0 | FILE_ATTRIBUTE_HIDDEN.0 | FILE_ATTRIBUTE_SYSTEM.0 | FILE_ATTRIBUTE_ARCHIVE.0 | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED.0 | FILE_ATTRIBUTE_TEMPORARY.0;
    if a == 0 {
        a = FILE_ATTRIBUTE_NORMAL.0;
    }
    unsafe { SetFileAttributesW(&h, FILE_FLAGS_AND_ATTRIBUTES(a)) }.map_err(|e| e.message())
}
pub fn set_creation_time(p: &str, ms: f64) -> Result<(), String> {
    let t = ((ms + 11_644_473_600_000.0) * 10_000.0) as u64;
    let ft = FILETIME { dwLowDateTime: t as u32, dwHighDateTime: (t >> 32) as u32 };
    unsafe {
        let h = CreateFileW(&HSTRING::from(p), FILE_WRITE_ATTRIBUTES.0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, None, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, None).map_err(|e| e.message())?;
        let r = SetFileTime(h, Some(&ft), None, None);
        let _ = CloseHandle(h);
        r.map_err(|e| e.message())
    }
}
pub fn create_junction(target: &str, link: &str) -> Result<(), String> {
    let o = crate::util::std_cmd("cmd.exe").args(["/c", "mklink", "/J", link, target]).output().map_err(|e| e.to_string())?;
    if o.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&o.stderr).trim().to_string()) }
}
pub fn create_shortcut(lnk: &str, target: &str) -> Result<(), String> {
    com_init();
    unsafe {
        let sl: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.message())?;
        sl.SetPath(&HSTRING::from(target)).map_err(|e| e.message())?;
        let dir = crate::util::dirname(target);
        let _ = sl.SetWorkingDirectory(&HSTRING::from(dir.as_str()));
        let pf: IPersistFile = sl.cast().map_err(|e| e.message())?;
        pf.Save(&HSTRING::from(lnk), BOOL(1)).map_err(|e| e.message())
    }
}
pub fn read_shortcut(lnk: &str) -> Option<String> {
    com_init();
    unsafe {
        let sl: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let pf: IPersistFile = sl.cast().ok()?;
        pf.Load(&HSTRING::from(lnk), STGM_READ).ok()?;
        let mut buf = [0u16; 1024];
        if sl.GetPath(&mut buf, std::ptr::null_mut(), 0).is_ok() {
            let s = from_wide(&buf);
            if !s.is_empty() {
                return Some(s);
            }
        }
        let pidl = sl.GetIDList().ok()?;
        let mut p = [0u16; 260];
        let ok = SHGetPathFromIDListW(pidl, &mut p).as_bool();
        CoTaskMemFree(Some(pidl as *const _));
        if ok { Some(from_wide(&p)).filter(|s| !s.is_empty()) } else { None }
    }
}

// ---------------- open, Open with, run as administrator, Properties ----------------
pub fn shell_execute(file: &str, verb: &str, params: Option<&str>, dir: Option<&str>) -> Result<(), String> {
    com_init();
    // the program we start may bring its window to the front, over Dogfile
    allow_foreground();
    let (f, v) = (HSTRING::from(file), HSTRING::from(verb));
    let p = params.map(HSTRING::from);
    let d = dir.map(HSTRING::from);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        hwnd: main_hwnd(),
        lpVerb: PCWSTR(v.as_ptr()),
        lpFile: PCWSTR(f.as_ptr()),
        lpParameters: p.as_ref().map(|x| PCWSTR(x.as_ptr())).unwrap_or(PCWSTR::null()),
        lpDirectory: d.as_ref().map(|x| PCWSTR(x.as_ptr())).unwrap_or(PCWSTR::null()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    match unsafe { ShellExecuteExW(&mut info) } {
        Ok(()) => Ok(()),
        Err(e) => {
            let code = e.code().0 as u32 & 0xFFFF;
            match code {
                1223 => Ok(()), // the person said no to the administrator prompt
                1155 => {
                    // no app for this type: offer one, like Explorer
                    open_with(file);
                    Ok(())
                }
                _ => Err(e.message()),
            }
        }
    }
}
pub fn open_with(p: &str) {
    let path = p.to_string();
    std::thread::spawn(move || {
        com_init();
        let h = HSTRING::from(path.as_str());
        let info = OPENASINFO { pcszFile: PCWSTR(h.as_ptr()), pcszClass: PCWSTR::null(), oaifInFlags: OPEN_AS_INFO_FLAGS(OAIF_ALLOW_REGISTRATION.0 | OAIF_EXEC.0) };
        let _ = unsafe { SHOpenWithDialog(main_hwnd(), &info) };
    });
}
pub fn show_properties(paths: &[String]) {
    for p in paths.iter().take(8) {
        let p = p.clone();
        ui_thread(move || {
            let _ = unsafe { SHObjectProperties(main_hwnd(), SHOP_FILEPATH, &HSTRING::from(p.as_str()), PCWSTR::null()) };
        });
    }
}
pub fn beep() {
    let _ = unsafe { windows::Win32::System::Diagnostics::Debug::MessageBeep(MB_OK) };
}
pub fn set_wallpaper(f: &str) -> bool {
    let mut w = wide(f);
    unsafe { SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, Some(w.as_mut_ptr() as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(SPIF_UPDATEINIFILE.0 | SPIF_SENDCHANGE.0)) }.is_ok()
}

/// a long-lived thread with a message loop, for shell windows that stay open (Properties)
pub fn ui_thread(f: impl FnOnce() + Send + 'static) {
    use std::sync::mpsc::{channel, Sender};
    use std::sync::OnceLock;
    type Task = Box<dyn FnOnce() + Send>;
    static TX: OnceLock<parking_lot::Mutex<Sender<Task>>> = OnceLock::new();
    static EVENT: OnceLock<usize> = OnceLock::new();
    let tx = TX.get_or_init(|| {
        let (tx, rx) = channel::<Task>();
        let ev = unsafe { windows::Win32::System::Threading::CreateEventW(None, BOOL(0), BOOL(0), PCWSTR::null()) }.map(|h| h.0 as usize).unwrap_or(0);
        let _ = EVENT.set(ev);
        std::thread::spawn(move || {
            com_init();
            let handles = [HANDLE(ev as *mut _)];
            loop {
                unsafe {
                    let _ = MsgWaitForMultipleObjects(Some(&handles), BOOL(0), 1000, QS_ALLINPUT);
                }
                while let Ok(t) = rx.try_recv() {
                    t();
                }
                let mut msg = MSG::default();
                while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
                    unsafe {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
            }
        });
        parking_lot::Mutex::new(tx)
    });
    let _ = tx.lock().send(Box::new(f));
    if let Some(ev) = EVENT.get() {
        let _ = unsafe { windows::Win32::System::Threading::SetEvent(HANDLE(*ev as *mut _)) };
    }
}

// ---------------- the classic right-click verbs ----------------
pub fn shell_verbs(p: &str) -> Vec<String> {
    com_init();
    let Ok(it) = item(p) else { return vec![] };
    let Ok(m) = menu_for(&it) else { return vec![] };
    let mut items = vec![];
    menu_items(m.hmenu, &mut items);
    let mut seen = std::collections::HashSet::new();
    items.into_iter().map(|(l, _)| l).filter(|l| seen.insert(l.clone())).collect()
}
pub fn invoke_verb(p: &str, verb: &str) -> Result<(), String> {
    let (p, verb) = (p.to_string(), verb.to_string());
    let (tx, rx) = std::sync::mpsc::channel();
    ui_thread(move || {
        let r = (|| -> Result<(), String> {
            let it = item(&p).map_err(|e| e.message())?;
            let m = menu_for(&it).map_err(|e| e.message())?;
            let mut items = vec![];
            menu_items(m.hmenu, &mut items);
            let id = items.iter().find(|(l, _)| *l == verb).map(|x| x.1).ok_or("That command is no longer available")?;
            invoke_id(&m, id, main_hwnd()).map_err(|e| e.message())
        })();
        let _ = tx.send(r);
    });
    rx.recv_timeout(std::time::Duration::from_secs(60)).unwrap_or(Ok(()))
}

// ---------------- icons (exe / shortcut / file type) ----------------
pub fn file_icon(p: &str, size: &str) -> Option<String> {
    com_init();
    let px = match size { "small" => 16, "large" => 48, _ => 32 };
    let it = item(p).ok()?;
    let f: IShellItemImageFactory = it.cast().ok()?;
    let hbm = unsafe { f.GetImage(SIZE { cx: px, cy: px }, SIIGBF(SIIGBF_ICONONLY.0 | SIIGBF_BIGGERSIZEOK.0)) }.ok()?;
    let (w, h, rgba) = thumbs::hbitmap_rgba(hbm)?;
    let png = thumbs::encode(w, h, rgba, true)?;
    Some(format!("data:image/png;base64,{}", crate::util::b64(&png.0)))
}

// ---------------- Recycle Bin ----------------
const RECYCLE_FMTID: windows::core::GUID = windows::core::GUID::from_u128(0x9b174b33_40ff_11d2_a27e_00c04fc30871);
const PKEY_DELETED_FROM: windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY = windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY { fmtid: RECYCLE_FMTID, pid: 2 };
const PKEY_DATE_DELETED: windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY = windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY { fmtid: RECYCLE_FMTID, pid: 3 };
struct Recycled {
    it: IShellItem,
    name: String,
    path: String,
    from: String,
    deleted: f64,
}
fn recycled() -> Vec<Recycled> {
    com_init();
    let Ok(rb) = known_item(&FOLDERID_RecycleBinFolder) else { return vec![] };
    children(&rb)
        .into_iter()
        .map(|it| {
            let path = display_name(&it, SIGDN_FILESYSPATH);
            let mut name = display_name(&it, SIGDN_NORMALDISPLAY);
            // the display name hides extensions when Explorer is set to: take it from the stored file
            let ext = crate::util::ext(&path);
            if !ext.is_empty() && !name.to_lowercase().ends_with(&format!(".{ext}")) && !std::path::Path::new(&path).is_dir() {
                name = format!("{name}.{ext}");
            }
            Recycled { from: prop_string(&it, &PKEY_DELETED_FROM), deleted: prop_time(&it, &PKEY_DATE_DELETED), name, path, it }
        })
        .collect()
}
pub fn recycle_list() -> Vec<Value> {
    recycled()
        .into_iter()
        .map(|r| {
            let is_dir = std::fs::metadata(&r.path).map(|m| m.is_dir()).unwrap_or(false);
            let size = prop_u64(&r.it, &windows::Win32::Storage::EnhancedStorage::PKEY_Size).unwrap_or_else(|| if is_dir { crate::util::dir_size(std::path::Path::new(&r.path)) } else { 0 });
            let modified = prop_time(&r.it, &windows::Win32::Storage::EnhancedStorage::PKEY_DateModified);
            json!({ "name": r.name, "path": r.path, "isDir": is_dir, "size": size, "from": r.from, "deleted": crate::fsx::iso_ms(r.deleted as i64), "modified": crate::fsx::iso_ms(modified as i64) })
        })
        .collect()
}
/// put items back where they came from: by their path in the Recycle Bin, or by where they were deleted from
pub fn recycle_restore(paths: &[String], by_original: bool) {
    let mut items = recycled();
    items.sort_by(|a, b| b.deleted.partial_cmp(&a.deleted).unwrap_or(std::cmp::Ordering::Equal));
    let want: Vec<String> = paths.iter().map(|p| p.to_lowercase()).collect();
    let mut done = std::collections::HashSet::new();
    for r in items {
        let key = if by_original { std::path::Path::new(&r.from).join(&r.name).to_string_lossy().to_lowercase() } else { r.path.to_lowercase() };
        if want.contains(&key) && done.insert(key) {
            let _ = invoke_verb_name(&r.it, "undelete", true);
        }
    }
}
pub fn recycle_delete(paths: &[String]) {
    let want: Vec<String> = paths.iter().map(|p| p.to_lowercase()).collect();
    let Ok(op) = file_op(NO_UI) else { return };
    let mut any = false;
    for r in recycled() {
        if want.contains(&r.path.to_lowercase()) {
            any |= delete_item(&op, &r.it).is_ok();
        }
    }
    if any {
        let _ = run_op(&op);
    }
}
pub fn recycle_empty() {
    let _ = unsafe { SHEmptyRecycleBinW(null_hwnd(), PCWSTR::null(), SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND) };
}

// ---------------- network places ----------------
pub fn network_items() -> Vec<Value> {
    com_init();
    let read = || -> Vec<Value> {
        let Ok(net) = known_item(&FOLDERID_NetworkFolder) else { return vec![] };
        children(&net)
            .into_iter()
            .map(|c| json!({ "name": display_name(&c, SIGDN_NORMALDISPLAY), "path": display_name(&c, SIGDN_DESKTOPABSOLUTEPARSING), "type": prop_string(&c, &windows::Win32::Storage::EnhancedStorage::PKEY_ItemTypeText) }))
            .filter(|v| v["name"].as_str().map(|n| !n.is_empty()).unwrap_or(false))
            .collect()
    };
    // the Network folder fills in as Windows looks around: read, wait a moment, read again
    let first = read();
    std::thread::sleep(std::time::Duration::from_millis(2500));
    let second = read();
    if second.len() >= first.len() { second } else { first }
}
pub fn open_network_item(name: &str) {
    com_init();
    let Ok(net) = known_item(&FOLDERID_NetworkFolder) else { return };
    if let Some(c) = find_child(&net, name) {
        let _ = invoke_default(&c);
    }
}

// ---------------- who is using a file (Restart Manager) ----------------
pub fn who_locks(paths: &[String]) -> Vec<Value> {
    use windows::Win32::System::RestartManager::*;
    let mut out = vec![];
    unsafe {
        let mut session = 0u32;
        let mut key = [0u16; 64];
        if RmStartSession(&mut session, 0, PWSTR(key.as_mut_ptr())) != ERROR_SUCCESS {
            return out;
        }
        let hs: Vec<HSTRING> = paths.iter().map(|p| HSTRING::from(p.as_str())).collect();
        let ps: Vec<PCWSTR> = hs.iter().map(|h| PCWSTR(h.as_ptr())).collect();
        if RmRegisterResources(session, Some(&ps), None, None) == ERROR_SUCCESS {
            let (mut needed, mut n, mut reasons) = (0u32, 0u32, 0u32);
            let r = RmGetList(session, &mut needed, &mut n, None, &mut reasons);
            if r == ERROR_MORE_DATA && needed > 0 {
                let mut info: Vec<RM_PROCESS_INFO> = (0..needed).map(|_| RM_PROCESS_INFO::default()).collect();
                n = needed;
                if RmGetList(session, &mut needed, &mut n, Some(info.as_mut_ptr()), &mut reasons) == ERROR_SUCCESS {
                    for i in info.iter().take(n as usize) {
                        let pid = i.Process.dwProcessId;
                        out.push(json!({ "pid": pid, "name": from_wide(&i.strAppName), "exe": process_exe(pid).unwrap_or_default() }));
                    }
                }
            }
        }
        let _ = RmEndSession(session);
    }
    out
}
fn process_exe(pid: u32) -> Option<String> {
    use windows::Win32::System::Threading::*;
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, BOOL(0), pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut n = buf.len() as u32;
        let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut n);
        let _ = CloseHandle(h);
        r.ok().map(|_| String::from_utf16_lossy(&buf[..n as usize]))
    }
}
/// the full path of a running program (Everything, portable copies included)
pub fn process_path(names: &[&str]) -> Option<PathBuf> {
    use windows::Win32::System::Diagnostics::ToolHelp::*;
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = None;
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let exe = from_wide(&e.szExeFile);
                if names.iter().any(|n| n.eq_ignore_ascii_case(&exe)) {
                    found = process_exe(e.th32ProcessID).map(PathBuf::from);
                    if found.is_some() {
                        break;
                    }
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

// ---------------- the clipboard with Explorer ----------------
pub fn clipboard_set_files(paths: &[String], cut: bool) -> bool {
    use clipboard_win::{options, raw, Clipboard};
    let Ok(_c) = Clipboard::new_attempts(10) else { return false };
    if raw::set_file_list(paths).is_err() {
        return false;
    }
    let _ = raw::set_string_with(&paths.join("\r\n"), options::NoClear);
    if let Some(fmt) = raw::register_format("Preferred DropEffect") {
        let effect: u32 = if cut { 2 } else { 5 };
        let _ = raw::set_without_clear(fmt.get(), &effect.to_le_bytes());
    }
    true
}
pub fn clipboard_get_files() -> (Vec<String>, bool) {
    use clipboard_win::{raw, Clipboard};
    let Ok(_c) = Clipboard::new_attempts(10) else { return (vec![], false) };
    let mut files = vec![];
    if raw::get_file_list(&mut files).is_err() {
        return (vec![], false);
    }
    let mut cut = false;
    if let Some(fmt) = raw::register_format("Preferred DropEffect") {
        let mut b = vec![];
        if raw::get_vec(fmt.get(), &mut b).is_ok() && b.len() >= 4 {
            cut = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) & 2 != 0;
        }
    }
    (files, cut)
}
pub fn clipboard_formats() -> Vec<String> {
    use clipboard_win::{raw, Clipboard};
    let Ok(_c) = Clipboard::new_attempts(5) else { return vec![] };
    raw::EnumFormats::new().filter_map(|f| raw::format_name_big(f).or_else(|| Some(format!("#{f}")))).collect()
}
pub fn clipboard_seq() -> u32 {
    unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}
/// a password manager marked what's on the clipboard as private
pub fn clipboard_is_private() -> bool {
    use clipboard_win::raw;
    ["ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "Clipboard Viewer Ignore"].iter().any(|n| raw::register_format(n).map(|f| raw::is_format_avail(f.get())).unwrap_or(false))
}

// ---------------- secrets (data protection for this Windows user) ----------------
pub fn dpapi_protect(data: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Security::Cryptography::*;
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(&input, PCWSTR::null(), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out).ok()?;
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = windows::Win32::Foundation::LocalFree(HLOCAL(out.pbData as *mut _));
        Some(v)
    }
}
pub fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Security::Cryptography::*;
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out).ok()?;
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = windows::Win32::Foundation::LocalFree(HLOCAL(out.pbData as *mut _));
        Some(v)
    }
}

pub fn utc_offset_secs() -> i64 {
    use windows::Win32::System::Time::*;
    let mut tz = TIME_ZONE_INFORMATION::default();
    let r = unsafe { GetTimeZoneInformation(&mut tz) };
    let bias = tz.Bias + if r == 2 { tz.DaylightBias } else { tz.StandardBias };
    -(bias as i64) * 60
}

// ---------------- copying one file with progress, pause and cancel ----------------
struct CopyCtx<'a> {
    job: &'a Job,
    last: u64,
}
unsafe extern "system" fn progress(_total: i64, done: i64, _st: i64, _sd: i64, _sn: u32, _reason: LPPROGRESS_ROUTINE_CALLBACK_REASON, _a: HANDLE, _b: HANDLE, data: *const core::ffi::c_void) -> u32 {
    let ctx = &mut *(data as *mut CopyCtx);
    let d = done as u64;
    if d > ctx.last {
        ctx.job.add_done(d - ctx.last);
        ctx.last = d;
    }
    while ctx.job.paused.load(Ordering::Relaxed) && !ctx.job.cancelled.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    if ctx.job.cancelled.load(Ordering::Relaxed) { 1 } else { 0 }
}
pub fn copy_file_progress(j: &Job, src: &std::path::Path, dst: &std::path::Path, _size: u64) -> JR {
    let mut ctx = CopyCtx { job: j, last: 0 };
    let r = unsafe { CopyFileExW(&HSTRING::from(&*src.to_string_lossy()), &HSTRING::from(&*dst.to_string_lossy()), Some(progress), Some(&mut ctx as *mut _ as *const _), None, 0) };
    match r {
        Ok(()) => Ok(()),
        Err(_) if j.cancelled.load(Ordering::Relaxed) => {
            let _ = std::fs::remove_file(dst);
            Err(Ok(Cancelled))
        }
        Err(e) => {
            let code = e.code().0 as u32 & 0xFFFF;
            Err(Err(match code {
                32 | 33 => "The file is in use by another program".into(),
                5 => "Access denied".into(),
                112 => "There is not enough space on the disk".into(),
                _ => e.message(),
            }))
        }
    }
}

#[allow(dead_code)]
fn unused(_: Option<IShellItem>) {}

/// Let whatever Dogfile starts next take the foreground (so it opens on top of Dogfile, not under it).
pub fn allow_foreground() {
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(windows::Win32::UI::WindowsAndMessaging::ASFW_ANY);
    }
}
