// The instant index: every file and folder on the chosen drives, kept in memory in a compact form and saved to
// disk, so searching a whole drive takes milliseconds and folder sizes are known without reading folders.
//
// One Tree per indexed root (usually a drive). Entries live in flat arrays (about 32 bytes each plus the name);
// names are stored once, with an ASCII-lowercase copy for fast case-insensitive matching. Folder sizes are kept
// up to date as files change. A watcher keeps the tree in sync while Dogfile runs; on start the saved index loads
// at once and a background rescan (or, with administrator rights on NTFS, a read of the master file table)
// catches up with anything that changed while Dogfile was closed.
use crate::matcher::Spec;
use crate::proto;
use crate::util;
use crate::walk::Ent;
use rayon::prelude::*;
use serde_json::{json, Value};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

pub const F_DIR: u16 = 1;
pub const F_HIDDEN: u16 = 2;
pub const F_SYSTEM: u16 = 4;
pub const F_DELETED: u16 = 8;
pub const F_LINK: u16 = 16;
const NONE: u32 = u32::MAX;

#[derive(Clone, Copy, Debug)]
pub struct E {
    pub parent: u32,
    pub name_off: u32,
    pub name_len: u16,
    pub flags: u16,
    pub size: u64, // files: size; folders: total size of everything inside
    pub mtime: i64,
    pub files: u32, // folders: number of files inside (all levels)
}

#[derive(Default)]
pub struct Tree {
    pub root: String, // "C:\" or "/home/me"
    pub entries: Vec<E>,
    pub names: Vec<u8>,
    /// each folder's first child and each entry's next sibling (a linked list per folder: 8 bytes an entry)
    pub first: Vec<u32>,
    pub next: Vec<u32>,
    pub deleted: usize,
    pub built_at: f64,
    pub method: String,
}

fn sep() -> char {
    if cfg!(windows) { '\\' } else { '/' }
}
fn eq_name(a: &[u8], b: &str) -> bool {
    if cfg!(windows) { a.eq_ignore_ascii_case(b.as_bytes()) } else { a == b.as_bytes() }
}

