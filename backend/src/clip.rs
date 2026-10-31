// The clipboard: file lists (with cut / copy, interoperating with Explorer), text, pictures, and an optional
// history of what you copy (skipping anything a password manager marks as private).
use crate::args::{Args, R};
use crate::events;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

pub fn image_png() -> Option<Vec<u8>> {
    let mut cb = arboard::Clipboard::new().ok()?;
    let img = cb.get_image().ok()?;
    let buf = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned())?;
    let mut out = std::io::Cursor::new(Vec::new());
    buf.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}
pub fn write_text(t: &str) -> bool {
    arboard::Clipboard::new().and_then(|mut c| c.set_text(t.to_string())).is_ok()
}
pub fn read_text() -> String {
    arboard::Clipboard::new().and_then(|mut c| c.get_text()).unwrap_or_default()
}
pub async fn write_files(a: &Args) -> R {
    let paths = a.strs(0);
    let cut = a.b(1);
    #[cfg(windows)]
    {
        return Ok(json!(tokio::task::spawn_blocking(move || crate::win::clipboard_set_files(&paths, cut)).await.unwrap_or(false)));
    }
    #[cfg(not(windows))]
    {
        let _ = cut;
        write_text(&paths.join("\n"));
        Ok(json!(false))
    }
}
pub async fn read_files() -> R {
    #[cfg(windows)]
    {
        let (paths, cut) = tokio::task::spawn_blocking(crate::win::clipboard_get_files).await.unwrap_or((vec![], false));
        return Ok(json!({ "paths": paths, "cut": cut }));
    }
    #[cfg(not(windows))]
    Ok(json!({ "paths": [], "cut": false }))
}
pub fn has_image() -> R {
    Ok(json!(arboard::Clipboard::new().and_then(|mut c| c.get_image()).is_ok()))
}
pub fn formats() -> R {
    #[cfg(windows)]
    return Ok(json!(crate::win::clipboard_formats()));
    #[cfg(not(windows))]
    {
        let mut f = vec![];
        if !read_text().is_empty() { f.push("text/plain") }
        Ok(json!(f))
    }
}

static WATCH_GEN: AtomicU64 = AtomicU64::new(0);
/// clip:watch(mode): off / paths / all — sends clip:changed to the window that asked
pub fn watch(win: &str, a: &Args) -> R {
    let mode = a.s_or(0, "off");
    let g = WATCH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    if mode == "off" || mode.is_empty() {
        return Ok(json!(true));
    }
    let w = win.to_string();
    let path_re = regex::Regex::new(r#"^(\s*("?([a-zA-Z]:\\|\\\\|/)[^\n"]*"?)\s*)(\r?\n\s*"?([a-zA-Z]:\\|\\\\|/)[^\n"]*"?\s*)*$"#).unwrap();
    tokio::spawn(async move {
        let mut last = tokio::task::spawn_blocking(read_text).await.unwrap_or_default();
        #[cfg(windows)]
        let mut seq = crate::win::clipboard_seq();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
            if WATCH_GEN.load(Ordering::SeqCst) != g { break }
            // nothing new on the clipboard: don't even open it
            #[cfg(windows)]
            {
                let s = crate::win::clipboard_seq();
                if s == seq { continue }
                seq = s;
                if crate::win::clipboard_is_private() { last = read_text(); continue }
            }
            let t = tokio::task::spawn_blocking(read_text).await.unwrap_or_default();
            if t.is_empty() || t == last || t.len() > 20000 { last = t; continue }
            last = t.clone();
            let is_path = path_re.is_match(&t);
            if mode == "paths" && !is_path { continue }
            events::emit(&w, "clip:changed", json!({ "text": t, "isPath": is_path, "at": crate::util::now_ms() }));
        }
    });
    Ok(json!(true))
}
pub fn unused(_: Value) {}
