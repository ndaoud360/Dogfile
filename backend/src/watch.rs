// Folder and file watchers: open folders refresh by themselves, automations see new files, Notepad sees outside
// edits, and a file opened from inside an archive goes back in when it's saved.
use crate::args::{Args, R};
use crate::{events, st};
use notify::{RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Runs `f` once, `ms` after the last trigger.
#[derive(Clone)]
pub struct Debounce {
    seq: Arc<AtomicU64>,
    ms: u64,
    f: Arc<dyn Fn() + Send + Sync>,
}
impl Debounce {
    pub fn new(ms: u64, f: impl Fn() + Send + Sync + 'static) -> Self {
        Debounce { seq: Arc::new(AtomicU64::new(0)), ms, f: Arc::new(f) }
    }
    pub fn trigger(&self) {
        let g = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let me = self.clone();
        st().rt.spawn(async move {
            tokio::time::sleep(Duration::from_millis(me.ms)).await;
            if me.seq.load(Ordering::SeqCst) == g {
                (me.f)();
            }
        });
    }
}

type W = notify::RecommendedWatcher;
fn make(path: &str, ms: u64, f: impl Fn() + Send + Sync + 'static) -> Option<W> {
    let d = Debounce::new(ms, f);
    let mut w = notify::recommended_watcher(move |r: notify::Result<notify::Event>| {
        if let Ok(e) = r {
            if !matches!(e.kind, notify::EventKind::Access(_)) {
                d.trigger();
            }
        }
    })
    .ok()?;
    w.watch(std::path::Path::new(path), RecursiveMode::NonRecursive).ok()?;
    Some(w)
}

fn folder_watchers() -> &'static Mutex<HashMap<String, W>> {
    static M: OnceLock<Mutex<HashMap<String, W>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}
/// watch:set(key, dir): one watcher per pane of a window
pub fn watch_set(win: &str, a: &Args) -> R {
    let key = a.s_or(0, "");
    let dir = a.os(1).unwrap_or_default();
    let k = format!("{win}:{key}");
    folder_watchers().lock().remove(&k);
    if dir.is_empty() || dir.starts_with("atlas:") {
        return Ok(json!(false));
    }
    let (w, key2, dir2) = (win.to_string(), key.clone(), dir.clone());
    match make(&dir, 250, move || events::emit(&w, "watch:changed", json!({ "key": key2, "dir": dir2 }))) {
        Some(watcher) => {
            folder_watchers().lock().insert(k, watcher);
            Ok(json!(true))
        }
        None => Ok(json!(false)),
    }
}
/// a window closed: drop its watchers
pub fn unwatch_window(win: &str) {
    let pre = format!("{win}:");
    folder_watchers().lock().retain(|k, _| !k.starts_with(&pre));
    file_watchers().lock().retain(|k, _| !k.starts_with(&pre));
}

fn rule_watchers() -> &'static Mutex<HashMap<String, W>> {
    static M: OnceLock<Mutex<HashMap<String, W>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}
/// rules:watch(dirs): folders with automations
pub fn rules_watch(win: &str, a: &Args) -> R {
    let want: Vec<String> = a.strs(0).into_iter().filter(|d| !d.is_empty() && !d.starts_with("atlas:")).collect();
    let mut m = rule_watchers().lock();
    m.retain(|d, _| want.contains(d));
    for d in &want {
        if m.contains_key(d) {
            continue;
        }
        let (w, dd) = (win.to_string(), d.clone());
        if let Some(watcher) = make(d, 600, move || events::emit(&w, "rules:changed", json!({ "dir": dd }))) {
            m.insert(d.clone(), watcher);
        }
    }
    Ok(json!(m.keys().cloned().collect::<Vec<_>>()))
}

fn file_watchers() -> &'static Mutex<HashMap<String, W>> {
    static M: OnceLock<Mutex<HashMap<String, W>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}
/// fs:watchFile(path, on): Notepad notices when a file changes on disk
pub fn watch_file(win: &str, a: &Args) -> R {
    let p = a.s(0)?;
    let on = a.b(1);
    let k = format!("{win}:{p}");
    file_watchers().lock().remove(&k);
    if !on {
        return Ok(json!(true));
    }
    // watch the folder (editors save by replacing the file) and filter for this file
    let dir = crate::util::dirname(&p);
    let name = crate::util::basename(&p);
    let (w, pp) = (win.to_string(), p.clone());
    let d = Debounce::new(300, move || events::emit(&w, "file:changed", json!(pp)));
    let watcher = notify::recommended_watcher(move |r: notify::Result<notify::Event>| {
        if let Ok(e) = r {
            if matches!(e.kind, notify::EventKind::Access(_)) {
                return;
            }
            if e.paths.iter().any(|x| x.file_name().map(|n| n.to_string_lossy() == name).unwrap_or(false)) {
                d.trigger();
            }
        }
    });
    if let Ok(mut watcher) = watcher {
        if watcher.watch(std::path::Path::new(&dir), RecursiveMode::NonRecursive).is_ok() {
            file_watchers().lock().insert(k, watcher);
        }
    }
    Ok(json!(true))
}

/// archive:watchEdit(file, archive, inner): a file opened from an archive goes back in when saved
pub fn archive_watch_edit(win: &str, a: &Args) -> R {
    static EDITS: OnceLock<Mutex<HashMap<String, ()>>> = OnceLock::new();
    let edits = EDITS.get_or_init(|| Mutex::new(HashMap::new()));
    let file = a.s(0)?;
    let arc = a.s(1)?;
    let inner = a.s_or(2, "");
    if edits.lock().contains_key(&file) {
        return Ok(json!(true));
    }
    let Ok(md) = std::fs::metadata(&file) else { return Ok(json!(false)) };
    edits.lock().insert(file.clone(), ());
    let w = win.to_string();
    let mut last = crate::util::ms(md.modified());
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            let Ok(md) = std::fs::metadata(&file) else { continue };
            let m = crate::util::ms(md.modified());
            if m == last {
                continue;
            }
            // wait until the saving program is done writing
            tokio::time::sleep(Duration::from_millis(700)).await;
            last = std::fs::metadata(&file).map(|m| crate::util::ms(m.modified())).unwrap_or(m);
            let title = format!("Updating {} in {}", crate::util::basename(&file), crate::util::basename(&arc));
            let id = crate::ops::start(json!({ "type": "archiveAdd", "sources": [file], "dest": arc, "opts": { "inner": inner }, "title": title }));
            events::emit(&w, "archive:updated", json!({ "file": file, "arc": arc, "id": id }));
        }
    });
    Ok(json!(true))
}

pub fn unused(_: Value) {}
