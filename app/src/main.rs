// Dogfile: the window around the interface. Tauri shows the pages in the system web view (WebView2 on Windows);
// everything else (files, copies, search, media…) is answered by dogfile-backend, in this same process.
//
// Pages load from the custom scheme dogfile:// (http://dogfile.localhost/ on Windows). The page's calls go to
// /invoke on that scheme; events come back through window.__dogEvent (see src/renderer/js/bridge.js).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod launch;
#[cfg(windows)]
mod winx;

use dogfile_backend::host::{DialogOpts, Host};
use dogfile_backend::http::{self as bhttp, Body as RBody, Req};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, DragDropEvent, Manager, PhysicalPosition, PhysicalSize, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// Browser flags shared by every window (they must match, or WebView2 refuses the second window).
/// One renderer process for all of Dogfile's pages (same site), and nothing running in the background.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,msEdgeTranslate,msImplicitSignin,msWebView2TextureStream --process-per-site --disable-background-networking --disable-component-update --disable-domain-reliability --no-pings";

fn page_url(page: &str, query: &str) -> WebviewUrl {
    let q = if query.is_empty() { String::new() } else { format!("?{query}") };
    let s = if cfg!(any(windows, target_os = "android")) { format!("http://dogfile.localhost/app/{page}{q}") } else { format!("dogfile://localhost/app/{page}{q}") };
    WebviewUrl::External(s.parse().unwrap())
}

// ---------------- the host: windows, events, dialogs ----------------
pub struct AppHost {
    app: OnceLock<AppHandle>,
    launches: Mutex<HashMap<String, Value>>,
    pending: Mutex<HashMap<String, Value>>,
    seq: AtomicU32,
    quitting: AtomicBool,
    tray: Mutex<Option<tauri::tray::TrayIcon>>,
    corners: Mutex<String>,
}

impl AppHost {
    fn app(&self) -> &AppHandle {
        self.app.get().expect("app not ready")
    }
    fn win(&self, label: &str) -> Option<WebviewWindow> {
        self.app().get_webview_window(label)
    }
    fn data_dir(&self) -> PathBuf {
        dogfile_backend::st().data_dir.clone()
    }
    fn theme_bg(&self, kind: &str) -> tauri::window::Color {
        if kind == "player" {
            return tauri::window::Color(0, 0, 0, 255);
        }
        if kind == "viewer" {
            return tauri::window::Color(11, 11, 13, 255);
        }
        let theme = dogfile_backend::setting("theme");
        let dark = match theme.as_str() {
            Some("dark") => true,
            Some("light") => false,
            _ => self.system_dark(),
        };
        if dark { tauri::window::Color(21, 22, 24, 255) } else { tauri::window::Color(239, 239, 240, 255) }
    }

    /// a file-browser window
    fn create_main(&self, launch: Value) {
        let n = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let label = format!("main-{n}");
        self.launches.lock().insert(label.clone(), launch);
        let first = self.app().webview_windows().keys().all(|k| !k.starts_with("main"));
        let saved = dogfile_backend::store::get("window").unwrap_or(json!({}));
        let b = WebviewWindowBuilder::new(self.app(), &label, page_url("index.html", &format!("w={label}")))
            .title("Dogfile")
            .min_inner_size(380.0, 300.0)
            .inner_size(saved["width"].as_f64().unwrap_or(1360.0), saved["height"].as_f64().unwrap_or(880.0));
        let b = if first && saved["x"].is_number() { b.position(saved["x"].as_f64().unwrap_or(80.0), saved["y"].as_f64().unwrap_or(60.0)) } else { b.center() };
        let maximized = first && saved["maximized"].as_bool().unwrap_or(false);
        match self.build(b, "main") {
            Ok(w) => {
                if maximized {
                    let _ = w.maximize();
                }
            }
            Err(e) => eprintln!("window: {e}"),
        }
    }

