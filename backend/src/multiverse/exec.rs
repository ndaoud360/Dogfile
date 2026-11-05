// Making a reality real, and taking it back. The rules this file keeps, because a mistake here loses someone's files:
//  * Before anything is touched, everything the changes rely on is checked against the folder as it was when the reality
//    was made. If anything is different (a file edited, moved, added to a folder that would be copied or recycled), nothing is done.
//  * Nothing is ever replaced and nothing is ever deleted for good. Moves are no-replace renames, copies go to a temporary
//    name first, and a delete only sets the item aside inside the folder.
//  * Items set aside are sent to the Recycle Bin last, after every other change has worked. If anything fails before that,
//    every change made so far is reversed, newest first, and the folder is back exactly as it was.
//  * Every step is written to a journal on disk before it is done. If the program stops in the middle, the next start
//    finishes the job or reverses it from the journal.
//  * What was applied can be undone: renames back, copies and new folders removed only if untouched, recycled items
//    restored. Undo checks everything first and refuses if the folder has changed since.
use super::env::{Env, Meta};
use super::tree::{Act, BEntry, Footprint, Kind};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const STAGE_PREFIX: &str = ".dogfile-multiverse-";

/// where an item that was deleted is now
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "s", rename_all = "camelCase")]
pub enum DelState {
    /// set aside in the folder, not recycled yet
    Staged,
    /// in the Recycle Bin, recycled from this path
    Trashed { from: String },
    /// couldn't be recycled; it was put back where it was
    Kept,
}

/// One thing that was done to the disk
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Step {
    Mv { from: String, to: String },
    Mkdir { path: String },
    Copy { from: String, to: String, part: String, size: u64 },
    /// `aside`: the file was replaced by new contents, so it is recycled from where it is set aside (its own name is taken)
    Del { orig: String, staged: String, kind: Kind, size: u64, mtime: i64, state: DelState, #[serde(default)] aside: bool },
    /// a file written from a blob: to a temporary name first, checked, then renamed into place
    Put { to: String, part: String, size: u64, blob: String },
}

pub struct Ctx<'a> {
    pub env: &'a dyn Env,
    pub root: &'a Path,
    /// where the journals are kept
    pub jdir: &'a Path,
    pub rid: &'a str,
    /// the reality these changes belong to (so a run finished from the journal can still be undone)
    pub owner: &'a str,
}

/// a path inside the folder, on disk
pub fn dp(root: &Path, p: &str) -> PathBuf {
    let mut b = root.to_path_buf();
    for x in p.split('/').filter(|x| !x.is_empty()) {
        b.push(x);
    }
    b
}
fn shown(p: &str) -> String {
    format!("“{p}”")
}

#[derive(Debug)]
pub enum ApplyError {
    /// nothing was done: the folder isn't as it was
    Drift(Vec<String>),
    /// nothing was done (or everything was reversed): why
    Refused(String),
    /// a step failed and everything done so far was reversed (`problems` is empty) or couldn't be fully reversed
    Failed { why: String, problems: Vec<String> },
    /// a test environment stopped dead
    Crashed,
}

#[derive(Default, Debug)]
pub struct Outcome {
    pub steps: Vec<Step>,
    /// things worth telling the person (an item that couldn't be recycled and was left where it was)
    pub notes: Vec<String>,
}

// ---------- journal ----------
pub struct Journal {
    f: std::fs::File,
    pub path: PathBuf,
}
impl Journal {
    pub fn path_for(jdir: &Path, rid: &str) -> PathBuf {
        jdir.join(format!("journal-{rid}.jsonl"))
    }
    pub fn open(jdir: &Path, rid: &str) -> std::io::Result<Journal> {
        std::fs::create_dir_all(jdir)?;
        let path = Self::path_for(jdir, rid);
        let f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Journal { f, path })
    }
    /// `sync`: the line is on the disk before this returns (done before a step is taken)
    pub fn line(&mut self, v: &Value, sync: bool) -> Result<(), String> {
        let mut s = serde_json::to_string(v).map_err(|e| e.to_string())?;
        s.push('\n');
        self.f.write_all(s.as_bytes()).map_err(|e| format!("The journal couldn’t be written: {e}"))?;
        if sync {
            self.f.sync_data().map_err(|e| format!("The journal couldn’t be written: {e}"))?;
        }
        Ok(())
    }
    pub fn remove(self) {
        let p = self.path.clone();
        drop(self.f);
        let _ = std::fs::remove_file(p);
    }
}

// ---------- looking at the folder ----------
fn walk(env: &dyn Env, root: &Path, rel: &str, out: &mut HashMap<String, Meta>, depth: usize) -> Result<(), String> {
    if depth > 64 {
        return Err("too deep".into());
    }
    for (name, m) in env.list(&dp(root, rel)).map_err(|e| format!("{rel}: {e}"))? {
        let p = if rel.is_empty() { name } else { format!("{rel}/{name}") };
        out.insert(p.clone(), m);
        if m.kind == Kind::Dir {
            walk(env, root, &p, out, depth + 1)?;
        }
    }
    Ok(())
}

