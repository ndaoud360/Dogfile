// Time travel: what a folder looked like before. Every time Dogfile lists a folder it notes what changed since the
// last look (files added, removed or modified), and once an hour it looks again at the folders you've visited
// recently, so the record fills in while you work. The slider in View > Time travel shows a folder as it was at any
// point since: files that are gone come back as ghosts (Revive brings them back from the Recycle Bin or Versions),
// changed files are marked, and busy folders glow warmer. Recording starts when this version is installed; nothing
// leaves the PC.
use crate::args::{Args, R};
use crate::util;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAX_ITEMS: usize = 20000;
const MAX_SNAPS: usize = 400;
const KEEP_DAYS: f64 = 180.0;

/// name -> (size, mtime, isDir)
type State = HashMap<String, (u64, f64, bool)>;

fn now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}
fn dir_root() -> PathBuf {
    crate::st().data_dir.join(if crate::demo::active() { "Timeline@demo" } else { "Timeline" })
}
fn key(dir: &str) -> String {
    let d = dir.trim_end_matches(['\\', '/']);
    if cfg!(windows) { d.to_lowercase() } else { d.to_string() }
}
fn file_for(dir: &str) -> PathBuf {
    use sha1::Digest;
    let h = sha1::Sha1::digest(key(dir).as_bytes());
    dir_root().join(format!("{}.json", h.iter().take(10).map(|b| format!("{b:02x}")).collect::<String>()))
}
fn entry(name: &str, v: &(u64, f64, bool)) -> Value {
    json!([name, v.0, v.1, v.2])
}
fn parse_entry(e: &Value) -> Option<(String, (u64, f64, bool))> {
    Some((e[0].as_str()?.to_string(), (e[1].as_u64().unwrap_or(0), e[2].as_f64().unwrap_or(0.0), e[3].as_bool().unwrap_or(false))))
}

/// the record of one folder: snapshots, the first one complete and the others as changes
#[derive(Default, Clone)]
struct Record {
    path: String,
    snaps: Vec<Value>,
}
impl Record {
    fn load(dir: &str) -> Record {
        let v: Value = std::fs::read(file_for(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
        Record { path: v["path"].as_str().unwrap_or(dir).to_string(), snaps: v["snaps"].as_array().cloned().unwrap_or_default() }
    }
    fn save(&self) {
        let _ = std::fs::create_dir_all(dir_root());
        let f = file_for(&self.path);
        let tmp = f.with_extension("tmp");
        if std::fs::write(&tmp, serde_json::to_vec(&json!({ "path": self.path, "snaps": self.snaps })).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &f);
        }
    }
    /// the folder at time t (the last snapshot at or before it); None before the first one
    fn state_at(&self, t: f64) -> Option<State> {
        let mut st: Option<State> = None;
        for s in &self.snaps {
            if s["t"].as_f64().unwrap_or(0.0) > t {
                break;
            }
            apply(&mut st, s);
        }
        st
    }
    fn latest(&self) -> Option<State> {
        self.state_at(f64::MAX)
    }
    /// keep it small: old snapshots fold into a complete one
    fn prune(&mut self) {
        let cutoff = now() - KEEP_DAYS * 86400.0;
        let old = self.snaps.iter().filter(|s| s["t"].as_f64().unwrap_or(0.0) < cutoff).count();
        let drop = old.max(self.snaps.len().saturating_sub(MAX_SNAPS));
        if drop == 0 || drop >= self.snaps.len() {
            return;
        }
        let t = self.snaps[drop]["t"].as_f64().unwrap_or(0.0);
        let full = self.state_at(t).unwrap_or_default();
        let mut first = json!({ "t": t, "full": full.iter().map(|(n, v)| entry(n, v)).collect::<Vec<_>>() });
        if let Some(c) = self.snaps[drop].get("c") {
            first["c"] = c.clone();
        }
        self.snaps.drain(..=drop);
        self.snaps.insert(0, first);
    }
}
fn apply(st: &mut Option<State>, s: &Value) {
    if let Some(full) = s["full"].as_array() {
        *st = Some(full.iter().filter_map(parse_entry).collect());
        return;
    }
    let m = st.get_or_insert_with(HashMap::new);
    for n in s["del"].as_array().into_iter().flatten().filter_map(|x| x.as_str()) {
        m.remove(n);
    }
    for (n, v) in s["set"].as_array().into_iter().flatten().filter_map(parse_entry) {
        m.insert(n, v);
    }
}

// the latest state of folders seen lately, so a listing that changed nothing costs a comparison
fn cache() -> &'static Mutex<HashMap<String, (bool, State)>> {
    static C: OnceLock<Mutex<HashMap<String, (bool, State)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}
