// Photoshop files with their layers: read them, change what you like (turn layers on and off, edit a layer, crop…) and save
// a PSD that Photoshop opens as it was, with every layer still in it.
// The reading and writing is done by a small helper program (tools/psd/dogfile_psd.py, built into dogfile-psd.exe with
// PyInstaller) that uses psd-tools, which keeps everything it doesn't change (text, smart objects, effects, adjustment
// layers, masks, colour profiles) exactly as it was. Windows installers bundle the helper beside Dogfile; portable
// builds can still fetch the checksum-verified component on first use.
use crate::args::{err, Args, R};
use crate::{components, st, util};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const EXE: &str = "dogfile-psd.exe";
const KEEP_BACKUPS: usize = 5;

/// the helper program: the downloaded part, one next to Dogfile, or (for development) DOGFILE_PSD_HELPER, which can be the
/// built program or dogfile_psd.py
fn helper() -> Option<(PathBuf, Vec<String>)> {
    if let Ok(p) = std::env::var("DOGFILE_PSD_HELPER") {
        let p = PathBuf::from(p);
        if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("py")) {
            let py = util::which("python3").or_else(|| util::which("python")).or_else(|| util::which("py"))?;
            return Some((py, vec![p.to_string_lossy().to_string()]));
        }
        return p.is_file().then_some((p, vec![]));
    }
    // Prefer the helper shipped beside Dogfile (the installer and Store package include it).
    // A verified downloaded copy remains the fallback for portable/update builds that contain
    // only Dogfile.exe.
    if let Some(p) = bundled() {
        return Some((p, vec![]));
    }
    let part = components::psd_dir().join(EXE);
    if components::ready("psd") && part.is_file() {
        return Some((part, vec![]));
    }
    None
}

/// a copy of the helper that ships with this build (next to the program)
pub fn bundled() -> Option<PathBuf> {
    let me = std::env::current_exe().ok()?;
    let dir = me.parent()?;
    [dir.join("psd").join(EXE), dir.join(EXE)].into_iter().find(|p| p.is_file())
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}
// DOGFILE_PSD_CACHE / DOGFILE_PSD_BACKUPS move the working and backup folders (the unit tests run without the app)
fn cache_root() -> PathBuf {
    std::env::var("DOGFILE_PSD_CACHE").map(PathBuf::from).unwrap_or_else(|_| st().data_dir.join("psd-cache"))
}
fn backup_root() -> PathBuf {
    std::env::var("DOGFILE_PSD_BACKUPS").map(PathBuf::from).unwrap_or_else(|_| st().data_dir.join("psd-backups"))
}

