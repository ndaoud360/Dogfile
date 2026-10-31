// The native engine (dogfile-core) runs inside the app: the instant index, folder listings, searches, folder
// sizes, duplicates, storage inventory and checksums. Its replies arrive through a sink and are routed here.
use crate::args::{Args, R};
use crate::events;
use crate::{setting, setting_bool, st};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

type Handler = Box<dyn Fn(Value) + Send + Sync>;
fn pending() -> &'static Mutex<HashMap<u64, Handler>> {
    static P: OnceLock<Mutex<HashMap<u64, Handler>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}
static SEQ: AtomicU64 = AtomicU64::new(1);

pub fn init() {
    dogfile_core::init_threads();
    dogfile_core::proto::set_sink(|m: Value| {
        let id = m["id"].as_u64().unwrap_or(0);
        if id == 0 {
            if m["type"] == "index" {
                events::broadcast("index:status", m);
            }
            return;
        }
        let kind = m["type"].as_str().unwrap_or("").to_string();
        let fin = kind == "done" || kind == "error";
        let h = if fin { pending().lock().remove(&id) } else { None };
        if let Some(h) = h {
            h(m);
            return;
        }
        if let Some(h) = pending().lock().get(&id) {
            h(m);
        }
    });
}

/// Start a request; every message (results / progress / done / error) goes to `on`. Returns the engine's id.
pub fn send(cmd: &str, args: Value, on: impl Fn(Value) + Send + Sync + 'static) -> u64 {
    let id = SEQ.fetch_add(1, Ordering::Relaxed);
    pending().lock().insert(id, Box::new(on));
    dogfile_core::dispatch(id, cmd.to_string(), args);
    id
}
/// A request with a single answer.
pub async fn request(cmd: &str, args: Value) -> Result<Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Value, String>>();
    let tx = Mutex::new(Some(tx));
    send(cmd, args, move |m| {
        let kind = m["type"].as_str().unwrap_or("");
        if kind == "done" || kind == "error" {
            if let Some(t) = tx.lock().take() {
                let _ = t.send(if kind == "done" { Ok(m) } else { Err(m["error"].as_str().unwrap_or("error").to_string()) });
            }
        }
    });
    rx.await.map_err(|_| "The engine stopped".to_string())?
}
pub fn cancel(id: u64) {
    dogfile_core::proto::cancel(id);
}

// ---------------- background jobs for the window: work:start / work:cancel ----------------
fn jobs() -> &'static Mutex<HashMap<String, u64>> {
    static J: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn work_start(win: &str, a: &Args) -> R {
    let mut spec = a.v(0);
    let kind = spec["type"].as_str().unwrap_or("").to_string();
    let id = crate::util::uuid();
    let w = win.to_string();
    let wid = id.clone();
    let relay = move |mut m: Value| {
        let fin = m["type"] == "done" || m["type"] == "error";
        m["id"] = json!(wid);
        events::emit(&w, "work:msg", m);
        if fin {
            jobs().lock().remove(&wid);
        }
    };
    // a search the instant index can answer: the whole result in one go
    if kind == "search" && setting_bool("indexEnabled", true) {
        let mut q = spec.clone();
        q["limit"] = json!(spec["maxResults"].as_u64().unwrap_or(20000));
        if let Ok(r) = request("index.search", q).await {
            let items = r["items"].clone();
            let total = r["total"].clone();
            let ms = r["ms"].clone();
            tokio::spawn(async move {
                relay(json!({ "type": "results", "items": items, "scanned": total }));
                relay(json!({ "type": "done", "scanned": total, "indexed": true, "total": total, "ms": ms }));
            });
            return Ok(json!(id));
        }
    }
    if !matches!(kind.as_str(), "search" | "size" | "dupes" | "inventory" | "hashfiles") {
        return Err(format!("Unknown job {kind}"));
    }
    if spec.get("type").is_none() {
        spec["type"] = json!(kind);
    }
    let cid = send(&kind, spec, relay);
    jobs().lock().insert(id.clone(), cid);
    Ok(json!(id))
}
pub fn work_cancel(a: &Args) -> R {
    let id = a.s(0)?;
    if let Some(c) = jobs().lock().remove(&id) {
        cancel(c);
    }
    Ok(json!(true))
}

