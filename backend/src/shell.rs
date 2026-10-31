// Windows shell features: opening things, "Open with", run as administrator, terminals, Properties, the classic
// right-click verbs, thumbnails and icons, the Recycle Bin, who's locking a file, network places, phones (MTP),
// the default file manager and Explorer's right-click entries for Dogfile.
use crate::args::{Args, R};
use crate::util::{self, IS_WIN};
use serde_json::{json, Value};

#[cfg(windows)]
use crate::win;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())
}

pub async fn open(a: &Args) -> R {
    let p = a.s(0)?;
    #[cfg(windows)]
    {
        return blocking(move || win::shell_execute(&p, "open", None, None)).await?.map(|_| json!(true));
    }
    #[cfg(not(windows))]
    {
        util::spawn_detached("xdg-open", &[p], None, true).map_err(|e| e.to_string())?;
        Ok(json!(true))
    }
}
/// open a web address in the default browser
pub fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        return win::shell_execute(url, "open", None, None).map(|_| ());
    }
    #[cfg(target_os = "macos")]
    {
        return util::spawn_detached("open", &[url.to_string()], None, true).map(|_| ()).map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    util::spawn_detached("xdg-open", &[url.to_string()], None, true).map(|_| ()).map_err(|e| e.to_string())
}
pub async fn open_external(a: &Args) -> R {
    let url = a.s(0)?;
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:") || url.starts_with("ms-settings:")) {
        return Err("Only web addresses".into());
    }
    #[cfg(windows)]
    {
        return blocking(move || win::shell_execute(&url, "open", None, None)).await?.map(|_| json!(true));
    }
    #[cfg(not(windows))]
    {
        open_url(&url)?;
        Ok(json!(true))
    }
}
pub async fn open_with(a: &Args) -> R {
    let p = a.s(0)?;
    if !IS_WIN {
        return Ok(json!(false));
    }
    #[cfg(windows)]
    blocking(move || win::open_with(&p)).await?;
    Ok(json!(true))
}
pub async fn run_as(a: &Args) -> R {
    let p = a.s(0)?;
    #[cfg(windows)]
    {
        let dir = util::dirname(&p);
        let _ = blocking(move || win::shell_execute(&p, "runas", None, Some(&dir))).await?;
        return Ok(json!(true));
    }
    #[cfg(not(windows))]
    {
        let _ = p;
        Ok(json!(false))
    }
}
pub async fn show_in_explorer(a: &Args) -> R {
    let p = a.s(0)?;
    let select = a.b(1);
    #[cfg(windows)]
    {
        // straight to explorer.exe, past our own "default file manager" registration
        let arg = if select { format!("/select,{p}") } else { p };
        crate::win::explorer_watch::allow_explorer();
        util::spawn_detached("explorer.exe", &[arg], None, true).map_err(|e| e.to_string())?;
        return Ok(json!(true));
    }
    #[cfg(not(windows))]
    {
        let target = if select { util::dirname(&p) } else { p };
        util::spawn_detached("xdg-open", &[target], None, true).map_err(|e| e.to_string())?;
        Ok(json!(true))
    }
}
pub async fn terminal(a: &Args) -> R {
    let dir = a.s(0)?;
    let kind = a.s_or(1, "auto");
    let admin = a.b(2);
    if !IS_WIN {
        for t in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            if util::which(t).is_some() {
                util::spawn_detached(t, &[], Some(&dir), true).map_err(|e| e.to_string())?;
                return Ok(json!(true));
            }
        }
        return Ok(json!(false));
    }
    #[cfg(windows)]
    {
        let wt = util::which("wt.exe").is_some();
        let q = dir.replace('\'', "''");
        if admin {
            let (exe, args) = if kind == "cmd" { ("cmd.exe".to_string(), format!("/k cd /d \"{dir}\"")) } else if wt && kind != "powershell" { ("wt.exe".to_string(), format!("-d \"{dir}\"")) } else { ("powershell.exe".to_string(), format!("-NoExit -Command Set-Location -LiteralPath '{q}'")) };
            let _ = blocking(move || win::shell_execute(&exe, "runas", Some(&args), None)).await?;
            return Ok(json!(true));
        }
        // each shell starts straight in the folder (its working folder), so the folder's name is never part of a
        // command line: names like "Tom & Jerry" or "a&b" can't be read as commands
        let open = |exe: &str, args: &[&str]| util::spawn_detached(exe, &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(), Some(&dir), true).map_err(|e| e.to_string());
        if (kind == "auto" || kind == "wt") && wt {
            util::spawn_detached("wt.exe", &["-d".into(), dir.clone()], Some(&dir), true).map_err(|e| e.to_string())?;
        } else if kind == "cmd" {
            open("cmd.exe", &["/k"])?;
        } else if kind == "pwsh" && util::which("pwsh.exe").is_some() {
            open("pwsh.exe", &["-NoExit"])?;
        } else {
            open("powershell.exe", &["-NoExit"])?;
        }
        let _ = &q;
        let _ = (&kind, admin);
        return Ok(json!(true));
    }
    #[allow(unreachable_code)]
    Ok(json!(false))
}
pub async fn properties(a: &Args) -> R {
    let paths = a.strs(0);
    #[cfg(windows)]
    {
        blocking(move || win::show_properties(&paths)).await?;
        return Ok(json!(true));
    }
    #[cfg(not(windows))]
    {
        let _ = paths;
        Ok(json!(false))
    }
}
pub async fn verbs(a: &Args) -> R {
    let p = a.s(0)?;
    #[cfg(windows)]
    return Ok(json!(blocking(move || win::shell_verbs(&p)).await?));
    #[cfg(not(windows))]
    {
        let _ = p;
        Ok(json!([]))
    }
}
pub async fn invoke_verb(a: &Args) -> R {
    let (p, v) = (a.s(0)?, a.s(1)?);
    #[cfg(windows)]
    {
        blocking(move || win::invoke_verb(&p, &v)).await??;
        return Ok(json!(true));
    }
    #[cfg(not(windows))]
    {
        let _ = (p, v);
        Ok(json!(false))
    }
}
pub fn beep() -> R {
    #[cfg(windows)]
    win::beep();
    Ok(json!(true))
}
/// shell:launch(cmd, args, cwd): an app with arguments (environment variables like %USERPROFILE% expanded)
pub async fn launch(a: &Args) -> R {
    let cmd = a.s(0)?;
    let args = a.strs(1);
    let cwd = a.os(2);
    let env_re = regex::Regex::new(r"%([^%]+)%").unwrap();
    let resolved = env_re.replace_all(&cmd, |c: &regex::Captures| std::env::var(&c[1]).unwrap_or_default()).to_string();
    #[cfg(windows)]
    {
        // through the shell, like Explorer: works for programs, documents, URLs and .lnk files
        let q = |s: &str| if s.contains([' ', '&', '(', ')', '^', '%', '!', ',', ';', '=']) && !(s.starts_with('"') && s.ends_with('"')) { format!("\"{s}\"") } else { s.to_string() };
        let params = args.iter().map(|x| q(x)).collect::<Vec<_>>().join(" ");
        let dir = cwd.clone();
        return blocking(move || win::shell_execute(&resolved, "open", if params.is_empty() { None } else { Some(&params) }, dir.as_deref())).await?.map(|_| json!(true));
    }
    #[cfg(not(windows))]
    {
        util::spawn_detached(&resolved, &args, cwd.as_deref(), true).map_err(|e| e.to_string())?;
        Ok(json!(true))
    }
}
pub async fn run_command(a: &Args) -> R {
    let line = a.s(0)?;
    let cwd = a.os(1);
    if IS_WIN {
        // cmd gets the line exactly as written (/s /c "…"): quoted paths stay quoted, so a name with & or ( ) in it
        // is part of the name, not the start of another command. /d: no AutoRun scripts.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let mut c = std::process::Command::new("cmd.exe");
            c.raw_arg(format!("/d /s /c \"{line}\"")).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            if let Some(d) = cwd.as_deref().filter(|d| std::path::Path::new(d).is_dir()) {
                c.current_dir(d);
            }
            crate::win::allow_foreground();
            c.creation_flags(0x0800_0000 | 0x0000_0200);
            c.spawn().map_err(|e| e.to_string())?;
        }
    } else {
        util::spawn_detached("sh", &["-c".into(), line], cwd.as_deref(), false).map_err(|e| e.to_string())?;
    }
    Ok(json!(true))
}
pub async fn wallpaper(a: &Args) -> R {
    let f = a.s(0)?;
    #[cfg(windows)]
    {
        return Ok(json!(blocking(move || win::set_wallpaper(&f)).await?));
    }
    #[cfg(not(windows))]
    {
        let _ = f;
        Ok(json!(false))
    }
}

