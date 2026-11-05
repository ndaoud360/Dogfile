// Tests for the part of Dogfile that changes people's folders. They run against real folders on disk and against an
// environment that fails or stops dead on purpose at every single step, because the promise is: a file is never lost.
use super::api;
use super::env::{rename_noreplace, Env, Meta, RealEnv};
use super::exec::{self, STAGE_PREFIX};
use super::reality::{self, Reality, State};
use super::tree::*;
use parking_lot::Mutex;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

// ---------- helpers ----------
struct Tmp(PathBuf);
impl Tmp {
    fn new() -> Tmp {
        let p = std::env::temp_dir().join(format!("dogfile-mv-test-{}", reality::new_id()));
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn put(root: &Path, rel: &str, content: &str, mtime: i64) {
    let p = exec::dp(root, rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, content).unwrap();
    filetime::set_file_mtime(&p, filetime::FileTime::from_unix_time(mtime, 0)).unwrap();
}
fn dir(root: &Path, rel: &str) {
    std::fs::create_dir_all(exec::dp(root, rel)).unwrap();
}

/// everything under a folder: path → "D", "F:<content>" or "L"
fn snap(root: &Path) -> BTreeMap<String, String> {
    fn go(root: &Path, rel: &str, out: &mut BTreeMap<String, String>) {
        for e in std::fs::read_dir(exec::dp(root, rel)).unwrap() {
            let e = e.unwrap();
            let name = e.file_name().to_string_lossy().to_string();
            let p = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            let m = std::fs::symlink_metadata(e.path()).unwrap();
            if m.file_type().is_symlink() {
                out.insert(p, "L".into());
            } else if m.is_dir() {
                out.insert(p.clone(), "D".into());
                go(root, &p, out);
            } else {
                out.insert(p, format!("F:{}", std::fs::read_to_string(e.path()).unwrap_or_default()));
            }
        }
    }
    let mut o = BTreeMap::new();
    go(root, "", &mut o);
    o
}
fn contents_under(dir: &Path) -> Vec<String> {
    let mut v = vec![];
    fn go(d: &Path, v: &mut Vec<String>) {
        for e in std::fs::read_dir(d).unwrap().flatten() {
            let m = std::fs::symlink_metadata(e.path()).unwrap();
            if m.is_dir() {
                go(&e.path(), v);
            } else if m.is_file() {
                v.push(std::fs::read_to_string(e.path()).unwrap_or_default());
            }
        }
    }
    go(dir, &mut v);
    v
}

// ---------- an environment that can fail or stop dead ----------
struct Bin {
    dir: PathBuf,
    items: Mutex<Vec<(String, PathBuf)>>,
    n: AtomicUsize,
}
struct TEnv {
    calls: AtomicUsize,
    fail_at: Option<usize>,
    fail_after: bool,
    crash_at: Option<usize>,
    crash_after: bool,
    crashed: AtomicBool,
    bin: Arc<Bin>,
    has_bin: bool,
}
impl TEnv {
    fn new(bin: Arc<Bin>) -> TEnv {
        TEnv { calls: AtomicUsize::new(0), fail_at: None, fail_after: false, crash_at: None, crash_after: false, crashed: AtomicBool::new(false), bin, has_bin: true }
    }
    fn failing(bin: Arc<Bin>, at: usize, after: bool) -> TEnv {
        let mut e = TEnv::new(bin);
        e.fail_at = Some(at);
        e.fail_after = after;
        e
    }
    fn crashing(bin: Arc<Bin>, at: usize, after: bool) -> TEnv {
        let mut e = TEnv::new(bin);
        e.crash_at = Some(at);
        e.crash_after = after;
        e
    }
    fn count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
    fn step<T>(&self, f: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
        if self.crashed.load(Ordering::SeqCst) {
            return Err(io::Error::other("crashed"));
        }
        let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if self.crash_at == Some(n) && !self.crash_after {
            self.crashed.store(true, Ordering::SeqCst);
            return Err(io::Error::other("crashed"));
        }
        if self.fail_at == Some(n) && !self.fail_after {
            return Err(io::Error::other("injected"));
        }
        let r = f();
        if self.crash_at == Some(n) && self.crash_after {
            self.crashed.store(true, Ordering::SeqCst);
        }
        if self.fail_at == Some(n) && self.fail_after {
            return Err(io::Error::other("injected after"));
        }
        r
    }
}
impl Env for TEnv {
    fn stat(&self, p: &Path) -> io::Result<Option<Meta>> {
        RealEnv.stat(p)
    }
    fn list(&self, p: &Path) -> io::Result<Vec<(String, Meta)>> {
        RealEnv.list(p)
    }
    fn rename_new(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.step(|| RealEnv.rename_new(from, to))
    }
    fn mkdir(&self, p: &Path) -> io::Result<()> {
        self.step(|| RealEnv.mkdir(p))
    }
    fn copy_new(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.step(|| RealEnv.copy_new(from, to))
    }
    fn remove_file(&self, p: &Path) -> io::Result<()> {
        self.step(|| RealEnv.remove_file(p))
    }
    fn remove_dir(&self, p: &Path) -> io::Result<()> {
        self.step(|| RealEnv.remove_dir(p))
    }
    fn trash(&self, p: &Path) -> Result<(), String> {
        self.step(|| {
            let n = self.bin.n.fetch_add(1, Ordering::SeqCst);
            let to = self.bin.dir.join(format!("{n}"));
            std::fs::rename(p, &to)?;
            self.bin.items.lock().push((p.to_string_lossy().to_string(), to));
            Ok(())
        })
        .map_err(|e| e.to_string())
    }
    fn bin_restore(&self, paths: &[String]) -> Result<(), String> {
        self.step(|| {
            for p in paths {
                let mut items = self.bin.items.lock();
                let Some(i) = items.iter().position(|(o, _)| o == p) else { return Err(io::Error::other(format!("{p} isn’t in the bin"))) };
                let (o, b) = items[i].clone();
                RealEnv.rename_new(&b, Path::new(&o))?;
                items.remove(i);
            }
            Ok(())
        })
        .map_err(|e| e.to_string())
    }
    fn bin_has(&self, p: &Path) -> bool {
        self.bin.items.lock().iter().any(|(o, _)| Path::new(o) == p)
    }
    fn has_bin(&self, _p: &Path) -> bool {
        self.has_bin
    }
    fn case_insensitive(&self, _p: &Path) -> bool {
        false
    }
    fn crashed(&self) -> bool {
        self.crashed.load(Ordering::SeqCst)
    }
}

struct World {
    _t: Tmp,
    root: PathBuf,
    data: PathBuf,
    bin: Arc<Bin>,
    id: String,
    /// baseline path → content
    orig: HashMap<String, String>,
    before: BTreeMap<String, String>,
}
impl World {
    fn new() -> World {
        let t = Tmp::new();
        let root = t.0.join("root");
        let data = t.0.join("data");
        let bind = t.0.join("bin");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&bind).unwrap();
        World { root, data, bin: Arc::new(Bin { dir: bind, items: Mutex::new(vec![]), n: AtomicUsize::new(0) }), _t: t, id: String::new(), orig: HashMap::new(), before: BTreeMap::new() }
    }
    fn env(&self) -> TEnv {
        TEnv::new(self.bin.clone())
    }
    /// make the reality (looks at the folder as it is now) and add the changes
    fn reality(&mut self, ops: Vec<OpKind>) {
        let env = self.env();
        let mut r = Reality::new(&env, "t", &self.root.to_string_lossy()).unwrap();
        r.add("g", ops);
        reality::save(&self.data, &r).unwrap();
        self.id = r.id.clone();
        self.orig = snap(&self.root).into_iter().filter_map(|(p, v)| v.strip_prefix("F:").map(|c| (p.clone(), c.to_string()))).collect();
        self.before = snap(&self.root);
    }
    fn journals(&self) -> Vec<PathBuf> {
        std::fs::read_dir(reality::dir(&self.data).join("journals")).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default()
    }
    fn bin_contents(&self) -> Vec<String> {
        contents_under(&self.bin.dir)
    }
    /// the promise: every file that was there is still somewhere (in the folder, or in the Recycle Bin)
    fn assert_no_loss(&self, why: &str) {
        let mut have: BTreeSet<String> = contents_under(&self.root).into_iter().collect();
        have.extend(self.bin_contents());
        for (p, c) in &self.orig {
            assert!(have.contains(c), "LOST {p} ({c}) — {why}");
        }
    }
    /// recycled contents that neither were meant to be deleted nor still exist in the folder (deleting a copy recycles a
    /// copy: the original's content is still in the folder)
    fn wrongly_recycled(&self) -> Vec<String> {
        let want = expected_deleted(self);
        let here: BTreeSet<String> = contents_under(&self.root).into_iter().collect();
        self.bin_contents().into_iter().filter(|c| !want.contains(c) && !here.contains(c)).collect()
    }
    fn assert_back_as_it_was(&self, why: &str) {
        assert_eq!(snap(&self.root), self.before, "{why}");
        assert!(self.bin_contents().is_empty(), "something was recycled — {why}");
    }
}

// ---------- a random folder and random changes ----------
fn fixture(root: &Path, rng: &mut StdRng) {
    let dirs = ["", "docs", "docs/old", "pics", "pics/2020", "misc", "empty", "deep/er/still"];
    for d in dirs {
        dir(root, d);
    }
    let names = ["a.txt", "b.txt", "c.jpg", "d.png", "e.pdf", "f.mp3", "g", "h.zip", "i.docx", "j.rs"];
    let mut n = 0;
    for d in dirs {
        if d == "empty" {
            continue;
        }
        for nm in names {
            if !rng.random_bool(0.4) {
                continue;
            }
            n += 1;
            put(root, &join(d, nm), &format!("content-{n}"), 1_500_000_000 + rng.random_range(0..90_000_000) as i64);
        }
    }
}
fn random_ops(base: &[BEntry], rng: &mut StdRng, count: usize, deletes: bool) -> Vec<OpKind> {
    let mut sim = Tree::from_base(base, false);
    let pool = ["a", "b", "c", "a.txt", "b.txt", "n1", "n2", "x.dat", "docs", "misc"];
    let mut ops = vec![];
    for _ in 0..count * 3 {
        if ops.len() >= count {
            break;
        }
        let nodes: Vec<Node> = sim.nodes().cloned().collect();
        let dirs: Vec<String> = std::iter::once(String::new()).chain(nodes.iter().filter(|n| n.kind == Kind::Dir).map(|n| n.path.clone())).collect();
        let pick = if nodes.is_empty() { None } else { Some(nodes[rng.random_range(0..nodes.len())].clone()) };
        let target_dir = dirs[rng.random_range(0..dirs.len())].clone();
        let nm = pool[rng.random_range(0..pool.len())];
        let op = match rng.random_range(0..100) {
            0..=34 => pick.map(|p| OpKind::Move { from: p.path.clone(), to: join(&target_dir, name_of(&p.path)) }),
            35..=49 => pick.map(|p| OpKind::Move { from: p.path.clone(), to: join(parent_of(&p.path), nm) }),
            50..=64 if deletes => pick.map(|p| OpKind::Delete { path: p.path }),
            65..=79 => Some(OpKind::Mkdir { path: join(&target_dir, nm) }),
            _ => pick.map(|p| OpKind::Copy { from: p.path.clone(), to: join(&target_dir, &format!("{}-copy", name_of(&p.path))) }),
        };
        if let Some(op) = op {
            if sim.apply(&op, None).is_ok() {
                ops.push(op);
            }
        }
    }
    ops
}

fn random_world(seed: u64, nops: usize, deletes: bool) -> World {
    let mut rng = StdRng::seed_from_u64(seed);
    let mut w = World::new();
    fixture(&w.root, &mut rng);
    let base = reality::scan(&RealEnv, &w.root).unwrap();
    let ops = random_ops(&base, &mut rng, nops, deletes);
    w.reality(ops);
    w
}

/// what the folder must look like after the changes: the virtual folder, with each file's content from the original
fn expected(w: &World) -> BTreeMap<String, String> {
    let r = reality::load(&w.data, &w.id).unwrap();
    let rp = reality::replay(&r.base, r.ci, &r.ops, true);
    let mut m = BTreeMap::new();
    for n in rp.tree.nodes() {
        m.insert(
            n.path.clone(),
            match n.kind {
                Kind::Dir => "D".to_string(),
                Kind::File => format!("F:{}", w.orig[n.origin.as_ref().unwrap()]),
                Kind::Link => "L".into(),
            },
        );
    }
    m
}
fn expected_deleted(w: &World) -> BTreeSet<String> {
    let r = reality::load(&w.data, &w.id).unwrap();
    let rp = reality::replay(&r.base, r.ci, &r.ops, true);
    let kept: BTreeSet<String> = rp.tree.nodes().filter(|n| !n.copy).filter_map(|n| n.origin.clone()).collect();
    r.base.iter().filter(|b| b.kind == Kind::File && !kept.contains(&b.path)).map(|b| w.orig[&b.path].clone()).collect()
}

fn ok(v: &Value) -> bool {
    v["ok"].as_bool().unwrap_or(false)
}

// ---------- names and paths ----------
#[test]
fn names_windows_would_refuse_are_refused() {
    for bad in ["", ".", "..", "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "con", "CON.txt", "nul", "Com1", "lpt9.log", "end.", "end ", "ctrl\u{7}", &"x".repeat(201)] {
        assert!(check_name(bad).is_err(), "{bad:?} should be refused");
    }
    for good in ["a", "a b", "résumé.pdf", "日本語", "file (2).txt", ".hidden", "console", "com10", "a.b.c", "CONFIG"] {
        assert!(check_name(good).is_ok(), "{good:?} should be fine");
    }
}
#[test]
fn paths_are_tidied_and_bad_ones_refused() {
    assert_eq!(norm("a\\b//c/").unwrap(), "a/b/c");
    assert_eq!(norm("").unwrap(), "");
    assert!(norm("a/../b").is_err());
    assert!(norm("a/./b").is_err());
    assert!(norm("a/con/b").is_err());
    assert!(norm(&format!("{}/x", "d".repeat(230))).is_err());
}

// ---------- the virtual folder ----------
fn base(items: &[(&str, Kind)]) -> Vec<BEntry> {
    items.iter().map(|(p, k)| BEntry { path: p.to_string(), kind: *k, size: if *k == Kind::File { 10 } else { 0 }, mtime: 100 }).collect()
}
fn sample() -> Tree {
    Tree::from_base(
        &base(&[("a", Kind::Dir), ("a/x.txt", Kind::File), ("a/sub", Kind::Dir), ("a/sub/y.txt", Kind::File), ("b", Kind::Dir), ("top.txt", Kind::File), ("lnk", Kind::Link), ("b/l", Kind::Link)]),
        false,
    )
}
fn mv(f: &str, t: &str) -> OpKind {
    OpKind::Move { from: f.into(), to: t.into() }
}
fn del(p: &str) -> OpKind {
    OpKind::Delete { path: p.into() }
}
fn mk(p: &str) -> OpKind {
    OpKind::Mkdir { path: p.into() }
}
fn cp(f: &str, t: &str) -> OpKind {
    OpKind::Copy { from: f.into(), to: t.into() }
}
fn paths(t: &Tree) -> Vec<String> {
    t.nodes().map(|n| n.path.clone()).collect()
}

#[test]
fn moving_a_folder_brings_everything_in_it() {
    let mut t = sample();
    let a = t.apply(&mv("a", "b/a2"), None).unwrap();
    assert_eq!(a, vec![Act::Mv { from: "a".into(), to: "b/a2".into() }]);
    let p = paths(&t);
    for want in ["b/a2", "b/a2/x.txt", "b/a2/sub", "b/a2/sub/y.txt"] {
        assert!(p.contains(&want.to_string()), "{want} in {p:?}");
    }
    assert!(!p.iter().any(|x| x == "a" || x.starts_with("a/")));
    // what it was is remembered
    assert_eq!(t.get("b/a2/sub/y.txt").unwrap().origin.as_deref(), Some("a/sub/y.txt"));
}
#[test]
fn nothing_is_replaced() {
    let mut t = sample();
    assert!(t.apply(&mv("top.txt", "a"), None).is_err());
    assert!(t.apply(&mv("a/x.txt", "a/sub"), None).is_err());
    assert!(t.apply(&cp("top.txt", "a"), None).is_err());
    assert!(t.apply(&mk("a"), None).is_err());
    assert!(t.apply(&mv("a", "b"), None).is_err());
}
#[test]
fn a_change_that_fails_changes_nothing() {
    let mut rng = StdRng::seed_from_u64(7);
    for _ in 0..400 {
        let mut t = sample();
        let _ = t.apply(&mk("m"), None);
        let nodes: Vec<String> = t.nodes().map(|n| n.path.clone()).collect();
        let pick = |rng: &mut StdRng| nodes[rng.random_range(0..nodes.len())].clone();
        let junk = ["", "x", "a/x", "nope/x", "a/sub/zz", "m/q", "b/../a"];
        let op = match rng.random_range(0..4) {
            0 => mv(&pick(&mut rng), junk[rng.random_range(0..junk.len())]),
            1 => cp(&pick(&mut rng), &join(&pick(&mut rng), "n")),
            2 => del(&pick(&mut rng)),
            _ => mk(&join(&pick(&mut rng), "k")),
        };
        let before: Vec<(String, Option<String>)> = t.nodes().map(|n| (n.path.clone(), n.origin.clone())).collect();
        let r = t.apply(&op, None);
        if r.is_err() {
            let after: Vec<(String, Option<String>)> = t.nodes().map(|n| (n.path.clone(), n.origin.clone())).collect();
            assert_eq!(before, after, "{op:?} failed but changed the folder");
        }
    }
}
#[test]
fn a_folder_cannot_go_into_itself() {
    let mut t = sample();
    assert!(t.apply(&mv("a", "a/sub/a"), None).is_err());
    assert!(t.apply(&mv("a", "a/x"), None).is_err());
    assert!(t.apply(&cp("a", "a/sub/a2"), None).is_err());
    assert!(t.apply(&mv("a", "a"), None).is_err());
    assert!(t.apply(&mv("", "z"), None).is_err());
    assert!(t.apply(&del(""), None).is_err());
    // but a name that merely starts the same is fine
    assert!(t.apply(&mv("a", "a2"), None).is_ok());
}
#[test]
fn the_new_place_must_exist() {
    let mut t = sample();
    assert!(t.apply(&mv("top.txt", "nowhere/top.txt"), None).is_err());
    assert!(t.apply(&mv("top.txt", "top.txt/inside"), None).is_err());
    assert!(t.apply(&mk("nowhere/x"), None).is_err());
    assert!(t.apply(&mk("a/new"), None).is_ok());
    assert!(t.apply(&mv("top.txt", "a/new/top.txt"), None).is_ok());
}
#[test]
fn links_and_unreadable_folders_are_never_changed() {
    let mut t = sample();
    assert!(t.apply(&mv("lnk", "a/lnk"), None).is_err());
    assert!(t.apply(&del("lnk"), None).is_err());
    assert!(t.apply(&cp("lnk", "a/l2"), None).is_err());
    // a folder holding a link can't be deleted or copied as a whole (that would follow or lose the link)
    assert!(t.apply(&del("b"), None).is_err());
    assert!(t.apply(&cp("b", "bcopy"), None).is_err());
    // …but can be moved, which keeps what's in it exactly as it is
    assert!(t.apply(&mv("b", "a/b"), None).is_ok());
}
#[test]
fn deleting_a_folder_removes_everything_under_it_and_frees_the_name() {
    let mut t = sample();
    let a = t.apply(&del("a"), None).unwrap();
    assert_eq!(a, vec![Act::Stage { path: "a".into() }]);
    assert!(!paths(&t).iter().any(|p| p == "a" || p.starts_with("a/")));
    assert!(t.apply(&mk("a"), None).is_ok());
    assert!(t.apply(&mv("top.txt", "a/top.txt"), None).is_ok());
}
#[test]
fn a_copy_is_a_new_thing_that_remembers_where_it_came_from() {
    let mut t = sample();
    let a = t.apply(&cp("a", "acopy"), None).unwrap();
    assert_eq!(a[0], Act::Mkdir { path: "acopy".into() });
    assert!(a.contains(&Act::CopyFile { from: "a/sub/y.txt".into(), to: "acopy/sub/y.txt".into() }));
    assert!(t.get("acopy/sub/y.txt").unwrap().copy);
    assert_eq!(change_of(&t, t.get("acopy").unwrap()), Change::Copy);
    assert_eq!(change_of(&t, t.get("acopy/x.txt").unwrap()), Change::Same);
    // the original is untouched
    assert!(!t.get("a/x.txt").unwrap().copy);
    // deleting the copy later must not be held against the baseline
    let mut f = Footprint::default();
    t.apply(&del("acopy"), Some(&mut f)).unwrap();
    assert!(f.files.is_empty() && f.dirs.is_empty() && f.deep.is_empty(), "{f:?}");
}
#[test]
fn the_footprint_is_what_the_changes_rely_on() {
    let mut t = sample();
    let mut f = Footprint::default();
    t.apply(&mv("top.txt", "a/t.txt"), Some(&mut f)).unwrap();
    t.apply(&del("a/sub"), Some(&mut f)).unwrap();
    assert!(f.files.contains(&"top.txt".to_string()));
    assert!(f.files.contains(&"a/sub/y.txt".to_string()));
    assert!(f.deep.contains(&"a/sub".to_string()));
    assert!(f.dirs.contains(&"a/sub".to_string()));
}
#[test]
fn badges_say_what_happened_to_each_item() {
    let mut t = sample();
    t.apply(&mv("top.txt", "renamed.txt"), None).unwrap();
    t.apply(&mv("a/x.txt", "b/x.txt"), None).unwrap();
    t.apply(&mk("fresh"), None).unwrap();
    t.apply(&mv("a/sub", "a/sub2"), None).unwrap();
    assert_eq!(change_of(&t, t.get("renamed.txt").unwrap()), Change::Renamed);
    assert_eq!(change_of(&t, t.get("b/x.txt").unwrap()), Change::Moved);
    assert_eq!(change_of(&t, t.get("fresh").unwrap()), Change::New);
    assert_eq!(change_of(&t, t.get("a/sub2").unwrap()), Change::Renamed);
    // what is inside a renamed folder came along, it wasn't moved by itself
    assert_eq!(change_of(&t, t.get("a/sub2/y.txt").unwrap()), Change::Same);
}
#[test]
fn a_case_insensitive_folder_cannot_hold_two_names_that_differ_by_case() {
    let mut t = Tree::from_base(&base(&[("Readme.txt", Kind::File), ("docs", Kind::Dir)]), true);
    assert!(t.get("README.TXT").is_some());
    assert!(t.apply(&mk("DOCS"), None).is_err());
    assert!(t.apply(&mv("Readme.txt", "readme.TXT"), None).is_ok(), "a change of case alone is allowed");
    assert_eq!(t.get("readme.txt").unwrap().path, "readme.TXT");
    assert!(t.apply(&mv("readme.TXT", "DOCS"), None).is_err());
    let mut s = Tree::from_base(&base(&[("Readme.txt", Kind::File)]), false);
    assert!(s.apply(&mk("readme.txt"), None).is_ok(), "on a case-sensitive folder they are different names");
}

// ---------- replaying a reality ----------
#[test]
fn a_switched_off_change_takes_the_ones_that_depend_on_it_with_it() {
    let b = base(&[("top.txt", Kind::File)]);
    let mut r = Reality { id: "x".into(), name: "t".into(), root: "/r".into(), created: 0, ci: false, base: b.clone(), ops: vec![], next_id: 1, applied: None };
    r.add("g", vec![mk("new"), mv("top.txt", "new/top.txt")]);
    let rp = reality::replay(&r.base, false, &r.ops, true);
    assert!(rp.state.iter().all(|s| s.1 == State::On));
    r.ops[0].on = false;
    let rp = reality::replay(&r.base, false, &r.ops, true);
    assert_eq!(rp.state[0].1, State::Off);
    assert!(matches!(rp.state[1].1, State::Blocked(_)), "{:?}", rp.state);
    assert!(rp.acts.is_empty());
    // and a delete is blocked where there is no Recycle Bin
    r.ops[0].on = true;
    r.add("g", vec![del("top.txt")]);
    let rp = reality::replay(&r.base, false, &r.ops, false);
    assert!(matches!(rp.state[2].1, State::Blocked(_)));
}
#[test]
fn the_order_of_changes_matters_and_swaps_work() {
    let b = base(&[("a.txt", Kind::File), ("b.txt", Kind::File)]);
    let ops = vec![mv("a.txt", "tmp"), mv("b.txt", "a.txt"), mv("tmp", "b.txt")];
    let mut r = Reality { id: "x".into(), name: "t".into(), root: "/r".into(), created: 0, ci: false, base: b, ops: vec![], next_id: 1, applied: None };
    r.add("g", ops);
    let rp = reality::replay(&r.base, false, &r.ops, true);
    assert!(rp.state.iter().all(|s| s.1 == State::On), "{:?}", rp.state);
    assert_eq!(rp.tree.get("a.txt").unwrap().origin.as_deref(), Some("b.txt"));
    assert_eq!(rp.tree.get("b.txt").unwrap().origin.as_deref(), Some("a.txt"));
}

// ---------- the disk ----------
#[test]
fn rename_never_replaces() {
    let t = Tmp::new();
    std::fs::write(t.0.join("a"), "A").unwrap();
    std::fs::write(t.0.join("b"), "B").unwrap();
    let e = rename_noreplace(&t.0.join("a"), &t.0.join("b")).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(std::fs::read_to_string(t.0.join("a")).unwrap(), "A");
    assert_eq!(std::fs::read_to_string(t.0.join("b")).unwrap(), "B");
    std::fs::create_dir(t.0.join("d")).unwrap();
    assert!(rename_noreplace(&t.0.join("a"), &t.0.join("d")).is_err());
    rename_noreplace(&t.0.join("a"), &t.0.join("c")).unwrap();
    assert_eq!(std::fs::read_to_string(t.0.join("c")).unwrap(), "A");
}
#[test]
fn scanning_lists_everything_and_leaves_links_and_set_aside_items_out_of_it() {
    let t = Tmp::new();
    put(&t.0, "a/b/c.txt", "c", 5);
    dir(&t.0, "empty");
    dir(&t.0, &format!("{STAGE_PREFIX}old"));
    put(&t.0, &format!("{STAGE_PREFIX}old/x"), "x", 5);
    #[cfg(unix)]
    std::os::unix::fs::symlink(t.0.join("a"), t.0.join("link")).unwrap();
    let b = reality::scan(&RealEnv, &t.0).unwrap();
    let got: Vec<(&str, Kind)> = b.iter().map(|e| (e.path.as_str(), e.kind)).collect();
    assert!(got.contains(&("a/b/c.txt", Kind::File)));
    assert!(got.contains(&("empty", Kind::Dir)));
    assert!(!got.iter().any(|g| g.0.starts_with(STAGE_PREFIX)));
    #[cfg(unix)]
    {
        assert!(got.contains(&("link", Kind::Link)));
        assert!(!got.iter().any(|g| g.0.starts_with("link/")), "never walks into a link");
    }
    assert_eq!(b.iter().find(|e| e.path == "a/b/c.txt").unwrap().mtime, 5);
    assert!(reality::scan(&RealEnv, &t.0.join("nope")).is_err());
    assert!(reality::scan(&RealEnv, &t.0.join("a/b/c.txt")).is_err());
}

fn simple_world() -> World {
    let mut w = World::new();
    put(&w.root, "docs/a.txt", "A", 1000);
    put(&w.root, "docs/b.pdf", "B", 2000);
    put(&w.root, "docs/old/c.txt", "C", 3000);
    put(&w.root, "pics/d.jpg", "D", 4000);
    put(&w.root, "e.txt", "E", 5000);
    dir(&w.root, "empty");
    w.reality(vec![mk("Sorted"), mv("e.txt", "Sorted/e.txt"), mv("docs/a.txt", "docs/a-renamed.txt"), cp("pics", "pics-backup"), del("docs/old"), mv("pics/d.jpg", "docs/d.jpg")]);
    w
}

#[test]
fn applying_makes_the_folder_look_like_the_reality() {
    let w = simple_world();
    let env = w.env();
    let v = api::apply(&env, &w.data, &w.id).unwrap();
    assert!(ok(&v), "{v}");
    assert_eq!(snap(&w.root), expected(&w));
    assert_eq!(w.bin_contents(), vec!["C".to_string()], "the deleted folder is in the Recycle Bin");
    assert!(w.journals().is_empty(), "the journal is removed once it's all done");
    w.assert_no_loss("apply");
    // the deleted folder was put back where it was before it was recycled, so Restore knows where to send it
    assert!(w.bin.items.lock()[0].0.ends_with("docs/old") || w.bin.items.lock()[0].0.ends_with("docs\\old"));
    // the reality remembers it was made
    let after = api::view(&env, &w.data, &w.id).unwrap();
    assert!(after["applied"].is_object());
    // and refuses to be made twice
    assert!(api::apply(&env, &w.data, &w.id).is_err());
}
#[test]
fn undo_puts_everything_back() {
    let w = simple_world();
    let env = w.env();
    assert!(ok(&api::apply(&env, &w.data, &w.id).unwrap()));
    let u = api::undo(&env, &w.data, &w.id).unwrap();
    assert!(ok(&u), "{u}");
    w.assert_back_as_it_was("after undo");
    assert!(api::view(&env, &w.data, &w.id).unwrap()["applied"].is_null());
    // it can be made again, and undone again
    assert!(ok(&api::apply(&env, &w.data, &w.id).unwrap()));
    assert!(ok(&api::undo(&env, &w.data, &w.id).unwrap()));
    w.assert_back_as_it_was("after the second undo");
}
#[test]
fn nothing_is_touched_when_a_change_is_not_switched_on() {
    let w = simple_world();
    let env = w.env();
    let all: Vec<u32> = reality::load(&w.data, &w.id).unwrap().ops.iter().map(|o| o.id).collect();
    api::toggle(&env, &w.data, &w.id, &json!(all), false).unwrap();
    assert!(api::apply(&env, &w.data, &w.id).is_err());
    w.assert_back_as_it_was("nothing on");
    // only the rename
    let rename_id = reality::load(&w.data, &w.id).unwrap().ops[2].id;
    api::toggle(&env, &w.data, &w.id, &json!([rename_id]), true).unwrap();
    assert!(ok(&api::apply(&env, &w.data, &w.id).unwrap()));
    let s = snap(&w.root);
    assert_eq!(s.get("docs/a-renamed.txt").map(|x| x.as_str()), Some("F:A"));
    assert!(s.contains_key("docs/old/c.txt") && s.contains_key("e.txt"), "the others weren't done");
    assert!(w.bin_contents().is_empty());
}

// ---------- the folder changed behind Dogfile's back ----------
#[test]
fn a_changed_file_stops_everything_and_changes_nothing() {
    let cases: Vec<(&str, Box<dyn Fn(&Path)>)> = vec![
        ("edited (size)", Box::new(|r| put(r, "e.txt", "EE", 5000))),
        ("edited (date)", Box::new(|r| put(r, "e.txt", "E", 9999))),
        ("removed", Box::new(|r| std::fs::remove_file(r.join("e.txt")).unwrap())),
        ("replaced by a folder", Box::new(|r| {
            std::fs::remove_file(r.join("e.txt")).unwrap();
            std::fs::create_dir(r.join("e.txt")).unwrap();
        })),
        ("a file was added to a folder that would be recycled", Box::new(|r| put(r, "docs/old/new.txt", "NEW", 1))),
        ("a file in a folder to be recycled was changed", Box::new(|r| put(r, "docs/old/c.txt", "CC", 3000))),
        ("a file in a folder to be copied was removed", Box::new(|r| std::fs::remove_file(r.join("pics/d.jpg")).unwrap())),
        ("a file was added to a folder to be copied", Box::new(|r| put(r, "pics/new.jpg", "N", 1))),
        ("a folder to be recycled became a file", Box::new(|r| {
            std::fs::remove_dir_all(r.join("docs/old")).unwrap();
            std::fs::write(r.join("docs/old"), "x").unwrap();
        })),
    ];
    for (name, f) in cases {
        let w = simple_world();
        f(&w.root);
        let changed = snap(&w.root);
        let env = w.env();
        let v = api::apply(&env, &w.data, &w.id).unwrap();
        assert!(!ok(&v) && v["kind"] == "drift", "{name}: {v}");
        assert_eq!(snap(&w.root), changed, "{name}: the folder must be left exactly as it was found");
        assert_eq!(env.count(), 0, "{name}: no change may be attempted");
        assert!(w.bin_contents().is_empty());
        assert!(w.journals().is_empty());
    }
}
#[test]
fn things_added_elsewhere_in_the_folder_do_not_matter() {
    let w = simple_world();
    put(&w.root, "unrelated.txt", "U", 1);
    put(&w.root, "docs/also-unrelated.txt", "U2", 1);
    std::fs::remove_file(w.root.join("empty")).ok();
    let env = w.env();
    let v = api::apply(&env, &w.data, &w.id).unwrap();
    assert!(ok(&v), "{v}");
    let s = snap(&w.root);
    assert_eq!(s.get("unrelated.txt").map(|x| x.as_str()), Some("F:U"));
    assert_eq!(s.get("docs/also-unrelated.txt").map(|x| x.as_str()), Some("F:U2"));
}
#[test]
fn something_new_where_a_file_is_going_is_never_replaced() {
    // someone put a file at the destination after the reality was made: the move must fail, and everything is reversed
    let w = simple_world();
    put(&w.root, "Sorted/e.txt", "SOMEONE ELSES", 1);
    let before = snap(&w.root);
    let env = w.env();
    let v = api::apply(&env, &w.data, &w.id).unwrap();
    assert!(!ok(&v), "{v}");
    assert_eq!(snap(&w.root), before);
    assert!(w.bin_contents().is_empty());
    assert!(w.journals().is_empty());
    assert_eq!(snap(&w.root).get("Sorted/e.txt").map(|x| x.as_str()), Some("F:SOMEONE ELSES"));
}
#[test]
fn a_copy_never_goes_over_something_new() {
    let w = simple_world();
    put(&w.root, "pics-backup/d.jpg", "SOMEONE ELSES", 1);
    // (that also puts a folder where the reality wants to make one: the folder step fails first)
    let before = snap(&w.root);
    let v = api::apply(&w.env(), &w.data, &w.id).unwrap();
    assert!(!ok(&v));
    assert_eq!(snap(&w.root), before);
}

// ---------- a failure at every step ----------
/// how many changes to the disk a run makes
fn mutations(build: &dyn Fn() -> World) -> usize {
    let w = build();
    let env = w.env();
    let v = api::apply(&env, &w.data, &w.id).unwrap();
    assert!(ok(&v), "{v}");
    env.count()
}

fn check_failure_at_every_step(build: &dyn Fn() -> World) {
    let total = mutations(build);
    assert!(total > 0);
    for after in [false, true] {
        for k in 1..=total {
            let w = build();
            let env = TEnv::failing(w.bin.clone(), k, after);
            let v = api::apply(&env, &w.data, &w.id).unwrap();
            let why = format!("failure at call {k} of {total} (after={after}): {v}");
            w.assert_no_loss(&why);
            let left_over = std::fs::read_dir(&w.root).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(STAGE_PREFIX));
            if ok(&v) {
                // it got as far as the Recycle Bin: the changes are made, items that couldn't be recycled stay put
                let notes = v["notes"].as_array().map(|a| a.len()).unwrap_or(0);
                if notes == 0 && !left_over {
                    assert_eq!(snap(&w.root), expected(&w), "{why}");
                }
                assert!(w.wrongly_recycled().is_empty(), "something that wasn't to be deleted was recycled — {why}");
                // and it can be undone, completely
                let u = api::undo(&w.env(), &w.data, &w.id).unwrap();
                if ok(&u) {
                    w.assert_back_as_it_was(&format!("undo after {why}"));
                } else {
                    w.assert_no_loss(&format!("undo failed: {u} after {why}"));
                }
            } else {
                assert!(v["kind"] == "failed", "{why}");
                assert!(v["problems"].as_array().map(|a| a.is_empty()).unwrap_or(true), "everything must be reversible here: {why}");
                w.assert_back_as_it_was(&why);
                assert!(w.journals().is_empty(), "the journal of a reversed run is removed: {why}");
                assert!(!left_over, "the set-aside folder must be gone: {why}");
                assert!(api::view(&w.env(), &w.data, &w.id).unwrap()["applied"].is_null());
            }
        }
    }
}