    fn build(&self, b: WebviewWindowBuilder<'_, tauri::Wry, AppHandle>, kind: &str) -> tauri::Result<WebviewWindow> {
        let b = b
            .decorations(false)
            .shadow(true)
            .visible(false)
            .resizable(true)
            .background_color(self.theme_bg(kind))
            .zoom_hotkeys_enabled(false)
            .additional_browser_args(BROWSER_ARGS)
            .on_page_load(|w, p| {
                if matches!(p.event(), tauri::webview::PageLoadEvent::Finished) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            });
        #[cfg(windows)]
        let b = b.data_directory(webview_data_dir());
        let w = b.build()?;
        #[cfg(windows)]
        if let Ok(h) = w.hwnd() {
            winx::set_corners(h.0 as isize, &self.corners.lock());
        }
        // a page that never reports finished loading still shows (e.g. a slow first start)
        let w2 = w.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(2500));
            if !w2.is_visible().unwrap_or(true) {
                let _ = w2.show();
            }
        });
        Ok(w)
    }

    fn open_path_anywhere(&self, launch: Value) {
        let wins: Vec<String> = self.windows().into_iter().filter(|w| w.starts_with("main")).collect();
        let want_new = launch["newWindow"].as_bool().unwrap_or(false) || dogfile_backend::setting_bool("openInNewWindow", false);
        if let Some(target) = wins.first().and_then(|l| self.win(l)) {
            if !want_new {
                let _ = target.show();
                let _ = target.unminimize();
                let _ = target.set_focus();
                self.emit(target.label(), "app:open", launch);
                return;
            }
        }
        self.create_main(launch);
    }

    fn handle_launch(&self, l: launch::Launch, first: bool) {
        let tools = !l.edit.is_empty() || !l.play.is_empty() || !l.view.is_empty();
        if !l.edit.is_empty() {
            self.open_tool("editor", l.edit.clone(), json!({}));
        }
        if !l.play.is_empty() {
            self.open_tool("player", l.play.clone(), json!({ "play": true }));
        }
        if !l.view.is_empty() {
            let one = l.view.len() == 1;
            self.open_tool("viewer", l.view.clone(), json!({ "autoPlaylist": one }));
        }
        if tools && l.path.is_none() {
            return;
        }
        let v = json!({ "path": l.path, "select": l.select });
        if first { self.create_main(v) } else { self.open_path_anywhere(v) }
    }

    fn save_bounds(&self, w: &tauri::Window) {
        if !w.label().starts_with("main") {
            let kind = w.label().split('-').next().unwrap_or("").to_string();
            if w.is_minimized().unwrap_or(false) || w.is_maximized().unwrap_or(false) {
                return;
            }
            if let (Ok(p), Ok(s), Ok(f)) = (w.outer_position(), w.inner_size(), w.scale_factor()) {
                let _ = dogfile_backend::store::set(&format!("{kind}-window"), &json!({ "x": p.x as f64 / f, "y": p.y as f64 / f, "width": s.width as f64 / f, "height": s.height as f64 / f }));
            }
            return;
        }
        if w.is_minimized().unwrap_or(false) {
            return;
        }
        let maximized = w.is_maximized().unwrap_or(false);
        let mut v = dogfile_backend::store::get("window").unwrap_or(json!({}));
        if !maximized {
            if let (Ok(p), Ok(s), Ok(f)) = (w.outer_position(), w.inner_size(), w.scale_factor()) {
                v = json!({ "x": p.x as f64 / f, "y": p.y as f64 / f, "width": s.width as f64 / f, "height": s.height as f64 / f });
            }
        }
        v["maximized"] = json!(maximized);
        let _ = dogfile_backend::store::set("window", &v);
    }

    fn tray_icon(&self) {
        if self.tray.lock().is_some() {
            return;
        }
        use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
        let app = self.app();
        let Ok(new) = MenuItem::with_id(app, "new", "New window", true, None::<&str>) else { return };
        let Ok(quit) = MenuItem::with_id(app, "quit", "Quit Dogfile", true, None::<&str>) else { return };
        let Ok(sep) = PredefinedMenuItem::separator(app) else { return };
        let Ok(menu) = Menu::with_items(app, &[&new, &sep, &quit]) else { return };
        let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")).ok();
        let mut b = TrayIconBuilder::with_id("dogfile").tooltip("Dogfile").menu(&menu).show_menu_on_left_click(false);
        if let Some(i) = icon {
            b = b.icon(i);
        }
        let t = b
            .on_menu_event(|_app, e| match e.id().as_ref() {
                "new" => host().open_path_anywhere(json!({ "newWindow": true })),
                "quit" => host().quit(),
                _ => {}
            })
            .on_tray_icon_event(|_t, e| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                    host().open_path_anywhere(json!({}));
                }
            })
            .build(app);
        if let Ok(t) = t {
            *self.tray.lock() = Some(t);
        }
    }
}

