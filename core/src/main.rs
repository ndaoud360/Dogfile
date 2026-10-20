// atlas-core: Atlas Files' native engine. Atlas starts it once and talks to it over stdin/stdout (see proto.rs):
// the instant file index, folder listings, searches, folder sizes, duplicates, storage inventory and checksums.
mod index;
mod jobs;
mod matcher;
mod mft;
mod proto;
mod util;
mod walk;

use serde_json::{json, Value};
use std::io::BufRead;

fn handle(id: u64, cmd: &str, args: Value) {
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
        "shutdown" => { index::save_all(); proto::send(id, "done", json!({ "ok": true })); std::process::exit(0) }
        _ => proto::send(id, "error", json!({ "error": format!("unknown command {cmd}") })),
    }
}

#[cfg(windows)]
fn is_admin() -> bool {
    // can we open a drive as a device? (that's what reading the file table needs)
    std::fs::OpenOptions::new().read(true).open("\\\\.\\C:").is_ok()
}
#[cfg(not(windows))]
fn is_admin() -> bool {
    false
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // lower priority helpers for heavy work: leave a core for the interface
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let _ = rayon::ThreadPoolBuilder::new().num_threads(threads.saturating_sub(1).max(2)).build_global();
    if args.get(1).map(|s| s.as_str()) == Some("--build-index") && args.len() >= 4 {
        std::process::exit(index::build_cli(&args[2], &args[3]));
    }
    if args.get(1).map(|s| s.as_str()) == Some("--version") {
        println!("atlas-core {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let id = msg["id"].as_u64().unwrap_or(0);
        let cmd = msg["cmd"].as_str().unwrap_or("").to_string();
        let a = msg["args"].clone();
        // quick answers inline; everything else on its own thread
        if matches!(cmd.as_str(), "ping" | "cancel" | "index.status" | "index.covers") { handle(id, &cmd, a); continue }
        std::thread::spawn(move || handle(id, &cmd, a));
    }
    // Atlas closed our input: save and leave
    index::save_all();
}
