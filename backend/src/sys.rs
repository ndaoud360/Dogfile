// System information: known folders, drives (and plugging them in), cloud folders, code editors, Everything.
use crate::args::{Args, R};
use crate::util::{self, IS_WIN};
use crate::{events, st};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn p(o: Option<PathBuf>) -> Value {
    o.map(|x| json!(x.to_string_lossy())).unwrap_or(Value::Null)
}
pub fn known_folders() -> Value {
    if crate::demo::active() {
        return crate::demo::known_folders();
    }
    let onedrive = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].iter().find_map(|k| std::env::var(k).ok()).filter(|d| Path::new(d).is_dir());
    json!({
        "home": p(dirs::home_dir()), "desktop": p(dirs::desktop_dir()), "documents": p(dirs::document_dir()), "downloads": p(dirs::download_dir()),
        "pictures": p(dirs::picture_dir()), "videos": p(dirs::video_dir()), "music": p(dirs::audio_dir()), "appData": p(dirs::config_dir()),
        "temp": std::env::temp_dir().to_string_lossy(), "onedrive": onedrive,
        "recentWin": if IS_WIN { p(dirs::data_dir().map(|d| d.join("Microsoft").join("Windows").join("Recent"))) } else { Value::Null },
    })
}
pub fn home() -> String {
    dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into())
}

pub fn info(win: &str) -> R {
    let s = st();
    let launch = s.host.launch_of(win);
    Ok(json!({
        "platform": if IS_WIN { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" },
        "sep": if IS_WIN { "\\" } else { "/" }, "version": env!("CARGO_PKG_VERSION"), "known": known_folders(),
        "userData": s.data_dir.to_string_lossy(), "exe": std::env::current_exe().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default(),
        "packaged": !s.test_mode, "launch": launch, "pending": Value::Null, "ffmpeg": crate::media::available(),
        "user": std::env::var(if IS_WIN { "USERNAME" } else { "USER" }).unwrap_or_default(), "hostname": if crate::demo::active() { "ALEX-PC".to_string() } else { hostname() },
        "has7z": crate::archive::find_7z().is_some(), "test": s.test_mode, "customControls": true, "engine": "tauri",
        "streamBase": s.stream_base.read().clone(), "demo": crate::demo::active(), "demoRoot": if crate::demo::active() { json!(crate::demo::root().to_string_lossy()) } else { Value::Null },
    }))
}
pub fn hostname() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).ok().or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string())).unwrap_or_default()
}

// ---------------- drives ----------------
pub async fn list_drives_raw() -> Vec<Value> {
    #[cfg(windows)]
    {
        return tokio::task::spawn_blocking(crate::win::list_drives).await.unwrap_or_default();
    }
    #[cfg(not(windows))]
    {
        let mut out = vec![];
        let (t, f) = statvfs("/");
        out.push(json!({ "path": "/", "name": "File System", "label": "", "type": "fixed", "total": t, "free": f }));
        for base in ["/mnt", "/media"] {
            if let Ok(rd) = std::fs::read_dir(base) {
                for e in rd.flatten() {
                    let pth = e.path().to_string_lossy().into_owned();
                    let name = e.file_name().to_string_lossy().into_owned();
                    let (t, f) = statvfs(&pth);
                    out.push(json!({ "path": pth, "name": name, "label": name, "type": "removable", "total": t, "free": f }));
                }
            }
        }
        out
    }
}
#[cfg(unix)]
fn statvfs(path: &str) -> (u64, u64) {
    let Ok(c) = std::ffi::CString::new(path) else { return (0, 0) };
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return (0, 0);
    }
    (s.f_blocks as u64 * s.f_frsize as u64, s.f_bavail as u64 * s.f_frsize as u64)
}
pub async fn drives() -> R {
    if crate::demo::active() {
        return Ok(json!(crate::demo::drives()));
    }
    let mut d = list_drives_raw().await;
    #[cfg(windows)]
    {
        let devs = tokio::task::spawn_blocking(crate::win::portable_devices).await.unwrap_or_default();
        d.extend(devs);
    }
    Ok(json!(d))
}
/// watch for drives and phones being plugged in or out
pub fn start_drive_watch() {
    tokio::spawn(async {
        let mut last = String::new();
        let mut n: u64 = 0;
        let mut devs = String::new();
        loop {
            let letters = drive_letters();
            #[cfg(windows)]
            if n % 3 == 0 {
                devs = tokio::task::spawn_blocking(|| crate::win::portable_devices().iter().filter_map(|d| d["name"].as_str().map(String::from)).collect::<Vec<_>>().join(","))
                    .await
                    .unwrap_or_default();
            }
            let sig = format!("{letters}#{devs}");
            if !last.is_empty() && sig != last {
                events::broadcast("drives:changed", json!({}));
            }
            last = sig;
            n += 1;
            tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
        }
    });
}
fn drive_letters() -> String {
    #[cfg(windows)]
    {
        let mask = unsafe { windows::Win32::Storage::FileSystem::GetLogicalDrives() };
        return format!("{mask:x}");
    }
    #[cfg(not(windows))]
    {
        let mut s = String::new();
        for b in ["/mnt", "/media"] {
            if let Ok(rd) = std::fs::read_dir(b) {
                for e in rd.flatten() {
                    s.push_str(&e.file_name().to_string_lossy());
                    s.push(',');
                }
            }
        }
        s
    }
}