#[test]
fn a_failure_at_any_step_leaves_the_folder_as_it_was_or_loses_nothing() {
    check_failure_at_every_step(&simple_world);
}
#[test]
fn a_failure_at_any_step_random_folders() {
    for seed in 0..25u64 {
        check_failure_at_every_step(&move || random_world(seed, 10, true));
    }
}

// ---------- the program stops dead ----------
fn commit_started(w: &World) -> bool {
    w.journals().iter().any(|j| std::fs::read_to_string(j).map(|t| t.contains("\"e\":\"commit\"")).unwrap_or(false))
}
fn check_crash_at_every_step(build: &dyn Fn() -> World) {
    let total = mutations(build);
    for after in [false, true] {
        for k in 1..=total {
            let w = build();
            let env = TEnv::crashing(w.bin.clone(), k, after);
            let r = api::apply(&env, &w.data, &w.id);
            let why = format!("crash at call {k} of {total} (after={after})");
            if !env.crashed() {
                continue;
            }
            assert!(r.is_err() || !ok(r.as_ref().unwrap()) || k == total, "{why}: {r:?}");
            // the next time Dogfile starts
            let began_commit = commit_started(&w);
            w.assert_no_loss(&format!("{why}, before recovery"));
            let report = api::recover(&w.env(), &w.data);
            let first = report.as_array().and_then(|a| a.first()).cloned();
            w.assert_no_loss(&format!("{why}, after recovery: {report}"));
            if let Some(f) = &first {
                assert!(f["problems"].as_array().unwrap().is_empty(), "{why}: {report}");
            }
            assert!(w.journals().is_empty(), "{why}: journal left");
            let stage_left = std::fs::read_dir(&w.root).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(STAGE_PREFIX));
            assert!(!stage_left, "{why}: set-aside folder left");
            if began_commit || (first.is_none() && k == total) {
                // finished: the folder is the reality, and it can be undone
                assert_eq!(snap(&w.root), expected(&w), "{why}");
                assert!(w.wrongly_recycled().is_empty(), "{why}");
                let v = api::view(&w.env(), &w.data, &w.id).unwrap();
                assert!(v["applied"].is_object(), "{why}: a finished run can be undone");
                let u = api::undo(&w.env(), &w.data, &w.id).unwrap();
                assert!(ok(&u), "{why}: {u}");
                w.assert_back_as_it_was(&format!("{why}, after undo"));
            } else {
                // reversed
                let s = snap(&w.root);
                // (a crash right after the very last step of the first phase can't be told from a finished one)
                assert_eq!(s, w.before, "{why}");
                assert!(w.bin_contents().is_empty(), "{why}");
            }
        }
    }
}
#[test]
fn a_crash_at_any_step_is_put_right_at_the_next_start() {
    check_crash_at_every_step(&simple_world);
}
#[test]
fn a_crash_at_any_step_random_folders() {
    for seed in 100..120u64 {
        check_crash_at_every_step(&move || random_world(seed, 10, true));
    }
}
#[test]
fn a_torn_or_empty_journal_is_harmless() {
    let w = simple_world();
    let jd = reality::dir(&w.data).join("journals");
    std::fs::create_dir_all(&jd).unwrap();
    std::fs::write(jd.join("journal-empty.jsonl"), "").unwrap();
    std::fs::write(jd.join("journal-torn.jsonl"), "{\"e\":\"begin\",\"rid\":\"torn\",\"owner\":\"\",\"root\":\"/nonexistent-folder-xyz\"}\n{\"e\":\"do\",\"i\":0,\"step\":{\"t\":\"mv\",\"from\":\"a\",\"to\":\"b\"}}\n{\"e\":\"ok\",\"i\"").unwrap();
    let before = snap(&w.root);
    let r = api::recover(&w.env(), &w.data);
    assert_eq!(snap(&w.root), before);
    // the torn one names a folder that isn't there: nothing to put back, and it is not an error to say so
    assert!(r.as_array().unwrap().iter().all(|x| x["problems"].as_array().map(|p| p.len() <= 1).unwrap_or(true)), "{r}");
}

