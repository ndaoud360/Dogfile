// Small shared helpers: paths, times, running programs without a console window.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const IS_WIN: bool = cfg!(windows);

pub fn ms(t: std::io::Result<SystemTime>) -> f64 {
    match t {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_millis() as f64,
            Err(e) => -(e.duration().as_millis() as f64),
        },
        Err(_) => 0.0,
    }
}
pub fn now_ms() -> f64 {
    ms(Ok(SystemTime::now()))
}
pub fn time_from_ms(v: f64) -> SystemTime {
    if v >= 0.0 { UNIX_EPOCH + Duration::from_millis(v as u64) } else { UNIX_EPOCH }
}

pub fn basename(p: &str) -> String {
    let t = p.trim_end_matches(['\\', '/']);
    match t.rfind(['\\', '/']) {
        Some(i) => t[i + 1..].to_string(),
        None => t.to_string(),
    }
}
pub fn dirname(p: &str) -> String {
    Path::new(p).parent().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default()
}
/// extension without the dot, lower case ("" for none)
pub fn ext(p: &str) -> String {
    let b = basename(p);
    match b.rfind('.') {
        Some(i) if i > 0 && i + 1 < b.len() => b[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}
pub fn low(p: &str) -> String {
    if IS_WIN { p.to_lowercase() } else { p.to_string() }
}
pub fn same_path(a: &str, b: &str) -> bool {
    let n = |s: &str| low(s.trim_end_matches(['\\', '/']));
    n(a) == n(b)
}
/// child is parent or inside it
pub fn is_inside(child: &str, parent: &str) -> bool {
    let c = low(child);
    let p = low(parent.trim_end_matches(['\\', '/']));
    c == p || (c.starts_with(&p) && matches!(c.as_bytes().get(p.len()), Some(b'\\') | Some(b'/')))
}
pub fn same_volume(a: &str, b: &str) -> bool {
    if !IS_WIN {
        return true;
    }
    let root = |s: &str| -> String {
        let p = Path::new(s);
        p.components().next().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).unwrap_or_default()
    };
    root(a) == root(b)
}
pub fn join(dir: &str, name: &str) -> String {
    Path::new(dir).join(name).to_string_lossy().into_owned()
}

pub fn exists(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// "name - Copy.ext" (style copy) or "name (2).ext" (style number) that doesn't exist yet in dir
pub fn unique_name(dir: &str, name: &str, style: &str) -> String {
    let (base, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let first = join(dir, name);
    if !exists(Path::new(&first)) {
        return first;
    }
    for i in 1..10000 {
        let n = if style == "copy" {
            if i == 1 { format!("{base} - Copy{ext}") } else { format!("{base} - Copy ({i}){ext}") }
        } else {
            format!("{base} ({}){ext}", i + 1)
        };
        let c = join(dir, &n);
        if !exists(Path::new(&c)) {
            return c;
        }
    }
    first
}

pub fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    let md = std::fs::symlink_metadata(src)?;
    if md.is_dir() {
        std::fs::create_dir_all(dst)?;
        for e in std::fs::read_dir(src)? {
            let e = e?;
            copy_tree(&e.path(), &dst.join(e.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::copy(src, dst).map(|_| ())
    }
}
pub fn dir_size(p: &Path) -> u64 {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| dir_size(&e.path())).sum()).unwrap_or(0),
        Ok(m) => crate::demo::size(p, m.len()),
        Err(_) => 0,
    }
}

/// A program started without a console window flashing up.
pub fn cmd(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c.kill_on_drop(true);
    c
}
pub fn std_cmd(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}
/// Start something that keeps running on its own (an app, a terminal…).
pub fn spawn_detached(program: &str, args: &[String], cwd: Option<&str>, show_window: bool) -> std::io::Result<()> {
    let mut c = std::process::Command::new(program);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(d) = cwd.filter(|d| !d.is_empty() && Path::new(d).is_dir()) {
        c.current_dir(d);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        crate::win::allow_foreground();
        // DETACHED_PROCESS for console helpers we don't want to see; GUI apps show their own windows
        c.creation_flags(if show_window { 0x0000_0200 } else { 0x0800_0000 | 0x0000_0200 });
    }
    #[cfg(not(windows))]
    let _ = show_window;
    c.spawn().map(|_| ())
}

pub struct Output {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
impl Output {
    pub fn out(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn err(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}
/// Run a program and collect what it prints (killed after the timeout).
pub async fn run(program: impl AsRef<std::ffi::OsStr>, args: &[String], cwd: Option<&Path>, timeout_ms: u64) -> std::io::Result<Output> {
    let mut c = cmd(program);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    let child = c.spawn()?;
    let fut = child.wait_with_output();
    let o = if timeout_ms > 0 {
        match tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await {
            Ok(r) => r?,
            Err(_) => return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out")),
        }
    } else {
        fut.await?
    };
    Ok(Output { ok: o.status.success(), code: o.status.code(), stdout: o.stdout, stderr: o.stderr })
}

/// Full path of a program on PATH.
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if IS_WIN && !name.contains('.') { vec![".exe".into(), ".cmd".into(), ".bat".into()] } else { vec![String::new()] };
    for dir in std::env::split_paths(&path) {
        for e in &exts {
            let p = dir.join(format!("{name}{e}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

pub fn last_line(s: &str) -> String {
    s.trim().lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("").to_string()
}

pub fn temp_dir(tag: &str) -> std::io::Result<PathBuf> {
    let r: u64 = rand::random();
    let d = std::env::temp_dir().join(format!("dogfile-{tag}-{r:x}"));
    std::fs::create_dir_all(&d)?;
    Ok(d)
}

pub fn b64(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}
pub fn unb64(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s.trim()).map_err(|e| e.to_string())
}
pub fn uuid() -> String {
    let a: u128 = rand::random();
    format!("{a:032x}")
}

/// one shared web client (rustls, gzip), with Dogfile's user agent
pub fn http() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().user_agent("Dogfile/2.0 ( https://github.com/ndaoud360/Dogfile )").connect_timeout(Duration::from_secs(15)).build().unwrap_or_default())
}