/// \\server -> its shares
pub async fn net_view(server: &str) -> Vec<String> {
    if !IS_WIN {
        return vec![];
    }
    let Ok(o) = util::run("net.exe", &["view".into(), server.into(), "/all".into()], None, 20000).await else { return vec![] };
    if !o.ok {
        return vec![];
    }
    let text = o.out();
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.iter().position(|l| l.starts_with("-----")).map(|i| i + 1).unwrap_or(lines.len());
    let re = regex::Regex::new(r"(?i)^(\S.*?)\s{2,}(Disk|Print|IPC)").unwrap();
    lines[start..].iter().filter_map(|l| re.captures(l)).filter(|c| c[2].eq_ignore_ascii_case("disk")).map(|c| c[1].trim().to_string()).collect()
}
pub async fn mapped() -> R {
    if !IS_WIN {
        return Ok(json!([]));
    }
    let Ok(o) = util::run("net.exe", &["use".into()], None, 15000).await else { return Ok(json!([])) };
    let re = regex::Regex::new(r"\s([A-Z]:)\s+(\\\\\S+)").unwrap();
    Ok(json!(o.out().lines().filter_map(|l| re.captures(l)).map(|c| json!({ "letter": &c[1], "remote": &c[2] })).collect::<Vec<_>>()))
}

// ---------------- code editors, cloud folders ----------------
pub async fn find_editor() -> R {
    let env = |k: &str| std::env::var(k).ok();
    let cands: Vec<Option<PathBuf>> = if IS_WIN {
        let la = env("LOCALAPPDATA").map(PathBuf::from);
        let pf = env("ProgramFiles").map(PathBuf::from);
        let pf86 = env("ProgramFiles(x86)").map(PathBuf::from);
        vec![
            la.clone().map(|d| d.join("Programs").join("Microsoft VS Code").join("Code.exe")),
            pf.clone().map(|d| d.join("Microsoft VS Code").join("Code.exe")),
            la.clone().map(|d| d.join("Programs").join("cursor").join("Cursor.exe")),
            la.clone().map(|d| d.join("Programs").join("VSCodium").join("VSCodium.exe")),
            pf.clone().map(|d| d.join("VSCodium").join("VSCodium.exe")),
            pf.clone().map(|d| d.join("Sublime Text").join("sublime_text.exe")),
            pf.clone().map(|d| d.join("Sublime Text 3").join("sublime_text.exe")),
            pf.clone().map(|d| d.join("Notepad++").join("notepad++.exe")),
            pf86.map(|d| d.join("Notepad++").join("notepad++.exe")),
        ]
    } else {
        ["/usr/bin/code", "/usr/local/bin/code", "/snap/bin/code", "/usr/bin/codium", "/usr/bin/subl"].iter().map(|s| Some(PathBuf::from(s))).collect()
    };
    for c in cands.into_iter().flatten() {
        if c.is_file() {
            let name = c.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            return Ok(json!({ "path": c.to_string_lossy(), "name": name }));
        }
    }
    Ok(Value::Null)
}
pub async fn cloud_detect() -> R {
    let home = PathBuf::from(home());
    let mut out: Vec<Value> = vec![];
    let mut add = |provider: &str, path: Option<PathBuf>, name: Option<&str>| {
        let Some(path) = path else { return };
        let ps = path.to_string_lossy().into_owned();
        if out.iter().any(|x| x["path"].as_str().map(|s| s.eq_ignore_ascii_case(&ps)).unwrap_or(false)) { return }
        if path.is_dir() {
            out.push(json!({ "provider": provider, "name": name.unwrap_or(provider), "path": ps }));
        }
    };
    let env = |k: &str| std::env::var(k).ok().map(PathBuf::from);
    add("OneDrive", env("OneDriveConsumer").or(env("OneDrive")), Some("OneDrive"));
    if let (Some(c), od) = (std::env::var("OneDriveCommercial").ok(), std::env::var("OneDrive").ok()) {
        if Some(&c) != od.as_ref() {
            let n = util::basename(&c);
            add("OneDrive", Some(PathBuf::from(&c)), Some(&n));
        }
    }
    let la = env("LOCALAPPDATA").unwrap_or(home.join("AppData").join("Local"));
    if let Ok(s) = std::fs::read_to_string(la.join("Dropbox").join("info.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&s) {
            if let Some(o) = v.as_object() {
                for (k, x) in o {
                    add("Dropbox", x["path"].as_str().map(PathBuf::from), Some(if k == "business" { "Dropbox (work)" } else { "Dropbox" }));
                }
            }
        }
    }
    add("Dropbox", Some(home.join("Dropbox")), None);
    add("Google Drive", Some(home.join("Google Drive")), None);
    add("Google Drive", Some(home.join("My Drive")), Some("Google Drive"));
    if IS_WIN {
        for l in "GHIJKLMNOPQRSTUVWXYZ".chars() {
            let p2 = PathBuf::from(format!("{l}:\\My Drive"));
            if p2.is_dir() {
                add("Google Drive", Some(p2), Some("Google Drive"));
                break;
            }
        }
    }
    add("iCloud Drive", Some(home.join("iCloudDrive")), None);
    add("Box", Some(home.join("Box")), None);
    add("MEGA", Some(home.join("MEGA")), None);
    add("MEGA", Some(home.join("Documents").join("MEGAsync")), Some("MEGA"));
    add("Nextcloud", Some(home.join("Nextcloud")), None);
    if IS_WIN {
        add("pCloud", Some(PathBuf::from("P:\\")), Some("pCloud Drive"));
    }
    add("Proton Drive", Some(home.join("Proton Drive")), None);
    add("Sync.com", Some(home.join("Sync")), None);
    Ok(json!(out))
}