impl Tree {
    pub fn new(root: &str, method: &str) -> Tree {
        let mut t = Tree { root: root.to_string(), method: method.into(), built_at: util::now_ms(), ..Default::default() };
        t.entries.push(E { parent: NONE, name_off: 0, name_len: 0, flags: F_DIR, size: 0, mtime: 0, files: 0 });
        t.first.push(NONE);
        t.next.push(NONE);
        t
    }
    /// the children of a folder
    pub fn kids(&self, parent: u32) -> Kids<'_> {
        Kids { t: self, cur: self.first.get(parent as usize).copied().unwrap_or(NONE) }
    }
    pub fn live(&self) -> usize {
        self.entries.len() - self.deleted
    }
    pub fn name(&self, i: u32) -> &str {
        let e = &self.entries[i as usize];
        std::str::from_utf8(&self.names[e.name_off as usize..e.name_off as usize + e.name_len as usize]).unwrap_or("")
    }
    fn name_bytes(&self, i: u32) -> &[u8] {
        let e = &self.entries[i as usize];
        &self.names[e.name_off as usize..e.name_off as usize + e.name_len as usize]
    }
    /// Add an entry under `parent` (no size bookkeeping; see `insert`).
    pub fn push(&mut self, parent: u32, name: &str, flags: u16, size: u64, mtime: i64) -> u32 {
        let off = self.names.len() as u32;
        let nm = if name.len() > u16::MAX as usize { &name[..u16::MAX as usize] } else { name };
        self.names.extend_from_slice(nm.as_bytes());
        let i = self.entries.len() as u32;
        self.entries.push(E { parent, name_off: off, name_len: nm.len() as u16, flags, size, mtime, files: 0 });
        self.first.push(NONE);
        self.next.push(self.first[parent as usize]);
        self.first[parent as usize] = i;
        i
    }
    pub fn path(&self, mut i: u32) -> String {
        let mut parts: Vec<&str> = Vec::new();
        while i != 0 && i != NONE {
            parts.push(self.name(i));
            i = self.entries[i as usize].parent;
        }
        let mut s = self.root.clone();
        for (k, p) in parts.iter().rev().enumerate() {
            if k > 0 || !s.ends_with(['\\', '/']) { s.push(sep()) }
            s.push_str(p);
        }
        s
    }
    /// Recompute every folder's total size and file count (after a build or load).
    pub fn aggregate(&mut self) {
        for e in self.entries.iter_mut() { if e.flags & F_DIR != 0 { e.size = 0; e.files = 0 } }
        // children always come after their parent in build order, so walking backwards adds each total upward
        for i in (1..self.entries.len()).rev() {
            let e = self.entries[i];
            if e.flags & F_DELETED != 0 || e.parent == NONE { continue }
            let (s, f) = if e.flags & F_DIR != 0 { (e.size, e.files) } else if e.flags & F_LINK != 0 { (0, 0) } else { (e.size, 1) };
            let p = &mut self.entries[e.parent as usize];
            p.size += s;
            p.files += f;
        }
    }
    fn add_up(&mut self, mut p: u32, ds: i64, df: i64) {
        while p != NONE {
            let e = &mut self.entries[p as usize];
            e.size = (e.size as i64 + ds).max(0) as u64;
            e.files = (e.files as i64 + df).max(0) as u32;
            p = e.parent;
        }
    }
    fn child(&self, parent: u32, name: &str) -> Option<u32> {
        self.kids(parent).find(|&c| self.entries[c as usize].flags & F_DELETED == 0 && eq_name(self.name_bytes(c), name))
    }
    fn rel_parts<'a>(&self, path: &'a str) -> Option<Vec<&'a str>> {
        if !util::same_path_prefix(path, &self.root) { return None }
        let rest = &path[self.root.trim_end_matches(['\\', '/']).len().min(path.len())..];
        Some(rest.split(['\\', '/']).filter(|s| !s.is_empty()).collect())
    }
    pub fn lookup(&self, path: &str) -> Option<u32> {
        let mut i = 0u32;
        for part in self.rel_parts(path)? { i = self.child(i, part)? }
        Some(i)
    }
    fn is_under(&self, mut i: u32, anc: u32) -> bool {
        if anc == 0 { return true }
        while i != NONE { if i == anc { return true } i = self.entries[i as usize].parent }
        false
    }

    // ---- live updates ----
    fn flags_of(e: &Ent) -> u16 {
        (if e.is_dir { F_DIR } else { 0 }) | (if e.attrs.hidden || e.name.starts_with('.') && !cfg!(windows) { F_HIDDEN } else { 0 }) | (if e.attrs.system { F_SYSTEM } else { 0 }) | (if e.is_link { F_LINK } else { 0 })
    }
    /// A path was created or changed: add it (with its parents, and its contents if it's a new folder) or
    /// refresh its size and date.
    pub fn upsert(&mut self, path: &Path) {
        let ps = util::path_str(path);
        let Some(parts) = self.rel_parts(&ps) else { return };
        if parts.is_empty() { return }
        if parts.iter().any(|p| util::is_skip_dir(p)) { return }
        let mut cur = 0u32;
        let mut built = PathBuf::from(&self.root);
        for (k, part) in parts.iter().enumerate() {
            built.push(part);
            let last = k == parts.len() - 1;
            match self.child(cur, part) {
                Some(c) => {
                    if last {
                        if let Some(e) = Ent::from_path(&built) {
                            let old = self.entries[c as usize];
                            if old.flags & F_DIR == 0 && !e.is_dir {
                                let ds = e.size as i64 - old.size as i64;
                                let en = &mut self.entries[c as usize];
                                en.size = e.size;
                                en.mtime = e.mtime as i64;
                                en.flags = Tree::flags_of(&e);
                                if ds != 0 && old.flags & F_LINK == 0 { self.add_up(old.parent, ds, 0) }
                            } else if (old.flags & F_DIR != 0) != e.is_dir {
                                self.remove_idx(c);
                                self.insert_new(cur, &e);
                            } else {
                                self.entries[c as usize].mtime = e.mtime as i64;
                            }
                        }
                    }
                    cur = c;
                }
                None => {
                    let Some(e) = Ent::from_path(&built) else { return };
                    cur = self.insert_new(cur, &e);
                    // a brand-new folder: everything inside it was just inserted too
                    return;
                }
            }
        }
    }
    fn insert_new(&mut self, parent: u32, e: &Ent) -> u32 {
        let i = self.push(parent, &e.name, Tree::flags_of(e), if e.is_dir { 0 } else { e.size }, e.mtime as i64);
        if !e.is_dir {
            if !e.is_link { self.add_up(parent, e.size as i64, 1) }
            return i;
        }
        if e.is_link { return i }
        // fill a new folder (rare and usually small: a folder copied or extracted in)
        let mut stack = vec![(e.path.clone(), i)];
        while let Some((dir, di)) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for d in rd.flatten() {
                let Some(c) = Ent::from_dir_entry(&d) else { continue };
                if c.is_dir && util::is_skip_dir(&c.name) { continue }
                let ci = self.push(di, &c.name, Tree::flags_of(&c), if c.is_dir { 0 } else { c.size }, c.mtime as i64);
                if c.is_dir { if !c.is_link { stack.push((c.path.clone(), ci)) } } else if !c.is_link { self.add_up(di, c.size as i64, 1) }
            }
        }
        i
    }
    pub fn remove_path(&mut self, path: &Path) {
        if let Some(i) = self.lookup(&util::path_str(path)) { if i != 0 { self.remove_idx(i) } }
    }
    fn remove_idx(&mut self, i: u32) {
        let e = self.entries[i as usize];
        if e.flags & F_DELETED != 0 { return }
        let (s, f) = if e.flags & F_DIR != 0 { (e.size, e.files) } else if e.flags & F_LINK != 0 { (0, 0) } else { (e.size, 1) };
        self.add_up(e.parent, -(s as i64), -(f as i64));
        // unlink from the parent's list
        let p = e.parent as usize;
        if self.first[p] == i { self.first[p] = self.next[i as usize] } else {
            let mut c = self.first[p];
            while c != NONE { let n = self.next[c as usize]; if n == i { self.next[c as usize] = self.next[i as usize]; break } c = n }
        }
        let mut stack = vec![i];
        while let Some(x) = stack.pop() {
            self.entries[x as usize].flags |= F_DELETED;
            self.deleted += 1;
            stack.extend(self.kids(x));
            self.first[x as usize] = NONE;
        }
    }
    /// Drop deleted entries (keeps parents before children).
    pub fn compact(&mut self) {
        let mut t = Tree { root: self.root.clone(), built_at: self.built_at, method: self.method.clone(), ..Default::default() };
        t.entries.push(self.entries[0]);
        let mut stack: Vec<(u32, u32)> = vec![(0, 0)];
        while let Some((old, new)) = stack.pop() {
            let kids: Vec<u32> = self.kids(old).collect();
            for c in kids {
                let e = self.entries[c as usize];
                if e.flags & F_DELETED != 0 { continue }
                let ni = t.push(new, self.name(c), e.flags, e.size, e.mtime);
                t.entries[ni as usize].files = e.files;
                if e.flags & F_DIR != 0 { stack.push((c, ni)) }
            }
        }
        *self = t;
    }

    // ---- saving ----
    pub fn save(&self, file: &Path) -> std::io::Result<()> {
        let tmp = file.with_extension("tmp");
        {
            let mut w = BufWriter::with_capacity(1 << 20, std::fs::File::create(&tmp)?);
            w.write_all(b"ATIX")?;
            w.write_all(&2u32.to_le_bytes())?;
            let wstr = |w: &mut BufWriter<std::fs::File>, s: &str| -> std::io::Result<()> { w.write_all(&(s.len() as u32).to_le_bytes())?; w.write_all(s.as_bytes()) };
            wstr(&mut w, &self.root)?;
            wstr(&mut w, &self.method)?;
            w.write_all(&self.built_at.to_le_bytes())?;
            let live: Vec<u32> = (0..self.entries.len() as u32).collect();
            w.write_all(&(live.len() as u32).to_le_bytes())?;
            for e in &self.entries {
                w.write_all(&e.parent.to_le_bytes())?;
                w.write_all(&e.name_off.to_le_bytes())?;
                w.write_all(&e.name_len.to_le_bytes())?;
                w.write_all(&e.flags.to_le_bytes())?;
                w.write_all(&e.size.to_le_bytes())?;
                w.write_all(&e.mtime.to_le_bytes())?;
            }
            w.write_all(&(self.names.len() as u32).to_le_bytes())?;
            w.write_all(&self.names)?;
            w.flush()?;
        }
        std::fs::rename(&tmp, file)
    }
    pub fn load(file: &Path) -> std::io::Result<Tree> {
        let mut r = BufReader::with_capacity(1 << 20, std::fs::File::open(file)?);
        let mut b4 = [0u8; 4];
        let mut b8 = [0u8; 8];
        let mut b2 = [0u8; 2];
        r.read_exact(&mut b4)?;
        if &b4 != b"ATIX" { return Err(std::io::Error::other("not an index")) }
        r.read_exact(&mut b4)?;
        if u32::from_le_bytes(b4) != 2 { return Err(std::io::Error::other("old index")) }
        let mut rstr = |r: &mut BufReader<std::fs::File>| -> std::io::Result<String> { let mut l = [0u8; 4]; r.read_exact(&mut l)?; let mut v = vec![0u8; u32::from_le_bytes(l) as usize]; r.read_exact(&mut v)?; Ok(String::from_utf8_lossy(&v).into_owned()) };
        let root = rstr(&mut r)?;
        let method = rstr(&mut r)?;
        r.read_exact(&mut b8)?;
        let built_at = f64::from_le_bytes(b8);
        r.read_exact(&mut b4)?;
        let n = u32::from_le_bytes(b4) as usize;
        let mut entries = Vec::with_capacity(n);
        for _ in 0..n {
            r.read_exact(&mut b4)?; let parent = u32::from_le_bytes(b4);
            r.read_exact(&mut b4)?; let name_off = u32::from_le_bytes(b4);
            r.read_exact(&mut b2)?; let name_len = u16::from_le_bytes(b2);
            r.read_exact(&mut b2)?; let flags = u16::from_le_bytes(b2);
            r.read_exact(&mut b8)?; let size = u64::from_le_bytes(b8);
            r.read_exact(&mut b8)?; let mtime = i64::from_le_bytes(b8);
            entries.push(E { parent, name_off, name_len, flags, size, mtime, files: 0 });
        }
        r.read_exact(&mut b4)?;
        let mut names = vec![0u8; u32::from_le_bytes(b4) as usize];
        r.read_exact(&mut names)?;
        let n = entries.len();
        let mut t = Tree { root, entries, names, first: vec![NONE; n], next: vec![NONE; n], deleted: 0, built_at, method };
        for i in 1..t.entries.len() as u32 {
            let e = t.entries[i as usize];
            if e.flags & F_DELETED != 0 { t.deleted += 1; continue }
            t.next[i as usize] = t.first[e.parent as usize];
            t.first[e.parent as usize] = i;
        }
        t.aggregate();
        Ok(t)
    }
}