// ---------- the reality matches the disk, over and over ----------
#[test]
fn random_realities_come_out_exactly_as_planned_and_undo_exactly() {
    for seed in 1000..1300u64 {
        let nops = 3 + (seed % 14) as usize;
        let w = random_world(seed, nops, true);
        let env = w.env();
        let r = reality::load(&w.data, &w.id).unwrap();
        let rp = reality::replay(&r.base, r.ci, &r.ops, true);
        if rp.acts.is_empty() {
            continue;
        }
        let v = api::apply(&env, &w.data, &w.id).unwrap();
        assert!(ok(&v), "seed {seed}: {v}");
        assert_eq!(snap(&w.root), expected(&w), "seed {seed}: the folder isn't what the reality showed");
        let got: BTreeSet<String> = w.bin_contents().into_iter().collect();
        assert!(expected_deleted(&w).is_subset(&got), "seed {seed}: something that should have been recycled wasn't");
        assert!(w.wrongly_recycled().is_empty(), "seed {seed}: the wrong things were recycled");
        w.assert_no_loss(&format!("seed {seed}"));
        let u = api::undo(&env, &w.data, &w.id).unwrap();
        assert!(ok(&u), "seed {seed}: {u}");
        w.assert_back_as_it_was(&format!("seed {seed} after undo"));
    }
}
#[test]
fn random_realities_with_every_change_switched_on_and_off_at_random() {
    for seed in 2000..2100u64 {
        let mut rng = StdRng::seed_from_u64(seed);
        let w0 = random_world(seed, 12, true);
        let mut r = reality::load(&w0.data, &w0.id).unwrap();
        for o in r.ops.iter_mut() {
            o.on = rng.random_bool(0.6);
        }
        reality::save(&w0.data, &r).unwrap();
        let rp = reality::replay(&r.base, r.ci, &r.ops, true);
        if rp.acts.is_empty() {
            continue;
        }
        let v = api::apply(&w0.env(), &w0.data, &w0.id).unwrap();
        assert!(ok(&v), "seed {seed}: {v}");
        assert_eq!(snap(&w0.root), expected(&w0), "seed {seed}");
        w0.assert_no_loss(&format!("seed {seed}"));
        let u = api::undo(&w0.env(), &w0.data, &w0.id).unwrap();
        assert!(ok(&u), "seed {seed}: {u}");
        w0.assert_back_as_it_was(&format!("seed {seed} after undo"));
    }
}

