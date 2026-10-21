// Small helpers: times, extensions, hidden/system attributes, folders to skip.
use std::fs::Metadata;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const SKIP_DIRS: [&str; 6] = ["$Recycle.Bin", "System Volume Information", "$WinREAgent", "Config.Msi", "WinSxS", "$SysReset"];

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

pub fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => name[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

#[derive(Default, Clone, Copy, Debug)]
pub struct Attrs {
    pub hidden: bool,
    pub system: bool,
    pub readonly: bool,
}

#[cfg(windows)]
pub fn attrs(md: &Metadata, _name: &str) -> Attrs {
    use std::os::windows::fs::MetadataExt;
    let a = md.file_attributes();
    Attrs { hidden: a & 0x2 != 0, system: a & 0x4 != 0, readonly: a & 0x1 != 0 }
}
#[cfg(not(windows))]
pub fn attrs(md: &Metadata, name: &str) -> Attrs {
    Attrs { hidden: name.starts_with('.'), system: false, readonly: md.permissions().readonly() }
}

/// Created time (birth time where the system has one).
pub fn ctime(md: &Metadata) -> f64 {
    let c = ms(md.created());
    if c != 0.0 {
        c
    } else {
        ms(md.modified())
    }
}

pub fn is_skip_dir(name: &str) -> bool {
    SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(name))
}

pub fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Windows paths compare without case; elsewhere exactly.
pub fn same_path_prefix(path: &str, prefix: &str) -> bool {
    let (a, b) = (path.trim_end_matches(['\\', '/']), prefix.trim_end_matches(['\\', '/']));
    if a.len() < b.len() {
        return false;
    }
    let head = &a[..b.len()];
    let eq = if cfg!(windows) { head.eq_ignore_ascii_case(b) } else { head == b };
    eq && (a.len() == b.len() || matches!(a.as_bytes()[b.len()], b'\\' | b'/') || b.is_empty() || b.ends_with(':'))
}

/// Run this thread at background priority (also lowers its disk and memory priority on Windows).
#[cfg(windows)]
pub fn lower_thread_priority() {
    unsafe extern "system" {
        fn GetCurrentThread() -> isize;
        fn SetThreadPriority(h: isize, p: i32) -> i32;
    }
    const THREAD_MODE_BACKGROUND_BEGIN: i32 = 0x0001_0000;
    unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN); }
}
#[cfg(not(windows))]
pub fn lower_thread_priority() {
    unsafe extern "C" {
        fn nice(inc: i32) -> i32;
    }
    unsafe { nice(10); }
}
