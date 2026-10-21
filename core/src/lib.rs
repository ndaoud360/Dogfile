// dogfile-core: Dogfile's native engine. Used inside the app as a library (replies go to a sink set with
// proto::set_sink), or as a separate program that talks JSON lines over stdin/stdout (see proto.rs):
// the instant file index, folder listings, searches, folder sizes, duplicates, storage inventory and checksums.
pub mod index;
pub mod jobs;
pub mod matcher;
pub mod mft;
pub mod proto;
pub mod util;
pub mod walk;

use serde_json::{json, Value};
use std::io::BufRead;

pub fn handle(id: u64, cmd: &str, args: Value) {
    match cmd {
        "ping" => proto::send(id, "done", json!({ "version": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS, "threads": rayon::current_num_threads(), "admin": is_admin() })),
        "cancel" => { let ok = proto::cancel(args["target"].as_u64().unwrap_or(0)); proto::send(id, "done", json!({ "ok": ok })) }
        "list" => match jobs::list(&args) {
            Ok(v) => proto::send(id, "done", v),
            Err(e) => proto::send(id, "error", json!({ "error": e })),
        },
        "search" | "size" | "dupes" | "inventory" | "hashfiles" => jobs::run(id, cmd, args),
        "index.configure" => proto::send(id, "done", index::configure(&args)),
        "index.status" => proto::send(id, "done", index::status()),
        "index.search" => match index::search(&args) {
            Ok(v) => proto::send(id, "done", v),
            Err(e) => proto::send(id, "error", json!({ "error": e })),
        },
        "index.covers" => proto::send(id, "done", json!({ "ok": index::covers(args["path"].as_str().unwrap_or("")) })),
        "index.sizes" => proto::send(id, "done", index::sizes(&args)),
        "index.refresh" => proto::send(id, "done", index::refresh(&args)),
        "index.reload" => proto::send(id, "done", index::reload(&args)),
        "index.save" => { index::save_all(); proto::send(id, "done", json!({ "ok": true })) }
        "shutdown" => { index::save_all(); proto::send(id, "done", json!({ "ok": true })); if proto::has_sink() { } else { std::process::exit(0) } }
        _ => proto::send(id, "error", json!({ "error": format!("unknown command {cmd}") })),
    }
}

#[cfg(windows)]
pub fn is_admin() -> bool {
    // can we open a drive as a device? (that's what reading the file table needs)
    std::fs::OpenOptions::new().read(true).open("\\\\.\\C:").is_ok()
}
#[cfg(not(windows))]
pub fn is_admin() -> bool {
    false
}


/// Quick commands answer inline; everything else gets its own thread (same rules as the stdin loop).
pub fn dispatch(id: u64, cmd: String, args: serde_json::Value) {
    if matches!(cmd.as_str(), "ping" | "cancel" | "index.status" | "index.covers") { handle(id, &cmd, args); return }
    std::thread::spawn(move || handle(id, &cmd, args));
}

/// Leave one core for the interface; call once at start.
pub fn init_threads() {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let _ = rayon::ThreadPoolBuilder::new().num_threads(threads.saturating_sub(1).max(2)).build_global();
}