// ---------- undo ----------
#[test]
fn undo_refuses_when_the_folder_has_changed_and_changes_nothing() {
    let cases: Vec<(&str, Box<dyn Fn(&Path)>)> = vec![
        ("a moved file was moved again", Box::new(|r| std::fs::rename(r.join("Sorted/e.txt"), r.join("elsewhere.txt")).unwrap())),
        ("a copy was edited", Box::new(|r| put(r, "pics-backup/d.jpg", "EDITED!", 4000))),
        ("something now where a file was", Box::new(|r| put(r, "e.txt", "NEW E", 1))),
    ];
    for (name, f) in cases {
        let w = simple_world();
        assert!(ok(&api::apply(&w.env(), &w.data, &w.id).unwrap()));
        f(&w.root);
        let changed = snap(&w.root);
        let bin_before = w.bin_contents();
        let env = w.env();
        let u = api::undo(&env, &w.data, &w.id).unwrap();
        assert!(!ok(&u) && u["kind"] == "blocked", "{name}: {u}");
        assert_eq!(snap(&w.root), changed, "{name}");
        assert_eq!(w.bin_contents(), bin_before, "{name}");
        assert_eq!(env.count(), 0, "{name}: nothing may be attempted");
    }
}
#[test]
fn undo_that_fails_part_way_loses_nothing_and_can_be_finished() {
    let build = simple_world;
    let total = {
        let w = build();
        assert!(ok(&api::apply(&w.env(), &w.data, &w.id).unwrap()));
        let env = w.env();
        assert!(ok(&api::undo(&env, &w.data, &w.id).unwrap()));
        env.count()
    };
    assert!(total > 3);
    for after in [false, true] {
        for k in 1..=total {
            let w = build();
            assert!(ok(&api::apply(&w.env(), &w.data, &w.id).unwrap()));
            let env = TEnv::failing(w.bin.clone(), k, after);
            let u = api::undo(&env, &w.data, &w.id).unwrap();
            let why = format!("undo failing at {k}/{total} after={after}: {u}");
            w.assert_no_loss(&why);
            if !ok(&u) {
                // what is left can be undone by trying again
                let u2 = api::undo(&w.env(), &w.data, &w.id).unwrap();
                w.assert_no_loss(&format!("{why} / second try {u2}"));
                if ok(&u2) {
                    w.assert_back_as_it_was(&format!("{why} / second try"));
                }
            } else {
                w.assert_back_as_it_was(&why);
            }
        }
    }
}
#[test]
fn undo_goes_back_in_reverse_so_names_used_twice_work() {
    let mut w = World::new();
    put(&w.root, "a.txt", "A", 1);
    put(&w.root, "b.txt", "B", 2);
    // delete a, then move b onto the name a had, then make a new folder with the name b had
    w.reality(vec![del("a.txt"), mv("b.txt", "a.txt"), mk("b.txt")]);
    let env = w.env();
    assert!(ok(&api::apply(&env, &w.data, &w.id).unwrap()));
    assert_eq!(snap(&w.root), expected(&w));
    assert_eq!(snap(&w.root).get("a.txt").map(|x| x.as_str()), Some("F:B"));
    assert_eq!(w.bin_contents(), vec!["A".to_string()]);
    assert!(ok(&api::undo(&env, &w.data, &w.id).unwrap()));
    w.assert_back_as_it_was("name reuse");
}
#[test]
fn swapping_two_files_names_works_on_disk() {
    let mut w = World::new();
    put(&w.root, "a.txt", "A", 1);
    put(&w.root, "b.txt", "B", 2);
    w.reality(vec![mv("a.txt", "tmp"), mv("b.txt", "a.txt"), mv("tmp", "b.txt")]);
    assert!(ok(&api::apply(&w.env(), &w.data, &w.id).unwrap()));
    let s = snap(&w.root);
    assert_eq!(s["a.txt"], "F:B");
    assert_eq!(s["b.txt"], "F:A");
    assert!(ok(&api::undo(&w.env(), &w.data, &w.id).unwrap()));
    w.assert_back_as_it_was("swap");
}