// ---------- thumbnails & icons (the Windows thumbnail cache: instant for photos, videos, PDFs, Office…) ----------
pub async fn thumb(a: &Args) -> R {
    let p = a.s(0)?;
    let size = a.u(1, 256) as u32;
    // Android phones over Wi-Fi / USB debugging: a copy kept on this PC stands in for the file
    if p.starts_with("atlas:mtp|") && crate::adb::dev_of(&p).map(|d| crate::adb::is_adb_name(&d)).unwrap_or(false) {
        let Some(local) = crate::adb::cached_copy(&p).await else { return Ok(Value::Null) };
        let lp = local.to_string_lossy().to_string();
        let ext = util::ext(&lp);
        #[cfg(windows)]
        if let Some(u) = win::thumbs::get(lp.clone(), size).await {
            return Ok(json!(u));
        }
        let enc = urlencoding::encode(&lp).into_owned();
        return Ok(json!(if ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"].contains(&ext.as_str()) { format!("/f/?p={enc}") } else { format!("/media/thumb?p={enc}&w={size}") }));
    }
    #[cfg(windows)]
    return Ok(win::thumbs::get(p, size).await.map(Value::String).unwrap_or(Value::Null));
    #[cfg(not(windows))]
    {
        let _ = (p, size);
        Ok(Value::Null)
    }
}
pub async fn icon(a: &Args) -> R {
    let p = a.s(0)?;
    let size = a.s_or(1, "normal");
    #[cfg(windows)]
    return Ok(blocking(move || win::file_icon(&p, &size)).await?.map(Value::String).unwrap_or(Value::Null));
    #[cfg(not(windows))]
    {
        let _ = (p, size);
        Ok(Value::Null)
    }
}

// ---------- Recycle Bin ----------
pub async fn recycle_list() -> R {
    #[cfg(windows)]
    return Ok(json!(blocking(win::recycle_list).await?));
    #[cfg(target_os = "macos")]
    return Ok(json!([]));
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let items = blocking(|| trash::os_limited::list().unwrap_or_default()).await?;
        Ok(json!(items.iter().map(|i| json!({ "name": i.name.to_string_lossy(), "path": format!("trash:{}", i.id.to_string_lossy()), "isDir": false, "size": 0, "from": i.original_parent.to_string_lossy(), "deleted": crate::fsx::iso_ms(i.time_deleted * 1000), "modified": crate::fsx::iso_ms(i.time_deleted * 1000) })).collect::<Vec<_>>()))
    }
}
pub async fn recycle_restore(a: &Args) -> R {
    let paths = a.strs(0);
    #[cfg(windows)]
    {
        let problems = blocking(move || win::recycle_restore(&paths, false)).await?;
        return Ok(json!({ "ok": problems.is_empty(), "problems": problems }));
    }
    #[cfg(not(windows))]
    {
        let _ = paths;
        Ok(json!({ "ok": true, "problems": [] }))
    }
}
/// by original location (Undo of "move to Recycle Bin")
pub async fn recycle_restore_original(a: &Args) -> R {
    let paths = a.strs(0);
    #[cfg(windows)]
    {
        let problems = blocking(move || win::recycle_restore(&paths, true)).await?;
        return Ok(json!({ "ok": problems.is_empty(), "problems": problems }));
    }
    #[cfg(target_os = "macos")]
    let _ = paths;
    #[cfg(all(unix, not(target_os = "macos")))]
    blocking(move || {
        let want: Vec<String> = paths.iter().map(|p| util::low(p)).collect();
        if let Ok(items) = trash::os_limited::list() {
            let pick: Vec<_> = items.into_iter().filter(|i| want.contains(&util::low(&i.original_path().to_string_lossy()))).collect();
            let _ = trash::os_limited::restore_all(pick);
        }
    })
    .await?;
    Ok(json!(true))
}
pub async fn recycle_delete_forever(a: &Args) -> R {
    let paths = a.strs(0);
    #[cfg(windows)]
    blocking(move || win::recycle_delete(&paths)).await?;
    #[cfg(not(windows))]
    let _ = paths;
    Ok(json!(true))
}
pub async fn recycle_empty() -> R {
    #[cfg(windows)]
    blocking(win::recycle_empty).await?;
    Ok(json!(true))
}

// ---------- locks ----------
pub async fn who_locks(a: &Args) -> R {
    let paths = a.strs(0);
    #[cfg(windows)]
    return Ok(json!(blocking(move || win::who_locks(&paths)).await?));
    #[cfg(not(windows))]
    {
        let _ = paths;
        Ok(json!([]))
    }
}
pub async fn kill_process(a: &Args) -> R {
    let pid = a.u(0, 0);
    if IS_WIN {
        let _ = util::run("taskkill.exe", &["/PID".into(), pid.to_string(), "/F".into()], None, 15000).await;
    } else {
        let _ = util::run("kill", &["-9".into(), pid.to_string()], None, 5000).await;
    }
    Ok(json!(true))
}

// ---------- network places ----------
pub async fn net_discover(a: &Args) -> R {
    use parking_lot::Mutex;
    static CACHE: std::sync::OnceLock<Mutex<(f64, Vec<Value>)>> = std::sync::OnceLock::new();
    let c = CACHE.get_or_init(|| Mutex::new((0.0, vec![])));
    let force = a.b(0);
    {
        let g = c.lock();
        if !force && util::now_ms() - g.0 < 60000.0 && !g.1.is_empty() {
            return Ok(json!(g.1));
        }
    }
    #[cfg(windows)]
    let shell_list = tokio::task::spawn_blocking(win::network_items);
    let upnp = crate::netdiscover::ssdp_discover().await;
    #[cfg(windows)]
    let mut arr: Vec<Value> = shell_list.await.unwrap_or_default();
    #[cfg(not(windows))]
    let mut arr: Vec<Value> = vec![];
    let mut names: std::collections::HashSet<String> = arr.iter().filter_map(|x| x["name"].as_str().map(|s| s.to_lowercase())).collect();
    for d in upnp {
        let n = d["name"].as_str().unwrap_or("").to_lowercase();
        if names.insert(n) {
            arr.push(json!({ "name": d["name"], "path": "", "type": d["type"], "url": d["url"], "ip": d["ip"], "model": d["model"], "source": "ssdp" }));
        }
    }
    *c.lock() = (util::now_ms(), arr.clone());
    Ok(json!(arr))
}
pub async fn net_open(a: &Args) -> R {
    let name = a.s(0)?;
    #[cfg(windows)]
    blocking(move || win::open_network_item(&name)).await?;
    #[cfg(not(windows))]
    let _ = name;
    Ok(json!(true))
}

// ---------- phones & cameras (MTP) ----------
#[cfg(windows)]
pub async fn mtp(name: &str, a: &Args) -> R {
    let a0 = a.v(0);
    let a1 = a.v(1);
    if let Some(r) = adb_route(name, &a0, &a1).await {
        return r;
    }
    let name = name.to_string();
    blocking(move || win::mtp::call(&name, a0, a1)).await?
}
#[cfg(not(windows))]
pub async fn mtp(name: &str, a: &Args) -> R {
    let (a0, a1) = (a.v(0), a.v(1));
    if let Some(r) = adb_route(name, &a0, &a1).await {
        return r;
    }
    Err("Phones and cameras are only available on Windows".into())
}
/// Android phones connected through adb (Wi-Fi or USB debugging) have their own names: those go to adb
async fn adb_route(name: &str, a0: &Value, a1: &Value) -> Option<R> {
    let path = if name == "mtp:copyIn" { a1.as_str().map(String::from) } else { a0.as_str().map(String::from).or_else(|| a0.as_array().and_then(|v| v.first()).and_then(|x| x.as_str()).map(String::from)) };
    let dev = crate::adb::dev_of(&path?)?;
    if !crate::adb::is_adb_name(&dev) {
        return None;
    }
    Some(crate::adb::call(name, a0.clone(), a1.clone()).await)
}
pub async fn mtp_fetch(a: &Args) -> R {
    let p = a.s(0)?;
    let r: u32 = rand::random();
    let dir = std::env::temp_dir().join("dogfile-mtp").join(format!("{r:08x}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = mtp("mtp:copyOut", &Args(vec![json!([p]), json!(dir.to_string_lossy())])).await?;
    // remember where it came from, so an edited copy can go back to the phone (mtp:origin)
    let parent = match p.rsplit_once('/') {
        Some((a, _)) if a.matches('|').count() >= 2 => a.to_string(),
        _ => p.rsplitn(2, '|').nth(1).map(|a| format!("{a}|")).unwrap_or_default(),
    };
    fetched().lock().insert(dir.to_string_lossy().to_string(), parent);
    Ok(out.get(0).cloned().unwrap_or(Value::Null))
}
fn fetched() -> &'static parking_lot::Mutex<std::collections::HashMap<String, String>> {
    static F: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashMap<String, String>>> = std::sync::OnceLock::new();
    F.get_or_init(Default::default)
}
/// mtp:origin(local file): the phone folder a file opened from a phone came from (null for other files)
pub async fn mtp_origin(a: &Args) -> R {
    let p = std::path::PathBuf::from(a.s(0)?);
    let dir = p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
    Ok(fetched().lock().get(&dir).map(|x| json!(x)).unwrap_or(Value::Null))
}

// ---------- default file manager / Explorer verbs / drives ----------
pub async fn default_get() -> R {
    #[cfg(windows)]
    return Ok(json!(win::reg::is_default()));
    #[cfg(not(windows))]
    Ok(json!(false))
}
pub async fn default_set(a: &Args) -> R {
    let on = a.b(0);
    #[cfg(windows)]
    {
        win::reg::set_default(on);
        return Ok(json!(win::reg::is_default()));
    }
    #[cfg(not(windows))]
    {
        let _ = on;
        Ok(json!(false))
    }
}
pub async fn shellverbs_set(a: &Args) -> R {
    let on = a.b(0);
    #[cfg(windows)]
    win::reg::set_shell_verbs(on);
    #[cfg(not(windows))]
    let _ = on;
    Ok(json!(true))
}
pub async fn eject(a: &Args) -> R {
    let letter = a.s(0)?;
    #[cfg(windows)]
    {
        blocking(move || win::eject(&letter)).await??;
        return Ok(json!({}));
    }
    #[cfg(not(windows))]
    {
        let _ = letter;
        Ok(json!({}))
    }
}
