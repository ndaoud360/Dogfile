// Parallel folder walker. Every folder is read on the thread pool, so big trees are read many folders at a
// time. On Windows the size, dates and attributes come with the folder listing itself (no extra call per file).
use crate::util::{self, Attrs};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[derive(Clone, Debug)]
pub struct Ent {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    pub mtime: f64,
    pub ctime: f64,
    pub atime: f64,
    pub attrs: Attrs,
}

impl Ent {
    pub fn from_dir_entry(d: &fs::DirEntry) -> Option<Ent> {
        let ft = d.file_type().ok()?;
        let is_link = ft.is_symlink();
        let md = d.metadata().ok()?; // symlink_metadata on unix; cached find data on Windows
        let name = d.file_name().to_string_lossy().into_owned();
        let attrs = util::attrs(&md, &name);
        // a link to a folder counts as a folder, but is never walked into
        let is_dir = if is_link { fs::metadata(d.path()).map(|m| m.is_dir()).unwrap_or(false) } else { ft.is_dir() };
        Some(Ent {
            path: d.path(),
            name,
            is_dir,
            is_link,
            size: if is_dir { 0 } else { md.len() },
            mtime: util::ms(md.modified()),
            ctime: util::ctime(&md),
            atime: util::ms(md.accessed()),
            attrs,
        })
    }
    pub fn from_path(p: &Path) -> Option<Ent> {
        let md = fs::symlink_metadata(p).ok()?;
        let is_link = md.file_type().is_symlink();
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| util::path_str(p));
        let attrs = util::attrs(&md, &name);
        let is_dir = if is_link { fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false) } else { md.is_dir() };
        Some(Ent {
            path: p.to_path_buf(),
            name,
            is_dir,
            is_link,
            size: if is_dir { 0 } else { md.len() },
            mtime: util::ms(md.modified()),
            ctime: util::ctime(&md),
            atime: util::ms(md.accessed()),
            attrs,
        })
    }
}

pub struct WalkOpts<'a> {
    pub recursive: bool,
    pub skip_dirs: &'a [String],
    pub cancel: Option<&'a AtomicBool>,
}

/// What the visitor wants for a folder it was shown.
#[derive(PartialEq)]
pub enum Visit {
    Continue,
    SkipChildren,
}

/// Walk `roots` in parallel. `visit(parent, entry)` is called for every entry (from many threads at once);
/// `dir_done(dir, count)` after each folder is read. Returns how many entries were seen.
pub fn walk<V, D>(roots: &[PathBuf], opts: &WalkOpts, visit: V, dir_done: D) -> u64
where
    V: Fn(&Path, &Ent) -> Visit + Sync,
    D: Fn(&Path, usize) + Sync,
{
    let seen = AtomicU64::new(0);
    rayon::scope(|s| {
        for r in roots {
            let r = r.clone();
            let (visit, dir_done, seen) = (&visit, &dir_done, &seen);
            s.spawn(move |s| read_dir_rec(s, r, opts, visit, dir_done, seen));
        }
    });
    seen.load(Ordering::Relaxed)
}

fn read_dir_rec<'s, V, D>(s: &rayon::Scope<'s>, dir: PathBuf, opts: &'s WalkOpts<'s>, visit: &'s V, dir_done: &'s D, seen: &'s AtomicU64)
where
    V: Fn(&Path, &Ent) -> Visit + Sync,
    D: Fn(&Path, usize) + Sync,
{
    if opts.cancel.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
        return;
    }
    let rd = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => {
            dir_done(&dir, usize::MAX);
            return;
        }
    };
    let mut n = 0usize;
    let mut subdirs: Vec<PathBuf> = Vec::new();
    for d in rd.flatten() {
        let Some(e) = Ent::from_dir_entry(&d) else { continue };
        n += 1;
        seen.fetch_add(1, Ordering::Relaxed);
        let v = visit(&dir, &e);
        if e.is_dir && !e.is_link && opts.recursive && v == Visit::Continue && !util::is_skip_dir(&e.name) && !opts.skip_dirs.iter().any(|x| x == &e.name) {
            subdirs.push(e.path);
        }
    }
    dir_done(&dir, n);
    for sd in subdirs {
        s.spawn(move |s| read_dir_rec(s, sd, opts, visit, dir_done, seen));
    }
}
