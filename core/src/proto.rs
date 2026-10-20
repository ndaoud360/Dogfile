// Talking to Dogfile: one JSON object per line on stdin (requests) and stdout (replies and events).
//   in:  {"id": 7, "cmd": "search", "args": {...}}
//   out: {"id": 7, "type": "results" | "progress" | "done" | "error", ...}
// Every request runs on its own thread; "cancel" stops a running one.
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

fn out() -> &'static Mutex<std::io::Stdout> {
    static OUT: OnceLock<Mutex<std::io::Stdout>> = OnceLock::new();
    OUT.get_or_init(|| Mutex::new(std::io::stdout()))
}

/// Send one message for request `id`. `body` must be a JSON object; `type` is added.
pub fn send(id: u64, kind: &str, body: Value) {
    let mut m = match body {
        Value::Object(m) => m,
        Value::Null => Map::new(),
        other => {
            let mut m = Map::new();
            m.insert("result".into(), other);
            m
        }
    };
    m.insert("id".into(), json!(id));
    m.insert("type".into(), json!(kind));
    let line = serde_json::to_string(&Value::Object(m)).unwrap_or_else(|_| "{}".into());
    let lock = out().lock();
    if let Ok(mut o) = lock {
        let _ = o.write_all(line.as_bytes());
        let _ = o.write_all(b"\n");
        let _ = o.flush();
    }
}
/// An event not tied to a request (index status changes…): id 0.
pub fn event(kind: &str, body: Value) {
    send(0, kind, body)
}

fn cancels() -> &'static Mutex<HashMap<u64, Arc<AtomicBool>>> {
    static C: OnceLock<Mutex<HashMap<u64, Arc<AtomicBool>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn register(id: u64) -> Arc<AtomicBool> {
    let f = Arc::new(AtomicBool::new(false));
    cancels().lock().unwrap().insert(id, f.clone());
    f
}
pub fn unregister(id: u64) {
    cancels().lock().unwrap().remove(&id);
}
pub fn cancel(id: u64) -> bool {
    if let Some(f) = cancels().lock().unwrap().get(&id) {
        f.store(true, Ordering::Relaxed);
        true
    } else {
        false
    }
}

/// Throttled batches of results: flushes every 200 items or 200 ms, like the old Node worker.
pub struct Batcher {
    id: u64,
    inner: Mutex<(Vec<Value>, std::time::Instant, u64)>,
}
impl Batcher {
    pub fn new(id: u64) -> Self {
        Batcher { id, inner: Mutex::new((Vec::new(), std::time::Instant::now(), 0)) }
    }
    pub fn push(&self, v: Value, scanned: u64) {
        let mut g = self.inner.lock().unwrap();
        g.0.push(v);
        g.2 = scanned;
        if g.0.len() >= 200 || g.1.elapsed().as_millis() >= 200 {
            let items = std::mem::take(&mut g.0);
            g.1 = std::time::Instant::now();
            drop(g);
            send(self.id, "results", json!({ "items": items, "scanned": scanned }));
        }
    }
    pub fn tick(&self, scanned: u64) {
        let mut g = self.inner.lock().unwrap();
        g.2 = scanned;
        if g.1.elapsed().as_millis() >= 250 {
            let items = std::mem::take(&mut g.0);
            g.1 = std::time::Instant::now();
            drop(g);
            send(self.id, "results", json!({ "items": items, "scanned": scanned }));
        }
    }
    pub fn flush(&self, scanned: u64) {
        let mut g = self.inner.lock().unwrap();
        let items = std::mem::take(&mut g.0);
        g.1 = std::time::Instant::now();
        drop(g);
        send(self.id, "results", json!({ "items": items, "scanned": scanned }));
    }
}

/// Rate-limited progress messages.
pub struct Progress {
    id: u64,
    last: Mutex<std::time::Instant>,
    every_ms: u128,
}
impl Progress {
    pub fn new(id: u64, every_ms: u128) -> Self {
        Progress { id, last: Mutex::new(std::time::Instant::now()), every_ms }
    }
    pub fn due(&self) -> bool {
        let mut l = self.last.lock().unwrap();
        if l.elapsed().as_millis() >= self.every_ms {
            *l = std::time::Instant::now();
            true
        } else {
            false
        }
    }
    pub fn send(&self, body: Value) {
        send(self.id, "progress", body)
    }
}
