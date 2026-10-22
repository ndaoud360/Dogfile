// Dialog jump: in any program's Open / Save dialog, press Ctrl+G for a menu of the folders open in Dogfile (and
// Desktop, Documents, Downloads); pick one and the dialog goes there. Optionally the dialog jumps by itself to
// the folder you're in in Dogfile when it opens.
// It watches which window is in front (a WinEvent hook); while that's a file dialog, Ctrl+G belongs to Dogfile.
use parking_lot::Mutex;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_CONTROL, MOD_NOREPEAT};
use windows::Win32::UI::WindowsAndMessaging::*;

static FOLDERS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static KNOWN: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
static SEEN: Mutex<Option<HashSet<isize>>> = Mutex::new(None);
static DIALOG: AtomicIsize = AtomicIsize::new(0);
static HELPER: AtomicIsize = AtomicIsize::new(0);
static HOTKEY: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);
const HOTKEY_ID: i32 = 0x4447;
const FILENAME_ID: i32 = 1148; // the "File name" box of Open / Save dialogs

/// the folders open in Dogfile, the current one first (sent by the window whenever that changes)
pub fn set_folders(list: Vec<String>, known: Vec<(String, String)>) {
    *FOLDERS.lock() = list;
    if !known.is_empty() {
        *KNOWN.lock() = known;
    }
}

pub fn start() {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new().name("dialog-jump".into()).spawn(|| unsafe {
        let helper = CreateWindowExW(WS_EX_TOOLWINDOW, w!("STATIC"), w!("Dogfile dialog jump"), WS_POPUP, 0, 0, 0, 0, HWND::default(), HMENU::default(), windows::Win32::Foundation::HINSTANCE::default(), None).unwrap_or_default();
        HELPER.store(helper.0 as isize, Ordering::Relaxed);
        let _hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, HMODULE::default(), Some(on_foreground), 0, 0, WINEVENT_OUTOFCONTEXT);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
            if msg.message == WM_HOTKEY && msg.wParam.0 as i32 == HOTKEY_ID {
                let dlg = HWND(DIALOG.load(Ordering::Relaxed) as *mut _);
                if is_file_dialog(dlg) {
                    show_menu(dlg);
                }
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }).ok();
}

unsafe extern "system" fn on_foreground(_h: HWINEVENTHOOK, _ev: u32, hwnd: HWND, _o: i32, _c: i32, _t: u32, _ms: u32) {
    if hwnd.0 as isize == HELPER.load(Ordering::Relaxed) {
        return; // our own menu took the front for a moment
    }
    if is_file_dialog(hwnd) {
        DIALOG.store(hwnd.0 as isize, Ordering::Relaxed);
        if !HOTKEY.swap(true, Ordering::SeqCst) && RegisterHotKey(HWND::default(), HOTKEY_ID, MOD_CONTROL | MOD_NOREPEAT, 'G' as u32).is_err() {
            HOTKEY.store(false, Ordering::SeqCst);
        }
        // jump by itself the first time this dialog shows up (when that's turned on)
        let first = SEEN.lock().get_or_insert_with(HashSet::new).insert(hwnd.0 as isize);
        if first && crate::setting_bool("dialogJumpAuto", false) {
            if let Some(f) = FOLDERS.lock().first().cloned() {
                let hv = hwnd.0 as isize;
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(350));
                    let _ = jump(HWND(hv as *mut _), &f);
                });
            }
        }
    } else if HOTKEY.swap(false, Ordering::SeqCst) {
        let _ = UnregisterHotKey(HWND::default(), HOTKEY_ID);
    }
}

