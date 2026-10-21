// Settings, tags, workspaces… one JSON file each in Dogfile's data folder, written atomically.
use crate::st;
use serde_json::Value;
use std::path::Path;

pub fn get_in(dir: &Path, name: &str) -> Option<Value> {
    let s = std::fs::read(dir.join(format!("{name}.json"))).ok()?;
    serde_json::from_slice(&s).ok()
}
pub fn get(name: &str) -> Option<Value> {
    get_in(&st().data_dir, name)
}
pub fn set(name: &str, v: &Value) -> Result<(), String> {
    let dir = &st().data_dir;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let f = dir.join(format!("{name}.json"));
    let tmp = dir.join(format!("{name}.json.tmp"));
    let body = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}
pub fn get_or(name: &str, d: Value) -> Value {
    get(name).unwrap_or(d)
}

/// Atlas Files became Dogfile: bring its settings, tags, workspaces, features and index over once.
pub fn migrate_from_atlas(now: &Path) {
    if now.join("settings.json").exists() {
        return;
    }
    let Some(parent) = now.parent() else { return };
    let old = parent.join("Atlas Files");
    if !old.join("settings.json").exists() {
        return;
    }
    let _ = std::fs::create_dir_all(now);
    let skip = regex::Regex::new(r"(?i)^(Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|Crashpad|blob_storage|Service Worker|Session Storage|Local Storage|IndexedDB|Shared Dictionary|SharedStorage|Network|logs|.*\.log|lockfile|Singleton.*)$").unwrap();
    if let Ok(rd) = std::fs::read_dir(&old) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if skip.is_match(&n) {
                continue;
            }
            let _ = crate::util::copy_tree(&e.path(), &now.join(&n));
        }
    }
}
