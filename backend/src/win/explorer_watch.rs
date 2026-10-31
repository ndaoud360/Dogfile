// "Show in folder" from other programs (a browser's Downloads list, Store apps, installers) opens File Explorer
// directly: Windows' SHOpenFolderAndSelectItems doesn't go through the default file manager setting. While Dogfile
// is the default file manager and running, a File Explorer window that opens on a folder on disk is closed and the
// same folder (with the same files selected) opens in Dogfile instead. Windows-only places (Control Panel, Settings,
// printers…) and Explorer windows that were already open are left alone.
use super::com_init;
use serde_json::json;
use std::collections::HashSet;
use std::time::{Duration, Instant};
use windows::core::{Interface, VARIANT};
use windows::Win32::System::Com::{CoCreateInstance, IDispatch, CLSCTX_ALL};
use windows::Win32::UI::Shell::{Folder2, IShellFolderViewDual, IShellWindows, IWebBrowser2, ShellWindows};

/// Dogfile opening File Explorer on purpose ("Show in File Explorer"): leave the windows of the next few seconds be
pub fn allow_explorer() {
    *ALLOW.lock() = Some(Instant::now() + Duration::from_secs(6));
}
static ALLOW: parking_lot::Mutex<Option<Instant>> = parking_lot::Mutex::new(None);
fn allowed() -> bool {
    ALLOW.lock().map(|t| Instant::now() < t).unwrap_or(false)
}

struct Win {
    hwnd: isize,
    path: String,
    selected: Vec<String>,
}

unsafe fn windows_now(sw: &IShellWindows) -> Vec<(isize, IWebBrowser2)> {
    let mut out = vec![];
    let n = sw.Count().unwrap_or(0);
    for i in 0..n {
        let Ok(d) = sw.Item(&VARIANT::from(i)) else { continue };
        let Ok(b) = d.cast::<IWebBrowser2>() else { continue };
        let Ok(h) = b.HWND() else { continue };
        out.push((h.0, b));
    }
    out
}
unsafe fn read(b: &IWebBrowser2, hwnd: isize) -> Option<Win> {
    let doc: IDispatch = b.Document().ok()?;
    let view: IShellFolderViewDual = doc.cast().ok()?;
    let path = view.Folder().ok()?.cast::<Folder2>().ok()?.Self_().ok()?.Path().ok()?.to_string();
    let mut selected = vec![];
    if let Ok(items) = view.SelectedItems() {
        for i in 0..items.Count().unwrap_or(0).min(200) {
            if let Ok(it) = items.Item(&VARIANT::from(i)) {
                if let Ok(p) = it.Path() {
                    selected.push(p.to_string());
                }
            }
        }
    }
    Some(Win { hwnd, path, selected })
}

pub fn start() {
    std::thread::Builder::new()
        .name("dogfile-explorer-watch".into())
        .spawn(|| unsafe {
            com_init();
            let Ok(sw) = CoCreateInstance::<_, IShellWindows>(&ShellWindows, None, CLSCTX_ALL) else { return };
            // windows open before Dogfile started stay as they are
            let mut known: HashSet<isize> = windows_now(&sw).into_iter().map(|w| w.0).collect();
            let mut fresh: Vec<(isize, Instant)> = vec![];
            let mut on = false;
            for round in 0u64.. {
                std::thread::sleep(Duration::from_millis(250));
                if round % 8 == 0 {
                    on = super::reg::is_default() && crate::setting_bool("takeOverExplorer", true);
                }
                let now = windows_now(&sw);
                for (h, _) in &now {
                    if known.insert(*h) && on && !allowed() {
                        fresh.push((*h, Instant::now()));
                    }
                }
                known.retain(|h| now.iter().any(|w| w.0 == *h));
                if fresh.is_empty() {
                    continue;
                }
                // a moment for it to arrive at its folder and select the file
                let mut keep = vec![];
                for (h, t) in fresh.drain(..) {
                    let Some((_, b)) = now.iter().find(|w| w.0 == h) else { continue };
                    let w = read(b, h);
                    let ready = w.as_ref().map(|w| !w.path.is_empty()).unwrap_or(false);
                    if !ready || t.elapsed() < Duration::from_millis(350) {
                        if t.elapsed() < Duration::from_secs(3) {
                            keep.push((h, t));
                        }
                        continue;
                    }
                    let w = w.unwrap();
                    // only folders on disk (not Control Panel, This PC's Windows-only views, zip folders…)
                    if !std::path::Path::new(&w.path).is_dir() {
                        continue;
                    }
                    let _ = b.Quit();
                    let select = w.selected.into_iter().find(|s| std::path::Path::new(s).exists());
                    crate::st().host.open_path(json!({ "path": w.path, "select": select }));
                    let _ = w.hwnd;
                }
                fresh = keep;
            }
        })
        .ok();
}
