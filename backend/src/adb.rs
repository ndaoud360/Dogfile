// Android phones as drives, over Wi-Fi (Wireless debugging, Android 11 and up) or USB debugging, using Google's adb.
// They show in This PC as "Pixel 8 (Wi-Fi)" and behave like the phones Windows shows over USB: the same paths
// (atlas:mtp|<name>|DCIM/Camera), so browsing, opening, copying in and out, renaming and deleting all work as
// they do there. adb is fetched once from Google (platform-tools) or taken from the phone mirroring feature.
// iPhones can't be browsed like this: Apple lets no PC program reach an iPhone's files over Wi-Fi.
use crate::args::{Args, R};
use crate::{st, util};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

const ROOT: &str = "/sdcard";

fn tool_dir() -> PathBuf {
    st().data_dir.join("tools").join("platform-tools")
}
fn exe_name() -> &'static str {
    if util::IS_WIN { "adb.exe" } else { "adb" }
}
/// adb: Dogfile's own copy, the one that came with phone mirroring (scrcpy), or one on the PATH
pub fn adb() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("DOGFILE_ADB") {
        return Some(PathBuf::from(p));
    }
    let mine = tool_dir().join(exe_name());
    if mine.is_file() {
        return Some(mine);
    }
    if let Some(local) = dirs::data_local_dir() {
        if let Ok(rd) = std::fs::read_dir(local.join("Dogfile").join("phone-mirror")) {
            for e in rd.flatten() {
                let p = e.path().join(exe_name());
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    util::which(exe_name())
}

async fn run(args: &[&str], secs: u64) -> Result<String, String> {
    let exe = adb().ok_or("NO_ADB")?;
    let out = util::cmd(&exe).args(args).output();
    let o = tokio::time::timeout(Duration::from_secs(secs), out).await.map_err(|_| "The phone didn’t answer in time".to_string())?.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&o.stdout).to_string();
    if !o.status.success() {
        let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
        return Err(if err.is_empty() { text.trim().to_string() } else { err });
    }
    Ok(text)
}

// ---------------------------------------------------------------------------------------------------------------
// devices: serial ↔ the name shown in Dogfile

#[derive(Clone)]
struct Dev {
    serial: String,
    label: String,
}
fn known() -> &'static Mutex<Vec<Dev>> {
    static K: OnceLock<Mutex<Vec<Dev>>> = OnceLock::new();
    K.get_or_init(|| Mutex::new(vec![]))
}
/// a name Dogfile gave an adb phone (the USB phones Windows shows have other names)
pub fn is_adb_name(dev: &str) -> bool {
    dev.ends_with(" (Wi-Fi)") || dev.ends_with(" (USB debugging)")
}
fn wireless(serial: &str) -> bool {
    serial.contains(':') || serial.contains("_adb-tls-connect")
}
/// the phones adb can reach right now
async fn devices() -> Vec<Dev> {
    let Ok(out) = run(&["devices", "-l"], 8).await else { return vec![] };
    let mut v: Vec<Dev> = vec![];
    for l in out.lines().skip(1) {
        let mut it = l.split_whitespace();
        let (Some(serial), Some(state)) = (it.next(), it.next()) else { continue };
        if state != "device" {
            continue;
        }
        let model = it.find_map(|x| x.strip_prefix("model:")).unwrap_or("Android phone").replace('_', " ");
        let mut label = format!("{model} ({})", if wireless(serial) { "Wi-Fi" } else { "USB debugging" });
        // the same phone by Wi-Fi and USB, or two of the same model: keep the names apart
        if v.iter().any(|d| d.label == label) {
            label = format!("{model} {} ({})", v.len() + 1, if wireless(serial) { "Wi-Fi" } else { "USB debugging" });
        }
        v.push(Dev { serial: serial.to_string(), label });
    }
    *known().lock() = v.clone();
    v
}
async fn serial_for(label: &str) -> Result<String, String> {
    if let Some(d) = known().lock().iter().find(|d| d.label == label) {
        return Ok(d.serial.clone());
    }
    devices().await.into_iter().find(|d| d.label == label).map(|d| d.serial).ok_or_else(|| format!("{label} isn’t connected right now"))
}

