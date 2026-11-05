// The only door to the disk. The engine never touches a file except through an `Env`, so the tests can swap in one that
// fails on purpose (to prove nothing is lost when something goes wrong half way) or stops dead (to prove a crash is
// recovered from).
use super::tree::Kind;
use std::io::{self, Read, Write};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Meta {
    pub kind: Kind,
    pub size: u64,
    pub mtime: i64,
}

pub trait Env: Send + Sync {
    /// what is at the path now (never follows a link); None when nothing is there
    fn stat(&self, p: &Path) -> io::Result<Option<Meta>>;
    /// the names directly in a folder
    fn list(&self, p: &Path) -> io::Result<Vec<(String, Meta)>>;
    /// move or rename; fails when the target exists: nothing is ever replaced
    fn rename_new(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// make a folder; fails when it exists
    fn mkdir(&self, p: &Path) -> io::Result<()>;
    /// copy the content of a file into a new file (fails when `to` exists) and give it the original's date
    fn copy_new(&self, from: &Path, to: &Path) -> io::Result<()>;
    fn remove_file(&self, p: &Path) -> io::Result<()>;
    /// an empty folder only
    fn remove_dir(&self, p: &Path) -> io::Result<()>;
    /// to the Recycle Bin (never deleted for good)
    fn trash(&self, p: &Path) -> Result<(), String>;
    /// out of the Recycle Bin to where they were, by the path they had when they were recycled
    fn bin_restore(&self, paths: &[String]) -> Result<(), String>;
    fn bin_has(&self, p: &Path) -> bool;
    /// can things be recycled from here
    fn has_bin(&self, p: &Path) -> bool;
    /// the folder is on a disk that tells upper and lower case apart
    fn case_insensitive(&self, p: &Path) -> bool;
    /// a test env that has been told to stop dead: the engine must return at once without cleaning up
    fn crashed(&self) -> bool {
        false
    }
}

fn kind_of(m: &std::fs::Metadata) -> Kind {
    let ft = m.file_type();
    if ft.is_symlink() {
        return Kind::Link;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // a junction or any other reparse point (OneDrive placeholders included) is not walked into
        if m.file_attributes() & 0x400 != 0 {
            return Kind::Link;
        }
    }
    if ft.is_dir() {
        Kind::Dir
    } else if ft.is_file() {
        Kind::File
    } else {
        Kind::Link
    }
}
pub fn meta_of(m: &std::fs::Metadata) -> Meta {
    let mtime = m.modified().ok().map(|t| match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(e) => -(e.duration().as_secs() as i64),
    });
    Meta { kind: kind_of(m), size: if m.is_dir() { 0 } else { m.len() }, mtime: mtime.unwrap_or(0) }
}

pub struct RealEnv;

impl Env for RealEnv {
    fn stat(&self, p: &Path) -> io::Result<Option<Meta>> {
        match std::fs::symlink_metadata(p) {
            Ok(m) => Ok(Some(meta_of(&m))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
    fn list(&self, p: &Path) -> io::Result<Vec<(String, Meta)>> {
        let mut v = vec![];
        for e in std::fs::read_dir(p)? {
            let e = e?;
            let m = match std::fs::symlink_metadata(e.path()) {
                Ok(m) => m,
                Err(_) => continue,
            };
            v.push((e.file_name().to_string_lossy().to_string(), meta_of(&m)));
        }
        Ok(v)
    }
    fn rename_new(&self, from: &Path, to: &Path) -> io::Result<()> {
        rename_noreplace(from, to)
    }
    fn mkdir(&self, p: &Path) -> io::Result<()> {
        std::fs::create_dir(p)
    }
    fn copy_new(&self, from: &Path, to: &Path) -> io::Result<()> {
        let mut src = std::fs::File::open(from)?;
        let mtime = src.metadata()?.modified().ok();
        let mut dst = std::fs::OpenOptions::new().write(true).create_new(true).open(to)?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n])?;
        }
        dst.sync_all()?;
        drop(dst);
        if let Some(t) = mtime {
            let _ = filetime::set_file_mtime(to, filetime::FileTime::from_system_time(t));
        }
        Ok(())
    }
    fn remove_file(&self, p: &Path) -> io::Result<()> {
        std::fs::remove_file(p)
    }
    fn remove_dir(&self, p: &Path) -> io::Result<()> {
        std::fs::remove_dir(p)
    }
    fn trash(&self, p: &Path) -> Result<(), String> {
        #[cfg(windows)]
        if !crate::win::has_recycle_bin(&p.to_string_lossy()) {
            return Err("this drive has no Recycle Bin".into());
        }
        trash::delete(p).map_err(|e| e.to_string())
    }
    fn bin_restore(&self, paths: &[String]) -> Result<(), String> {
        #[cfg(windows)]
        {
            let problems = crate::win::recycle_restore(paths, true);
            if problems.is_empty() { Ok(()) } else { Err(format!("{problems:?}")) }
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let want: Vec<String> = paths.iter().map(|p| crate::util::low(p)).collect();
            let items = trash::os_limited::list().map_err(|e| e.to_string())?;
            let pick: Vec<_> = items.into_iter().filter(|i| want.contains(&crate::util::low(&i.original_path().to_string_lossy()))).collect();
            trash::os_limited::restore_all(pick).map_err(|e| e.to_string())
        }
        #[cfg(target_os = "macos")]
        {
            let _ = paths;
            Err("restoring from the Trash isn’t supported here".into())
        }
    }
    fn bin_has(&self, p: &Path) -> bool {
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let w = crate::util::low(&p.to_string_lossy());
            return trash::os_limited::list().map(|v| v.iter().any(|i| crate::util::low(&i.original_path().to_string_lossy()) == w)).unwrap_or(false);
        }
        #[allow(unreachable_code)]
        {
            let _ = p;
            true
        }
    }
    fn has_bin(&self, p: &Path) -> bool {
        #[cfg(windows)]
        {
            return crate::win::has_recycle_bin(&p.to_string_lossy());
        }
        #[allow(unreachable_code)]
        {
            let _ = p;
            true
        }
    }
    fn case_insensitive(&self, p: &Path) -> bool {
        let _ = p;
        cfg!(windows) || cfg!(target_os = "macos")
    }
}

/// Rename that refuses to replace. The standard library's rename replaces a file that is already there, which here
/// would destroy someone's file, so each system's own no-replace call is used.
pub fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        return crate::win::move_no_replace(from, to);
    }
    #[cfg(target_os = "linux")]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let f = CString::new(from.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        let t = CString::new(to.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        let r = unsafe { libc::renameat2(libc::AT_FDCWD, f.as_ptr(), libc::AT_FDCWD, t.as_ptr(), libc::RENAME_NOREPLACE) };
        if r == 0 {
            return Ok(());
        }
        let e = io::Error::last_os_error();
        // a file system without the flag (some network shares): look first, then rename
        if e.raw_os_error() == Some(libc::EINVAL) || e.raw_os_error() == Some(libc::ENOSYS) {
            if std::fs::symlink_metadata(to).is_ok() {
                return Err(io::Error::from(io::ErrorKind::AlreadyExists));
            }
            return std::fs::rename(from, to);
        }
        Err(e)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        if std::fs::symlink_metadata(to).is_ok() {
            return Err(io::Error::from(io::ErrorKind::AlreadyExists));
        }
        std::fs::rename(from, to)
    }
}
