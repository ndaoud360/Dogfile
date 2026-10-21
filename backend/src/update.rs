// Updates: Dogfile checks a small file (latest.json) on its public GitHub Releases page, downloads the new
// version's packages, checks them, unpacks them next to the running copy and, on Windows, swaps them in with a
// little script that waits for Dogfile to close and starts it again.
//
// latest.json:
// {
//   "version": "2.0.1", "date": "2026-10-22",
//   "notes": "Markdown-ish changelog: lines starting with \"- \" are bullets, \"# \" are headings",
//   "packages": [
//     { "id": "app", "version": "2.0.1", "url": "https://github.com/…/Dogfile-2.0.1-app.zip", "sha256": "…", "size": 12345 },
//     { "id": "ffmpeg", "version": "7.1", "url": "…", "sha256": "…", "size": 89000000 }
//   ]
// }
// A package is downloaded only when its version differs from the one installed (components.json beside the exe),
// so most updates are just the app (about 20 MB) and the video tools come only when they change.
use crate::args::{Args, R};
use crate::{events, setting, util};
#[cfg(windows)]
use crate::st;
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

pub const DEFAULT_URL: &str = "https://github.com/ndaoud360/dogfile-updates/releases/latest/download/latest.json";

fn manifest_url() -> String {
    if let Ok(u) = std::env::var("DOGFILE_UPDATE_URL") {
        return u;
    }
    setting("updateUrl").as_str().filter(|s| s.starts_with("https://") || s.starts_with("http://127.0.0.1")).map(String::from).unwrap_or_else(|| DEFAULT_URL.to_string())
}
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
fn install_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())).unwrap_or_default()
}
fn work_dir() -> PathBuf {
    std::env::temp_dir().join("dogfile-update")
}

/// "2.0.10" > "2.0.9"; anything after a dash (2.1.0-beta) sorts before the plain version
pub fn newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> (Vec<u64>, bool) {
        let v = v.trim().trim_start_matches(['v', 'V']);
        let (main, pre) = v.split_once('-').map(|(m, p)| (m, !p.is_empty())).unwrap_or((v, false));
        (main.split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect(), pre)
    };
    let (mut x, xp) = parse(a);
    let (mut y, yp) = parse(b);
    let n = x.len().max(y.len());
    x.resize(n, 0);
    y.resize(n, 0);
    if x != y {
        return x > y;
    }
    !xp && yp
}

/// versions of the installed parts: {"app": "2.0.0", "ffmpeg": "7.1"}
fn components() -> Value {
    let f = install_dir().join("components.json");
    let mut v: Value = std::fs::read(&f).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({}));
    if !v.is_object() {
        v = json!({});
    }
    v["app"] = json!(current_version());
    v
}

struct Last {
    manifest: Option<Value>,
    checked: f64,
    error: Option<String>,
}
fn last() -> &'static Mutex<Last> {
    static L: OnceLock<Mutex<Last>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(Last { manifest: None, checked: 0.0, error: None }))
}

fn status_json() -> Value {
    let l = last().lock();
    let cur = current_version();
    let (available, latest, notes, date, size) = match &l.manifest {
        Some(m) => {
            let v = m["version"].as_str().unwrap_or("");
            let avail = !v.is_empty() && newer(v, cur);
            let comps = components();
            let size: u64 = needed(m, &comps).iter().map(|p| p["size"].as_u64().unwrap_or(0)).sum();
            (avail, json!(v), m["notes"].clone(), m["date"].clone(), json!(size))
        }
        None => (false, Value::Null, Value::Null, Value::Null, Value::Null),
    };
    json!({ "current": cur, "available": available, "latest": latest, "notes": notes, "date": date, "size": size,
            "checked": if l.checked > 0.0 { json!(l.checked) } else { Value::Null }, "error": l.error,
            "canInstall": cfg!(windows), "downloading": DOWNLOADING.load(Ordering::Relaxed), "ready": staged_version().is_some() })
}
fn needed(m: &Value, comps: &Value) -> Vec<Value> {
    m["packages"].as_array().cloned().unwrap_or_default().into_iter().filter(|p| {
        let id = p["id"].as_str().unwrap_or("");
        let want = p["version"].as_str().unwrap_or("");
        !id.is_empty() && (id == "app" || comps[id].as_str() != Some(want))
    }).collect()
}

/// update:check — look for a new version now
pub async fn check(_a: &Args) -> R {
    let url = manifest_url();
    let r = async {
        let resp = util::http().get(&url).header("Cache-Control", "no-cache").timeout(std::time::Duration::from_secs(20)).send().await.map_err(|e| short_err(&e.to_string()))?;
        if !resp.status().is_success() {
            return Err(if resp.status().as_u16() == 404 { "No updates have been published yet".to_string() } else { format!("The update server answered {}", resp.status()) });
        }
        let m: Value = resp.json().await.map_err(|_| "The update information couldn't be read".to_string())?;
        if m["version"].as_str().is_none() {
            return Err("The update information couldn't be read".into());
        }
        Ok(m)
    }
    .await;
    {
        let mut l = last().lock();
        l.checked = util::now_ms();
        match r {
            Ok(m) => {
                l.manifest = Some(m);
                l.error = None;
            }
            Err(e) => l.error = Some(e),
        }
    }
    Ok(status_json())
}
fn short_err(e: &str) -> String {
    if e.contains("dns") || e.contains("connect") || e.contains("timed out") { "No connection to the update server".into() } else { util::last_line(e) }
}
pub fn status(_a: &Args) -> R {
    Ok(status_json())
}