/// Build a tree by walking the folders (works everywhere, no special rights).
pub struct Kids<'a> {
    t: &'a Tree,
    cur: u32,
}
impl Iterator for Kids<'_> {
    type Item = u32;
    fn next(&mut self) -> Option<u32> {
        if self.cur == NONE { return None }
        let c = self.cur;
        self.cur = self.t.next[c as usize];
        Some(c)
    }
}

pub fn build_by_walk(root: &str, cancel: &AtomicBool, progress: &(dyn Fn(u64) + Sync)) -> Tree {
    // One folder level at a time: the folders of a level are read in parallel (on the small background pool),
    // then added in order, so parents always come before children and only one level's listings are held.
    let mut t = Tree::new(root, "scan");
    let mut frontier: Vec<(u32, PathBuf)> = vec![(0, PathBuf::from(root))];
    let mut n = 0u64;
    while !frontier.is_empty() && !cancel.load(Ordering::Relaxed) {
        let lists: Vec<(u32, Vec<Ent>)> = background_pool().install(|| {
            frontier.par_iter().map(|(di, dir)| {
                let mut v = Vec::new();
                if let Ok(rd) = std::fs::read_dir(dir) {
                    for d in rd.flatten() {
                        if let Some(e) = Ent::from_dir_entry(&d) {
                            if e.is_dir && util::is_skip_dir(&e.name) { continue }
                            v.push(e);
                        }
                    }
                }
                (*di, v)
            }).collect()
        });
        let mut next: Vec<(u32, PathBuf)> = Vec::new();
        for (di, list) in lists {
            for e in list {
                let i = t.push(di, &e.name, Tree::flags_of(&e), if e.is_dir { 0 } else { e.size }, e.mtime as i64);
                if e.is_dir && !e.is_link { next.push((i, e.path)) }
                n += 1;
                if n % 20000 == 0 { progress(n) }
            }
        }
        frontier = next;
    }
    t.names.shrink_to_fit();
    t.entries.shrink_to_fit();
    t.first.shrink_to_fit();
    t.next.shrink_to_fit();
    t.aggregate();
    t
}