#[cfg(windows)]
fn webview_data_dir() -> PathBuf {
    // keep the web view's cache beside Dogfile's own data (portable copies keep everything in one folder)
    dogfile_backend::st().data_dir.join("WebView")
}

fn js_str(v: &impl serde::Serialize) -> String {
    // JSON is valid JavaScript, except two line separators some engines reject inside strings
    serde_json::to_string(v).unwrap_or_else(|_| "null".into()).replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029")
}

impl Host for AppHost {
    fn emit(&self, win: &str, channel: &str, data: Value) {
        if let Some(w) = self.win(win) {
            let _ = w.eval(format!("window.__dogEvent&&window.__dogEvent({},{})", js_str(&channel), js_str(&data)));
        }
    }
    fn broadcast(&self, channel: &str, data: Value) {
        let script = format!("window.__dogEvent&&window.__dogEvent({},{})", js_str(&channel), js_str(&data));
        for w in self.app().webview_windows().values() {
            let _ = w.eval(script.clone());
        }
    }
    fn windows(&self) -> Vec<String> {
        let all = self.app().webview_windows();
        let mut v: Vec<(bool, String)> = all.iter().map(|(k, w)| (w.is_focused().unwrap_or(false), k.clone())).collect();
        v.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        v.into_iter().map(|x| x.1).collect()
    }
    fn win_control(&self, win: &str, action: &str) -> Value {
        let Some(w) = self.win(win) else { return json!(false) };
        match action {
            "min" => {
                let _ = w.minimize();
            }
            // F11 behaves like the maximize button
            "max" | "fullscreen" => {
                if w.is_fullscreen().unwrap_or(false) {
                    let _ = w.set_fullscreen(false);
                } else if w.is_maximized().unwrap_or(false) {
                    let _ = w.unmaximize();
                } else {
                    let _ = w.maximize();
                }
            }
            "close" => {
                let _ = w.close();
            }
            "devtools" => {
                #[cfg(debug_assertions)]
                w.open_devtools();
            }
            "quit" => self.quit(),
            "ontop" => {
                let on = !w.is_always_on_top().unwrap_or(false);
                let _ = w.set_always_on_top(on);
                return json!(on);
            }
            "isFullscreen" => return json!(w.is_fullscreen().unwrap_or(false)),
            "isMaximized" => {}
            "focus" => {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            _ => {}
        }
        json!(w.is_maximized().unwrap_or(false))
    }
    fn new_window(&self, launch: Value) {
        self.create_main(launch);
    }
    fn open_tool(&self, kind: &str, files: Vec<String>, opts: Value) {
        let label = format!("{kind}-1");
        let mut o = if opts.is_object() { opts } else { json!({}) };
        o["files"] = json!(files);
        if let Some(w) = self.win(&label) {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
            if !files.is_empty() {
                self.emit(&label, &format!("{kind}:open"), o);
            }
            return;
        }
        self.pending.lock().insert(label.clone(), o);
        let saved = dogfile_backend::store::get(&format!("{kind}-window")).unwrap_or(json!({}));
        let big = kind == "player" || kind == "viewer";
        let title = match kind {
            "editor" => "Dogfile Notepad",
            "player" => "Dogfile Player",
            "viewer" => "Dogfile Photos",
            _ => "Dogfile",
        };
        let b = WebviewWindowBuilder::new(self.app(), &label, page_url(&format!("{kind}.html"), &format!("w={label}")))
            .title(title)
            .min_inner_size(340.0, 260.0)
            .inner_size(saved["width"].as_f64().unwrap_or(if big { 1280.0 } else { 1100.0 }), saved["height"].as_f64().unwrap_or(if big { 760.0 } else { 800.0 }));
        let b = if saved["x"].is_number() { b.position(saved["x"].as_f64().unwrap_or(80.0), saved["y"].as_f64().unwrap_or(60.0)) } else { b.center() };
        if let Err(e) = self.build(b, kind) {
            eprintln!("tool window: {e}");
        }
    }
    fn tool_pending(&self, win: &str) -> Value {
        self.pending.lock().remove(win).unwrap_or(Value::Null)
    }
    fn launch_of(&self, win: &str) -> Value {
        self.launches.lock().get(win).cloned().unwrap_or(json!({}))
    }
    fn set_zoom(&self, win: &str, factor: f64) {
        if let Some(w) = self.win(win) {
            let _ = w.set_zoom(factor);
        }
    }
    fn start_drag(&self, win: &str, paths: Vec<String>) {
        let Some(w) = self.win(win) else { return };
        let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).filter(|p| p.exists()).collect();
        if files.is_empty() {
            return;
        }
        let w2 = w.clone();
        let _ = w.run_on_main_thread(move || {
            let image = drag::Image::Raw(include_bytes!("../icons/drag.png").to_vec());
            #[cfg(target_os = "linux")]
            let Ok(target) = w2.gtk_window() else { return };
            #[cfg(not(target_os = "linux"))]
            let target = w2;
            let _ = drag::start_drag(&target, drag::DragItem::Files(files), image, |_r, _p| {}, drag::Options::default());
        });
    }
    fn start_window_drag(&self, win: &str) {
        if let Some(w) = self.win(win) {
            let _ = w.start_dragging();
        }
    }
    fn start_window_resize(&self, win: &str, dir: &str) {
        use tauri_runtime::ResizeDirection as RD;
        let d = match dir {
            "North" => RD::North,
            "South" => RD::South,
            "East" => RD::East,
            "West" => RD::West,
            "NorthEast" => RD::NorthEast,
            "NorthWest" => RD::NorthWest,
            "SouthEast" => RD::SouthEast,
            _ => RD::SouthWest,
        };
        if let Some(w) = self.win(win) {
            let wv: &tauri::Webview = w.as_ref();
            let _ = wv.window().start_resize_dragging(d);
        }
    }
    fn set_corners(&self, pref: &str) {
        *self.corners.lock() = pref.to_string();
        #[cfg(windows)]
        for w in self.app().webview_windows().values() {
            if let Ok(h) = w.hwnd() {
                winx::set_corners(h.0 as isize, pref);
            }
        }
    }
    fn ensure_tray(&self) {
        self.tray_icon();
    }
    fn pick_folder(&self, win: &str, title: Option<String>) -> Option<String> {
        let mut d = rfd::FileDialog::new();
        if let Some(t) = title {
            d = d.set_title(t);
        }
        if let Some(w) = self.win(win) {
            d = d.set_parent(&w);
        }
        d.pick_folder().map(|p| p.to_string_lossy().into_owned())
    }
    fn open_files(&self, win: &str, o: DialogOpts) -> Vec<String> {
        let mut d = dialog_from(o);
        if let Some(w) = self.win(win) {
            d = d.set_parent(&w);
        }
        d.pick_files().unwrap_or_default().into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
    }
    fn save_file(&self, win: &str, o: DialogOpts) -> Option<String> {
        let mut d = dialog_from(o);
        if let Some(w) = self.win(win) {
            d = d.set_parent(&w);
        }
        d.save_file().map(|p| p.to_string_lossy().into_owned())
    }
    fn message_box(&self, win: &str, title: &str, message: &str, detail: &str, buttons: Vec<String>, cancel_id: usize) -> usize {
        use rfd::{MessageButtons, MessageDialog, MessageDialogResult};
        let text = if detail.is_empty() { message.to_string() } else { format!("{message}\n\n{detail}") };
        let mut d = MessageDialog::new().set_title(title).set_description(text);
        if let Some(w) = self.win(win) {
            d = d.set_parent(&w);
        }
        let b = |i: usize| buttons.get(i).cloned().unwrap_or_default();
        d = match buttons.len() {
            0 | 1 => d.set_buttons(MessageButtons::OkCustom(b(0))),
            2 => d.set_buttons(MessageButtons::OkCancelCustom(b(0), b(1))),
            _ => d.set_buttons(MessageButtons::YesNoCancelCustom(b(0), b(1), b(2))),
        };
        match d.show() {
            MessageDialogResult::Custom(s) => buttons.iter().position(|x| *x == s).unwrap_or(cancel_id),
            MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
            MessageDialogResult::No => 1,
            _ => cancel_id,
        }
    }
    fn system_dark(&self) -> bool {
        #[cfg(windows)]
        {
            return winx::system_dark();
        }
        #[cfg(not(windows))]
        self.app().webview_windows().values().next().and_then(|w| w.theme().ok()).map(|t| t == tauri::Theme::Dark).unwrap_or(false)
    }
    fn accent_color(&self) -> Option<String> {
        #[cfg(windows)]
        {
            return winx::accent_color();
        }
        #[cfg(not(windows))]
        None
    }
    fn native_window_handle(&self, win: &str) -> Option<isize> {
        #[cfg(windows)]
        {
            return self.win(win).and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
        }
        #[cfg(not(windows))]
        {
            let _ = win;
            None
        }
    }
    fn quit(&self) {
        self.quitting.store(true, Ordering::Relaxed);
        dogfile_backend::shutdown();
        self.app().exit(0);
    }
}

