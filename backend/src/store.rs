// Settings, tags, workspaces… one JSON file each in Dogfile's data folder, written atomically.
use crate::st;
use serde_json::Value;
use std::path::Path;

pub fn get_in(dir: &Path, name: &str) -> Option<Value> {
    // demo mode keeps personal things apart
    let name = crate::demo::store_key(name);
    let f = dir.join(format!("{name}.json"));
    let s = std::fs::read(&f).ok()?;
    match serde_json::from_slice(&s) {
        Ok(v) => Some(v),
        // a damaged file (a crash or power cut mid-write on an old version, a disk error): the last good copy is used
        // instead of quietly starting over with nothing, and the damaged one is kept aside for a look
        Err(e) => {
            let bak = dir.join(format!("{name}.json.bak"));
            let good = std::fs::read(&bak).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
            let aside = dir.join(format!("{name}.json.damaged"));
            let _ = std::fs::copy(&f, &aside);
            crate::errlog(&format!("store: {name}.json couldn't be read ({e}); {}", if good.is_some() { "using the backup" } else { "no backup" }));
            good
        }
    }
}
pub fn get(name: &str) -> Option<Value> {
    get_in(&st().data_dir, name)
}
pub fn set(name: &str, v: &Value) -> Result<(), String> {
    set_in(&st().data_dir, name, v)
}
pub fn set_in(dir: &Path, name: &str, v: &Value) -> Result<(), String> {
    let name = &crate::demo::store_key(name);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let f = dir.join(format!("{name}.json"));
    let tmp = dir.join(format!("{name}.json.tmp"));
    let body = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    {
        use std::io::Write;
        let mut w = std::fs::File::create(&tmp).map_err(|e| crate::fsx::friendly(&e))?;
        w.write_all(&body).map_err(|e| crate::fsx::friendly(&e))?;
        // on disk before it takes the real name, so a power cut never leaves an empty or half-written file
        w.sync_all().map_err(|e| crate::fsx::friendly(&e))?;
    }
    // the previous good copy stays as .bak (read if the main file is ever damaged)
    if f.exists() {
        let _ = std::fs::copy(&f, dir.join(format!("{name}.json.bak")));
    }
    std::fs::rename(&tmp, &f).map_err(|e| crate::fsx::friendly(&e))
}
pub fn get_or(name: &str, d: Value) -> Value {
    get(name).unwrap_or(d)
}

/// Other places this PC may already have Dogfile's data, newest kind first: the regular install's folder, the Store
/// package's own copy of it (Windows keeps a packaged app's AppData apart), a portable copy's "data" folder, and
/// "Atlas Files" (Dogfile's old name). `now` itself is left out.
pub fn other_data_dirs(now: &Path) -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut v: Vec<PathBuf> = Vec::new();
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    if let Some(a) = env("APPDATA") {
        v.push(a.join("Dogfile"));
    }
    if let Some(l) = env("LOCALAPPDATA") {
        // the Store package: %LOCALAPPDATA%\Packages\<…Dogfile…>\LocalCache\Roaming\Dogfile
        if let Ok(rd) = std::fs::read_dir(l.join("Packages")) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().to_lowercase().contains("dogfile") {
                    v.push(e.path().join("LocalCache").join("Roaming").join("Dogfile"));
                }
            }
        }
        v.push(l.join("Programs").join("Dogfile").join("data"));
        v.push(l.join("Dogfile"));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("data"))) {
        v.push(dir);
    }
    if let Some(a) = env("APPDATA") {
        v.push(a.join("Atlas Files"));
    }
    if let Some(p) = now.parent() {
        v.push(p.join("Atlas Files"));
    }
    let same = |a: &Path, b: &Path| a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y);
    let mut out: Vec<PathBuf> = Vec::new();
    for d in v {
        if !same(&d, now) && !out.iter().any(|o| same(o, &d)) && d.is_dir() {
            out.push(d);
        }
    }
    out
}

/// A first start in this data folder, with Dogfile's data somewhere else on the PC (an update that changed the kind
/// of install: Store package, setup program, portable; or the old Atlas Files): bring the settings, tags,
/// workspaces, index and the rest over once, so nothing seems lost. The most recently used copy wins. The AI models
/// are left to `ai::adopt_models` (moved, not copied: they're gigabytes).
pub fn adopt_previous(now: &Path) {
    if now.join("settings.json").exists() {
        return;
    }
    let newest = other_data_dirs(now)
        .into_iter()
        .filter_map(|d| std::fs::metadata(d.join("settings.json")).and_then(|m| m.modified()).ok().map(|t| (t, d)))
        .max_by_key(|(t, _)| *t);
    let Some((_, old)) = newest else { return };
    let _ = std::fs::create_dir_all(now);
    let skip = regex::Regex::new(r"(?i)^(models|Demo|Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|Crashpad|blob_storage|Service Worker|Session Storage|Local Storage|IndexedDB|Shared Dictionary|SharedStorage|Network|EBWebView|logs|.*\.log|.*\.tmp|lockfile|Singleton.*)$").unwrap();
    let mut copied = 0;
    if let Ok(rd) = std::fs::read_dir(&old) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if skip.is_match(&n) {
                continue;
            }
            match crate::util::copy_tree(&e.path(), &now.join(&n)) {
                Ok(()) => copied += 1,
                Err(err) => crate::errlog(&format!("store: couldn't bring {n} over from {}: {err}", old.display())),
            }
        }
    }
    crate::errlog(&format!("store: first start here; brought {copied} items over from {}", old.display()));
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_new_data_folder_takes_over_the_previous_installs_data() {
        let base = std::env::temp_dir().join(format!("dogfile-adopt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let roaming = base.join("Roaming");
        // the old install: settings, tags, a model (left where it is: models are moved by ai::adopt_models)
        let old = roaming.join("Dogfile");
        std::fs::create_dir_all(old.join("models").join("unsloth")).unwrap();
        std::fs::write(old.join("settings.json"), br#"{"language":"de","welcomed":true}"#).unwrap();
        std::fs::write(old.join("tags.json"), br#"{"a":["red"]}"#).unwrap();
        std::fs::write(old.join("models").join("unsloth").join("big.gguf"), b"x").unwrap();
        // SAFETY: only this test reads APPDATA
        unsafe { std::env::set_var("APPDATA", &roaming) };
        // the new install's folder (say, the Store package's)
        let now = base.join("Packages").join("Dogfile").join("LocalCache").join("Roaming").join("Dogfile");
        super::adopt_previous(&now);
        assert!(std::fs::read_to_string(now.join("settings.json")).unwrap().contains("\"de\""));
        assert!(now.join("tags.json").exists());
        assert!(!now.join("models").exists(), "models aren't copied");
        // a folder that already has settings is never overwritten
        std::fs::write(now.join("settings.json"), br#"{"language":"fr"}"#).unwrap();
        super::adopt_previous(&now);
        assert!(std::fs::read_to_string(now.join("settings.json")).unwrap().contains("\"fr\""));
        std::fs::remove_dir_all(&base).ok();
    }
}