// ---------------- the instant index ----------------
pub async fn index_roots() -> Vec<String> {
    if !setting_bool("indexEnabled", true) {
        return vec![];
    }
    let r = crate::args::strs(&setting("indexRoots"));
    if !r.is_empty() {
        return r;
    }
    let drives = crate::sys::list_drives_raw().await;
    let fixed: Vec<String> = drives.iter().filter(|d| d["type"] == "fixed").filter_map(|d| d["path"].as_str().map(String::from)).collect();
    if cfg!(windows) {
        fixed
    } else {
        vec![dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or("/".into())]
    }
}
pub async fn configure_index(rescan: bool) -> R {
    let roots = index_roots().await;
    let data = st().data_dir.join("Index");
    request("index.configure", json!({ "roots": roots, "dataDir": data.to_string_lossy(), "rescan": rescan, "mft": setting_bool("indexMft", true), "system": setting_bool("indexSystem", false) })).await
}
pub async fn index_status() -> R {
    // demo mode: the index (your real files) rests; searches walk the demo folders
    if crate::demo::active() {
        return Ok(json!({ "available": false, "demo": true }));
    }
    let s = request("index.status", json!({})).await?;
    Ok(json!({ "available": true, "admin": dogfile_core::is_admin(), "roots": s["roots"] }))
}
pub async fn index_refresh(a: &Args) -> R {
    request("index.refresh", json!({ "root": a.s_or(0, ""), "mft": setting_bool("indexMft", true) })).await
}
pub async fn index_search(a: &Args) -> R {
    if crate::demo::active() {
        return Err("The index is off in demo mode".into());
    }
    let mut q = a.v(0);
    if !q.is_object() {
        q = json!({});
    }
    q["typed"] = json!(true);
    request("index.search", q).await
}
pub async fn index_sizes(a: &Args) -> R {
    if crate::demo::active() {
        return Ok(json!({}));
    }
    if !setting_bool("indexEnabled", true) {
        return Ok(json!({}));
    }
    Ok(request("index.sizes", json!({ "paths": a.v(0) })).await.unwrap_or_else(|_| json!({})))
}
/// One-time fast build from the NTFS file table: needs administrator rights, so this program runs itself
/// elevated with --build-index (Windows asks once), writes the index file and exits; then the index reloads.
pub async fn index_fast_build(a: &Args) -> R {
    if !cfg!(windows) {
        return Ok(json!({ "ok": false, "error": "Only on Windows" }));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let data = st().data_dir.join("Index");
    let mut roots = a.strs(0);
    if roots.is_empty() {
        roots = index_roots().await;
    }
    let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let script = roots
        .iter()
        .map(|r| {
            let r = r.trim_end_matches(['\\', '/']);
            format!("Start-Process -FilePath {} -ArgumentList {} -Verb RunAs -Wait -WindowStyle Hidden", q(&exe.to_string_lossy()), q(&format!("--build-index \"{}\" \"{}\"", r, data.to_string_lossy())))
        })
        .collect::<Vec<_>>()
        .join("; ");
    let out = crate::util::run("powershell.exe", &["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), script], None, 30 * 60 * 1000).await;
    match out {
        Ok(o) if o.ok => {}
        Ok(o) => {
            let e = o.err();
            return Ok(json!({ "ok": false, "error": if e.to_lowercase().contains("cancel") { "Administrator permission was not given".to_string() } else { crate::util::last_line(&e) } }));
        }
        Err(e) => return Ok(json!({ "ok": false, "error": e.to_string() })),
    }
    request("index.reload", json!({})).await?;
    Ok(json!({ "ok": true }))
}
pub async fn core_info() -> R {
    let mut p = request("ping", json!({})).await.unwrap_or_else(|_| json!({}));
    p["available"] = json!(true);
    Ok(p)
}
/// a folder listing with attributes (one call, no shell round trip)
pub async fn list(dir: &str) -> Result<Value, String> {
    request("list", json!({ "path": dir })).await
}

pub fn shutdown() {
    dogfile_core::index::save_all();
}