static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
fn staged_marker() -> PathBuf {
    work_dir().join("staged.json")
}
fn staged_version() -> Option<String> {
    let v: Value = serde_json::from_slice(&std::fs::read(staged_marker()).ok()?).ok()?;
    let ver = v["version"].as_str()?.to_string();
    if newer(&ver, current_version()) && work_dir().join("stage").is_dir() { Some(ver) } else { None }
}

/// Only files from the update page (GitHub) are accepted.
fn allowed(url: &str) -> bool {
    let ok_host = |h: &str| h == "github.com" || h.ends_with(".githubusercontent.com") || h == "127.0.0.1" && std::env::var("DOGFILE_UPDATE_URL").is_ok();
    url.split("://").nth(1).and_then(|r| r.split(['/', ':']).next()).map(ok_host).unwrap_or(false) && (url.starts_with("https://") || url.starts_with("http://127.0.0.1"))
}

/// update:download — fetch, check and unpack what's new; progress arrives as update:progress events
pub async fn download(win: &str, _a: &Args) -> R {
    let m = last().lock().manifest.clone().ok_or("Check for updates first")?;
    let version = m["version"].as_str().unwrap_or("").to_string();
    if !newer(&version, current_version()) {
        return Err("You already have the latest version".into());
    }
    if DOWNLOADING.swap(true, Ordering::Relaxed) {
        return Err("The update is already downloading".into());
    }
    CANCEL.store(false, Ordering::Relaxed);
    let w = win.to_string();
    let r = download_inner(&w, &m, &version).await;
    DOWNLOADING.store(false, Ordering::Relaxed);
    match r {
        Ok(()) => {
            events::emit(&w, "update:progress", json!({ "stage": "ready", "version": version }));
            Ok(status_json())
        }
        Err(e) => {
            events::emit(&w, "update:progress", json!({ "stage": "error", "error": e }));
            Err(e)
        }
    }
}
async fn download_inner(win: &str, m: &Value, version: &str) -> Result<(), String> {
    let dir = work_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("stage")).map_err(|e| e.to_string())?;
    let pkgs = needed(m, &components());
    if pkgs.is_empty() {
        return Err("The update has nothing to download".into());
    }
    let total: u64 = pkgs.iter().map(|p| p["size"].as_u64().unwrap_or(0)).sum();
    let mut done_all = 0u64;
    let mut installed = json!({});
    for p in &pkgs {
        let id = p["id"].as_str().unwrap_or("app").to_string();
        let url = p["url"].as_str().unwrap_or("").to_string();
        if !allowed(&url) {
            return Err(format!("The update file address isn't allowed ({url})"));
        }
        let file = dir.join(format!("{id}.zip"));
        let mut resp = util::http().get(&url).send().await.map_err(|e| short_err(&e.to_string()))?;
        if !resp.status().is_success() {
            return Err(format!("Download failed ({})", resp.status()));
        }
        let mut out = std::fs::File::create(&file).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut last_emit = std::time::Instant::now();
        while let Some(chunk) = resp.chunk().await.map_err(|e| short_err(&e.to_string()))? {
            if CANCEL.load(Ordering::Relaxed) {
                return Err("Cancelled".into());
            }
            out.write_all(&chunk).map_err(|e| e.to_string())?;
            hasher.update(&chunk);
            done_all += chunk.len() as u64;
            if last_emit.elapsed().as_millis() > 200 {
                last_emit = std::time::Instant::now();
                events::emit(win, "update:progress", json!({ "stage": "download", "done": done_all, "total": total, "part": id }));
            }
        }
        drop(out);
        if let Some(want) = p["sha256"].as_str().filter(|s| !s.is_empty()) {
            let got = format!("{:x}", hasher.finalize());
            if !got.eq_ignore_ascii_case(want) {
                return Err("The downloaded update is damaged (its checksum doesn't match). Try again.".into());
            }
        }
        events::emit(win, "update:progress", json!({ "stage": "unpack", "part": id }));
        let stage = dir.join("stage");
        let f2 = file.clone();
        tokio::task::spawn_blocking(move || unzip(&f2, &stage)).await.map_err(|e| e.to_string())??;
        installed[&id] = p["version"].clone();
    }
    // the app package must bring the program itself
    if pkgs.iter().any(|p| p["id"] == "app") && !dir.join("stage").join(if cfg!(windows) { "Dogfile.exe" } else { "dogfile" }).exists() && !dir.join("stage").join("renderer").is_dir() {
        return Err("The update package is incomplete".into());
    }
    std::fs::write(staged_marker(), serde_json::to_vec(&json!({ "version": version, "components": installed })).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(())
}
fn unzip(file: &Path, dest: &Path) -> Result<(), String> {
    let f = std::fs::File::open(file).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(f).map_err(|_| "The update package couldn't be opened".to_string())?;
    // packages may hold their files at the top or inside one folder ("Dogfile/…"): either works
    let names: Vec<String> = (0..z.len()).filter_map(|i| z.by_index(i).ok().map(|e| e.name().to_string())).collect();
    let prefix = {
        let firsts: std::collections::HashSet<&str> = names.iter().map(|n| n.split('/').next().unwrap_or("")).collect();
        if firsts.len() == 1 && names.iter().all(|n| n.contains('/')) { format!("{}/", firsts.into_iter().next().unwrap_or("")) } else { String::new() }
    };
    for i in 0..z.len() {
        let mut e = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = e.enclosed_name() else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let rel = rel.strip_prefix(&prefix).unwrap_or(&rel).to_string();
        if rel.is_empty() {
            continue;
        }
        let out = dest.join(&rel);
        if e.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::with_capacity(e.size() as usize);
        e.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&out, buf).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn cancel(_a: &Args) -> R {
    CANCEL.store(true, Ordering::Relaxed);
    Ok(json!(true))
}

/// update:install — close Dogfile, put the new files in place, start it again (Windows)
pub fn install(_a: &Args) -> R {
    let ver = staged_version().ok_or("Download the update first")?;
    #[cfg(not(windows))]
    {
        let _ = ver;
        return Err("Installing updates works on Windows; on this system, replace the files by hand".into());
    }
    #[cfg(windows)]
    {
        let dir = install_dir();
        let stage = work_dir().join("stage");
        let marker: Value = serde_json::from_slice(&std::fs::read(staged_marker()).unwrap_or_default()).unwrap_or(json!({}));
        let mut comps = components();
        if let Some(o) = marker["components"].as_object() {
            for (k, v) in o {
                comps[k] = v.clone();
            }
        }
        comps["app"] = json!(ver);
        let comps_file = work_dir().join("components.json");
        std::fs::write(&comps_file, serde_json::to_vec_pretty(&comps).unwrap_or_default()).map_err(|e| e.to_string())?;
        // can we write where Dogfile lives? (otherwise the script asks for administrator rights)
        let probe = dir.join(".dogfile-write-test");
        let writable = std::fs::write(&probe, b"x").is_ok();
        let _ = std::fs::remove_file(&probe);
        let q = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', "''"));
        let exe = dir.join("Dogfile.exe");
        let log = work_dir().join("install.log");
        let script = format!(
            r#"$ErrorActionPreference = 'Continue'
Start-Transcript -Path {log} -Force | Out-Null
$dir = {dir}; $stage = {stage}
try {{ Wait-Process -Id {pid} -Timeout 30 -ErrorAction SilentlyContinue }} catch {{}}
Get-Process Dogfile -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -eq {exe} }} | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400
# the interface is replaced as a whole, so files removed in the new version don't linger
if (Test-Path (Join-Path $stage 'renderer')) {{ Remove-Item -Recurse -Force (Join-Path $dir 'renderer') -ErrorAction SilentlyContinue }}
foreach ($i in 1..5) {{
  robocopy $stage $dir /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -lt 8) {{ break }}
  Start-Sleep -Seconds 1
}}
Copy-Item {comps} (Join-Path $dir 'components.json') -Force
$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Dogfile'
if (Test-Path $k) {{ Set-ItemProperty $k DisplayVersion '{ver}' }}
Start-Process -FilePath {exe} -ArgumentList '--updated'
Stop-Transcript | Out-Null
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
"#,
            log = q(&log),
            dir = q(&dir),
            stage = q(&stage),
            pid = std::process::id(),
            exe = q(&exe),
            comps = q(&comps_file),
            ver = ver.replace('\'', ""),
        );
        let sfile = work_dir().join("apply.ps1");
        std::fs::write(&sfile, script).map_err(|e| e.to_string())?;
        let ps_args = format!("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{}\"", sfile.to_string_lossy());
        if writable {
            util::spawn_detached("powershell.exe", &["-NoProfile".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-WindowStyle".into(), "Hidden".into(), "-File".into(), sfile.to_string_lossy().into_owned()], None, false).map_err(|e| e.to_string())?;
        } else {
            // installed somewhere only an administrator can change (e.g. Program Files)
            let elevate = format!("Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList '{}'", ps_args.replace('\'', "''"));
            util::spawn_detached("powershell.exe", &["-NoProfile".into(), "-WindowStyle".into(), "Hidden".into(), "-Command".into(), elevate], None, false).map_err(|e| e.to_string())?;
        }
        // leave a moment for the answer to reach the window, then close
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(600));
            crate::shutdown();
            st().host.quit();
        });
        Ok(json!({ "ok": true, "version": ver }))
    }
}
