// The web pane: ordinary web pages in a native web view that sits over the pane. Nothing is kept (private mode:
// no history, cookies, passwords or cache survive), no extensions, and the pages get no way to call Dogfile.
//
// - Each browser tab is one web view, made only when its tab is first shown and closed with the tab. Tabs left in
//   the background are put to sleep by the page (closed, with the address kept) and wake up when clicked.
// - The pages can't reach Dogfile: the web views are not allowed to call the app (no capability is given to them),
//   the app's own address scheme refuses them (main.rs) and `webguard` only lets http and https through.
// - Dropping files onto a page works as in any browser: the web view handles the drop itself.
// - Downloads go to the Downloads folder under a safe name and are reported to the window.
use dogfile_backend::webguard;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

pub type Emit = Arc<dyn Fn(&str, &str, Value) + Send + Sync>;

pub struct Setup {
    pub browser_args: &'static str,
    pub data_dir: Option<PathBuf>,
    pub downloads: PathBuf,
}

/// at most this many web views per window: a runaway page can't fill the memory
const MAX_VIEWS: usize = 10;

fn label_of(win: &str, id: &str) -> Option<String> {
    let id = clean_id(id);
    if id.is_empty() { None } else { Some(format!("web-{win}-{id}")) }
}
fn clean_id(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(24).collect()
}
fn f(a: &Value, k: &str) -> f64 {
    a[k].as_f64().filter(|v| v.is_finite()).unwrap_or(0.0).clamp(-20000.0, 20000.0)
}
fn evt(id: &str, kind: &str, extra: Value) -> Value {
    let mut o = json!({ "id": id, "type": kind });
    if let (Some(m), Some(x)) = (o.as_object_mut(), extra.as_object()) {
        m.extend(x.clone());
    }
    o
}
fn bad(msg: &str) -> Value {
    json!({ "ok": false, "error": msg })
}