fn recorded(dir: &str) -> bool {
    !(dir.is_empty() || dir.starts_with("atlas:") || dir.starts_with("\\\\?\\") || dir.contains("://") || crate::demo::active() != dir_in_demo(dir))
}
fn dir_in_demo(dir: &str) -> bool {
    crate::demo::inside(Path::new(dir))
}

/// note a folder's contents (from a listing); writes a snapshot only when something changed
pub fn observe(dir: &str, now_state: State) {
    if !recorded(dir) || now_state.len() > MAX_ITEMS || !crate::setting_bool("timeTravel", true) {
        return;
    }
    let k = format!("{}|{}", crate::demo::active(), key(dir));
    let prev = {
        let c = cache().lock();
        c.get(&k).map(|x| x.1.clone())
    };
    let mut rec: Option<Record> = None;
    let prev = match prev {
        Some(p) => Some(p),
        None => {
            let r = Record::load(dir);
            let l = r.latest();
            rec = Some(r);
            l
        }
    };
    let t = now();
    let snap = match &prev {
        None => json!({ "t": t, "full": now_state.iter().map(|(n, v)| entry(n, v)).collect::<Vec<_>>() }),
        Some(p) => {
            let del: Vec<&String> = p.keys().filter(|n| !now_state.contains_key(*n)).collect();
            // a folder's own date changes with every file inside it: only files count as modified
            let set: Vec<Value> = now_state.iter().filter(|(n, v)| match p.get(*n) { None => true, Some(o) => !v.2 && (o.0 != v.0 || (o.1 - v.1).abs() > 1.0) }).map(|(n, v)| entry(n, v)).collect();
            if del.is_empty() && set.is_empty() {
                cache().lock().insert(k, (true, now_state));
                return;
            }
            json!({ "t": t, "del": del, "set": set, "c": del.len() + set.len() })
        }
    };
    let mut r = rec.unwrap_or_else(|| Record::load(dir));
    r.path = dir.to_string();
    r.snaps.push(snap);
    r.prune();
    r.save();
    let mut c = cache().lock();
    if c.len() > 600 {
        c.clear();
    }
    c.insert(k, (true, now_state));
    drop(c);
    remember_recent(dir);
}
/// from a listing's items
pub fn observe_listing(dir: String, v: &Value) {
    let Some(items) = v["items"].as_array() else { return };
    if items.len() > MAX_ITEMS {
        return;
    }
    let st: State = items.iter().filter_map(|i| Some((i["name"].as_str()?.to_string(), (i["size"].as_u64().unwrap_or(0), i["mtime"].as_f64().unwrap_or(0.0) / if i["mtime"].as_f64().unwrap_or(0.0) > 1e11 { 1000.0 } else { 1.0 }, i["isDir"].as_bool().unwrap_or(false))))).collect();
    std::thread::spawn(move || observe(&dir, st));
}
fn read_state(dir: &str) -> Option<State> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut st = State::new();
    for e in rd.flatten() {
        let Ok(md) = e.metadata() else { continue };
        let mt = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs_f64()).unwrap_or(0.0);
        st.insert(e.file_name().to_string_lossy().into_owned(), (if md.is_dir() { 0 } else { crate::demo::size(&e.path(), md.len()) }, mt, md.is_dir()));
        if st.len() > MAX_ITEMS {
            return None;
        }
    }
    Some(st)
}