/// What is different on disk from what the changes rely on. Empty means it's safe to go ahead.
pub fn preflight(env: &dyn Env, root: &Path, base: &[BEntry], foot: &Footprint) -> Vec<String> {
    let by_path: HashMap<&str, &BEntry> = base.iter().map(|e| (e.path.as_str(), e)).collect();
    let mut bad: Vec<String> = vec![];
    let mut seen: HashSet<&str> = HashSet::new();
    for p in &foot.files {
        if !seen.insert(p.as_str()) {
            continue;
        }
        let Some(b) = by_path.get(p.as_str()) else { continue };
        match env.stat(&dp(root, p)) {
            Ok(Some(m)) if m.kind == Kind::File && m.size == b.size && m.mtime == b.mtime => {}
            Ok(Some(m)) if m.kind != Kind::File => bad.push(format!("{} isn’t a file any more", shown(p))),
            Ok(Some(_)) => bad.push(format!("{} has been changed", shown(p))),
            Ok(None) => bad.push(format!("{} isn’t there any more", shown(p))),
            Err(e) => bad.push(format!("{} can’t be read ({e})", shown(p))),
        }
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for p in &foot.dirs {
        if !seen.insert(p.as_str()) {
            continue;
        }
        match env.stat(&dp(root, p)) {
            Ok(Some(m)) if m.kind == Kind::Dir => {}
            Ok(Some(_)) => bad.push(format!("{} isn’t a folder any more", shown(p))),
            Ok(None) => bad.push(format!("{} isn’t there any more", shown(p))),
            Err(e) => bad.push(format!("{} can’t be read ({e})", shown(p))),
        }
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for p in &foot.deep {
        if !seen.insert(p.as_str()) {
            continue;
        }
        let mut now = HashMap::new();
        if let Err(e) = walk(env, root, p, &mut now, 0) {
            bad.push(format!("{} can’t be read ({e})", shown(p)));
            continue;
        }
        let prefix = format!("{p}/");
        let mut want = 0usize;
        for e in base.iter().filter(|e| e.path.starts_with(&prefix)) {
            want += 1;
            match now.get(&e.path) {
                Some(m) if m.kind == e.kind && (e.kind != Kind::File || (m.size == e.size && m.mtime == e.mtime)) => {}
                Some(_) => bad.push(format!("{} has been changed", shown(&e.path))),
                None => bad.push(format!("{} isn’t there any more", shown(&e.path))),
            }
        }
        if now.len() != want {
            let known: HashSet<&str> = base.iter().filter(|e| e.path.starts_with(&prefix)).map(|e| e.path.as_str()).collect();
            for k in now.keys().filter(|k| !known.contains(k.as_str())).take(3) {
                bad.push(format!("{} was added to {}", shown(k), shown(p)));
            }
        }
    }
    bad.sort();
    bad.dedup();
    bad.truncate(50);
    bad
}

// ---------- applying ----------
fn io_msg(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::AlreadyExists => "something with that name is already there".into(),
        std::io::ErrorKind::NotFound => "it isn’t there".into(),
        std::io::ErrorKind::PermissionDenied => "it’s in use or Dogfile isn’t allowed to change it".into(),
        _ => e.to_string(),
    }
}

/// Do the changes. `acts` are the disk changes of every change that is switched on and can be made, in order.
pub fn apply(c: &Ctx, base: &[BEntry], foot: &Footprint, acts: &[Act]) -> Result<Outcome, ApplyError> {
    if acts.is_empty() {
        return Ok(Outcome::default());
    }
    let has_del = acts.iter().any(|a| matches!(a, Act::Stage { .. } | Act::Put { replace: true, .. }));
    if has_del && !c.env.has_bin(c.root) {
        return Err(ApplyError::Refused("This drive has no Recycle Bin, so nothing can be deleted safely here. Switch off the deletes to go ahead.".into()));
    }
    match c.env.stat(c.root) {
        Ok(Some(m)) if m.kind == Kind::Dir => {}
        _ => return Err(ApplyError::Refused("The folder isn’t there any more".into())),
    }
    let drift = preflight(c.env, c.root, base, foot);
    if !drift.is_empty() {
        return Err(ApplyError::Drift(drift));
    }
    // all the new content must be there and whole before anything is touched
    let blobs = super::blobs::dir_of_jdir(c.jdir);
    for a in acts {
        if let Act::Put { path, blob, size, .. } = a {
            if !super::blobs::verify(&blobs, blob, *size) {
                return Err(ApplyError::Refused(format!("The new contents for {} are missing or damaged, so nothing was changed. Make that change again.", shown(path))));
            }
        }
    }
    let stage_name = format!("{STAGE_PREFIX}{}", c.rid);
    let mut j = Journal::open(c.jdir, c.rid).map_err(|e| ApplyError::Refused(format!("The journal couldn’t be started: {e}")))?;
    j.line(&json!({ "e": "begin", "rid": c.rid, "owner": c.owner, "root": c.root.to_string_lossy(), "stage": stage_name }), true).map_err(ApplyError::Refused)?;
    let mut steps: Vec<Step> = vec![];
    let mut n = 0u32;
    let mut stage_n = 0u32;

    // one step: written first, then done, then marked done
    macro_rules! step {
        ($s:expr, $do:expr) => {{
            let s: Step = $s;
            if let Err(e) = j.line(&json!({ "e": "do", "i": n, "step": s }), true) {
                return fail(c, j, &steps, None, e);
            }
            let r: Result<(), String> = $do;
            if c.env.crashed() {
                return Err(ApplyError::Crashed);
            }
            match r {
                Ok(()) => {
                    let _ = j.line(&json!({ "e": "ok", "i": n }), false);
                    steps.push(s);
                    n += 1;
                }
                Err(e) => return fail(c, j, &steps, Some(s), e),
            }
        }};
    }

    if has_del {
        let p = c.root.join(&stage_name);
        step!(Step::Mkdir { path: stage_name.clone() }, c.env.mkdir(&p).map_err(|e| format!("The place to set deleted items aside couldn’t be made: {}", io_msg(&e))));
    }
    for a in acts {
        match a {
            Act::Mkdir { path } => {
                let p = dp(c.root, path);
                // looked at first, so that a folder found later where this one was made is known to be ours
                if matches!(c.env.stat(&p), Ok(Some(_))) {
                    return fail(c, j, &steps, None, format!("The folder {} couldn’t be made: something with that name is already there", shown(path)));
                }
                step!(Step::Mkdir { path: path.clone() }, c.env.mkdir(&p).map_err(|e| format!("The folder {} couldn’t be made: {}", shown(path), io_msg(&e))));
            }
            Act::Mv { from, to } => {
                let (f, t) = (dp(c.root, from), dp(c.root, to));
                step!(Step::Mv { from: from.clone(), to: to.clone() }, c.env.rename_new(&f, &t).map_err(|e| format!("{} couldn’t be moved to {}: {}", shown(from), shown(to), io_msg(&e))));
            }
            Act::CopyFile { from, to } => {
                let (f, t) = (dp(c.root, from), dp(c.root, to));
                let size = match c.env.stat(&f) {
                    Ok(Some(m)) => m.size,
                    _ => return fail(c, j, &steps, None, format!("{} isn’t there", shown(from))),
                };
                // looked at first, so that a file found later at the new name is known to be this step's own
                if matches!(c.env.stat(&t), Ok(Some(_))) {
                    return fail(c, j, &steps, None, format!("{} couldn’t be copied to {}: something with that name is already there", shown(from), shown(to)));
                }
                let part = format!("{to}.dogfile-part-{}", c.rid);
                let pp = dp(c.root, &part);
                step!(
                    Step::Copy { from: from.clone(), to: to.clone(), part: part.clone(), size },
                    (|| {
                        c.env.copy_new(&f, &pp).map_err(|e| format!("{} couldn’t be copied: {}", shown(from), io_msg(&e)))?;
                        c.env.rename_new(&pp, &t).map_err(|e| format!("{} couldn’t be copied to {}: {}", shown(from), shown(to), io_msg(&e)))
                    })()
                );
            }
            Act::Put { path, blob, size, replace, from_hash } => {
                let t = dp(c.root, path);
                if *replace {
                    // the file that is there is set aside first, exactly as a delete would, and is recycled last. It keeps its name
                    // (after a number) so that it can be found in the Recycle Bin.
                    let (kind, osize, mtime) = match c.env.stat(&t) {
                        Ok(Some(m)) if m.kind == Kind::File => (m.kind, m.size, m.mtime),
                        _ => return fail(c, j, &steps, None, format!("{} isn’t there", shown(path))),
                    };
                    // the new contents were made from one version of this file: it must still be that one
                    match super::blobs::hash_file(&t) {
                        Ok((h, n)) if h == *from_hash && n == osize => {}
                        _ => return fail(c, j, &steps, None, format!("{} has been changed since the new contents were made, so nothing was changed", shown(path))),
                    }
                    let staged = format!("{stage_name}/{stage_n}-{}", super::tree::name_of(path));
                    stage_n += 1;
                    let st = dp(c.root, &staged);
                    step!(
                        Step::Del { orig: path.clone(), staged: staged.clone(), kind, size: osize, mtime, state: DelState::Staged, aside: true },
                        c.env.rename_new(&t, &st).map_err(|e| format!("{} couldn’t be set aside: {}", shown(path), io_msg(&e)))
                    );
                }
                // looked at first, so that a file found later at this name is known to be this step's own
                if matches!(c.env.stat(&t), Ok(Some(_))) {
                    return fail(c, j, &steps, None, format!("The file {} couldn’t be made: something with that name is already there", shown(path)));
                }
                let part = format!("{path}.dogfile-part-{}", c.rid);
                let pp = dp(c.root, &part);
                let src = super::blobs::path_in(&blobs, blob);
                step!(
                    Step::Put { to: path.clone(), part: part.clone(), size: *size, blob: blob.clone() },
                    (|| {
                        c.env.copy_new(&src, &pp).map_err(|e| format!("The new contents of {} couldn’t be written: {}", shown(path), io_msg(&e)))?;
                        // what was written must be exactly the new contents
                        match super::blobs::hash_file(&pp) {
                            Ok((h, n)) if h == *blob && n == *size => {}
                            _ => {
                                let _ = c.env.remove_file(&pp);
                                return Err(format!("The new contents of {} weren’t written correctly, so nothing was changed", shown(path)));
                            }
                        }
                        c.env.rename_new(&pp, &t).map_err(|e| format!("The new contents of {} couldn’t be put in place: {}", shown(path), io_msg(&e)))
                    })()
                );
            }
            Act::Stage { path } => {
                let (kind, size, mtime) = match c.env.stat(&dp(c.root, path)) {
                    Ok(Some(m)) => (m.kind, m.size, m.mtime),
                    _ => return fail(c, j, &steps, None, format!("{} isn’t there", shown(path))),
                };
                let staged = format!("{stage_name}/{stage_n}");
                stage_n += 1;
                let (f, t) = (dp(c.root, path), dp(c.root, &staged));
                step!(
                    Step::Del { orig: path.clone(), staged: staged.clone(), kind, size, mtime, state: DelState::Staged, aside: false },
                    c.env.rename_new(&f, &t).map_err(|e| format!("{} couldn’t be set aside: {}", shown(path), io_msg(&e)))
                );
            }
        }
    }

    // everything worked: now, and only now, the deleted items go to the Recycle Bin
    let _ = j.line(&json!({ "e": "commit" }), true);
    let mut out = Outcome::default();
    for (i, s) in steps.iter_mut().enumerate() {
        if let Step::Del { orig, staged, kind, size, mtime, state, aside } = s {
            match commit_one(c, orig, staged, *kind, *size, *mtime, *aside) {
                Ok(st) => {
                    if let DelState::Kept = st {
                        out.notes.push(format!("{} couldn’t be sent to the Recycle Bin, so it was left where it was", shown(orig)));
                    }
                    *state = st;
                }
                Err(e) => {
                    if c.env.crashed() {
                        return Err(ApplyError::Crashed);
                    }
                    out.notes.push(e);
                }
            }
            let _ = j.line(&json!({ "e": "trashed", "i": i, "state": state }), false);
        }
    }
    let _ = c.env.remove_dir(&c.root.join(&stage_name));
    if c.env.crashed() {
        return Err(ApplyError::Crashed);
    }
    let _ = j.line(&json!({ "e": "end" }), true);
    j.remove();
    out.steps = steps;
    Ok(out)
}

/// One item from "set aside" to the Recycle Bin. It goes back to its own place first so that the Recycle Bin knows where
/// it came from (that is what "Restore" and Undo use).
fn commit_one(c: &Ctx, orig: &str, staged: &str, kind: Kind, size: u64, mtime: i64, aside: bool) -> Result<DelState, String> {
    let (o, s) = (dp(c.root, orig), dp(c.root, staged));
    if aside {
        // replaced by new contents: recycled from where it is set aside, under that name, never from its own place
        return match c.env.stat(&s) {
            Ok(Some(m)) if m.kind == kind && m.size == size && m.mtime == mtime => match c.env.trash(&s) {
                Ok(()) => Ok(DelState::Trashed { from: s.to_string_lossy().to_string() }),
                Err(e) if c.env.crashed() => Err(e),
                Err(_) if exists(c, &s).is_none() => Ok(DelState::Trashed { from: s.to_string_lossy().to_string() }),
                Err(e) => Err(format!("The old {} is still set aside in {} because it couldn’t be recycled: {e}", shown(orig), shown(staged.rsplit_once('/').map(|x| x.0).unwrap_or(staged)))),
            },
            Ok(Some(_)) => Err(format!("The old {} was changed while it was set aside, so it was left alone", shown(orig))),
            // gone from the set-aside place: it was recycled by an earlier, interrupted run
            Ok(None) => Ok(DelState::Trashed { from: s.to_string_lossy().to_string() }),
            Err(e) => Err(format!("{} couldn’t be checked: {e}", shown(orig))),
        };
    }
    let ok_item = |m: &Meta| m.kind == kind && (kind != Kind::File || (m.size == size && m.mtime == mtime));
    match c.env.stat(&s) {
        Ok(Some(m)) if ok_item(&m) => {
            let moved_back = match c.env.rename_new(&s, &o) {
                Ok(()) => true,
                Err(_) if c.env.crashed() => return Err("stopped".into()),
                // reported as failed: if it is gone from the set-aside place and is at its own place, it was moved
                Err(_) => exists(c, &s).is_none() && matches!(exists(c, &o), Some(m) if ok_item(&m)),
            };
            if moved_back {
                return match c.env.trash(&o) {
                    Ok(()) => Ok(DelState::Trashed { from: o.to_string_lossy().to_string() }),
                    Err(e) if c.env.crashed() => Err(e),
                    // reported as failed: where is it? still in its place means it wasn't recycled
                    Err(_) => Ok(if exists(c, &o).is_some() { DelState::Kept } else { DelState::Trashed { from: o.to_string_lossy().to_string() } }),
                };
            }
            // its own place is taken now: recycle it from where it is
            match c.env.trash(&s) {
                Ok(()) => Ok(DelState::Trashed { from: s.to_string_lossy().to_string() }),
                Err(_) if !c.env.crashed() && exists(c, &s).is_none() => Ok(DelState::Trashed { from: s.to_string_lossy().to_string() }),
                Err(e) => Err(format!("{} is still set aside in {} because it couldn’t be recycled: {e}", shown(orig), shown(staged.rsplit_once('/').map(|x| x.0).unwrap_or(staged)))),
            }
        }
        Ok(Some(_)) => Err(format!("{} was changed while it was set aside, so it was left alone", shown(orig))),
        // gone from the staging place: it was moved back (and maybe recycled) by an earlier, interrupted run
        Ok(None) => match c.env.stat(&o) {
            Ok(Some(m)) if ok_item(&m) => match c.env.trash(&o) {
                Ok(()) => Ok(DelState::Trashed { from: o.to_string_lossy().to_string() }),
                Err(e) if c.env.crashed() => Err(e),
                Err(_) => Ok(if exists(c, &o).is_some() { DelState::Kept } else { DelState::Trashed { from: o.to_string_lossy().to_string() } }),
            },
            _ => Ok(DelState::Trashed { from: o.to_string_lossy().to_string() }),
        },
        Err(e) => Err(format!("{} couldn’t be checked: {e}", shown(orig))),
    }
}

fn fail(c: &Ctx, j: Journal, steps: &[Step], pending: Option<Step>, why: String) -> Result<Outcome, ApplyError> {
    let problems = reverse_all(c, steps, pending.as_ref());
    if problems.is_empty() {
        let mut j = j;
        let _ = j.line(&json!({ "e": "end" }), true);
        j.remove();
    }
    Err(ApplyError::Failed { why, problems })
}

/// Put everything back, newest first. A step that can't be reversed is reported and left alone; the rest still are.
pub fn reverse_all(c: &Ctx, steps: &[Step], pending: Option<&Step>) -> Vec<String> {
    let mut problems = vec![];
    if let Some(p) = pending {
        reverse_pending(c, p, &mut problems);
    }
    for s in steps.iter().rev() {
        reverse_step(c, s, &mut problems);
    }
    problems
}

fn exists(c: &Ctx, p: &Path) -> Option<Meta> {
    c.env.stat(p).ok().flatten()
}

/// a step that may or may not have happened: only what can be told for certain is undone
fn reverse_pending(c: &Ctx, s: &Step, problems: &mut Vec<String>) {
    match s {
        Step::Mv { from, to } | Step::Del { orig: from, staged: to, .. } => {
            let (f, t) = (dp(c.root, from), dp(c.root, to));
            // (a change of upper and lower case only can't be told apart by looking, so it is left)
            if from.to_lowercase() != to.to_lowercase() && exists(c, &t).is_some() && exists(c, &f).is_none() {
                if let Err(e) = c.env.rename_new(&t, &f) {
                    problems.push(format!("{} couldn’t be moved back to {}: {}", shown(to), shown(from), io_msg(&e)));
                }
            }
        }
        // it was known not to exist when this was written down, so a folder there now is the one this step made
        Step::Mkdir { path } => {
            let p = dp(c.root, path);
            if matches!(exists(c, &p), Some(m) if m.kind == Kind::Dir) {
                if let Err(e) = c.env.remove_dir(&p) {
                    problems.push(format!("The folder {} was left because it isn’t empty or is in use ({})", shown(path), io_msg(&e)));
                }
            }
        }
        Step::Put { to, part, size, blob } => {
            let pp = dp(c.root, part);
            if exists(c, &pp).is_some() {
                if let Err(e) = c.env.remove_file(&pp) {
                    problems.push(format!("The half-written file {} couldn’t be removed: {}", shown(part), io_msg(&e)));
                }
            } else {
                // nothing was at the name when this was written down, and the half-written file is gone: it was renamed
                // into place last, so a file there with these contents is this step's own
                remove_put(c, to, *size, blob, problems);
            }
        }
        Step::Copy { to, part, size, .. } => {
            let pp = dp(c.root, part);
            if exists(c, &pp).is_some() {
                if let Err(e) = c.env.remove_file(&pp) {
                    problems.push(format!("The half-made copy {} couldn’t be removed: {}", shown(part), io_msg(&e)));
                }
            } else {
                // nothing was at the new name when this was written down, and the half-made copy is gone: the copy was
                // finished (it is renamed into place last), so it is this step's own
                let t = dp(c.root, to);
                if matches!(exists(c, &t), Some(m) if m.kind == Kind::File && m.size == *size) {
                    if let Err(e) = c.env.remove_file(&t) {
                        problems.push(format!("The copy {} couldn’t be removed: {}", shown(to), io_msg(&e)));
                    }
                }
            }
        }
    }
}

/// take away a file written by a Put, if it is still exactly what was written
fn remove_put(c: &Ctx, to: &str, size: u64, blob: &str, problems: &mut Vec<String>) {
    let t = dp(c.root, to);
    match exists(c, &t) {
        Some(m) if m.kind == Kind::File && m.size == size => {
            if !same_as_blob(c, &t, blob, size) {
                problems.push(format!("{} was changed, so it was left", shown(to)));
            } else if let Err(e) = c.env.remove_file(&t) {
                problems.push(format!("{} couldn’t be removed: {}", shown(to), io_msg(&e)));
            }
        }
        Some(_) => problems.push(format!("{} was changed, so it was left", shown(to))),
        None => {}
    }
}
/// is the file what the blob holds (when the blob is gone, the size has to do)
fn same_as_blob(c: &Ctx, p: &Path, blob: &str, size: u64) -> bool {
    let b = super::blobs::path_in(&super::blobs::dir_of_jdir(c.jdir), blob);
    if std::fs::metadata(&b).is_err() {
        return true;
    }
    matches!(super::blobs::hash_file(p), Ok((h, n)) if h == blob && n == size)
}

fn reverse_step(c: &Ctx, s: &Step, problems: &mut Vec<String>) {
    match s {
        Step::Put { to, part, size, blob } => {
            let pp = dp(c.root, part);
            if exists(c, &pp).is_some() {
                let _ = c.env.remove_file(&pp);
            }
            remove_put(c, to, *size, blob, problems);
        }
        Step::Mv { from, to } => {
            let (f, t) = (dp(c.root, from), dp(c.root, to));
            let same = from.to_lowercase() == to.to_lowercase();
            match (exists(c, &t), if same { None } else { exists(c, &f) }) {
                (Some(_), None) => {
                    if let Err(e) = c.env.rename_new(&t, &f) {
                        problems.push(format!("{} couldn’t be moved back to {}: {}", shown(to), shown(from), io_msg(&e)));
                    }
                }
                (None, _) => problems.push(format!("{} isn’t where it was put, so it couldn’t be moved back", shown(to))),
                (Some(_), Some(_)) => problems.push(format!("{} couldn’t be moved back to {}: something else is there now", shown(to), shown(from))),
            }
        }
        Step::Mkdir { path } => {
            let p = dp(c.root, path);
            if exists(c, &p).is_some() {
                if let Err(e) = c.env.remove_dir(&p) {
                    problems.push(format!("The folder {} was left because it isn’t empty or is in use ({})", shown(path), io_msg(&e)));
                }
            }
        }
        Step::Copy { to, part, size, .. } => {
            let pp = dp(c.root, part);
            if exists(c, &pp).is_some() {
                let _ = c.env.remove_file(&pp);
            }
            let t = dp(c.root, to);
            match exists(c, &t) {
                Some(m) if m.kind == Kind::File && m.size == *size => {
                    if let Err(e) = c.env.remove_file(&t) {
                        problems.push(format!("The copy {} couldn’t be removed: {}", shown(to), io_msg(&e)));
                    }
                }
                Some(_) => problems.push(format!("The copy {} was changed, so it was left", shown(to))),
                None => {}
            }
        }
        Step::Del { orig, staged, state, .. } => {
            let (o, s) = (dp(c.root, orig), dp(c.root, staged));
            match state {
                DelState::Staged => {
                    if exists(c, &s).is_some() && exists(c, &o).is_none() {
                        if let Err(e) = c.env.rename_new(&s, &o) {
                            problems.push(format!("{} couldn’t be put back: {}", shown(orig), io_msg(&e)));
                        }
                    } else if exists(c, &o).is_none() {
                        problems.push(format!("{} isn’t where it was set aside", shown(orig)));
                    }
                }
                DelState::Kept => {}
                DelState::Trashed { from } => {
                    // recycled from the set-aside place (its own place was taken): that place is made again for it
                    let par = Path::new(from).parent().map(|p| p.to_path_buf());
                    let aside = *from != o.to_string_lossy();
                    if aside {
                        if let Some(p) = &par {
                            if exists(c, p).is_none() {
                                let _ = c.env.mkdir(p);
                            }
                        }
                    }
                    if let Err(e) = c.env.bin_restore(&[from.clone()]) {
                        problems.push(format!("{} couldn’t be restored from the Recycle Bin: {e}", shown(orig)));
                    } else if aside {
                        if let Err(e) = c.env.rename_new(Path::new(from), &o) {
                            problems.push(format!("{} was restored but couldn’t be put back where it was: {}", shown(orig), io_msg(&e)));
                        } else if let Some(p) = par {
                            if p.file_name().map(|n| n.to_string_lossy().starts_with(STAGE_PREFIX)).unwrap_or(false) {
                                let _ = c.env.remove_dir(&p);
                            }
                        }
                    }
                }
            }
        }
    }
}

// ---------- undo ----------
/// What the folder would look like part way through an undo, for checking it beforehand: what is there now, with the
/// effect of the steps already "undone" laid over it.
struct Sim<'a, 'b> {
    c: &'a Ctx<'b>,
    over: HashMap<String, bool>,
}
impl Sim<'_, '_> {
    /// is something at the path. `inside`: what to assume for a path inside a folder that the steps so far bring back
    /// (what it holds isn't known until it is back; the steps themselves check each thing as they go)
    fn has(&self, p: &str, inside: bool) -> bool {
        if let Some(v) = self.over.get(p) {
            return *v;
        }
        let mut q = p;
        while let Some((par, _)) = q.rsplit_once('/') {
            if let Some(v) = self.over.get(par) {
                return if *v { inside } else { false };
            }
            q = par;
        }
        exists(self.c, &dp(self.c.root, p)).is_some()
    }
}

/// What stands in the way of undoing; empty means it can go ahead.
pub fn undo_check(c: &Ctx, steps: &[Step]) -> Vec<String> {
    let mut bad = vec![];
    let mut sim = Sim { c, over: HashMap::new() };
    for s in steps.iter().rev() {
        match s {
            Step::Mv { from, to } => {
                let same = from.to_lowercase() == to.to_lowercase();
                if !sim.has(to, true) {
                    bad.push(format!("{} isn’t there any more", shown(to)));
                }
                if !same && sim.has(from, false) {
                    bad.push(format!("Something is now at {}", shown(from)));
                }
                if !same {
                    sim.over.insert(to.clone(), false);
                }
                sim.over.insert(from.clone(), true);
            }
            Step::Mkdir { path } => {
                sim.over.insert(path.clone(), false);
            }
            Step::Put { to, size, blob, .. } => {
                if sim.over.get(to).is_none() {
                    if let Some(m) = exists(c, &dp(c.root, to)) {
                        if m.kind != Kind::File || m.size != *size || !same_as_blob(c, &dp(c.root, to), blob, *size) {
                            bad.push(format!("{} has been changed since", shown(to)));
                        }
                    }
                }
                sim.over.insert(to.clone(), false);
            }
            Step::Copy { to, size, .. } => {
                if sim.over.get(to).is_none() {
                    if let Some(m) = exists(c, &dp(c.root, to)) {
                        if m.kind != Kind::File || m.size != *size {
                            bad.push(format!("The copy {} has been changed", shown(to)));
                        }
                    }
                }
                sim.over.insert(to.clone(), false);
            }
            Step::Del { orig, staged, state, .. } => match state {
                DelState::Kept => {}
                DelState::Staged => {
                    if sim.has(orig, false) {
                        bad.push(format!("Something is now at {}", shown(orig)));
                    }
                    sim.over.insert(staged.clone(), false);
                    sim.over.insert(orig.clone(), true);
                }
                DelState::Trashed { from } => {
                    if sim.has(orig, false) {
                        bad.push(format!("Something is now at {}", shown(orig)));
                    }
                    if !c.env.bin_has(Path::new(from)) {
                        bad.push(format!("{} isn’t in the Recycle Bin any more", shown(orig)));
                    }
                    sim.over.insert(orig.clone(), true);
                }
            },
        }
    }
    bad.sort();
    bad.dedup();
    bad.truncate(50);
    bad
}

/// Undo one step at a time, newest first. Returns the steps still not undone (empty = all undone) and what went wrong.
pub fn undo(c: &Ctx, steps: &[Step]) -> (Vec<Step>, Vec<String>) {
    let mut left: Vec<Step> = steps.to_vec();
    while let Some(s) = left.last().cloned() {
        let mut problems = vec![];
        reverse_step(c, &s, &mut problems);
        if !problems.is_empty() {
            return (left, problems);
        }
        left.pop();
    }
    (left, vec![])
}

// ---------- recovery ----------
#[derive(Debug, Default)]
pub struct Recovery {
    pub rid: String,
    pub owner: String,
    pub root: String,
    /// "reversed", "finished" or "needs attention"
    pub result: String,
    pub problems: Vec<String>,
    pub steps: Vec<Step>,
}

/// Journals left behind by a run that was cut short (power off, crash, killed): finish or reverse each one.
pub fn recover_all(env: &dyn Env, jdir: &Path) -> Vec<Recovery> {
    let mut out = vec![];
    let Ok(rd) = std::fs::read_dir(jdir) else { return out };
    let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.file_name().map(|n| n.to_string_lossy().starts_with("journal-") && n.to_string_lossy().ends_with(".jsonl")).unwrap_or(false)).collect();
    files.sort();
    for f in files {
        if let Some(r) = recover_one(env, jdir, &f) {
            out.push(r);
        }
    }
    out
}

