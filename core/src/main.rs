// dogfile-core as a separate program (also the elevated helper that builds the index from the NTFS file table).
use dogfile_core::{dispatch, index, init_threads};
use serde_json::Value;
use std::io::BufRead;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    init_threads();
    if args.get(1).map(|s| s.as_str()) == Some("--build-index") && args.len() >= 4 {
        std::process::exit(index::build_cli(&args[2], &args[3]));
    }
    if args.get(1).map(|s| s.as_str()) == Some("--version") {
        println!("dogfile-core {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let id = msg["id"].as_u64().unwrap_or(0);
        let cmd = msg["cmd"].as_str().unwrap_or("").to_string();
        dispatch(id, cmd, msg["args"].clone());
    }
    // Dogfile closed our input: save and leave
    index::save_all();
}
