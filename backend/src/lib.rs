// Dogfile's back end: everything the window asks for (files, copies, search, media, shell…) answered natively.
// The window calls `invoke(name, ...args)`; `dispatch` routes the name to the module that does the work.
// The app (Tauri) and the development server both run this same code; they differ only in the `Host` they
// provide (windows, dialogs, events).
pub mod args;
pub mod license;
#[cfg(feature = "llm")]
pub mod llm;
#[cfg(feature = "llm")]
pub mod llm_server;
#[cfg(not(feature = "llm"))]
#[path = "llm_off.rs"]
pub mod llm;
pub mod uipak;
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
pub mod keywords;
pub mod versions;
pub mod ai;
pub mod imgmeta;
pub mod imgdec;
pub mod netdiscover;
pub mod remote;
pub mod reminders;
pub mod notify;
pub mod cloudapi;
pub mod s3;
pub mod meta;
pub mod model3d;
pub mod phonelink;
pub mod demo;
pub mod bugreport;
pub mod summary;
pub mod links;
pub mod timeline;
pub mod adb;
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
    /// the interface packed into the program (then renderer_dir isn't used)
    pub ui: Option<uipak::Pak>,
    /// bundled tools: ffmpeg/, 7zip/
    pub res_dir: PathBuf,
    pub settings: RwLock<Value>,
    pub test_mode: bool,
    pub rt: tokio::runtime::Handle,
    /// address of the local media server (live video conversion is streamed from there)
    pub stream_base: RwLock<String>,
}

static STATE: OnceLock<State> = OnceLock::new();
pub fn try_st() -> Option<&'static State> {
    STATE.get()
}
pub fn st() -> &'static State {
    STATE.get().expect("backend not started")
}

pub struct Config {
    pub data_dir: PathBuf,
    pub renderer_dir: PathBuf,
    /// the packed interface (app/gen/ui.pak compiled in), served instead of renderer_dir
    pub ui_pak: Option<&'static [u8]>,
    pub res_dir: PathBuf,
    pub test_mode: bool,
}

/// Start the back end. Call once, from inside a tokio runtime. Fails (with a message for the person) only when
/// Dogfile's data folder can't be created or written to, since settings, tags and everything else live there.
pub fn start(cfg: Config, host: Arc<dyn Host>) -> Result<(), String> {
    check_data_dir(&cfg.data_dir)?;
    store::adopt_previous(&cfg.data_dir);
    demo::init(&cfg.data_dir);
    let settings = store::get_in(&cfg.data_dir, "settings").unwrap_or_else(|| Value::Object(Default::default()));
    let s = State {
        host,
        data_dir: cfg.data_dir,
        renderer_dir: cfg.renderer_dir,
        ui: cfg.ui_pak.and_then(uipak::Pak::parse),
        res_dir: cfg.res_dir,
        settings: RwLock::new(settings),
        test_mode: cfg.test_mode,
        rt: tokio::runtime::Handle::current(),
        stream_base: RwLock::new(String::new()),
    };
    if STATE.set(s).is_err() {
        return Ok(());
    }
    engine::init();
    license::start_background();
    // AI models downloaded by another kind of install of Dogfile on this PC are taken over, not downloaded again
    std::thread::spawn(ai::adopt_models);
    // the assistant's model gives its memory back after 10 minutes unused
    tokio::spawn(async {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            llm::idle_check(900);
        }
    });
    ops::configure_from_settings();
    // the media server for live video conversion (a page can't stream from a custom scheme)
    tokio::spawn(async {
        if let Ok(base) = server::start_stream_server().await {
            *st().stream_base.write() = base;
        }
    });
    // drives plugged in or out
    sys::start_drive_watch();
    // Android phones set up over Wi-Fi come back by themselves
    adb::start_watch();
    #[cfg(windows)]
    if !st().test_mode {
        // a default set by an earlier version: folders only, so Control Panel opens again
        win::reg::migrate();
        // "Show in folder" from browsers and other programs comes to Dogfile while it's the default
        win::explorer_watch::start();
    }
    // document reminders: watched folders and the hourly date check
    reminders::start();
    // linked files: who uses what (web pages, music and video projects, playlists…), looked through in the background
    links::start();
    // time travel: what folders looked like before (recorded from now on)
    timeline::start();
    phonelink::autostart();
    // the instant index starts a moment after the window is up
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        let _ = engine::configure_index(true).await;
    });
    Ok(())
}

/// Dogfile's data folder exists and can be written to (a test file is written and removed)
pub fn check_data_dir(dir: &std::path::Path) -> Result<(), String> {
    let why = |e: std::io::Error| format!("Dogfile couldn’t use its data folder:\n{}\n\n{}\n\nCheck that the drive isn’t full or read-only and that you can write to that folder (security software can block it), then start Dogfile again.", dir.display(), fsx::friendly(&e));
    std::fs::create_dir_all(dir).map_err(why)?;
    let probe = dir.join(".write-test");
    std::fs::write(&probe, b"ok").map_err(why)?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// Before quitting: save the index, stop helpers.
pub fn shutdown() {
    timeline::save_recent();
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

/// When the program started (for the startup time Dogfile reports in tests and in About)
static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
pub fn mark_start() {
    let _ = START.set(std::time::Instant::now());
}
pub fn uptime_ms() -> u64 {
    START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64
}

/// Something went wrong that the person may not have seen (a failed save, a damaged file, an error in the window):
/// one line in errors.log in the data folder, which a bug report includes. Line breaks and control characters in
/// the message are flattened so a file name or an error text can't forge extra log lines.
pub fn errlog(msg: &str) {
    let Some(s) = try_st() else { return };
    let clean: String = msg.chars().map(|c| if c == '\n' || c == '\r' { '⏎' } else if c.is_control() { ' ' } else { c }).take(2000).collect();
    let when = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let f = s.data_dir.join("errors.log");
    // kept small: the newest 100 KB or so
    if std::fs::metadata(&f).map(|m| m.len() > 200_000).unwrap_or(false) {
        if let Ok(old) = std::fs::read_to_string(&f) {
            let cut = old.len() - 100_000;
            let at = old[cut..].find('\n').map(|i| cut + i + 1).unwrap_or(cut);
            let at = (at..old.len()).find(|i| old.is_char_boundary(*i)).unwrap_or(old.len());
            let _ = std::fs::write(&f, &old[at..]);
        }
    }
    use std::io::Write;
    if let Ok(mut w) = std::fs::OpenOptions::new().create(true).append(true).open(&f) {
        let _ = writeln!(w, "[{when}] {clean}");
    }
}
/// the end of errors.log (for bug reports)
pub fn recent_errors(max_lines: usize) -> String {
    let Some(s) = try_st() else { return String::new() };
    let t = std::fs::read_to_string(s.data_dir.join("errors.log")).unwrap_or_default();
    let lines: Vec<&str> = t.lines().collect();
    lines[lines.len().saturating_sub(max_lines)..].join("\n")
}

#[cfg(test)]
mod start_tests {
    #[test]
    fn an_unusable_data_folder_stops_startup_with_a_message() {
        let base = std::env::temp_dir().join(format!("dogfile-datadir-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        assert!(super::check_data_dir(&base.join("fine")).is_ok());
        // a file where the folder should be: refused, and the message names the folder
        std::fs::write(base.join("taken"), b"").unwrap();
        let msg = super::check_data_dir(&base.join("taken").join("Dogfile")).unwrap_err();
        assert!(msg.contains("data folder") && msg.contains("taken"), "{msg}");
        std::fs::remove_dir_all(&base).ok();
    }
}
