// Shell (COM) helpers: items by path or in special folders, their children and properties, the classic
// right-click verbs, and file operations through the shell (phones, the Recycle Bin).
use windows::core::{Interface, GUID, HSTRING, PCSTR, PCWSTR, PWSTR};
use windows::Win32::Foundation::{BOOL, FILETIME, HWND};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
use windows::Win32::System::SystemServices::{SFGAO_FILESYSTEM, SFGAO_FLAGS, SFGAO_FOLDER, SFGAO_STREAM};
use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;

pub fn pwstr_to_string(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let s = unsafe { p.to_string().unwrap_or_default() };
    unsafe { CoTaskMemFree(Some(p.0 as *const _)) };
    s
}
pub fn item(path: &str) -> windows::core::Result<IShellItem> {
    super::com_init();
    unsafe { SHCreateItemFromParsingName(&HSTRING::from(path), None) }
}
pub fn known_item(id: &GUID) -> windows::core::Result<IShellItem> {
    super::com_init();
    unsafe { SHGetKnownFolderItem(id, KF_FLAG_DEFAULT, None) }
}
pub fn children(folder: &IShellItem) -> Vec<IShellItem> {
    let mut out = vec![];
    let Ok(en) = (unsafe { folder.BindToHandler::<_, IEnumShellItems>(None, &BHID_EnumItems) }) else { return out };
    loop {
        let mut buf: [Option<IShellItem>; 16] = Default::default();
        let mut n = 0u32;
        if unsafe { en.Next(&mut buf, Some(&mut n)) }.is_err() && n == 0 {
            break;
        }
        if n == 0 {
            break;
        }
        for it in buf.into_iter().take(n as usize).flatten() {
            out.push(it);
        }
        if n < 16 {
            break;
        }
    }
    out
}
pub fn display_name(it: &IShellItem, kind: SIGDN) -> String {
    unsafe { it.GetDisplayName(kind) }.map(pwstr_to_string).unwrap_or_default()
}
pub fn attrs(it: &IShellItem, mask: SFGAO_FLAGS) -> u32 {
    unsafe { it.GetAttributes(mask) }.map(|a| a.0).unwrap_or(0)
}
pub fn is_folder(it: &IShellItem) -> bool {
    let a = attrs(it, SFGAO_FLAGS(SFGAO_FOLDER.0 | SFGAO_STREAM.0));
    a & SFGAO_FOLDER.0 != 0 && a & SFGAO_STREAM.0 == 0
}
pub fn is_filesystem(it: &IShellItem) -> bool {
    attrs(it, SFGAO_FILESYSTEM) & SFGAO_FILESYSTEM.0 != 0
}
pub fn prop_string(it: &IShellItem, key: &PROPERTYKEY) -> String {
    let Ok(i2) = it.cast::<IShellItem2>() else { return String::new() };
    unsafe { i2.GetString(key) }.map(pwstr_to_string).unwrap_or_default()
}
pub fn prop_u64(it: &IShellItem, key: &PROPERTYKEY) -> Option<u64> {
    let i2 = it.cast::<IShellItem2>().ok()?;
    unsafe { i2.GetUInt64(key) }.ok()
}
pub fn filetime_ms(ft: FILETIME) -> f64 {
    let t = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
    if t == 0 {
        return 0.0;
    }
    (t as f64 / 10_000.0) - 11_644_473_600_000.0
}
pub fn prop_time(it: &IShellItem, key: &PROPERTYKEY) -> f64 {
    let Ok(i2) = it.cast::<IShellItem2>() else { return 0.0 };
    unsafe { i2.GetFileTime(key) }.map(filetime_ms).unwrap_or(0.0)
}
/// the item's file name (devices sometimes hide extensions in the display name)
pub fn file_name(it: &IShellItem) -> String {
    let n = prop_string(it, &windows::Win32::Storage::EnhancedStorage::PKEY_FileName);
    if !n.is_empty() { n } else { display_name(it, SIGDN_NORMALDISPLAY) }
}
pub fn find_child(folder: &IShellItem, name: &str) -> Option<IShellItem> {
    children(folder).into_iter().find(|c| display_name(c, SIGDN_NORMALDISPLAY) == name || file_name(c) == name)
}