/// drives for This PC: only once the person has connected a phone this way (so adb isn't started for everyone)
pub async fn drive_entries() -> Vec<Value> {
    if !crate::setting_bool("phoneAdb", false) || adb().is_none() {
        return vec![];
    }
    // phones paired before come back by themselves when they're on the same Wi-Fi (adb finds them on the network)
    let mut list = devices().await;
    if !list.iter().any(|d| wireless(&d.serial)) {
        if let Ok(m) = run(&["mdns", "services"], 4).await {
            for l in m.lines().filter(|l| l.contains("_adb-tls-connect")) {
                if let Some(addr) = l.split_whitespace().last().filter(|a| a.contains(':')) {
                    let _ = run(&["connect", addr], 6).await;
                }
            }
            list = devices().await;
        }
    }
    list.into_iter()
        .map(|d| json!({ "path": format!("atlas:mtp|{}|", d.label), "name": d.label, "label": d.label, "type": "portable", "devType": "Android phone", "total": 0, "free": 0, "adb": true }))
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------
// files

fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
/// atlas:mtp|Pixel 8 (Wi-Fi)|DCIM/Camera → ("Pixel 8 (Wi-Fi)", "/sdcard/DCIM/Camera")
fn split(p: &str) -> (String, String) {
    let rest = p.strip_prefix("atlas:mtp|").unwrap_or(p);
    let (dev, sub) = rest.split_once('|').unwrap_or((rest, ""));
    let sub = sub.trim_matches('/');
    (dev.to_string(), if sub.is_empty() { ROOT.to_string() } else { format!("{ROOT}/{sub}") })
}
pub fn dev_of(p: &str) -> Option<String> {
    let rest = p.strip_prefix("atlas:mtp|")?;
    Some(rest.split_once('|').map(|x| x.0).unwrap_or(rest).to_string())
}
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}
/// one line of `ls -lA` (toybox): perms links owner group size date time name
pub fn parse_ls(out: &str, dev: &str, sub: &str) -> Vec<Value> {
    let base = if sub.is_empty() { format!("atlas:mtp|{dev}|") } else { format!("atlas:mtp|{dev}|{sub}/") };
    let mut v = vec![];
    for line in out.lines() {
        if line.starts_with("total") || line.trim().is_empty() {
            continue;
        }
        // the first seven fields, then the rest of the line is the name (names can have spaces)
        let mut rest = line;
        let mut f: Vec<&str> = vec![];
        for _ in 0..7 {
            rest = rest.trim_start();
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            f.push(&rest[..end]);
            rest = &rest[end..];
        }
        let mut name = rest.strip_prefix(' ').unwrap_or(rest).to_string();
        if f.len() < 7 || name.is_empty() || !f[0].starts_with(['d', '-', 'l']) {
            continue;
        }
        let link = f[0].starts_with('l');
        if link {
            if let Some((n, _)) = name.split_once(" -> ") {
                name = n.to_string();
            }
        }
        let dir = f[0].starts_with('d') || link;
        let size: u64 = f[4].parse().unwrap_or(0);
        let mtime = {
            let d: Vec<i64> = f[5].split('-').filter_map(|x| x.parse().ok()).collect();
            let t: Vec<i64> = f[6].split(':').filter_map(|x| x.parse().ok()).collect();
            if d.len() == 3 && t.len() >= 2 { (days_from_civil(d[0], d[1], d[2]) * 86400 + t[0] * 3600 + t[1] * 60) as f64 * 1000.0 } else { 0.0 }
        };
        v.push(json!({ "name": name, "path": format!("{base}{name}"), "isDir": dir, "size": if dir { Value::Null } else { json!(size) },
            "mtime": mtime, "ctime": 0, "ext": if dir { String::new() } else { util::ext(&name) }, "hidden": name.starts_with('.'), "mtp": true }));
    }
    v
}
fn strs(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        Value::String(s) => vec![s.clone()],
        _ => vec![],
    }
}
/// the mtp:* calls for adb phones
pub async fn call(name: &str, a0: Value, a1: Value) -> R {
    match name {
        "mtp:list" => {
            let p = a0.as_str().unwrap_or("");
            let (dev, path) = split(p);
            let s = serial_for(&dev).await?;
            let out = run(&["-s", &s, "shell", &format!("ls -lA {}", q(&format!("{path}/")))], 30).await?;
            let sub = p.strip_prefix("atlas:mtp|").and_then(|r| r.split_once('|')).map(|x| x.1.trim_matches('/').to_string()).unwrap_or_default();
            Ok(json!(parse_ls(&out, &dev, &sub)))
        }
        "mtp:copyOut" => {
            let dest = a1.as_str().unwrap_or("").to_string();
            let mut out = vec![];
            for p in strs(&a0) {
                let (dev, path) = split(&p);
                let s = serial_for(&dev).await?;
                run(&["-s", &s, "pull", "-a", &path, &dest], 3600).await?;
                out.push(util::join(&dest, path.rsplit('/').next().unwrap_or("")));
            }
            Ok(json!(out))
        }
        "mtp:copyIn" => {
            let (dev, path) = split(a1.as_str().unwrap_or(""));
            let s = serial_for(&dev).await?;
            for lp in strs(&a0) {
                run(&["-s", &s, "push", &lp, &format!("{path}/")], 3600).await?;
                // so the phone's Gallery and Files see it straight away
                let name = Path::new(&lp).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let _ = run(&["-s", &s, "shell", &format!("am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d {}", q(&format!("file://{path}/{name}")))], 10).await;
            }
            Ok(json!(true))
        }
        "mtp:delete" => {
            for p in strs(&a0) {
                let (dev, path) = split(&p);
                if path == ROOT {
                    return Err("The phone’s storage itself can’t be deleted".into());
                }
                let s = serial_for(&dev).await?;
                run(&["-s", &s, "shell", &format!("rm -rf {}", q(&path))], 120).await?;
            }
            Ok(json!(true))
        }
        "mtp:mkdir" => {
            let (dev, path) = split(a0.as_str().unwrap_or(""));
            let s = serial_for(&dev).await?;
            let name = a1.as_str().unwrap_or("New folder").replace('/', "_");
            run(&["-s", &s, "shell", &format!("mkdir -p {}", q(&format!("{path}/{name}")))], 20).await?;
            Ok(json!(true))
        }
        "mtp:rename" => {
            let (dev, path) = split(a0.as_str().unwrap_or(""));
            let s = serial_for(&dev).await?;
            let new = a1.as_str().unwrap_or("").replace('/', "_");
            let parent = path.rsplit_once('/').map(|x| x.0).unwrap_or(ROOT);
            run(&["-s", &s, "shell", &format!("mv {} {}", q(&path), q(&format!("{parent}/{new}")))], 20).await?;
            Ok(json!(true))
        }
        _ => Err(format!("Unknown {name}")),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// setting up: getting adb, pairing, connecting

#[derive(Default, Clone)]
struct Fetch {
    running: bool,
    error: Option<String>,
}
fn fetch() -> &'static Mutex<Fetch> {
    static F: OnceLock<Mutex<Fetch>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(Fetch::default()))
}
/// phone:adbStatus: {ready, downloading, error, phones:[names]}
pub async fn status(_a: &Args) -> R {
    let f = fetch().lock().clone();
    let phones: Vec<String> = if adb().is_some() { devices().await.into_iter().map(|d| d.label).collect() } else { vec![] };
    Ok(json!({ "ready": adb().is_some(), "downloading": f.running, "error": f.error, "phones": phones }))
}
/// phone:adbInstall: Google's platform-tools (adb), once
pub fn install(_a: &Args) -> R {
    if adb().is_some() {
        return Ok(json!({ "ready": true }));
    }
    {
        let mut f = fetch().lock();
        if f.running {
            return Ok(json!({ "downloading": true }));
        }
        *f = Fetch { running: true, error: None };
    }
    st().rt.spawn(async {
        let r = get_adb().await;
        let mut f = fetch().lock();
        f.running = false;
        f.error = r.err();
    });
    Ok(json!({ "downloading": true }))
}
async fn get_adb() -> Result<(), String> {
    let os = if util::IS_WIN { "windows" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
    let url = format!("https://dl.google.com/android/repository/platform-tools-latest-{os}.zip");
    let r = util::http().get(&url).timeout(Duration::from_secs(600)).send().await.map_err(|e| format!("Couldn’t reach Google: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("Couldn’t download adb (HTTP {})", r.status().as_u16()));
    }
    let b = r.bytes().await.map_err(|e| e.to_string())?;
    let dir = tool_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(b)).map_err(|e| e.to_string())?;
    for i in 0..z.len() {
        let mut e = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = e.enclosed_name().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())) else { continue };
        // just adb and what it needs
        if !(name == exe_name() || name.starts_with("AdbWin") || name == "NOTICE.txt") || e.is_dir() {
            continue;
        }
        let mut w = std::fs::File::create(dir.join(&name)).map_err(|e| e.to_string())?;
        std::io::copy(&mut e, &mut w).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir.join(&name), std::fs::Permissions::from_mode(0o755));
        }
    }
    if !dir.join(exe_name()).is_file() {
        return Err("adb wasn’t in the download".into());
    }
    Ok(())
}
fn remember() {
    let mut s = crate::store::get("settings").unwrap_or_else(|| json!({}));
    if s["phoneAdb"] != json!(true) {
        s["phoneAdb"] = json!(true);
        let _ = crate::store::set("settings", &s);
        st().settings.write()["phoneAdb"] = json!(true);
    }
}
/// phone:adbPair(address, code): the "Pair device with pairing code" screen on the phone, then connected
pub async fn pair(a: &Args) -> R {
    let addr = a.s(0)?.trim().to_string();
    let code = a.s(1)?.trim().to_string();
    let out = run(&["pair", &addr, &code], 20).await?;
    if !out.to_lowercase().contains("success") {
        return Err(if out.trim().is_empty() { "Pairing didn’t work. Check the address and code on the phone.".into() } else { out.trim().to_string() });
    }
    remember();
    // pairing uses its own port; connecting uses the one on the Wireless debugging screen, found on the network
    tokio::time::sleep(Duration::from_millis(800)).await;
    let _ = drive_entries().await;
    crate::events::broadcast("drives:changed", json!({}));
    Ok(json!({ "phones": known().lock().iter().map(|d| d.label.clone()).collect::<Vec<_>>() }))
}
/// phone:adbConnect(address): the IP address & port shown on the Wireless debugging screen
pub async fn connect(a: &Args) -> R {
    let addr = a.s(0)?.trim().to_string();
    let out = run(&["connect", &addr], 15).await?;
    if out.contains("failed") || out.contains("cannot") || out.contains("unable") {
        return Err(out.trim().to_string());
    }
    remember();
    let _ = devices().await;
    crate::events::broadcast("drives:changed", json!({}));
    Ok(json!({ "phones": known().lock().iter().map(|d| d.label.clone()).collect::<Vec<_>>() }))
}
/// phone:adbDisconnect(name)
pub async fn disconnect(a: &Args) -> R {
    let label = a.s(0)?;
    if let Ok(s) = serial_for(&label).await {
        let _ = run(&["disconnect", &s], 8).await;
    }
    let _ = devices().await;
    crate::events::broadcast("drives:changed", json!({}));
    Ok(json!(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_ls() {
        let out = "total 24\ndrwxrws--- 3 u0_a123 media_rw 3452 2024-05-01 10:20 Camera\n-rw-rw---- 1 u0_a123 media_rw 2483456 2026-10-23 18:05 IMG 2026 (1).jpg\nlrwxrwxrwx 1 root root 21 2024-01-01 00:00 sdcard -> /storage/self/primary\n";
        let v = parse_ls(out, "Pixel 8 (Wi-Fi)", "DCIM");
        assert_eq!(v.len(), 3);
        assert_eq!(v[0]["name"], "Camera");
        assert_eq!(v[0]["isDir"], true);
        assert_eq!(v[1]["name"], "IMG 2026 (1).jpg");
        assert_eq!(v[1]["size"], 2483456);
        assert_eq!(v[1]["path"], "atlas:mtp|Pixel 8 (Wi-Fi)|DCIM/IMG 2026 (1).jpg");
        assert_eq!(v[2]["name"], "sdcard");
        assert_eq!(split("atlas:mtp|Pixel 8 (Wi-Fi)|DCIM/Camera").1, "/sdcard/DCIM/Camera");
        assert_eq!(split("atlas:mtp|Pixel 8 (Wi-Fi)|").1, "/sdcard");
    }
}