/// A small pool for rebuilding the index in the background: at most two threads, at low priority, so the
/// computer (and Dogfile's window) stays responsive while it runs.
pub fn background_pool() -> &'static rayon::ThreadPool {
    static P: OnceLock<rayon::ThreadPool> = OnceLock::new();
    P.get_or_init(|| {
        let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).clamp(1, 4) / 2;
        rayon::ThreadPoolBuilder::new().num_threads(n.max(1)).thread_name(|i| format!("dogfile-index-{i}")).start_handler(|_| util::lower_thread_priority()).build().expect("pool")
    })
}

// ---------------- the index service ----------------
pub struct Root {
    pub path: String,
    pub tree: RwLock<Option<Tree>>,
    pub state: Mutex<String>,
    pub dirty: AtomicBool,
    pub scanned: AtomicU64,
    pub ms: AtomicU64,
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    pub pending: Mutex<Vec<notify::Event>>, // changes seen while a rebuild is running
}

#[derive(Default)]
pub struct Service {
    pub roots: RwLock<Vec<Arc<Root>>>,
    pub data_dir: Mutex<PathBuf>,
    pub excludes: RwLock<Vec<String>>,
}
pub fn service() -> &'static Service {
    static S: OnceLock<Service> = OnceLock::new();
    S.get_or_init(Service::default)
}