// ---------- the commands ----------
#[test]
fn a_drive_without_a_recycle_bin_never_deletes() {
    let mut w = simple_world();
    let mut env = w.env();
    env.has_bin = false;
    let v = api::view(&env, &w.data, &w.id).unwrap();
    assert_eq!(v["canDelete"], false);
    assert!(v["ops"].as_array().unwrap().iter().any(|o| o["state"] == "blocked"), "{v}");
    // the rest can still be made
    let a = api::apply(&env, &w.data, &w.id).unwrap();
    assert!(ok(&a), "{a}");
    assert!(w.bin_contents().is_empty());
    assert!(snap(&w.root).contains_key("docs/old/c.txt"), "the delete was left out");
    w.before = BTreeMap::new();
    // and the delete is not accepted in the first place
    let w2 = simple_world();
    let r = api::add_ops(&env, &w2.data, &w2.id, "x", &json!([{ "op": "delete", "path": "e.txt" }])).unwrap();
    assert_eq!(r["rejected"].as_array().unwrap().len(), 1);
}
#[test]
fn bad_changes_are_rejected_one_by_one_and_the_good_ones_kept() {
    let mut w = World::new();
    put(&w.root, "a.txt", "A", 1);
    w.reality(vec![]);
    let env = w.env();
    let r = api::add_ops(
        &env,
        &w.data,
        &w.id,
        "mixed",
        &json!([
            { "op": "mkdir", "path": "new" },
            { "op": "move", "from": "a.txt", "to": "new/a.txt" },
            { "op": "move", "from": "a.txt", "to": "again.txt" },
            { "op": "mkdir", "path": "con" },
            { "op": "move", "from": "nothing", "to": "x" },
            { "op": "delete", "path": "new/a.txt" }
        ]),
    )
    .unwrap();
    assert_eq!(r["added"].as_array().unwrap().len(), 3);
    let rej: Vec<String> = r["rejected"].as_array().unwrap().iter().map(|x| x["why"].as_str().unwrap().to_string()).collect();
    assert_eq!(rej.len(), 3, "{rej:?}");
    assert!(api::add_ops(&env, &w.data, &w.id, "x", &json!([{ "op": "explode" }])).is_err());
    assert!(api::add_ops(&env, &w.data, &w.id, "x", &json!("nope")).is_err());
}
#[test]
fn presets_write_changes_that_can_all_be_made() {
    for kind in ["type", "month", "flatten"] {
        for seed in 0..40u64 {
            let mut rng = StdRng::seed_from_u64(seed);
            let mut w = World::new();
            fixture(&w.root, &mut rng);
            w.reality(vec![]);
            let env = w.env();
            let v = api::preset(&env, &w.data, &w.id, kind, "").unwrap();
            assert_eq!(v["rejected"].as_array().map(|a| a.len()).unwrap_or(0), 0, "{kind} {seed}: {v}");
            let r = reality::load(&w.data, &w.id).unwrap();
            if r.ops.is_empty() {
                continue;
            }
            let rp = reality::replay(&r.base, r.ci, &r.ops, true);
            assert!(rp.state.iter().all(|s| s.1 == State::On), "{kind} {seed}: {:?}", rp.state);
            assert!(ok(&api::apply(&env, &w.data, &w.id).unwrap()), "{kind} {seed}");
            assert_eq!(snap(&w.root), expected(&w), "{kind} {seed}");
            w.assert_no_loss(&format!("{kind} {seed}"));
            // nothing was deleted by sorting
            assert!(w.bin_contents().is_empty());
            assert!(ok(&api::undo(&env, &w.data, &w.id).unwrap()));
            w.assert_back_as_it_was(&format!("{kind} {seed} undo"));
        }
    }
}
#[test]
fn sort_by_type_puts_each_kind_in_its_folder_and_keeps_both_when_names_clash() {
    let mut w = World::new();
    put(&w.root, "a.jpg", "1", 1);
    put(&w.root, "b.pdf", "2", 1);
    put(&w.root, "sub/a.jpg", "3", 1);
    put(&w.root, "noext", "4", 1);
    put(&w.root, "Images/a.jpg", "5", 1);
    w.reality(vec![]);
    api::preset(&w.env(), &w.data, &w.id, "type", "").unwrap();
    assert!(ok(&api::apply(&w.env(), &w.data, &w.id).unwrap()));
    let s = snap(&w.root);
    assert_eq!(s["Images/a.jpg"], "F:5");
    assert_eq!(s["Images/a (2).jpg"], "F:1", "{s:?}");
    assert_eq!(s["Documents/b.pdf"], "F:2");
    assert_eq!(s["Other/noext"], "F:4");
    assert_eq!(s["sub/a.jpg"], "F:3", "files in other folders are left alone unless asked");
    w.assert_no_loss("sort");
}
#[test]
fn month_arithmetic_is_right() {
    use super::presets::year_month;
    assert_eq!(year_month(0), (1970, 1));
    assert_eq!(year_month(951_782_400), (2000, 2)); // 2000-02-29
    assert_eq!(year_month(1_700_000_000), (2023, 11));
    assert_eq!(year_month(1_709_251_199), (2024, 2)); // 2024-02-29 23:59:59
    assert_eq!(year_month(1_709_251_200), (2024, 3));
    assert_eq!(year_month(-86_400), (1969, 12));
    assert_eq!(year_month(4_102_444_800), (2100, 1));
}
#[test]
fn realities_are_saved_listed_renamed_and_discarded() {
    let w = simple_world();
    let env = w.env();
    let l = api::list(&w.data);
    assert_eq!(l.as_array().unwrap().len(), 1);
    assert_eq!(l[0]["ops"], 6);
    api::rename(&w.data, &w.id, "  My plan  ").unwrap();
    assert_eq!(api::list(&w.data)[0]["name"], "My plan");
    // a made-real reality can't be thrown away by accident
    assert!(ok(&api::apply(&env, &w.data, &w.id).unwrap()));
    assert!(api::discard(&w.data, &w.id, false).is_err());
    assert!(api::discard(&w.data, &w.id, true).is_ok());
    assert_eq!(api::list(&w.data).as_array().unwrap().len(), 0);
    assert!(api::view(&env, &w.data, &w.id).is_err());
    // an id that tries to leave the folder is refused
    assert!(api::view(&env, &w.data, "../x").is_err());
    assert!(api::discard(&w.data, "../../x", true).is_err());
}
#[test]
fn looking_at_the_folder_again_keeps_the_changes_and_marks_the_ones_that_no_longer_fit() {
    let mut w = simple_world();
    std::fs::remove_file(w.root.join("e.txt")).unwrap();
    put(&w.root, "brand-new.txt", "BN", 1);
    let env = w.env();
    w.orig = snap(&w.root).into_iter().filter_map(|(p, v)| v.strip_prefix("F:").map(|c| (p.clone(), c.to_string()))).collect();
    let v = api::rebase(&env, &w.data, &w.id).unwrap();
    let blocked = v["ops"].as_array().unwrap().iter().filter(|o| o["state"] == "blocked").count();
    assert_eq!(blocked, 1, "the move of e.txt no longer fits: {v}");
    assert!(v["rows"].as_array().unwrap().iter().any(|r| r["p"] == "brand-new.txt"));
    let a = api::apply(&env, &w.data, &w.id).unwrap();
    assert!(ok(&a), "{a}");
    assert_eq!(snap(&w.root), expected(&w));
}
#[test]
fn check_reports_the_difference_without_changing_anything() {
    let w = simple_world();
    let env = w.env();
    assert!(api::check(&env, &w.data, &w.id).unwrap()["ok"].as_bool().unwrap());
    put(&w.root, "e.txt", "changed", 5000);
    let c = api::check(&env, &w.data, &w.id).unwrap();
    assert!(!c["ok"].as_bool().unwrap());
    assert!(c["drift"][0].as_str().unwrap().contains("e.txt"));
    assert_eq!(env.count(), 0);
}
#[test]
fn the_view_shows_what_changed_and_what_is_gone() {
    let w = simple_world();
    let v = api::view(&w.env(), &w.data, &w.id).unwrap();
    let rows = v["rows"].as_array().unwrap();
    let tag = |p: &str| rows.iter().find(|r| r["p"] == p).map(|r| r["c"].as_str().unwrap().to_string());
    assert_eq!(tag("Sorted").as_deref(), Some("new"));
    assert_eq!(tag("Sorted/e.txt").as_deref(), Some("moved"));
    assert_eq!(tag("docs/a-renamed.txt").as_deref(), Some("renamed"));
    assert_eq!(tag("pics-backup").as_deref(), Some("copy"));
    assert_eq!(tag("docs/d.jpg").as_deref(), Some("moved"));
    assert_eq!(tag("docs/old"), None);
    let gone: Vec<&str> = v["gone"].as_array().unwrap().iter().map(|g| g["p"].as_str().unwrap()).collect();
    assert_eq!(gone, vec!["docs/old"], "only the top of a deleted folder is listed");
    assert_eq!(v["stats"]["deleted"], 1);
    assert_eq!(v["stats"]["copies"], 1);
}
#[cfg(unix)]
#[test]
fn a_link_in_the_folder_survives_everything() {
    let mut w = World::new();
    put(&w.root, "real/a.txt", "A", 1);
    put(&w.root, "box/keep.txt", "K", 1);
    std::os::unix::fs::symlink(w.root.join("real"), w.root.join("box/lnk")).unwrap();
    put(&w.root, "x.txt", "X", 1);
    w.reality(vec![del("box"), mv("x.txt", "y.txt")]);
    let r = api::view(&w.env(), &w.data, &w.id).unwrap();
    assert_eq!(r["ops"][0]["state"], "blocked", "a folder holding a link can't be deleted: {r}");
    assert!(ok(&api::apply(&w.env(), &w.data, &w.id).unwrap()));
    let s = snap(&w.root);
    assert_eq!(s["box/lnk"], "L");
    assert_eq!(s["real/a.txt"], "F:A");
    assert_eq!(s["y.txt"], "F:X");
}
#[test]
fn only_one_thing_changes_the_disk_at_a_time_and_applying_to_a_missing_folder_is_refused() {
    let w = simple_world();
    std::fs::remove_dir_all(&w.root).unwrap();
    let v = api::apply(&w.env(), &w.data, &w.id).unwrap();
    assert!(!ok(&v), "{v}");
}
#[test]
fn a_hundred_thousand_steps_worth_of_names_stay_fast() {
    // the virtual folder must not be slow on a big folder
    let items: Vec<BEntry> = (0..20_000).map(|i| BEntry { path: format!("d{}/f{i}.txt", i % 50), kind: Kind::File, size: 1, mtime: 1 }).chain((0..50).map(|i| BEntry { path: format!("d{i}"), kind: Kind::Dir, size: 0, mtime: 0 })).collect();
    let ops: Vec<Op> = (0..2000).map(|i| Op { id: i, group: "g".into(), kind: mv(&format!("d{}/f{}.txt", i % 50, i), &format!("d{}/g{i}.txt", i % 50)), on: true }).collect();
    let t = std::time::Instant::now();
    let rp = reality::replay(&items, false, &ops, true);
    assert!(rp.state.iter().all(|s| s.1 == State::On));
    assert!(t.elapsed().as_secs() < 20, "replay took {:?}", t.elapsed());
}