/// A request from the window (`api('web:do', op, args)`). `win` is the window asking.
pub fn run(app: &AppHandle, win: &str, op: &str, a: &Value, setup: &Setup, emit: &Emit) -> Value {
    if !win.starts_with("main") {
        return bad("The web pane belongs to the main window");
    }
    let id = a["id"].as_str().unwrap_or("");
    let Some(label) = label_of(win, id) else {
        if op == "closeAll" {
            // every tab of one web pane (its ids all start with the same prefix and an underscore)
            return close_all(app, win, &clean_id(a["prefix"].as_str().unwrap_or("")));
        }
        return bad("No tab");
    };
    let allow_local = a["allowLocal"].as_bool().unwrap_or(false);
    match op {
        "open" => {
            if app.webviews().keys().filter(|k| k.starts_with(&format!("web-{win}-"))).count() >= MAX_VIEWS && app.get_webview(&label).is_none() {
                return bad("Too many tabs are awake: close one first");
            }
            if let Some(existing) = app.get_webview(&label) {
                let _ = existing.show();
                return json!({ "ok": true, "reused": true });
            }
            let url = match webguard::check(a["url"].as_str().unwrap_or(""), allow_local) {
                Ok(u) => u,
                Err(e) => return bad(e),
            };
            let Ok(parsed) = url.parse::<Url>() else { return bad("That isn’t a web address") };
            let Some(window) = app.get_window(win) else { return bad("The window is gone") };
            let wid = id.to_string();
            let wname = win.to_string();
            let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
                .incognito(true)
                .disable_drag_drop_handler()
                .zoom_hotkeys_enabled(true) // Ctrl + mouse wheel zooms the page, as in any browser
                .additional_browser_args(setup.browser_args)
                .on_navigation({
                    let (wid, emit, wname) = (wid.clone(), emit.clone(), wname.clone());
                    move |u| {
                        let ok = u.as_str() == "about:blank" || webguard::check(u.as_str(), allow_local).is_ok();
                        if !ok {
                            emit(&wname, "web:event", evt(&wid, "blocked", json!({ "url": u.as_str() })));
                        }
                        ok
                    }
                })
                .on_new_window({
                    let (wid, emit, wname) = (wid.clone(), emit.clone(), wname.clone());
                    move |u, _features| {
                        // a link that wants a new window becomes a new tab in this pane
                        if webguard::check(u.as_str(), allow_local).is_ok() {
                            emit(&wname, "web:event", evt(&wid, "newtab", json!({ "url": u.as_str() })));
                        }
                        NewWindowResponse::Deny
                    }
                })
                .on_page_load({
                    let (wid, emit, wname) = (wid.clone(), emit.clone(), wname.clone());
                    move |_wv, p| {
                        let state = if matches!(p.event(), PageLoadEvent::Started) { "start" } else { "done" };
                        emit(&wname, "web:event", evt(&wid, "load", json!({ "state": state, "url": p.url().as_str() })));
                    }
                })
                .on_document_title_changed({
                    let (wid, emit, wname) = (wid.clone(), emit.clone(), wname.clone());
                    move |wv, title| {
                        let url = wv.url().map(|u| u.to_string()).unwrap_or_default();
                        emit(&wname, "web:event", evt(&wid, "title", json!({ "title": title, "url": url })));
                    }
                })
                .on_download({
                    let (wid, emit, wname, dir) = (wid.clone(), emit.clone(), wname.clone(), setup.downloads.clone());
                    move |_wv, event| match event {
                        DownloadEvent::Requested { url, destination } => {
                            if webguard::check(url.as_str(), true).is_err() && url.scheme() != "blob" {
                                return false;
                            }
                            let name = webguard::safe_file_name(&destination.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
                            let _ = std::fs::create_dir_all(&dir);
                            let target = unique(&dir, &name);
                            *destination = target.clone();
                            let shown = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name);
                            emit(&wname, "web:event", evt(&wid, "download", json!({ "state": "start", "name": shown, "risky": webguard::risky_file(&shown) })));
                            true
                        }
                        DownloadEvent::Finished { path, success, .. } => {
                            let p = path.map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
                            emit(&wname, "web:event", evt(&wid, "download", json!({ "state": if success { "done" } else { "failed" }, "path": p })));
                            true
                        }
                        _ => true,
                    }
                });
            #[cfg(windows)]
            let builder = match &setup.data_dir {
                Some(d) => builder.data_directory(d.clone()),
                None => builder,
            };
            let z = a["zoom"].as_f64().filter(|z| (0.25..=5.0).contains(z)).unwrap_or(1.0);
            let (x, y, w, h) = (f(a, "x") * z, f(a, "y") * z, (f(a, "w") * z).max(1.0), (f(a, "h") * z).max(1.0));
            match window.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h)) {
                Ok(wv) => {
                    if a["visible"].as_bool() == Some(false) {
                        let _ = wv.hide();
                    }
                    json!({ "ok": true })
                }
                Err(e) => bad(&format!("The web view couldn’t start: {e}")),
            }
        }
        "bounds" => {
            let Some(wv) = app.get_webview(&label) else { return bad("Asleep") };
            let z = a["zoom"].as_f64().filter(|z| (0.25..=5.0).contains(z)).unwrap_or(1.0);
            let _ = wv.set_position(LogicalPosition::new(f(a, "x") * z, f(a, "y") * z));
            let _ = wv.set_size(LogicalSize::new((f(a, "w") * z).max(1.0), (f(a, "h") * z).max(1.0)));
            json!({ "ok": true })
        }
        "show" => {
            let Some(wv) = app.get_webview(&label) else { return bad("Asleep") };
            if a["on"].as_bool().unwrap_or(true) { let _ = wv.show(); } else { let _ = wv.hide(); }
            json!({ "ok": true })
        }
        "nav" => {
            let Some(wv) = app.get_webview(&label) else { return bad("Asleep") };
            match webguard::check(a["url"].as_str().unwrap_or(""), allow_local).ok().and_then(|u| u.parse::<Url>().ok()) {
                Some(u) => { let _ = wv.navigate(u); json!({ "ok": true }) }
                None => bad("That address can’t be opened here"),
            }
        }
        "back" | "forward" | "reload" | "stop" => {
            let Some(wv) = app.get_webview(&label) else { return bad("Asleep") };
            let js = match op { "back" => "history.back()", "forward" => "history.forward()", "reload" => "location.reload()", _ => "window.stop()" };
            let _ = wv.eval(js);
            json!({ "ok": true })
        }
        "focus" => {
            if let Some(wv) = app.get_webview(&label) { let _ = wv.set_focus(); }
            json!({ "ok": true })
        }
        "zoom" => {
            if let Some(wv) = app.get_webview(&label) { let _ = wv.set_zoom(a["factor"].as_f64().unwrap_or(1.0).clamp(0.25, 5.0)); }
            json!({ "ok": true })
        }
        "low" => {
            #[cfg(windows)]
            if let Some(wv) = app.get_webview(&label) { crate::winx::webview_memory_low_wv(&wv, a["on"].as_bool().unwrap_or(true)); }
            json!({ "ok": true })
        }
        "close" => {
            if let Some(wv) = app.get_webview(&label) { let _ = wv.close(); }
            json!({ "ok": true })
        }
        "closeAll" => close_all(app, win, ""),
        "count" => json!({ "ok": true, "count": app.webviews().keys().filter(|k| k.starts_with(&format!("web-{win}-"))).count() }),
        _ => bad("Unknown request"),
    }
}

fn close_all(app: &AppHandle, win: &str, id_prefix: &str) -> Value {
    let prefix = format!("web-{win}-{id_prefix}");
    for (k, wv) in app.webviews() {
        if k.starts_with(&prefix) {
            let _ = wv.close();
        }
    }
    json!({ "ok": true })
}

/// "name.ext", or "name (2).ext" when that is taken: a download never replaces a file
fn unique(dir: &std::path::Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for n in 2..1000 {
        let p = dir.join(format!("{stem} ({n}){ext}"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem}-{}{ext}", std::process::id()))
}