// folders visited lately: looked at again every hour
fn recent() -> &'static Mutex<Vec<(String, f64)>> {
    static R: OnceLock<Mutex<Vec<(String, f64)>>> = OnceLock::new();
    R.get_or_init(|| {
        let v = crate::store::get("timeline").unwrap_or(Value::Null);
        Mutex::new(v["recent"].as_array().into_iter().flatten().filter_map(|x| Some((x[0].as_str()?.to_string(), x[1].as_f64()?))).collect())
    })
}
fn remember_recent(dir: &str) {
    // network folders aren't looked at in the background (a server that's away would hold the look-through up)
    if dir.starts_with("\\\\") || dir.starts_with("//") {
        return;
    }
    let mut r = recent().lock();
    r.retain(|x| key(&x.0) != key(dir));
    r.push((dir.to_string(), now()));
    let cutoff = now() - 14.0 * 86400.0;
    r.retain(|x| x.1 > cutoff);
    if r.len() > 200 {
        let n = r.len() - 200;
        r.drain(..n);
    }
}
pub fn start() {
    tokio::spawn(async {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            let dirs: Vec<String> = {
                let r = recent().lock();
                let _ = crate::store::set("timeline", &json!({ "recent": r.iter().map(|x| json!([x.0, x.1])).collect::<Vec<_>>() }));
                r.iter().map(|x| x.0.clone()).collect()
            };
            let _ = tokio::task::spawn_blocking(move || {
                for d in dirs {
                    if let Some(st) = read_state(&d) {
                        observe(&d, st);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(30));
                }
            })
            .await;
        }
    });
}
pub fn save_recent() {
    let r = recent().lock();
    let _ = crate::store::set("timeline", &json!({ "recent": r.iter().map(|x| json!([x.0, x.1])).collect::<Vec<_>>() }));
}

// ---------------------------------------------------------------------------------------------------------------
// the calls the interface makes