fn index_file(dir: &Path, root: &str) -> PathBuf {
    let h = xxhash_rust::xxh3::xxh3_64(root.to_lowercase().as_bytes());
    dir.join(format!("index-{:016x}.atix", h))
}

fn status_of(r: &Root) -> Value {
    let t = r.tree.read().unwrap();
    json!({ "root": r.path, "state": *r.state.lock().unwrap(), "count": t.as_ref().map(|t| t.live()).unwrap_or(0),
            "method": t.as_ref().map(|t| t.method.clone()), "builtAt": t.as_ref().map(|t| t.built_at),
            "scanned": r.scanned.load(Ordering::Relaxed), "ms": r.ms.load(Ordering::Relaxed) })
}
pub fn status() -> Value {
    let roots = service().roots.read().unwrap();
    json!({ "roots": roots.iter().map(|r| status_of(r)).collect::<Vec<_>>() })
}
fn announce(r: &Root) {
    proto::event("index", status_of(r));
}

/// Set which roots are indexed. Existing ones are kept; new ones load from disk (instantly) and refresh.
pub fn configure(j: &Value) -> Value {
    let svc = service();
    if let Some(d) = j["dataDir"].as_str() {
        let _ = std::fs::create_dir_all(d);
        *svc.data_dir.lock().unwrap() = PathBuf::from(d);
    }
    let want: Vec<String> = j["roots"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let rescan = j["rescan"].as_bool().unwrap_or(true);
    if let Some(ms) = j["rescanAfter"].as_u64() { rescan_after.store(ms, Ordering::Relaxed) }
    let mft = j["mft"].as_bool().unwrap_or(true);
    {
        let mut roots = svc.roots.write().unwrap();
        roots.retain(|r| {
            let keep = want.iter().any(|w| w.eq_ignore_ascii_case(&r.path));
            if !keep { *r.watcher.lock().unwrap() = None }
            keep
        });
        for w in &want {
            if roots.iter().any(|r| r.path.eq_ignore_ascii_case(w)) { continue }
            let r = Arc::new(Root { path: w.clone(), tree: RwLock::new(None), state: Mutex::new("loading".into()), dirty: AtomicBool::new(false), scanned: AtomicU64::new(0), ms: AtomicU64::new(0), watcher: Mutex::new(None), pending: Mutex::new(Vec::new()) });
            roots.push(r.clone());
            std::thread::spawn(move || start_root(r, rescan, mft));
        }
    }
    ensure_saver();
    status()
}

/// how old a saved index may be before the start-up refresh (default 6 hours)
#[allow(non_upper_case_globals)]
static rescan_after: AtomicU64 = AtomicU64::new(6 * 3600 * 1000);

fn start_root(r: Arc<Root>, rescan: bool, mft: bool) {
    util::lower_thread_priority();
    let dir = service().data_dir.lock().unwrap().clone();
    let file = index_file(&dir, &r.path);
    let t0 = std::time::Instant::now();
    let loaded = Tree::load(&file).ok().filter(|t| t.root.eq_ignore_ascii_case(&r.path));
    let had = loaded.is_some();
    if let Some(t) = loaded {
        r.ms.store(t0.elapsed().as_millis() as u64, Ordering::Relaxed);
        *r.tree.write().unwrap() = Some(t);
        *r.state.lock().unwrap() = "ready".into();
        announce(&r);
    }
    start_watch(&r);
    // a saved index is kept up to date by the watcher while Dogfile runs; rebuild only when it is missing, or
    // older than `rescanAfter` (changes made while Dogfile was closed), in the background at low priority
    let stale = { let b = r.tree.read().unwrap().as_ref().map(|t| t.built_at).unwrap_or(0.0); util::now_ms() - b > rescan_after.load(Ordering::Relaxed) as f64 };
    if had && (!rescan || !stale) { return }
    rebuild(&r, mft, &file);
}

/// Build the tree again (master file table if allowed, otherwise a walk) and swap it in.
pub fn rebuild(r: &Arc<Root>, mft: bool, file: &Path) {
    *r.state.lock().unwrap() = if r.tree.read().unwrap().is_some() { "refreshing".into() } else { "scanning".into() };
    announce(r);
    let t0 = std::time::Instant::now();
    let cancel = AtomicBool::new(false);
    let rr = r.clone();
    let last = Mutex::new(std::time::Instant::now());
    let prog = move |n: u64| {
        rr.scanned.store(n, Ordering::Relaxed);
        let mut l = last.lock().unwrap();
        if l.elapsed().as_millis() > 500 { *l = std::time::Instant::now(); announce(&rr); }
    };
    let mut tree = None;
    if mft { tree = crate::mft::build(&r.path, &prog).ok() }
    let mut tree = tree.unwrap_or_else(|| build_by_walk(&r.path, &cancel, &prog));
    // apply changes that happened during the build
    let pend: Vec<notify::Event> = std::mem::take(&mut *r.pending.lock().unwrap());
    for ev in pend { apply_event(&mut tree, &ev) }
    r.ms.store(t0.elapsed().as_millis() as u64, Ordering::Relaxed);
    r.scanned.store(tree.live() as u64, Ordering::Relaxed);
    let _ = tree.save(file);
    *r.tree.write().unwrap() = Some(tree);
    *r.state.lock().unwrap() = "ready".into();
    r.dirty.store(false, Ordering::Relaxed);
    announce(r);
}

fn apply_event(t: &mut Tree, ev: &notify::Event) {
    use notify::EventKind;
    if matches!(ev.kind, EventKind::Access(_)) { return }
    let dd = service().data_dir.lock().unwrap().clone();
    for p in &ev.paths {
        if p.starts_with(&dd) { continue }
        if p.symlink_metadata().is_ok() { t.upsert(p) } else { t.remove_path(p) }
    }
}

fn start_watch(r: &Arc<Root>) {
    use notify::{RecursiveMode, Watcher};
    let weak = Arc::downgrade(r);
    let w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Some(r) = weak.upgrade() else { return };
        match res {
            Ok(ev) => {
                if ev.need_rescan() {
                    let r2 = r.clone();
                    std::thread::spawn(move || { let f = index_file(&service().data_dir.lock().unwrap(), &r2.path); rebuild(&r2, true, &f) });
                    return;
                }
                let st = r.state.lock().unwrap().clone();
                if st == "scanning" || st == "refreshing" { r.pending.lock().unwrap().push(ev.clone()) }
                if let Some(t) = r.tree.write().unwrap().as_mut() { apply_event(t, &ev); r.dirty.store(true, Ordering::Relaxed); }
            }
            Err(_) => {}
        }
    });
    if let Ok(mut w) = w {
        if w.watch(Path::new(&r.path), RecursiveMode::Recursive).is_ok() { *r.watcher.lock().unwrap() = Some(w) }
    }
}