fn dialog_from(o: DialogOpts) -> rfd::FileDialog {
    let mut d = rfd::FileDialog::new();
    if let Some(t) = o.title {
        d = d.set_title(t);
    }
    if let Some(p) = o.default_path {
        let pb = PathBuf::from(&p);
        if pb.is_dir() {
            d = d.set_directory(pb);
        } else {
            if let Some(dir) = pb.parent() {
                d = d.set_directory(dir);
            }
            if let Some(n) = pb.file_name() {
                d = d.set_file_name(n.to_string_lossy());
            }
        }
    }
    for (name, exts) in o.filters {
        let e: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
        d = d.add_filter(name, &e);
    }
    d
}

static HOST: OnceLock<Arc<AppHost>> = OnceLock::new();
fn host() -> &'static Arc<AppHost> {
    HOST.get().expect("host")
}

// ---------------- dogfile:// → the back end ----------------
fn to_req(label: &str, r: tauri::http::Request<Vec<u8>>) -> Req {
    let uri = r.uri().clone();
    let headers: HashMap<String, String> = r.headers().iter().map(|(k, v)| (k.as_str().to_lowercase(), v.to_str().unwrap_or("").to_string())).collect();
    let raw_query = uri.query().unwrap_or("").to_string();
    Req {
        method: r.method().to_string(),
        path: urlencoding::decode(uri.path()).map(|c| c.into_owned()).unwrap_or_else(|_| uri.path().to_string()),
        query: bhttp::parse_query(&raw_query),
        raw_query,
        win: headers.get("x-dog-win").cloned().unwrap_or_else(|| label.to_string()),
        headers,
        body: r.into_body(),
    }
}
async fn respond(req: Req) -> tauri::http::Response<Vec<u8>> {
    let r = bhttp::handle(req).await;
    let mut b = tauri::http::Response::builder().status(r.status);
    for (k, v) in &r.headers {
        b = b.header(k.as_str(), v.as_str());
    }
    let body = match r.body {
        RBody::Bytes(v) => v,
        // the custom scheme can't stream: gather it (live video goes through the local media server instead)
        RBody::Stream(mut rx) => {
            let mut out = Vec::new();
            while let Some(c) = rx.recv().await {
                out.extend_from_slice(&c);
            }
            out
        }
    };
    b.body(body).unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

fn data_dir() -> PathBuf {
    let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())).unwrap_or_default();
    if std::env::var("ATLAS_PORTABLE").as_deref() == Ok("1") || exe_dir.join("portable.txt").exists() {
        return exe_dir.join("data");
    }
    if let Ok(d) = std::env::var("DOGFILE_DATA") {
        return PathBuf::from(d);
    }
    // the same folder the Electron version used, so settings, tags and the index carry over
    dirs::config_dir().unwrap_or(exe_dir).join("Dogfile")
}
/// where the interface and the bundled tools are: beside the exe (installed / portable), or the source tree
fn resource_dirs() -> (PathBuf, PathBuf) {
    let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())).unwrap_or_default();
    for base in [exe_dir.clone(), exe_dir.join("resources")] {
        if base.join("renderer").join("index.html").exists() {
            return (base.join("renderer"), base);
        }
    }
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    (src.join("src").join("renderer"), src)
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    // the elevated helper that builds the index from the NTFS file table
    if argv.get(1).map(|s| s.as_str()) == Some("--build-index") && argv.len() >= 4 {
        dogfile_core::init_threads();
        std::process::exit(dogfile_core::index::build_cli(&argv[2], &argv[3]));
    }
    let test_mode = std::env::var("ATLAS_TEST").as_deref() == Ok("1");
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).max_blocking_threads(16).enable_all().thread_name("dogfile").build().expect("runtime");
    tauri::async_runtime::set(rt.handle().clone());

    let h = Arc::new(AppHost {
        app: OnceLock::new(),
        launches: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashMap::new()),
        seq: AtomicU32::new(0),
        quitting: AtomicBool::new(false),
        tray: Mutex::new(None),
        corners: Mutex::new("round".into()),
    });
    let _ = HOST.set(h.clone());
    let (renderer_dir, res_dir) = resource_dirs();
    {
        let _g = rt.enter();
        dogfile_backend::start(dogfile_backend::Config { data_dir: data_dir(), renderer_dir, res_dir, test_mode }, h.clone());
    }
    *h.corners.lock() = dogfile_backend::setting("windowCorners").as_str().unwrap_or("round").to_string();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, argv, cwd| {
            let l = launch::parse(&argv.iter().skip(1).cloned().collect::<Vec<_>>(), Some(&cwd));
            host().handle_launch(l, false);
        }))
        .register_asynchronous_uri_scheme_protocol("dogfile", |ctx, request, responder| {
            let req = to_req(ctx.webview_label(), request);
            tauri::async_runtime::spawn(async move {
                responder.respond(respond(req).await);
            });
        })
        .setup(move |app| {
            let _ = host().app.set(app.handle().clone());
            let l = launch::parse(&argv.iter().skip(1).cloned().collect::<Vec<_>>(), None);
            if test_mode {
                if let Ok(tool) = std::env::var("ATLAS_TEST_TOOL") {
                    let files: Vec<String> = serde_json::from_str(&std::env::var("ATLAS_TEST_FILES").unwrap_or("[]".into())).unwrap_or_default();
                    host().open_tool(&tool, files, json!({ "play": true }));
                    return Ok(());
                }
            }
            host().handle_launch(l, true);
            Ok(())
        })
        .on_window_event(|w, e| match e {
            WindowEvent::CloseRequested { api, .. } => {
                let h = host();
                if h.quitting.load(Ordering::Relaxed) {
                    return;
                }
                let mains = h.windows().into_iter().filter(|x| x.starts_with("main")).count();
                if w.label().starts_with("main") && mains == 1 && dogfile_backend::setting_bool("keepRunning", false) {
                    api.prevent_close();
                    h.emit(w.label(), "app:beforeHide", json!({}));
                    let _ = w.hide();
                    h.tray_icon();
                }
            }
            WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                save_bounds_soon(w.clone());
                if w.label().starts_with("main") {
                    let m = w.is_maximized().unwrap_or(false);
                    host().emit(w.label(), "win:state", json!({ "maximized": m }));
                }
            }
            WindowEvent::Destroyed => {
                let label = w.label().to_string();
                host().launches.lock().remove(&label);
                dogfile_backend::window_closed(&label);
            }
            WindowEvent::DragDrop(d) => {
                let (kind, paths, pos): (&str, Vec<String>, Option<PhysicalPosition<f64>>) = match d {
                    DragDropEvent::Enter { paths, position } => ("enter", paths.iter().map(|p| p.to_string_lossy().into_owned()).collect(), Some(*position)),
                    DragDropEvent::Over { position } => ("over", vec![], Some(*position)),
                    DragDropEvent::Drop { paths, position } => ("drop", paths.iter().map(|p| p.to_string_lossy().into_owned()).collect(), Some(*position)),
                    DragDropEvent::Leave => ("leave", vec![], None),
                    _ => return,
                };
                let p = pos.unwrap_or(PhysicalPosition::new(0.0, 0.0));
                host().emit(w.label(), "dogfile:drag", json!({ "type": kind, "paths": paths, "x": p.x, "y": p.y }));
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("Dogfile could not start");
    let _ = PhysicalSize::<u32>::new(0, 0);
    app.run(|_app, e| {
        if let RunEvent::Exit = e {
            dogfile_backend::shutdown();
        }
    });
}

/// remember window sizes and positions, at most twice a second
fn save_bounds_soon(w: tauri::Window) {
    static GEN: AtomicU32 = AtomicU32::new(0);
    let g = GEN.fetch_add(1, Ordering::Relaxed) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if GEN.load(Ordering::Relaxed) == g {
            host().save_bounds(&w);
        }
    });
}
