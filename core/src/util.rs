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
    /// a cloud placeholder (OneDrive "online-only"): reading its content downloads it
    pub cloud: bool,
}
/// FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | RECALL_ON_OPEN | OFFLINE
pub const CLOUD_ATTRS: u32 = 0x0040_0000 | 0x0004_0000 | 0x0000_1000;
/// Is this file only in the cloud (reading it would download it)? Searching contents, hashing and duplicate checks skip these.
#[cfg(windows)]
pub fn online_only(p: &std::path::Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    std::fs::symlink_metadata(p).map(|m| m.file_attributes() & CLOUD_ATTRS != 0).unwrap_or(false)
}
#[cfg(not(windows))]
pub fn online_only(_p: &std::path::Path) -> bool {
    false
}

#[cfg(windows)]
pub fn attrs(md: &Metadata, _name: &str) -> Attrs {
    use std::os::windows::fs::MetadataExt;
    let a = md.file_attributes();
    Attrs { hidden: a & 0x2 != 0, system: a & 0x4 != 0, readonly: a & 0x1 != 0, cloud: a & CLOUD_ATTRS != 0 }
}
#[cfg(not(windows))]
pub fn attrs(md: &Metadata, name: &str) -> Attrs {
    Attrs { hidden: name.starts_with('.'), system: false, readonly: md.permissions().readonly(), cloud: false }
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

/// Leave Windows' own folders and programs out of the index (the default): they hold a large share of a system
/// drive's files and nobody searches them for their documents. `top` is true for folders at the drive's top.
pub static INDEX_SYSTEM: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const SYSTEM_TOP: [&str; 10] = ["Windows", "Program Files", "Program Files (x86)", "ProgramData", "$Windows.~BT", "$Windows.~WS", "Recovery", "PerfLogs", "MSOCache", "$GetCurrent"];
pub fn index_skip(name: &str, top: bool) -> bool {
    if is_skip_dir(name) { return true }
    if INDEX_SYSTEM.load(std::sync::atomic::Ordering::Relaxed) { return false }
    if top && cfg!(windows) && SYSTEM_TOP.iter().any(|s| s.eq_ignore_ascii_case(name)) { return true }
    name.eq_ignore_ascii_case("AppData")
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