/// timeline:points {dir}: when this folder was recorded, and how much changed each time
pub async fn points(a: &Args) -> R {
    let dir = a.s(0)?;
    tokio::task::spawn_blocking(move || {
        // look now, so "now" is up to date
        if let Some(st) = read_state(&dir) {
            observe(&dir, st);
        }
        let r = Record::load(&dir);
        let pts: Vec<Value> = r.snaps.iter().map(|s| json!({ "t": s["t"], "changes": s["c"].as_u64().unwrap_or(0), "first": s.get("full").is_some() })).collect();
        Ok(json!({ "points": pts, "now": now() }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// timeline:at {dir, t}: the folder as it was. Each item says whether it's gone now, changed since, or the same.
pub async fn at(a: &Args) -> R {
    let o = a.v(0);
    let dir = o["dir"].as_str().unwrap_or("").to_string();
    let t = o["t"].as_f64().unwrap_or(0.0);
    tokio::task::spawn_blocking(move || {
        let r = Record::load(&dir);
        let Some(then) = r.state_at(t) else { return Ok(json!({ "items": [], "before": true })) };
        let current = read_state(&dir).unwrap_or_default();
        let items: Vec<Value> = then
            .iter()
            .map(|(n, v)| {
                let path = util::join(&dir, n);
                let nowv = current.get(n);
                let status = match nowv {
                    None => "gone",
                    Some(c) if !v.2 && (c.0 != v.0 || (c.1 - v.1).abs() > 1.0) => "changed",
                    _ => "same",
                };
                json!({ "name": n, "path": path, "isDir": v.2, "size": if v.2 { Value::Null } else { json!(v.0) }, "mtime": v.1 * 1000.0, "tt": status,
                    "nowSize": nowv.map(|c| c.0), "nowMtime": nowv.map(|c| c.1 * 1000.0) })
            })
            .collect();
        let added = current.keys().filter(|n| !then.contains_key(*n)).count();
        let mut items = items;
        // files that are gone: their picture comes from where a copy still is (the Recycle Bin, else a saved version)
        if items.iter().any(|i| i["tt"] == "gone") {
            let bin = recycled_copies();
            for i in items.iter_mut().filter(|i| i["tt"] == "gone" && i["isDir"] != true) {
                let p = i["path"].as_str().unwrap_or("").to_string();
                if let Some(src) = bin.get(&key(&p)).cloned().or_else(|| crate::versions::latest_copy(&p)) {
                    i["thumbSrc"] = json!(src);
                }
            }
        }
        Ok(json!({ "items": items, "addedSince": added }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// original path -> the file's copy in the Recycle Bin
fn recycled_copies() -> HashMap<String, String> {
    let mut m = HashMap::new();
    #[cfg(windows)]
    for r in crate::win::recycle_list() {
        let (Some(from), Some(name), Some(path)) = (r["from"].as_str(), r["name"].as_str(), r["path"].as_str()) else { continue };
        m.insert(key(&util::join(from, name)), path.to_string());
    }
    m
}

/// timeline:heat {dirs}: how busy each folder has been (changes a week over the last 30 days)
pub async fn heat(a: &Args) -> R {
    let dirs = a.strs(0);
    tokio::task::spawn_blocking(move || {
        let cutoff = now() - 30.0 * 86400.0;
        let mut out = serde_json::Map::new();
        for d in dirs.iter().take(2000) {
            if !file_for(d).exists() {
                continue;
            }
            let r = Record::load(d);
            let first = r.snaps.first().and_then(|s| s["t"].as_f64()).unwrap_or(now());
            let n: u64 = r.snaps.iter().filter(|s| s["t"].as_f64().unwrap_or(0.0) >= cutoff).map(|s| s["c"].as_u64().unwrap_or(0)).sum();
            let weeks = ((now() - first.max(cutoff)) / (7.0 * 86400.0)).max(1.0);
            if n > 0 {
                out.insert(d.clone(), json!((n as f64 / weeks * 10.0).round() / 10.0));
            }
        }
        Ok(Value::Object(out))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn st(v: &[(&str, u64, f64)]) -> State {
        v.iter().map(|(n, s, m)| (n.to_string(), (*s, *m, false))).collect()
    }
    #[test]
    fn rebuilds_a_folder_at_any_time() {
        let mut r = Record::default();
        let mut cur: Option<State> = None;
        for (t, s) in [(10.0, st(&[("a", 1, 1.0), ("b", 2, 1.0)])), (20.0, st(&[("a", 5, 9.0), ("b", 2, 1.0), ("c", 3, 9.0)])), (30.0, st(&[("c", 3, 9.0)]))] {
            let snap = match &cur {
                None => json!({ "t": t, "full": s.iter().map(|(n, v)| entry(n, v)).collect::<Vec<_>>() }),
                Some(p) => {
                    let del: Vec<&String> = p.keys().filter(|n| !s.contains_key(*n)).collect();
                    let set: Vec<Value> = s.iter().filter(|(n, v)| p.get(*n) != Some(v)).map(|(n, v)| entry(n, v)).collect();
                    json!({ "t": t, "del": del, "set": set, "c": del.len() + set.len() })
                }
            };
            r.snaps.push(snap);
            cur = Some(s);
        }
        assert!(r.state_at(5.0).is_none());
        assert_eq!(r.state_at(15.0).unwrap(), st(&[("a", 1, 1.0), ("b", 2, 1.0)]));
        assert_eq!(r.state_at(25.0).unwrap(), st(&[("a", 5, 9.0), ("b", 2, 1.0), ("c", 3, 9.0)]));
        assert_eq!(r.latest().unwrap(), st(&[("c", 3, 9.0)]));
    }
}