fn recover_one(env: &dyn Env, jdir: &Path, file: &Path) -> Option<Recovery> {
    let text = std::fs::read_to_string(file).ok()?;
    let mut rid = String::new();
    let mut owner = String::new();
    let mut root = String::new();
    let mut steps: Vec<Step> = vec![];
    let mut done: HashSet<u64> = HashSet::new();
    let mut intents: Vec<(u64, Step)> = vec![];
    let mut commit = false;
    let mut ended = false;
    let mut trashed: HashMap<usize, DelState> = HashMap::new();
    for l in text.lines() {
        // a last line cut off by the stop is ignored
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        match v["e"].as_str() {
            Some("begin") => {
                rid = v["rid"].as_str().unwrap_or("").to_string();
                owner = v["owner"].as_str().unwrap_or("").to_string();
                root = v["root"].as_str().unwrap_or("").to_string();
            }
            Some("do") => {
                if let (Some(i), Ok(s)) = (v["i"].as_u64(), serde_json::from_value::<Step>(v["step"].clone())) {
                    intents.push((i, s));
                }
            }
            Some("ok") => {
                if let Some(i) = v["i"].as_u64() {
                    done.insert(i);
                }
            }
            Some("commit") => commit = true,
            Some("trashed") => {
                if let (Some(i), Ok(s)) = (v["i"].as_u64(), serde_json::from_value::<DelState>(v["state"].clone())) {
                    trashed.insert(i as usize, s);
                }
            }
            Some("end") => ended = true,
            _ => {}
        }
    }
    if ended {
        let _ = std::fs::remove_file(file);
        return None;
    }
    if rid.is_empty() || root.is_empty() {
        // a journal that never got to say what it was for: nothing was done
        let _ = std::fs::remove_file(file);
        return None;
    }
    let mut pending: Option<Step> = None;
    for (i, s) in intents {
        if done.contains(&i) {
            steps.push(s);
        } else {
            pending = Some(s);
        }
    }
    let root_p = PathBuf::from(&root);
    let ctx = Ctx { env, root: &root_p, jdir, rid: &rid, owner: &owner };
    let mut rec = Recovery { rid: rid.clone(), owner: owner.clone(), root: root.clone(), ..Default::default() };
    if commit {
        // the deleted items were already set aside and everything else was done: carry on to the Recycle Bin
        let mut notes = vec![];
        for (i, s) in steps.iter_mut().enumerate() {
            if let Step::Del { orig, staged, kind, size, mtime, state, aside } = s {
                if let Some(t) = trashed.get(&i) {
                    *state = t.clone();
                    continue;
                }
                match commit_one(&ctx, orig, staged, *kind, *size, *mtime, *aside) {
                    Ok(st) => *state = st,
                    Err(e) => notes.push(e),
                }
            }
        }
        let stage = root_p.join(format!("{STAGE_PREFIX}{rid}"));
        let _ = env.remove_dir(&stage);
        rec.result = if notes.is_empty() { "finished".into() } else { "needs attention".into() };
        rec.problems = notes;
        rec.steps = steps;
    } else {
        let problems = reverse_all(&ctx, &steps, pending.as_ref());
        rec.result = if problems.is_empty() { "reversed".into() } else { "needs attention".into() };
        rec.problems = problems;
    }
    if rec.problems.is_empty() {
        let _ = std::fs::remove_file(file);
    } else {
        // kept, so the next start tries again
        rec.result = "needs attention".into();
    }
    Some(rec)
}
