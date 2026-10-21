// Dogfile's back end: everything the window asks for (files, copies, search, media, shell…) answered natively.
// The window calls `invoke(name, ...args)`; `dispatch` routes the name to the module that does the work.
// The app (Tauri) and the development server both run this same code; they differ only in the `Host` they
// provide (windows, dialogs, events).
pub mod args;
pub mod dispatch;
pub mod engine;
pub mod events;
pub mod fsx;
pub mod host;
pub mod http;
pub mod store;
pub mod sys;
pub mod watch;
pub mod ops;
pub mod archive;
pub mod media;
pub mod doc;
pub mod tags;
pub mod versions;
pub mod ai;
pub mod imgmeta;
pub mod netdiscover;
pub mod remote;
pub mod git;
pub mod pty;
pub mod clip;
pub mod secrets;
pub mod shell;
pub mod server;
pub mod util;
pub mod update;
#[cfg(windows)]
pub mod win;

pub use host::Host;
use parking_lot::RwLock;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

pub struct State {
    pub host: Arc<dyn Host>,
    /// %APPDATA%\Dogfile (settings, tags, index, versions, models…)
    pub data_dir: PathBuf,
    /// the interface files (index.html, js/, styles.css…)
    pub renderer_dir: PathBuf,
    /// bundled tools: ffmpeg/, 7zip/
    pub res_dir: PathBuf,
    pub settings: RwLock<Value>,
    pub test_mode: bool,
    pub rt: tokio::runtime::Handle,
    /// address of the local media server (live video conversion is streamed from there)
    pub stream_base: RwLock<String>,
}

static STATE: OnceLock<State> = OnceLock::new();
pub fn st() -> &'static State {
    STATE.get().expect("backend not started")
}

pub struct Config {
    pub data_dir: PathBuf,
    pub renderer_dir: PathBuf,
    pub res_dir: PathBuf,
    pub test_mode: bool,
}

/// Start the back end. Call once, from inside a tokio runtime.
pub fn start(cfg: Config, host: Arc<dyn Host>) {
    let _ = std::fs::create_dir_all(&cfg.data_dir);
    store::migrate_from_atlas(&cfg.data_dir);
    let settings = store::get_in(&cfg.data_dir, "settings").unwrap_or_else(|| Value::Object(Default::default()));
    let s = State {
        host,
        data_dir: cfg.data_dir,
        renderer_dir: cfg.renderer_dir,
        res_dir: cfg.res_dir,
        settings: RwLock::new(settings),
        test_mode: cfg.test_mode,
        rt: tokio::runtime::Handle::current(),
        stream_base: RwLock::new(String::new()),
    };
    if STATE.set(s).is_err() {
        return;
    }
    engine::init();
    ops::configure_from_settings();
    // the media server for live video conversion (a page can't stream from a custom scheme)
    tokio::spawn(async {
        if let Ok(base) = server::start_stream_server().await {
            *st().stream_base.write() = base;
        }
    });
    // drives plugged in or out
    sys::start_drive_watch();
    // the instant index starts a moment after the window is up
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        let _ = engine::configure_index(true).await;
    });
}

/// Before quitting: save the index, stop helpers.
pub fn shutdown() {
    engine::shutdown();
    media::kill_all();
    pty::kill_all();
}

pub fn setting_bool(key: &str, default: bool) -> bool {
    st().settings.read().get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}
pub fn setting(key: &str) -> Value {
    st().settings.read().get(key).cloned().unwrap_or(Value::Null)
}

/// A window closed: stop what it was watching and its terminals.
pub fn window_closed(win: &str) {
    watch::unwatch_window(win);
    pty::kill_window(win);
    if win.starts_with("player") {
        media::kill_all();
    }
}