/// A long run for when this code changes: `cargo test --lib multiverse -- --ignored soak`
/// (set MV_SOAK to the number of random folders; each is applied, undone, and then made to fail and to stop at random steps)
#[test]
#[ignore]
fn soak() {
    let n: u64 = std::env::var("MV_SOAK").ok().and_then(|v| v.parse().ok()).unwrap_or(1500);
    for seed in 50_000..50_000 + n {
        let nops = 4 + (seed % 20) as usize;
        let total = {
            let w = random_world(seed, nops, true);
            let env = w.env();
            let v = api::apply(&env, &w.data, &w.id);
            let Ok(v) = v else { panic!("seed {seed}: {v:?}") };
            if v["kind"] == "refused" && v["message"].as_str().unwrap_or("").contains("nothing switched") {
                continue;
            }
            if !ok(&v) {
                // no changes to make
                continue;
            }
            assert_eq!(snap(&w.root), expected(&w), "seed {seed}");
            assert!(w.wrongly_recycled().is_empty(), "seed {seed}");
            let u = api::undo(&env, &w.data, &w.id).unwrap();
            assert!(ok(&u), "seed {seed}: {u}");
            w.assert_back_as_it_was(&format!("seed {seed}"));
            env.count()
        };
        let mut rng = StdRng::seed_from_u64(seed);
        for _ in 0..6 {
            let k = rng.random_range(1..=total.max(1));
            let after = rng.random_bool(0.5);
            // a failure
            {
                let w = random_world(seed, nops, true);
                let env = TEnv::failing(w.bin.clone(), k, after);
                let v = api::apply(&env, &w.data, &w.id).unwrap();
                let why = format!("seed {seed}: failure at {k}/{total} after={after}: {v}");
                w.assert_no_loss(&why);
                if !ok(&v) {
                    assert!(v["problems"].as_array().map(|a| a.is_empty()).unwrap_or(true), "{why}");
                    w.assert_back_as_it_was(&why);
                    assert!(w.journals().is_empty(), "{why}");
                } else {
                    assert!(w.wrongly_recycled().is_empty(), "{why}");
                    let u = api::undo(&w.env(), &w.data, &w.id).unwrap();
                    if ok(&u) {
                        w.assert_back_as_it_was(&format!("undo: {why}"));
                    }
                    w.assert_no_loss(&format!("undo: {why}"));
                }
            }
            // a stop
            {
                let w = random_world(seed, nops, true);
                let env = TEnv::crashing(w.bin.clone(), k, after);
                let _ = api::apply(&env, &w.data, &w.id);
                if !env.crashed() {
                    continue;
                }
                let why = format!("seed {seed}: stop at {k}/{total} after={after}");
                let began_commit = commit_started(&w);
                w.assert_no_loss(&why);
                let report = api::recover(&w.env(), &w.data);
                w.assert_no_loss(&format!("{why}: {report}"));
                assert!(w.journals().is_empty(), "{why}: journal left: {report}");
                if began_commit {
                    assert!(w.wrongly_recycled().is_empty(), "{why}");
                    let u = api::undo(&w.env(), &w.data, &w.id).unwrap();
                    assert!(ok(&u), "{why}: {u}");
                    w.assert_back_as_it_was(&format!("undo: {why}"));
                } else if report.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                    w.assert_back_as_it_was(&why);
                }
            }
        }
    }
}

