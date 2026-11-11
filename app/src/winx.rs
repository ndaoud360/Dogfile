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

/// Dogfile's own windows are an app, not a browser: switch off the web view's built-in shortcuts (Print on Ctrl+P /
/// Ctrl+Shift+P, reload, view source, developer tools, find, back/forward) so they can never open over the app. Dogfile
/// has its own for everything it wants. Typing and copy/paste keep working. The web pane's sites are not touched.
pub fn no_browser_keys(w: &tauri::WebviewWindow) {
    let _ = w.with_webview(move |pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows_core::Interface;
        if let Ok(core) = pw.controller().CoreWebView2() {
            if let Ok(settings) = core.Settings() {
                if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                    let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                }
            }
        }
    });
}

/// Ask the web view to use as little memory as it can while the window is minimized or hidden, and go back to
/// normal when it's shown again.
pub fn webview_memory_low(w: &tauri::Webview, low: bool) {
    let _ = w.with_webview(move |pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL};
        use windows_core::Interface;
        if let Ok(core) = pw.controller().CoreWebView2() {
            if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
                let _ = c19.SetMemoryUsageTargetLevel(if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL });
            }
        }
    });
}

/// the same for one web view of the web pane (a tab left in the background)
pub fn webview_memory_low_wv(w: &tauri::Webview, low: bool) {
    let _ = w.with_webview(move |pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL};
        use windows_core::Interface;
        if let Ok(core) = pw.controller().CoreWebView2() {
            if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
                let _ = c19.SetMemoryUsageTargetLevel(if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL });
            }
        }
    });
}

/// Hand back the memory this program isn't using right now (its pages stay available: Windows brings back the ones
/// that are needed again). Used a little after Dogfile stops being the window in front.
pub fn trim_own_memory() {
    unsafe {
        let _ = windows::Win32::System::ProcessStatus::EmptyWorkingSet(windows::Win32::System::Threading::GetCurrentProcess());
    }
}