// ---------------- the classic right-click menu ----------------
const CMIC_MASK_UNICODE: u32 = 0x4000;
const CMIC_MASK_FLAG_NO_UI: u32 = 0x400;
pub struct Menu {
    pub cm: IContextMenu,
    pub hmenu: HMENU,
}
impl Drop for Menu {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyMenu(self.hmenu);
        }
    }
}
pub const FIRST_ID: u32 = 1;
pub fn menu_for(it: &IShellItem) -> windows::core::Result<Menu> {
    let cm: IContextMenu = unsafe { it.BindToHandler(None, &BHID_SFUIObject)? };
    let hmenu = unsafe { CreatePopupMenu()? };
    unsafe { cm.QueryContextMenu(hmenu, 0, FIRST_ID, 0x7FFF, CMF_NORMAL)? };
    Ok(Menu { cm, hmenu })
}
/// (label, command id) of every plain entry, submenus flattened
pub fn menu_items(h: HMENU, out: &mut Vec<(String, u32)>) {
    let n = unsafe { GetMenuItemCount(h) };
    for i in 0..n.max(0) as u32 {
        let mut mii = MENUITEMINFOW { cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32, fMask: MIIM_FTYPE | MIIM_ID | MIIM_SUBMENU | MIIM_STRING, ..Default::default() };
        if unsafe { GetMenuItemInfoW(h, i, BOOL(1), &mut mii) }.is_err() {
            continue;
        }
        if mii.fType.0 & MFT_SEPARATOR.0 != 0 {
            continue;
        }
        let mut buf = vec![0u16; mii.cch as usize + 1];
        mii.dwTypeData = PWSTR(buf.as_mut_ptr());
        mii.cch += 1;
        let label = if unsafe { GetMenuItemInfoW(h, i, BOOL(1), &mut mii) }.is_ok() { String::from_utf16_lossy(&buf[..mii.cch as usize]) } else { String::new() };
        if !mii.hSubMenu.is_invalid() {
            menu_items(mii.hSubMenu, out);
            continue;
        }
        if !label.trim().is_empty() {
            out.push((label, mii.wID));
        }
    }
}
pub fn invoke_id(m: &Menu, id: u32, hwnd: HWND) -> windows::core::Result<()> {
    let off = (id - FIRST_ID) as usize;
    let info = CMINVOKECOMMANDINFOEX {
        cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
        fMask: CMIC_MASK_UNICODE,
        hwnd,
        lpVerb: PCSTR(off as *const u8),
        lpVerbW: PCWSTR(off as *const u16),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe { m.cm.InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO) }
}
/// run a verb by its programmatic name ("undelete", "eject", "delete"…)
pub fn invoke_verb_name(it: &IShellItem, verb: &str, quiet: bool) -> windows::core::Result<()> {
    let m = menu_for(it)?;
    let a = std::ffi::CString::new(verb).unwrap_or_default();
    let w = HSTRING::from(verb);
    let info = CMINVOKECOMMANDINFOEX {
        cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
        fMask: CMIC_MASK_UNICODE | if quiet { CMIC_MASK_FLAG_NO_UI } else { 0 },
        lpVerb: PCSTR(a.as_ptr() as *const u8),
        lpVerbW: PCWSTR(w.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe { m.cm.InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO) }
}
/// the menu's default command (what a double-click does)
pub fn invoke_default(it: &IShellItem) -> windows::core::Result<()> {
    let m = menu_for(it)?;
    let id = unsafe { GetMenuDefaultItem(m.hmenu, 0, GET_MENU_DEFAULT_ITEM_FLAGS(0)) };
    if id == u32::MAX || id < FIRST_ID {
        return Err(windows::core::Error::from_win32());
    }
    invoke_id(&m, id, HWND(std::ptr::null_mut()))
}

// ---------------- file operations through the shell ----------------
pub fn file_op(flags: u32) -> windows::core::Result<IFileOperation> {
    super::com_init();
    let op: IFileOperation = unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_ALL)? };
    unsafe { op.SetOperationFlags(FILEOPERATION_FLAGS(flags))? };
    Ok(op)
}
pub const NO_UI: u32 = FOF_NO_UI.0;
pub fn run_op(op: &IFileOperation) -> windows::core::Result<()> {
    unsafe { op.PerformOperations() }
}
pub fn copy_item(op: &IFileOperation, it: &IShellItem, dest: &IShellItem) -> windows::core::Result<()> {
    unsafe { op.CopyItem(it, dest, PCWSTR::null(), None::<&IFileOperationProgressSink>) }
}
pub fn delete_item(op: &IFileOperation, it: &IShellItem) -> windows::core::Result<()> {
    unsafe { op.DeleteItem(it, None::<&IFileOperationProgressSink>) }
}
pub fn rename_item(op: &IFileOperation, it: &IShellItem, name: &str) -> windows::core::Result<()> {
    unsafe { op.RenameItem(it, &HSTRING::from(name), None::<&IFileOperationProgressSink>) }
}
pub fn new_folder(op: &IFileOperation, dest: &IShellItem, name: &str) -> windows::core::Result<()> {
    unsafe { op.NewItem(dest, 0x10, &HSTRING::from(name), PCWSTR::null(), None::<&IFileOperationProgressSink>) }
}