// ---------------- Everything (voidtools) ----------------
fn everything_exe() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        return crate::win::process_path(&["Everything.exe", "Everything64.exe"]);
    }
    #[cfg(not(windows))]
    None
}
fn find_es() -> Option<PathBuf> {
    let mut c: Vec<PathBuf> = vec![];
    if let Some(w) = util::which("es.exe") {
        c.push(w);
    }
    if let Some(run) = everything_exe() {
        if let Some(d) = run.parent() {
            c.push(d.join("es.exe"));
        }
    }
    c.push(PathBuf::from(r"C:\Program Files\Everything\es.exe"));
    c.push(PathBuf::from(r"C:\Program Files (x86)\Everything\es.exe"));
    c.push(st().data_dir.join("es.exe"));
    c.into_iter().find(|p| p.is_file())
}
pub async fn everything_search(a: &Args) -> R {
    if crate::demo::active() {
        return Ok(Value::Null);
    }
    let Some(es) = find_es() else { return Ok(Value::Null) };
    let mut args = vec!["-n".to_string(), a.u(1, 2000).to_string(), "-full-path-and-name".into()];
    if let Some(root) = a.os(2).filter(|r| !r.is_empty()) {
        args.push("-path".into());
        args.push(root);
    }
    args.push(a.s_or(0, ""));
    match util::run(&es, &args, None, 30000).await {
        Ok(o) if o.ok => Ok(json!(o.out().lines().filter(|l| !l.is_empty()).collect::<Vec<_>>())),
        _ => Ok(Value::Null),
    }
}
pub async fn everything_available() -> R {
    Ok(json!(find_es().is_some() && !crate::demo::active()))
}
pub async fn everything_status() -> R {
    let es = find_es();
    let run = if es.is_some() { None } else { everything_exe() };
    Ok(json!({ "es": es.as_ref().map(|p| p.to_string_lossy().into_owned()), "running": es.is_some() || run.is_some(), "exe": run.map(|p| p.to_string_lossy().into_owned()) }))
}

/// the PC's memory in GB (to suggest the right size of the assistant's model)
pub fn total_memory_gb() -> f64 {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        if unsafe { GlobalMemoryStatusEx(&mut m) }.is_ok() {
            return m.ullTotalPhys as f64 / 1073741824.0;
        }
        0.0
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<f64>().ok()).map(|b| b / 1073741824.0).unwrap_or(0.0)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::fs::read_to_string("/proc/meminfo").ok().and_then(|s| s.lines().find(|l| l.starts_with("MemTotal")).and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok())).map(|kb| kb / 1048576.0).unwrap_or(0.0)
    }
}