fn ensure_saver() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::Relaxed) { return }
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_secs(90));
        save_all();
    });
}
pub fn save_all() {
    let dir = service().data_dir.lock().unwrap().clone();
    for r in service().roots.read().unwrap().iter() {
        if !r.dirty.swap(false, Ordering::Relaxed) { continue }
        let mut g = r.tree.write().unwrap();
        if let Some(t) = g.as_mut() {
            if t.deleted > t.entries.len() / 5 { t.compact() }
            let _ = t.save(&index_file(&dir, &r.path));
        }
    }
}

// ---------------- searching ----------------
/// Which indexed root (and folder inside it) covers `scope`? None = not indexed.
fn scope_of(scope: Option<&str>) -> Vec<(Arc<Root>, Option<String>)> {
    let roots = service().roots.read().unwrap();
    match scope {
        None | Some("") => roots.iter().map(|r| (r.clone(), None)).collect(),
        Some(s) => roots.iter().filter(|r| util::same_path_prefix(s, &r.path)).map(|r| (r.clone(), Some(s.to_string()))).take(1).collect(),
    }
}
/// Can the index answer for this folder right now?
pub fn covers(scope: &str) -> bool {
    scope_of(Some(scope)).iter().any(|(r, _)| r.tree.read().unwrap().is_some())
}

pub struct Hit {
    pub root: usize,
    pub idx: u32,
}

/// Leave out things inside skipped folders (node_modules, .git…) and, unless hidden items are shown, inside
/// dot-folders: the same rules the folder-walking search follows.
fn ancestors_ok(t: &Tree, mut p: u32, skip: &[Vec<u8>], include_hidden: bool) -> bool {
    if skip.is_empty() && include_hidden { return true }
    while p != 0 && p != NONE {
        let ln = t.name_bytes(p);
        if !include_hidden && ln.first() == Some(&b'.') { return false }
        if skip.iter().any(|s| s.eq_ignore_ascii_case(ln)) { return false }
        p = t.entries[p as usize].parent;
    }
    true
}

