// File & folder versions: copies kept in Dogfile's data folder (never next to your files). Saved by hand, or
// automatically whenever a tracked file changes. Old versions are pruned per file and by total size.
use crate::args::{Args, R};
use crate::util::{self, basename};
use crate::{setting, st};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

fn root() -> PathBuf {
    st().data_dir.join("versions")
}
fn keep() -> usize {
    setting("versionsKeep").as_u64().unwrap_or(20).max(1) as usize
}
fn max_total() -> u64 {
    setting("versionsMaxMB").as_u64().unwrap_or(5000) * 1048576
}
fn id_for(p: &str) -> String {
    use sha1::Digest;
    let h = sha1::Sha1::digest(util::low(p).as_bytes());
    h.iter().map(|b| format!("{b:02x}")).collect::<String>()[..20].to_string()
}
fn dir_for(p: &str) -> PathBuf {
    root().join(id_for(p))
}
fn read_index(p: &str) -> Value {
    std::fs::read(dir_for(p).join("index.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({ "path": p, "versions": [] }))
}
fn write_index(p: &str, idx: &Value) -> Result<(), String> {
    let d = dir_for(p);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    std::fs::write(d.join("index.json"), serde_json::to_vec_pretty(idx).unwrap_or_default()).map_err(|e| e.to_string())
}
fn rm(p: &Path) {
    if p.is_dir() { let _ = std::fs::remove_dir_all(p); } else { let _ = std::fs::remove_file(p); }
}

pub fn save(p: &str, note: &str, auto: bool) -> Result<Value, String> {
    let md = std::fs::metadata(p).map_err(|e| crate::fsx::friendly(&e))?;
    let mut idx = read_index(p);
    let mtime = util::ms(md.modified());
    if auto {
        if let Some(last) = idx["versions"].as_array().and_then(|v| v.last()) {
            if last["mtime"].as_f64() == Some(mtime) && last["size"].as_u64() == Some(md.len()) {
                return Ok(Value::Null); // nothing changed
            }
        }
    }
    let at = util::now_ms() as u64;
    let name = format!("{at}-{}", basename(p));
    let d = dir_for(p);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let dst = d.join(&name);
    util::copy_tree(Path::new(p), &dst).map_err(|e| e.to_string())?;
    let size = if md.is_dir() { util::dir_size(&dst) } else { md.len() };
    let v = json!({ "id": name, "at": at, "note": note, "auto": auto, "size": size, "mtime": mtime, "isDir": md.is_dir() });
    idx["path"] = json!(p);
    let list = idx["versions"].as_array_mut().unwrap();
    list.push(v.clone());
    while list.len() > keep() {
        let old = list.remove(0);
        rm(&d.join(old["id"].as_str().unwrap_or("")));
    }
    write_index(p, &idx)?;
    std::thread::spawn(prune);
    Ok(v)
}
pub async fn save_call(a: &Args) -> R {
    let p = a.s(0)?;
    let note = a.s_or(1, "");
    tokio::task::spawn_blocking(move || save(&p, &note, false)).await.map_err(|e| e.to_string())?
}
pub async fn list(a: &Args) -> R {
    let p = a.s(0)?;
    let idx = read_index(&p);
    let d = dir_for(&p);
    let mut v: Vec<Value> = idx["versions"].as_array().cloned().unwrap_or_default();
    v.reverse();
    for x in v.iter_mut() {
        x["file"] = json!(d.join(x["id"].as_str().unwrap_or("")).to_string_lossy());
    }
    Ok(json!(v))
}
pub async fn restore(a: &Args) -> R {
    let p = a.s(0)?;
    let id = a.s(1)?;
    let as_copy = a.r(2)["asCopy"].as_bool().unwrap_or(false);
    tokio::task::spawn_blocking(move || -> R {
        let src = dir_for(&p).join(&id);
        let md = std::fs::metadata(&src).map_err(|e| e.to_string())?;
        if as_copy {
            let ext = if md.is_dir() { String::new() } else { Path::new(&p).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default() };
            let base = if ext.is_empty() { p.clone() } else { p[..p.len() - ext.len()].to_string() };
            let at: i64 = id.split('-').next().and_then(|x| x.parse().ok()).unwrap_or(0);
            let iso = crate::fsx::iso_ms(at + crate::archive::local_offset_secs() * 1000);
            let stamp = format!("{} {}.{}", &iso[..10], &iso[11..13], &iso[14..16]);
            let out = format!("{base} (version {stamp}){ext}");
            util::copy_tree(&src, Path::new(&out)).map_err(|e| e.to_string())?;
            return Ok(json!(out));
        }
        if Path::new(&p).exists() {
            let _ = save(&p, "Before restoring an older version", true);
        }
        if md.is_dir() {
            let _ = std::fs::remove_dir_all(&p);
        }
        util::copy_tree(&src, Path::new(&p)).map_err(|e| e.to_string())?;
        Ok(json!(p))
    })
    .await
    .map_err(|e| e.to_string())?
}
fn remove_one(p: &str, id: &str) {
    let mut idx = read_index(p);
    if let Some(l) = idx["versions"].as_array_mut() {
        l.retain(|v| v["id"].as_str() != Some(id));
    }
    rm(&dir_for(p).join(id));
    let _ = write_index(p, &idx);
}
pub async fn remove(a: &Args) -> R {
    remove_one(&a.s(0)?, &a.s(1)?);
    Ok(json!(true))
}
fn all_indexes() -> Vec<Value> {
    let Ok(rd) = std::fs::read_dir(root()) else { return vec![] };
    rd.flatten().filter_map(|e| std::fs::read(e.path().join("index.json")).ok()).filter_map(|b| serde_json::from_slice(&b).ok()).collect()
}
pub async fn overview() -> R {
    let mut out: Vec<Value> = all_indexes()
        .into_iter()
        .filter_map(|idx| {
            let v = idx["versions"].as_array()?.clone();
            if v.is_empty() { return None }
            Some(json!({ "path": idx["path"], "count": v.len(), "last": v.last().unwrap()["at"], "size": v.iter().map(|x| x["size"].as_u64().unwrap_or(0)).sum::<u64>() }))
        })
        .collect();
    out.sort_by(|a, b| b["last"].as_u64().cmp(&a["last"].as_u64()));
    Ok(json!(out))
}
/// keep the whole store under the size limit by dropping the oldest versions anywhere
fn prune() {
    let mut all: Vec<(String, Value)> = vec![];
    let mut total = 0u64;
    for idx in all_indexes() {
        let p = idx["path"].as_str().unwrap_or("").to_string();
        for v in idx["versions"].as_array().cloned().unwrap_or_default() {
            total += v["size"].as_u64().unwrap_or(0);
            all.push((p.clone(), v));
        }
    }
    all.sort_by_key(|(_, v)| v["at"].as_u64().unwrap_or(0));
    let max = max_total();
    let mut i = 0;
    while total > max && i < all.len() {
        let (p, v) = &all[i];
        total = total.saturating_sub(v["size"].as_u64().unwrap_or(0));
        remove_one(p, v["id"].as_str().unwrap_or(""));
        i += 1;
    }
}

/// automatic versions for tracked files: checked every few seconds, saved a moment after they change
pub async fn track(a: &Args) -> R {
    static TRACKED: OnceLock<Mutex<HashMap<String, f64>>> = OnceLock::new();
    static STARTED: OnceLock<()> = OnceLock::new();
    let t = TRACKED.get_or_init(|| Mutex::new(HashMap::new()));
    let want = a.strs(0);
    {
        let mut m = t.lock();
        m.retain(|k, _| want.contains(k));
        for p in &want {
            if !m.contains_key(p) {
                let mt = std::fs::metadata(p).map(|md| util::ms(md.modified())).unwrap_or(0.0);
                m.insert(p.clone(), mt);
                let p2 = p.clone();
                std::thread::spawn(move || {
                    if read_index(&p2)["versions"].as_array().map(|v| v.is_empty()).unwrap_or(true) {
                        let _ = save(&p2, "Started tracking", true);
                    }
                });
            }
        }
    }
    if STARTED.set(()).is_ok() {
        tokio::spawn(async move {
            let mut changed_at: HashMap<String, std::time::Instant> = HashMap::new();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                let snapshot: Vec<(String, f64)> = t.lock().iter().map(|(k, v)| (k.clone(), *v)).collect();
                for (p, last) in snapshot {
                    let mt = std::fs::metadata(&p).map(|md| util::ms(md.modified())).unwrap_or(0.0);
                    if mt != 0.0 && mt != last {
                        t.lock().insert(p.clone(), mt);
                        changed_at.insert(p.clone(), std::time::Instant::now());
                    }
                }
                let due: Vec<String> = changed_at.iter().filter(|(_, at)| at.elapsed().as_secs() >= 4).map(|(p, _)| p.clone()).collect();
                for p in due {
                    changed_at.remove(&p);
                    tokio::task::spawn_blocking(move || { let _ = save(&p, "", true); });
                }
            }
        });
    }
    Ok(json!(true))
}