fn class_of(h: HWND) -> String {
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}
/// an Open / Save / Browse dialog of any program (the standard Windows ones)
pub fn is_file_dialog(h: HWND) -> bool {
    if h.0.is_null() || !unsafe { IsWindow(h) }.as_bool() || class_of(h) != "#32770" {
        return false;
    }
    find_class(h, "DUIViewWndClassName").is_some() || find_id(h, FILENAME_ID).is_some()
}
/// the first descendant of `parent` with this control id (Vista-style dialogs nest the "File name" box deep inside)
fn find_id(parent: HWND, id: i32) -> Option<HWND> {
    unsafe {
        if let Ok(h) = GetDlgItem(parent, id) {
            if !h.0.is_null() {
                return Some(h);
            }
        }
        let found = Mutex::new((id, None::<isize>));
        unsafe extern "system" fn each(h: HWND, l: LPARAM) -> BOOL {
            let f = &*(l.0 as *const Mutex<(i32, Option<isize>)>);
            let mut g = f.lock();
            if GetDlgCtrlID(h) == g.0 {
                g.1 = Some(h.0 as isize);
                return FALSE;
            }
            TRUE
        }
        let _ = EnumChildWindows(parent, Some(each), LPARAM(&found as *const _ as isize));
        let r = found.lock().1;
        r.map(|v| HWND(v as *mut _))
    }
}
fn find_class(parent: HWND, class: &str) -> Option<HWND> {
    let found = Mutex::new((class.to_string(), None::<isize>));
    unsafe extern "system" fn each(h: HWND, l: LPARAM) -> BOOL {
        let f = &*(l.0 as *const Mutex<(String, Option<isize>)>);
        let mut g = f.lock();
        if class_of(h) == g.0 {
            g.1 = Some(h.0 as isize);
            return FALSE;
        }
        TRUE
    }
    let _ = unsafe { EnumChildWindows(parent, Some(each), LPARAM(&found as *const _ as isize)) };
    let r = found.lock().1;
    r.map(|v| HWND(v as *mut _))
}
fn name_edit(dlg: HWND) -> Option<HWND> {
    let item = find_id(dlg, FILENAME_ID)?;
    if class_of(item) == "Edit" {
        return Some(item);
    }
    // ComboBoxEx32 > ComboBox > Edit (or ComboBox > Edit)
    find_class(item, "Edit")
}
fn get_text(h: HWND) -> String {
    let mut buf = vec![0u16; 4096];
    let n = unsafe { GetWindowTextW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}
fn set_text(h: HWND, s: &str) {
    let t = HSTRING::from(s);
    unsafe { SendMessageW(h, WM_SETTEXT, WPARAM(0), LPARAM(t.as_ptr() as isize)) };
}
/// send the dialog to a folder: type the folder into "File name", press Enter, then put the name back
pub fn jump(dlg: HWND, folder: &str) -> Result<(), String> {
    let edit = name_edit(dlg).ok_or("This dialog has no file name box")?;
    let before = get_text(edit);
    set_text(edit, folder);
    unsafe { SendMessageW(dlg, WM_COMMAND, WPARAM(IDOK.0 as usize), LPARAM(0)) };
    std::thread::sleep(std::time::Duration::from_millis(250));
    // a Save dialog keeps the name you typed; an Open dialog's box is emptied
    let keep = if before.contains('\\') || before.contains('/') { String::new() } else { before };
    if let Some(e) = name_edit(dlg) {
        set_text(e, &keep);
    }
    Ok(())
}

unsafe fn show_menu(dlg: HWND) {
    let folders = FOLDERS.lock().clone();
    let known = KNOWN.lock().clone();
    let Ok(menu) = CreatePopupMenu() else { return };
    let mut items: Vec<String> = Vec::new();
    let add = |label: &str, path: &str, items: &mut Vec<String>| {
        items.push(path.to_string());
        let _ = AppendMenuW(menu, MF_STRING, items.len(), &HSTRING::from(label));
    };
    if folders.is_empty() {
        let _ = AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, w!("No folders open in Dogfile"));
    }
    for f in folders.iter().take(12) {
        let name = f.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or(f);
        add(&format!("{name}\t{f}"), f, &mut items);
    }
    if !known.is_empty() {
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
        for (label, path) in &known {
            add(label, path, &mut items);
        }
    }
    let mut r = RECT::default();
    let at = name_edit(dlg).unwrap_or(dlg);
    let _ = GetWindowRect(at, &mut r);
    let helper = HWND(HELPER.load(Ordering::Relaxed) as *mut _);
    let _ = SetForegroundWindow(helper);
    let pick = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_LEFTALIGN | TPM_BOTTOMALIGN, r.left, r.top - 2, 0, helper, None).0 as usize;
    let _ = DestroyMenu(menu);
    let _ = SetForegroundWindow(dlg);
    if pick > 0 {
        if let Some(p) = items.get(pick - 1) {
            let p = p.clone();
            let dv = dlg.0 as isize;
            std::thread::spawn(move || { let _ = jump(HWND(dv as *mut _), &p); });
        }
    }
}

/// tests: wait for a file dialog of another program, send it to `folder`, type `name` and press OK
pub fn test(folder: &str, name: &str) -> Result<String, String> {
    let t0 = std::time::Instant::now();
    let dlg = loop {
        let found = Mutex::new(None::<isize>);
        unsafe extern "system" fn each(h: HWND, l: LPARAM) -> BOOL {
            let found = &*(l.0 as *const Mutex<Option<isize>>);
            if IsWindowVisible(h).as_bool() && is_file_dialog(h) {
                *found.lock() = Some(h.0 as isize);
                return FALSE;
            }
            TRUE
        }
        let _ = unsafe { EnumWindows(Some(each), LPARAM(&found as *const _ as isize)) };
        if let Some(h) = *found.lock() {
            break HWND(h as *mut _);
        }
        if t0.elapsed().as_secs() > 14 {
            // say what was on screen, to see why
            let seen = Mutex::new(Vec::<String>::new());
            unsafe extern "system" fn list(h: HWND, l: LPARAM) -> BOOL {
                let v = &*(l.0 as *const Mutex<Vec<String>>);
                if IsWindowVisible(h).as_bool() {
                    v.lock().push(format!("{}:{}", class_of(h), get_text(h)));
                }
                TRUE
            }
            let _ = unsafe { EnumWindows(Some(list), LPARAM(&seen as *const _ as isize)) };
            let v = seen.lock().iter().take(12).cloned().collect::<Vec<_>>().join(" | ");
            return Err(format!("no file dialog appeared; windows: {v}"));
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    };
    jump(dlg, folder)?;
    std::thread::sleep(std::time::Duration::from_millis(1200));
    let edit = name_edit(dlg).ok_or("no file name box")?;
    set_text(edit, name);
    unsafe { SendMessageW(dlg, WM_COMMAND, WPARAM(IDOK.0 as usize), LPARAM(0)) };
    Ok(format!("dialog {:?} after {} ms", dlg.0, t0.elapsed().as_millis()))
}