pub fn search(j: &Value) -> Result<Value, String> {
    let t0 = std::time::Instant::now();
    let spec = if j["query"].is_string() && j["typed"].as_bool().unwrap_or(false) { Spec::from_query(j["query"].as_str().unwrap()) } else { Spec::from_job(j)? };
    let scopes: Vec<String> = j["roots"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let limit = j["limit"].as_u64().or(j["maxResults"].as_u64()).unwrap_or(1000) as usize;
    let offset = j["offset"].as_u64().unwrap_or(0) as usize;
    let sort = j["sort"].as_str().unwrap_or("name");
    let recursive = j["recursive"].as_bool() != Some(false);
    let skip: Vec<Vec<u8>> = j["skipDirs"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.to_ascii_lowercase().into_bytes()).collect()).unwrap_or_default();
    let include_hidden = spec.include_hidden;
    let mut targets: Vec<(Arc<Root>, Option<String>)> = Vec::new();
    if !spec.index_can() { return Err("not indexed: needs a folder walk".into()) }
    if scopes.is_empty() { targets = scope_of(None) } else {
        for s in &scopes {
            let t = scope_of(Some(s));
            if t.is_empty() || t.iter().any(|(r, _)| r.tree.read().unwrap().is_none()) { return Err("not indexed".into()) }
            targets.extend(t);
        }
    }
    if targets.is_empty() { return Err("not indexed".into()) }
    let guards: Vec<_> = targets.iter().map(|(r, s)| (r.tree.read().unwrap(), s.clone())).collect();
    let mut hits: Vec<(usize, u32)> = Vec::new();
    let mut total = 0usize;
    for (gi, (g, scope)) in guards.iter().enumerate() {
        let Some(t) = g.as_ref() else { continue };
        let sidx = match scope { Some(s) => match t.lookup(s) { Some(i) => i, None => continue }, None => 0 };
        let found: Vec<u32> = (1..t.entries.len() as u32).into_par_iter().map_init(String::new, |buf, i| {
            let e = &t.entries[i as usize];
            if e.flags & F_DELETED != 0 { return None }
            if !recursive && e.parent != sidx { return None }
            let name = t.name(i);
            // lower-case on the fly (no second copy of every name in memory)
            buf.clear();
            if name.is_ascii() { buf.extend(name.chars().map(|c| c.to_ascii_lowercase())) } else { buf.push_str(&name.to_lowercase()) }
            let low = buf.as_str();
            let ok = spec.name_ok(name, low, e.flags & F_DIR != 0, e.flags & F_HIDDEN != 0)
                && spec.meta_ok(e.flags & F_DIR != 0, e.size, e.mtime as f64, e.mtime as f64, e.mtime as f64)
                && (sidx == 0 || recursive && t.is_under(e.parent, sidx))
                && (!spec.has_path_words() || spec.path_ok(&t.path(i).to_lowercase()))
                && ancestors_ok(t, e.parent, &skip, include_hidden);
            if ok { Some(i) } else { None }
        }).flatten().collect();
        total += found.len();
        hits.extend(found.into_iter().map(|i| (gi, i)));
    }
    // order
    let tr = |gi: usize| guards[gi].0.as_ref().unwrap();
    match sort {
        "size" => hits.par_sort_by(|a, b| tr(b.0).entries[b.1 as usize].size.cmp(&tr(a.0).entries[a.1 as usize].size)),
        "mtime" | "date" => hits.par_sort_by(|a, b| tr(b.0).entries[b.1 as usize].mtime.cmp(&tr(a.0).entries[a.1 as usize].mtime)),
        "path" => hits.par_sort_by_cached_key(|h| tr(h.0).path(h.1).to_lowercase()),
        _ => hits.par_sort_by(|a, b| { let (x, y) = (tr(a.0).name_bytes(a.1), tr(b.0).name_bytes(b.1)); x.iter().map(u8::to_ascii_lowercase).cmp(y.iter().map(u8::to_ascii_lowercase)) }),
    }
    let items: Vec<Value> = hits.iter().skip(offset).take(limit).map(|&(gi, i)| {
        let t = tr(gi);
        let e = &t.entries[i as usize];
        json!({ "name": t.name(i), "path": t.path(i), "isDir": e.flags & F_DIR != 0, "size": e.size, "mtime": e.mtime as f64, "ctime": e.mtime as f64, "atime": e.mtime as f64,
                "isLink": e.flags & F_LINK != 0, "hidden": e.flags & F_HIDDEN != 0, "files": if e.flags & F_DIR != 0 { json!(e.files) } else { Value::Null } })
    }).collect();
    Ok(json!({ "total": total, "items": items, "ms": t0.elapsed().as_secs_f64() * 1000.0, "indexed": true }))
}

/// Folder sizes straight from the index (for size badges): {path: {size, files}} for every path it knows.
pub fn sizes(j: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for p in j["paths"].as_array().cloned().unwrap_or_default() {
        let Some(p) = p.as_str() else { continue };
        for (r, _) in scope_of(Some(p)) {
            let g = r.tree.read().unwrap();
            if let Some(t) = g.as_ref() {
                if let Some(i) = t.lookup(p) {
                    let e = &t.entries[i as usize];
                    out.insert(p.to_string(), json!({ "size": e.size, "files": e.files, "isDir": e.flags & F_DIR != 0 }));
                }
            }
        }
    }
    Value::Object(out)
}