/// a fresh folder for one open file's pictures; folders from a day ago are cleared
fn session_dir() -> Result<PathBuf, String> {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let root = cache_root();
    std::fs::create_dir_all(&root).map_err(|e| format!("Couldn’t make a working folder: {e}"))?;
    if let Ok(rd) = std::fs::read_dir(&root) {
        for e in rd.flatten() {
            let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() > 86_400).unwrap_or(false);
            if old {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    let d = root.join(format!("{}-{}", now_ms(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    std::fs::create_dir_all(&d).map_err(|e| format!("Couldn’t make a working folder: {e}"))?;
    Ok(d)
}
/// true when `p` is inside the working folder (so a window can't make the helper read or write anywhere else)
fn in_cache(p: &Path) -> bool {
    let (Ok(a), Ok(b)) = (std::fs::canonicalize(p.parent().unwrap_or(p)), std::fs::canonicalize(cache_root())) else { return false };
    a.starts_with(b)
}

fn is_psd(p: &str) -> bool {
    matches!(Path::new(p).extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref(), Some("psd") | Some("psb"))
}

async fn call(args: Vec<String>, timeout_ms: u64) -> Result<Value, String> {
    let (exe, mut all) = helper().ok_or("NEED_PSD")?;
    all.extend(args);
    let o = util::run(&exe, &all, None, timeout_ms).await.map_err(|e| format!("Couldn’t run the Photoshop helper: {e}"))?;
    let text = String::from_utf8_lossy(&o.stdout).to_string();
    let v: Value = serde_json::from_str(text.trim()).map_err(|_| {
        let e = String::from_utf8_lossy(&o.stderr).trim().chars().take(300).collect::<String>();
        if e.is_empty() { "The Photoshop helper gave no answer".to_string() } else { format!("The Photoshop helper gave no answer: {e}") }
    })?;
    if v["ok"].as_bool() == Some(true) {
        Ok(v)
    } else {
        Err(v["error"].as_str().unwrap_or("The Photoshop helper failed").to_string())
    }
}

/// psd:status → { ready, version? }
pub async fn status(_a: &Args) -> R {
    if helper().is_none() {
        return Ok(json!({ "ready": false }));
    }
    match call(vec!["version".into()], 30_000).await {
        Ok(v) => Ok(json!({ "ready": true, "helper": v["helper"], "psdTools": v["psdTools"] })),
        Err(e) => Ok(json!({ "ready": false, "error": e })),
    }
}

/// psd:open(path) → the layers, with a picture of each, and the flattened picture
pub async fn open(a: &Args) -> R {
    let path = a.s(0)?;
    if !is_psd(&path) || !Path::new(&path).is_file() {
        return Err("That isn’t a Photoshop file".into());
    }
    let dir = session_dir()?;
    let mut v = call(vec!["info".into(), path.clone(), dir.to_string_lossy().to_string()], 600_000).await?;
    // full paths, so the window can load each picture
    if let Some(layers) = v["layers"].as_array_mut() {
        for l in layers {
            if let Some(n) = l["png"].as_str().map(String::from) {
                l["png"] = json!(dir.join(n).to_string_lossy());
            }
        }
    }
    if let Some(n) = v["composite"].as_str().map(String::from) {
        v["composite"] = json!(dir.join(n).to_string_lossy());
    }
    v["dir"] = json!(dir.to_string_lossy());
    v["size"] = json!(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0));
    Ok(v)
}

/// psd:raw(path, id, dir) → one layer's own pixels, for editing
pub async fn raw(a: &Args) -> R {
    let (path, id, dir) = (a.s(0)?, a.u(1, 0), PathBuf::from(a.s(2)?));
    if !is_psd(&path) || !in_cache(&dir.join("x")) {
        return Err("That isn’t a Photoshop file".into());
    }
    let mut v = call(vec!["raw".into(), path, dir.to_string_lossy().to_string(), id.to_string()], 300_000).await?;
    if let Some(n) = v["png"].as_str().map(String::from) {
        v["png"] = json!(dir.join(n).to_string_lossy());
    }
    Ok(v)
}

/// psd:render(path, { hide, show, max }, dir) → the picture as Photoshop would draw it with those layers on or off
pub async fn render(a: &Args) -> R {
    let (path, o, dir) = (a.s(0)?, a.v(1), PathBuf::from(a.s(2)?));
    if !is_psd(&path) || !in_cache(&dir.join("x")) {
        return Err("That isn’t a Photoshop file".into());
    }
    let list = |k: &str| o[k].as_array().map(|v| v.iter().filter_map(|x| x.as_u64()).map(|x| x.to_string()).collect::<Vec<_>>().join(",")).unwrap_or_default();
    let out = dir.join(format!("render-{}.png", now_ms()));
    let mut args = vec!["render".to_string(), path, out.to_string_lossy().to_string(), "--force".into()];
    for (flag, key) in [("--hide", "hide"), ("--show", "show")] {
        let l = list(key);
        if !l.is_empty() {
            args.push(flag.into());
            args.push(l);
        }
    }
    if let Some(m) = o["max"].as_u64() {
        args.push("--max".into());
        args.push(m.to_string());
    }
    let v = call(args, 600_000).await?;
    Ok(json!({ "path": out.to_string_lossy(), "width": v["width"], "height": v["height"] }))
}

/// keep a copy of a file before it is written over (the newest few are kept)
fn back_up(path: &Path) -> Result<PathBuf, String> {
    let root = backup_root();
    std::fs::create_dir_all(&root).map_err(|e| format!("Couldn’t make a backup folder: {e}"))?;
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let ext = path.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "psd".into());
    let dest = root.join(format!("{stem}-{}.{ext}", now_ms()));
    std::fs::copy(path, &dest).map_err(|e| format!("Couldn’t back up the original first, so nothing was changed: {e}"))?;
    let mut mine: Vec<PathBuf> = std::fs::read_dir(&root)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(&format!("{stem}-")))).collect())
        .unwrap_or_default();
    mine.sort();
    while mine.len() > KEEP_BACKUPS {
        let _ = std::fs::remove_file(mine.remove(0));
    }
    Ok(dest)
}

/// psd:save({ src, dest, layers, doc }, dir): write the file. When it overwrites the original, a copy is kept first.
pub async fn save(a: &Args) -> R {
    let (mut spec, dir) = (a.v(0), PathBuf::from(a.s(1)?));
    let (src, dest) = (spec["src"].as_str().unwrap_or("").to_string(), spec["dest"].as_str().unwrap_or("").to_string());
    if !is_psd(&src) || !is_psd(&dest) || !Path::new(&src).is_file() {
        return Err("That isn’t a Photoshop file".into());
    }
    if !in_cache(&dir.join("x")) {
        return Err("Couldn’t find the working folder".into());
    }
    // new pixels are only taken from the working folder
    if let Some(layers) = spec["layers"].as_object_mut() {
        for (_, ch) in layers.iter_mut() {
            if let Some(p) = ch["pixels"].as_str().map(String::from) {
                let abs = if Path::new(&p).is_absolute() { PathBuf::from(&p) } else { dir.join(&p) };
                if !in_cache(&abs) || !abs.is_file() {
                    return Err("An edited layer’s picture is missing".into());
                }
                ch["pixels"] = json!(abs.to_string_lossy());
            }
        }
    }
    let overwrite = std::fs::canonicalize(&src).ok() == std::fs::canonicalize(&dest).ok() && Path::new(&dest).exists();
    let backup = if overwrite { Some(back_up(Path::new(&src))?) } else { None };
    let spec_file = dir.join(format!("save-{}.json", now_ms()));
    std::fs::write(&spec_file, serde_json::to_vec(&spec).map_err(err)?).map_err(|e| format!("Couldn’t write the save request: {e}"))?;
    let r = call(vec!["save".into(), spec_file.to_string_lossy().to_string()], 900_000).await;
    let _ = std::fs::remove_file(&spec_file);
    let v = r?;
    Ok(json!({ "path": v["path"], "layers": v["layers"], "backup": backup.map(|b| b.to_string_lossy().to_string()) }))
}

