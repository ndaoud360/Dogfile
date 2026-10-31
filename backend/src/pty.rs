// The terminal drawer: a real console (ConPTY on Windows) for PowerShell, cmd or the Unix shell.
use crate::args::{Args, R};
use crate::events;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

struct Term {
    win: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}
fn terms() -> &'static Mutex<HashMap<u64, Term>> {
    static T: OnceLock<Mutex<HashMap<u64, Term>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}
static SEQ: AtomicU64 = AtomicU64::new(1);

pub fn available() -> R {
    Ok(json!(true))
}
pub fn spawn(win: &str, a: &Args) -> R {
    let o = a.v(0);
    let kind = o["shell"].as_str().unwrap_or("powershell").to_string();
    let cols = o["cols"].as_u64().unwrap_or(100).max(2) as u16;
    let rows = o["rows"].as_u64().unwrap_or(24).max(2) as u16;
    let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| format!("Terminal component is not available: {e}"))?;
    let mut cmd;
    if cfg!(windows) {
        if kind == "cmd" {
            cmd = CommandBuilder::new("cmd.exe");
            cmd.args(["/K", "prompt $e]9;9;\"$P\"$e\\$P$G"]);
        } else {
            let exe = if kind == "pwsh" && crate::util::which("pwsh.exe").is_some() { "pwsh.exe" } else { "powershell.exe" };
            cmd = CommandBuilder::new(exe);
            cmd.args(["-NoLogo", "-NoExit", "-Command", "function prompt { $e=[char]27; $p=$PWD.ProviderPath; \"$e]9;9;`\"$p`\"$([char]7)PS $p> \" }"]);
        }
    } else {
        cmd = CommandBuilder::new(std::env::var("SHELL").unwrap_or("/bin/bash".into()));
        cmd.env("PROMPT_COMMAND", "printf \"\\033]9;9;\\\"%s\\\"\\007\" \"$PWD\"");
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let cwd = o["cwd"].as_str().filter(|d| std::path::Path::new(d).is_dir()).map(String::from).unwrap_or_else(crate::sys::home);
    cmd.cwd(cwd);
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let id = SEQ.fetch_add(1, Ordering::SeqCst);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    terms().lock().insert(id, Term { win: win.to_string(), master: pair.master, writer, killer });
    let w = win.to_string();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 16384];
        let mut carry: Vec<u8> = vec![];
        loop {
            let n = match reader.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => n };
            carry.extend_from_slice(&buf[..n]);
            // send whole characters only
            let cut = match std::str::from_utf8(&carry) { Ok(_) => carry.len(), Err(e) => if e.error_len().is_none() { e.valid_up_to() } else { carry.len() } };
            if cut == 0 { continue }
            let text = String::from_utf8_lossy(&carry[..cut]).into_owned();
            carry.drain(..cut);
            events::emit(&w, "pty:data", json!({ "id": id, "d": text }));
        }
    });
    let w2 = win.to_string();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(0);
        terms().lock().remove(&id);
        events::emit(&w2, "pty:exit", json!({ "id": id, "exitCode": code }));
    });
    Ok(json!({ "id": id, "shell": kind }))
}
pub fn write(a: &Args) -> R {
    let id = a.u(0, 0);
    let d = a.s_or(1, "");
    if let Some(t) = terms().lock().get_mut(&id) {
        let _ = t.writer.write_all(d.as_bytes());
        let _ = t.writer.flush();
    }
    Ok(json!(true))
}
pub fn resize(a: &Args) -> R {
    let id = a.u(0, 0);
    let (cols, rows) = (a.u(1, 80).max(2) as u16, a.u(2, 24).max(2) as u16);
    if let Some(t) = terms().lock().get(&id) {
        let _ = t.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
    Ok(json!(true))
}
pub fn kill(a: &Args) -> R {
    if let Some(mut t) = terms().lock().remove(&a.u(0, 0)) {
        let _ = t.killer.kill();
    }
    Ok(json!(true))
}
pub fn kill_window(win: &str) {
    let mut m = terms().lock();
    let ids: Vec<u64> = m.iter().filter(|(_, t)| t.win == win).map(|(k, _)| *k).collect();
    for id in ids {
        if let Some(mut t) = m.remove(&id) {
            let _ = t.killer.kill();
        }
    }
}
pub fn kill_all() {
    for (_, mut t) in terms().lock().drain() {
        let _ = t.killer.kill();
    }
}
pub fn unused(_: Value) {}