/// The elevated helper (`dogfile-core --build-index C:\ <dataDir>`) wrote a fresh index file: load it.
pub fn reload(j: &Value) -> Value {
    let want = j["root"].as_str().unwrap_or("").to_string();
    let dir = service().data_dir.lock().unwrap().clone();
    for r in service().roots.read().unwrap().iter() {
        if !want.is_empty() && !r.path.eq_ignore_ascii_case(&want) { continue }
        if let Ok(t) = Tree::load(&index_file(&dir, &r.path)) {
            r.scanned.store(t.live() as u64, Ordering::Relaxed);
            *r.tree.write().unwrap() = Some(t);
            *r.state.lock().unwrap() = "ready".into();
            announce(r);
        }
    }
    status()
}

/// Command line: build one root's index file and exit (run elevated so the file table can be read).
pub fn build_cli(root: &str, data_dir: &str) -> i32 {
    // "C:" (a trailing backslash can't be passed safely in quotes) means the drive root "C:\"
    let root_owned = if root.len() == 2 && root.ends_with(':') { format!("{root}\\") } else { root.to_string() };
    let root = root_owned.as_str();
    let t0 = std::time::Instant::now();
    let tree = match crate::mft::build(root, &|_| {}) {
        Ok(t) => t,
        Err(e) => { eprintln!("file table not readable ({e}); walking folders"); build_by_walk(root, &AtomicBool::new(false), &|_| {}) }
    };
    let _ = std::fs::create_dir_all(data_dir);
    match tree.save(&index_file(Path::new(data_dir), root)) {
        Ok(_) => { println!("{} entries in {:.1}s ({})", tree.live(), t0.elapsed().as_secs_f64(), tree.method); 0 }
        Err(e) => { eprintln!("{e}"); 1 }
    }
}

/// Rebuild one root now (Settings > "Rebuild index").
pub fn refresh(j: &Value) -> Value {
    let want = j["root"].as_str().unwrap_or("").to_string();
    let roots = service().roots.read().unwrap().clone();
    for r in roots {
        if !want.is_empty() && !r.path.eq_ignore_ascii_case(&want) { continue }
        let f = index_file(&service().data_dir.lock().unwrap(), &r.path);
        let mft = j["mft"].as_bool().unwrap_or(true);
        std::thread::spawn(move || rebuild(&r, mft, &f));
    }
    status()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn build_update_search() {
        let base = std::env::temp_dir().join(format!("atlas-idx-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("a/b")).unwrap();
        std::fs::write(base.join("a/report 2024.pdf"), vec![0u8; 1000]).unwrap();
        std::fs::write(base.join("a/b/photo.jpg"), vec![0u8; 500]).unwrap();
        std::fs::write(base.join("notes.txt"), b"hi").unwrap();
        let root = util::path_str(&base);
        let mut t = build_by_walk(&root, &AtomicBool::new(false), &|_| {});
        assert_eq!(t.live(), 6);
        assert_eq!(t.entries[0].size, 1502);
        let a = t.lookup(&util::path_str(&base.join("a"))).unwrap();
        assert_eq!(t.entries[a as usize].size, 1500);
        assert_eq!(t.entries[a as usize].files, 2);
        // new file and new folder
        std::fs::create_dir_all(base.join("a/new/deep")).unwrap();
        std::fs::write(base.join("a/new/deep/x.bin"), vec![0u8; 50]).unwrap();
        t.upsert(&base.join("a/new"));
        assert_eq!(t.entries[a as usize].size, 1550);
        assert!(t.lookup(&util::path_str(&base.join("a/new/deep/x.bin"))).is_some());
        // file grew
        std::fs::write(base.join("notes.txt"), b"hello").unwrap();
        t.upsert(&base.join("notes.txt"));
        assert_eq!(t.entries[0].size, 1555);
        // delete a folder
        std::fs::remove_dir_all(base.join("a/b")).unwrap();
        t.remove_path(&base.join("a/b"));
        assert_eq!(t.entries[a as usize].size, 1050);
        assert_eq!(t.entries[0].files, 3);
        // save / load / compact
        let f = base.join("../atlas-idx-test.atix");
        t.compact();
        t.save(&f).unwrap();
        let t2 = Tree::load(&f).unwrap();
        assert_eq!(t2.live(), t.live());
        assert_eq!(t2.entries[0].size, 1055 + 500 - 500);
        let x = base.join("a").join("new").join("deep").join("x.bin");
        assert_eq!(t2.path(t2.lookup(&util::path_str(&x)).unwrap()), util::path_str(&x));
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_file(&f);
    }
}
