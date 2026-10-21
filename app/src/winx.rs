// Windows-only window touches: Windows 11 corner style, dark mode and the accent colour.
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND, DWMWCP_ROUND, DWMWCP_ROUNDSMALL};

pub fn set_corners(hwnd: isize, pref: &str) {
    let v = match pref {
        "square" => DWMWCP_DONOTROUND,
        "small" => DWMWCP_ROUNDSMALL,
        _ => DWMWCP_ROUND,
    };
    unsafe {
        let _ = DwmSetWindowAttribute(HWND(hwnd as _), DWMWA_WINDOW_CORNER_PREFERENCE, &v as *const _ as *const _, std::mem::size_of_val(&v) as u32);
    }
}

fn reg_dword(path: &str, name: &str) -> Option<u32> {
    let k = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).open_subkey(path).ok()?;
    k.get_value::<u32, _>(name).ok()
}
pub fn system_dark() -> bool {
    reg_dword(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme") == Some(0)
}
pub fn accent_color() -> Option<String> {
    // stored as 0xAABBGGRR
    let v = reg_dword(r"Software\Microsoft\Windows\DWM", "AccentColor")?;
    Some(format!("{:02x}{:02x}{:02x}ff", v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff))
}