// ---------- stage 2: several what-if copies of one folder ----------
/// another reality of the same folder, made from the folder as it is now
fn another(w: &World, name: &str, ops: Vec<OpKind>) -> String {
    let env = w.env();
    let mut r = Reality::new(&env, name, &w.root.to_string_lossy()).unwrap();
    r.add("g", ops);
    reality::save(&w.data, &r).unwrap();
    r.id
}
fn replay_of(w: &World, id: &str) -> reality::Replay {
    let r = reality::load(&w.data, id).unwrap();
    reality::replay(&r.base, r.ci, &r.ops, true)
}

#[test]
fn a_duplicate_starts_the_same_and_then_goes_its_own_way() {
    let w = simple_world();
    let env = w.env();
    assert!(ok(&api::apply(&env, &w.data, &w.id).unwrap()));
    let f = api::fork(&w.data, &w.id, "").unwrap();
    let fid = f["id"].as_str().unwrap().to_string();
    assert_ne!(fid, w.id);
    let fr = reality::load(&w.data, &fid).unwrap();
    let orig = reality::load(&w.data, &w.id).unwrap();
    assert_eq!(fr.ops, orig.ops);
    assert_eq!(fr.base, orig.base);
    assert!(fr.applied.is_none(), "a duplicate hasn't been made real");
    assert!(orig.applied.is_some(), "…and the one it came from still has");
    assert!(fr.name.ends_with("(copy)"));
    // independent
    api::toggle(&env, &w.data, &fid, &json!([fr.ops[0].id]), false).unwrap();
    assert!(reality::load(&w.data, &w.id).unwrap().ops[0].on);
    assert_eq!(api::list(&w.data).as_array().unwrap().len(), 2);
    assert_eq!(api::fork(&w.data, &w.id, "  Plan B ").unwrap()["id"].as_str().map(|_| ()), Some(()));
    assert!(api::fork(&w.data, "../nope", "").is_err());
}
#[test]
fn two_copies_with_the_same_changes_compare_as_identical() {
    let w = simple_world();
    let f = api::fork(&w.data, &w.id, "B").unwrap();
    let c = api::compare(&w.env(), &w.data, &w.id, f["id"].as_str().unwrap()).unwrap();
    assert_eq!(c["identical"], true, "{c}");
    assert_eq!(c["differ"], 0);
}
#[test]
fn compare_lists_what_ends_up_in_different_places() {
    let mut w = World::new();
    put(&w.root, "a.txt", "A", 1);
    put(&w.root, "b.txt", "B", 1);
    put(&w.root, "c.txt", "C", 1);
    put(&w.root, "dir/inner.txt", "I", 1);
    w.reality(vec![mk("X"), mv("a.txt", "X/a.txt"), mv("b.txt", "bee.txt"), cp("c.txt", "c2.txt"), mv("dir", "moved")]);
    let a = w.id.clone();
    let b = another(&w, "B", vec![mk("Y"), mv("a.txt", "Y/a.txt"), del("b.txt"), mv("dir", "moved")]);
    let c = api::compare(&w.env(), &w.data, &a, &b).unwrap();
    let rows = c["rows"].as_array().unwrap();
    let row = |o: &str| rows.iter().find(|r| r["origin"] == o).cloned();
    let ra = row("a.txt").expect("a.txt differs");
    assert_eq!((ra["a"].as_str(), ra["b"].as_str()), (Some("X/a.txt"), Some("Y/a.txt")));
    let rb = row("b.txt").expect("b.txt differs");
    assert_eq!((rb["a"].as_str(), rb["b"].as_str()), (Some("bee.txt"), None), "deleted in B");
    assert!(row("c.txt").is_none(), "c.txt stays in both");
    assert!(row("dir").is_none() && row("dir/inner.txt").is_none(), "moved the same way in both, and what's inside came along");
    let only_a: Vec<&str> = c["onlyA"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
    let only_b: Vec<&str> = c["onlyB"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
    assert_eq!(only_a, vec!["X", "c2.txt"]);
    assert_eq!(only_b, vec!["Y"]);
    assert_eq!(c["identical"], false);
}
#[test]
fn compare_is_right_for_random_pairs() {
    for seed in 0..120u64 {
        let mut rng = StdRng::seed_from_u64(seed + 9000);
        let mut w = World::new();
        fixture(&w.root, &mut rng);
        let base = reality::scan(&RealEnv, &w.root).unwrap();
        let ops_a = random_ops(&base, &mut rng, 8, true);
        let ops_b = random_ops(&base, &mut rng, 8, true);
        w.reality(ops_a);
        let a = w.id.clone();
        let b = another(&w, "B", ops_b);
        let (ra, rb) = (replay_of(&w, &a), replay_of(&w, &b));
        let c = api::compare(&w.env(), &w.data, &a, &b).unwrap();
        // what it says is true
        let find = |rp: &reality::Replay, origin: &str| rp.tree.nodes().find(|n| !n.copy && n.origin.as_deref() == Some(origin)).map(|n| n.path.clone());
        for r in c["rows"].as_array().unwrap() {
            let o = r["origin"].as_str().unwrap();
            assert_eq!(r["a"].as_str().map(String::from), find(&ra, o), "seed {seed} {o}");
            assert_eq!(r["b"].as_str().map(String::from), find(&rb, o), "seed {seed} {o}");
            assert_ne!(r["a"], r["b"], "seed {seed}");
        }
        // and it is complete: the two end up the same exactly when it says identical
        let shape = |rp: &reality::Replay| -> BTreeSet<(String, Option<String>, bool)> { rp.tree.nodes().map(|n| (n.path.clone(), if n.copy { None } else { n.origin.clone() }, n.copy)).collect() };
        let paths = |rp: &reality::Replay| -> BTreeSet<String> { rp.tree.nodes().map(|n| n.path.clone()).collect() };
        if paths(&ra) != paths(&rb) {
            assert_eq!(c["identical"], false, "seed {seed}: different folders reported as identical");
        }
        if shape(&ra) == shape(&rb) {
            assert_eq!(c["identical"], true, "seed {seed}: the same folder reported as different: {c}");
        }
    }
}
#[test]
fn compare_refuses_different_folders() {
    let w = simple_world();
    let w2 = simple_world();
    // (the second world is another folder, in the same data folder)
    let r2 = reality::load(&w2.data, &w2.id).unwrap();
    reality::save(&w.data, &r2).unwrap();
    assert!(api::compare(&w.env(), &w.data, &w.id, &r2.id).is_err());
    assert!(api::take_ops(&w.env(), &w.data, &w.id, &r2.id, &json!([1])).is_err());
}
#[test]
fn changes_can_be_brought_over_from_another_copy_and_the_ones_that_dont_fit_say_why() {
    let mut w = World::new();
    put(&w.root, "a.txt", "A", 1);
    put(&w.root, "b.txt", "B", 1);
    w.reality(vec![mv("a.txt", "renamed.txt")]);
    let a = w.id.clone();
    let b = another(&w, "B", vec![mk("dir"), mv("a.txt", "dir/a.txt"), mv("b.txt", "dir/b.txt")]);
    let env = w.env();
    let br = reality::load(&w.data, &b).unwrap();
    let all: Vec<u32> = br.ops.iter().map(|o| o.id).collect();
    let r = api::take_ops(&env, &w.data, &a, &b, &json!(all)).unwrap();
    assert_eq!(r["added"].as_array().unwrap().len(), 2, "the folder and the move of b.txt: {r}");
    let rej = r["rejected"].as_array().unwrap();
    assert_eq!(rej.len(), 1);
    assert!(rej[0]["why"].as_str().unwrap().contains("a.txt"), "{rej:?}");
    let ar = reality::load(&w.data, &a).unwrap();
    assert_eq!(ar.ops.len(), 3);
    assert!(ar.ops.iter().skip(1).all(|o| o.group.starts_with("From “B”")));
    // B is untouched
    assert_eq!(reality::load(&w.data, &b).unwrap().ops, br.ops);
    assert!(api::take_ops(&env, &w.data, &a, &b, &json!([999])).is_err());
    assert!(api::take_ops(&env, &w.data, &a, &a, &json!([1])).is_err());
    // and the result can be made real
    assert!(ok(&api::apply(&env, &w.data, &a).unwrap()));
    let s = snap(&w.root);
    assert_eq!(s["renamed.txt"], "F:A");
    assert_eq!(s["dir/b.txt"], "F:B");
}
#[test]
fn only_one_of_several_copies_can_be_made_real_and_the_others_are_not_damaged() {
    let mut w = World::new();
    put(&w.root, "a.txt", "A", 1);
    put(&w.root, "b.txt", "B", 1);
    w.reality(vec![mv("a.txt", "x.txt")]);
    let a = w.id.clone();
    let b = another(&w, "B", vec![del("a.txt"), mv("b.txt", "y.txt")]);
    let env = w.env();
    assert!(ok(&api::apply(&env, &w.data, &a).unwrap()));
    let after_a = snap(&w.root);
    // B was made from the folder as it was: it must not be applied to what A made
    let v = api::apply(&env, &w.data, &b).unwrap();
    assert!(!ok(&v) && v["kind"] == "drift", "{v}");
    assert_eq!(snap(&w.root), after_a);
    assert!(w.bin_contents().is_empty());
    // undo A, and B works again
    assert!(ok(&api::undo(&env, &w.data, &a).unwrap()));
    assert!(ok(&api::apply(&env, &w.data, &b).unwrap()));
    let s = snap(&w.root);
    assert_eq!(s["y.txt"], "F:B");
    assert!(!s.contains_key("a.txt") && !s.contains_key("x.txt"));
    assert_eq!(w.bin_contents(), vec!["A".to_string()]);
    // A can no longer be made real or undone by accident: it was never applied this time
    let v = api::apply(&env, &w.data, &a).unwrap();
    assert!(!ok(&v), "{v}");
    w.assert_no_loss("two copies");
}