/// psd:clean(dir): the working folder of a file that was closed
pub fn clean(a: &Args) -> R {
    let dir = PathBuf::from(a.s(0)?);
    if in_cache(&dir.join("x")) && dir != cache_root() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    Ok(json!(true))
}

#[cfg(test)]
mod tests {
    use super::*;

    // the real helper, run through Python (the tests need Python and psd-tools; they are skipped without them)
    fn have_helper() -> bool {
        let py = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/psd/dogfile_psd.py");
        if !py.is_file() || util::which("python3").or_else(|| util::which("python")).is_none() {
            return false;
        }
        unsafe { std::env::set_var("DOGFILE_PSD_HELPER", py) };
        true
    }

    #[test]
    fn only_psd_files_and_the_working_folder_are_allowed() {
        assert!(is_psd("C:\\a\\b.PSD") && is_psd("x.psb") && !is_psd("x.png") && !is_psd("x"));
        let work = std::env::temp_dir().join(format!("dogfile-psdcache-{}", std::process::id()));
        std::fs::create_dir_all(work.join("a")).unwrap();
        unsafe { std::env::set_var("DOGFILE_PSD_CACHE", &work) };
        assert!(in_cache(&work.join("a").join("x")));
        assert!(!in_cache(Path::new("/definitely/not/here/x")));
        assert!(!in_cache(&std::env::temp_dir().join("x")));
        unsafe { std::env::remove_var("DOGFILE_PSD_CACHE") };
        let _ = std::fs::remove_dir_all(&work);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn open_render_edit_and_save_through_the_helper() {
        if !have_helper() {
            return;
        }
        let Ok(sample) = std::env::var("DOGFILE_TEST_PSD") else { return };
        let work = std::env::temp_dir().join(format!("dogfile-psdtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        unsafe {
            std::env::set_var("DOGFILE_PSD_CACHE", work.join("cache"));
            std::env::set_var("DOGFILE_PSD_BACKUPS", work.join("backups"));
        }
        let file = work.join("a.psd");
        std::fs::copy(&sample, &file).unwrap();
        let f = file.to_string_lossy().to_string();
        let o = open(&Args(vec![json!(f)])).await.unwrap();
        let dir = o["dir"].as_str().unwrap().to_string();
        let layers = o["layers"].as_array().unwrap();
        assert!(!layers.is_empty());
        assert!(Path::new(o["composite"].as_str().unwrap()).is_file());
        let first_pixel = layers.iter().find(|l| l["kind"] == "pixel").unwrap();
        let id = first_pixel["id"].as_u64().unwrap();
        assert!(Path::new(first_pixel["png"].as_str().unwrap()).is_file());
        // a layer's own pixels for editing, and the picture with that layer hidden
        let r = raw(&Args(vec![json!(f), json!(id), json!(dir)])).await.unwrap();
        assert!(Path::new(r["png"].as_str().unwrap()).is_file());
        let rd = render(&Args(vec![json!(f), json!({ "hide": [id], "max": 400 }), json!(dir)])).await.unwrap();
        assert!(Path::new(rd["path"].as_str().unwrap()).is_file());
        // save: hide that layer and keep the original (a copy, then overwrite)
        let copy = work.join("a (edited).psd").to_string_lossy().to_string();
        let s = save(&Args(vec![json!({ "src": f, "dest": copy, "layers": { id.to_string(): { "visible": false } } }), json!(dir)])).await.unwrap();
        assert!(s["backup"].is_null());
        let o2 = open(&Args(vec![json!(copy)])).await.unwrap();
        assert_eq!(o2["layers"][id as usize]["visible"], false);
        let s = save(&Args(vec![json!({ "src": f, "dest": f, "layers": { id.to_string(): { "opacity": 100 } } }), json!(dir)])).await.unwrap();
        assert!(Path::new(s["backup"].as_str().unwrap()).is_file());
        // a picture from outside the working folder is refused
        let bad = save(&Args(vec![json!({ "src": f, "dest": copy, "layers": { id.to_string(): { "pixels": "C:\\Windows\\x.png" } } }), json!(dir)])).await;
        assert!(bad.is_err());
        clean(&Args(vec![json!(dir)])).unwrap();
        assert!(!Path::new(&dir).exists());
        let _ = std::fs::remove_dir_all(&work);
    }
}
