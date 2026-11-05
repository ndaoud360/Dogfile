// The commands the window calls. Everything is a plain function of (env, data folder, arguments) so the tests drive the
// same code the window does, against a real folder or one that fails on purpose.
use super::env::{Env, RealEnv};
use super::exec::{self, ApplyError, Ctx};
use super::reality::{self, Applied, Reality, State};
use super::tree::*;
use crate::args::{Args, R};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// one thing at a time changes the disk
static BUSY: Mutex<()> = Mutex::new(());

pub async fn call(cmd: &'static str, a: Args) -> R {
    let data = crate::st().data_dir.clone();
    tokio::task::spawn_blocking(move || run(&RealEnv, &data, cmd, &a)).await.map_err(|e| e.to_string())?
}

pub fn run(env: &dyn Env, data: &Path, cmd: &str, a: &Args) -> R {
    match cmd {
        "list" => Ok(list(data)),
        "create" => create(env, data, &a.s(0)?, &a.s_or(1, "")),
        "view" => view(env, data, &a.s(0)?),
        "addOps" => add_ops(env, data, &a.s(0)?, &a.s_or(1, "Changes"), a.r(2)),
        "preset" => preset(env, data, &a.s(0)?, &a.s(1)?, &a.s_or(2, "")),
        "toggle" => toggle(env, data, &a.s(0)?, a.r(1), a.r(2).as_bool().unwrap_or(true)),
        "removeOps" => remove_ops(env, data, &a.s(0)?, a.r(1)),
        "rebase" => rebase(env, data, &a.s(0)?),
        "check" => check(env, data, &a.s(0)?),
        "apply" => apply(env, data, &a.s(0)?),
        "undo" => undo(env, data, &a.s(0)?),
        "rename" => rename(data, &a.s(0)?, &a.s(1)?),
        "discard" => discard(data, &a.s(0)?, a.r(1).as_bool().unwrap_or(false)),
        "recover" => Ok(recover(env, data)),
        "fork" => fork(data, &a.s(0)?, &a.s_or(1, "")),
        "compare" => compare(env, data, &a.s(0)?, &a.s(1)?),
        "takeOps" => take_ops(env, data, &a.s(0)?, &a.s(1)?, a.r(2)),
        "editText" => edit_text(env, data, &a.s(0)?, a.r(1), a.r(2), a.b(3)),
        "newFile" => new_file(env, data, &a.s(0)?, &a.s(1)?, &a.s_or(2, "")),
        "exportPack" => export_pack(env, data, &a.s(0)?, &a.s(1)?),
        "inspectPack" => inspect_pack(&a.s(0)?),
        "importPack" => import_pack(env, data, &a.s(0)?, &a.s(1)?, &a.s_or(2, "")),
        "viewAt" => view_at(env, data, &a.s(0)?, a.u(1, 0) as usize),
        _ => Err(format!("unknown command {cmd}")),
    }
}

fn can_delete(env: &dyn Env, r: &Reality) -> bool {
    env.has_bin(Path::new(&r.root))
}
fn jdir(data: &Path) -> PathBuf {
    reality::dir(data).join("journals")
}
fn ids(v: &Value) -> Vec<u32> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect()).unwrap_or_default()
}

pub fn list(data: &Path) -> Value {
    let rs: Vec<Value> = reality::list(data)
        .into_iter()
        .map(|r| json!({ "id": r.id, "name": r.name, "root": r.root, "created": r.created, "ops": r.ops.len(), "on": r.ops.iter().filter(|o| o.on).count(), "applied": r.applied.as_ref().map(|a| a.at) }))
        .collect();
    json!(rs)
}

pub fn create(env: &dyn Env, data: &Path, root: &str, name: &str) -> R {
    if root.trim().is_empty() || !Path::new(root).is_absolute() {
        return Err("Choose a folder".into());
    }
    let name = if name.trim().is_empty() { format!("What if: {}", Path::new(root).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| root.to_string())) } else { name.to_string() };
    let r = Reality::new(env, &name, root)?;
    reality::save(data, &r)?;
    view_of(env, &r)
}

fn load(data: &Path, id: &str) -> Result<Reality, String> {
    reality::load(data, id)
}

pub fn view(env: &dyn Env, data: &Path, id: &str) -> R {
    let r = load(data, id)?;
    view_of(env, &r)
}

pub fn view_of(env: &dyn Env, r: &Reality) -> R {
    let rp = reality::replay(&r.base, r.ci, &r.ops, can_delete(env, r));
    let t = &rp.tree;
    let mut rows: Vec<Value> = vec![];
    let (mut moved, mut renamed, mut created, mut copies, mut edited_n, mut new_files) = (0u32, 0u32, 0u32, 0u32, 0u32, 0u32);
    for n in t.nodes() {
        let c = change_of(t, n);
        let tag = match c {
            Change::Same => "",
            Change::Renamed => {
                renamed += 1;
                "renamed"
            }
            Change::Moved => {
                moved += 1;
                "moved"
            }
            Change::New => {
                // a new file is not a new folder
                if n.kind == Kind::File {
                    new_files += 1;
                } else {
                    created += 1;
                }
                "new"
            }
            Change::Copy => {
                copies += 1;
                "copy"
            }
        };
        let edited = n.put.is_some() && n.origin.is_some() && !n.copy;
        if edited {
            edited_n += 1;
        }
        rows.push(json!({ "p": n.path, "k": n.kind, "s": n.size, "m": n.mtime, "c": tag, "e": edited, "o": if c == Change::Moved || c == Change::Renamed { n.origin.clone() } else { None } }));
    }
    // baseline items that are no longer anywhere (the top of each deleted part only)
    let kept: std::collections::HashSet<String> = t.nodes().filter(|n| !n.copy).filter_map(|n| n.origin.as_ref().map(|o| if t.ci { o.to_lowercase() } else { o.clone() })).collect();
    let key = |p: &str| if t.ci { p.to_lowercase() } else { p.to_string() };
    let gone_all: Vec<&BEntry> = r.base.iter().filter(|b| !kept.contains(&key(&b.path))).collect();
    let gone_set: std::collections::HashSet<String> = gone_all.iter().map(|b| key(&b.path)).collect();
    let gone: Vec<Value> = gone_all.iter().filter(|b| !gone_set.contains(&key(parent_of(&b.path)))).map(|b| json!({ "p": b.path, "k": b.kind, "s": b.size })).collect();
    let ops: Vec<Value> = r
        .ops
        .iter()
        .zip(rp.state.iter())
        .map(|(o, (_, s))| {
            let (st, why) = match s {
                State::On => ("on", None),
                State::Off => ("off", None),
                State::Blocked(w) => ("blocked", Some(w.clone())),
            };
            json!({ "id": o.id, "group": o.group, "op": o.kind, "on": o.on, "state": st, "why": why })
        })
        .collect();
    let blocked = rp.state.iter().filter(|s| matches!(s.1, State::Blocked(_))).count();
    Ok(json!({
        "id": r.id, "name": r.name, "root": r.root, "created": r.created, "ci": r.ci,
        "baseCount": r.base.len(), "rows": rows, "gone": gone, "ops": ops,
        "stats": { "moved": moved, "renamed": renamed, "new": created, "copies": copies, "edited": edited_n, "newFiles": new_files, "deleted": gone.len(), "blocked": blocked, "on": rp.acts.len() },
        "canDelete": can_delete(env, r),
        "applied": r.applied.as_ref().map(|a| json!({ "at": a.at, "notes": a.notes, "steps": a.steps.len() })),
    }))
}

/// Time travel: the folder as it looks after only the first `at` changes (0 = as it is now). Read only: nothing is saved,
/// and the real folder isn't looked at. The changes themselves are all still listed so the slider can move.
pub fn view_at(env: &dyn Env, data: &Path, id: &str, at: usize) -> R {
    let mut r = load(data, id)?;
    let total = r.ops.len();
    let at = at.min(total);
    let steps: Vec<Value> = r.ops.iter().map(|o| json!({ "id": o.id, "group": o.group, "on": o.on })).collect();
    r.ops.truncate(at);
    // what this is a picture of is not "made real", even if the reality was
    let was_applied = r.applied.take().is_some();
    let mut v = view_of(env, &r)?;
    v["at"] = json!(at);
    v["total"] = json!(total);
    v["steps"] = json!(steps);
    v["wasApplied"] = json!(was_applied);
    Ok(v)
}

/// Add changes. Each is tried against the reality as it stands; one that can't be made is not added (and says why).
pub fn add_ops(env: &dyn Env, data: &Path, id: &str, group: &str, ops: &Value) -> R {
    let _g = BUSY.lock();
    let mut r = load(data, id)?;
    if r.applied.is_some() {
        return Err("These changes have been made. Undo them, or make a new reality, to change more.".into());
    }
    let kinds: Vec<OpKind> = ops
        .as_array()
        .ok_or("no changes given")?
        .iter()
        .map(|v| serde_json::from_value::<OpKind>(v.clone()).map_err(|e| format!("That change isn’t understood: {e}")))
        .collect::<Result<_, _>>()?;
    if kinds.len() > 20_000 {
        return Err("That is too many changes at once".into());
    }
    let (added, rejected) = fit(env, data, &r, kinds);
    if content_bytes(&r.ops, &added) > super::blobs::MAX_TOTAL {
        return Err("That is more new content than one what-if copy can hold".into());
    }
    let new_ids = r.add(group, added);
    reality::save(data, &r)?;
    Ok(json!({ "added": new_ids, "rejected": rejected, "view": view_of(env, &r)? }))
}

/// Which of these changes can be made on top of what the reality already does (each is tried in order, so one that
/// needs an earlier one is fine). The others come back with the reason.
fn fit(env: &dyn Env, data: &Path, r: &Reality, kinds: Vec<OpKind>) -> (Vec<OpKind>, Vec<Value>) {
    let mut rp = reality::replay(&r.base, r.ci, &r.ops, can_delete(env, r));
    fit_on(env, data, r, &mut rp.tree, kinds)
}
/// the size of all the new content a reality holds (a blob used twice counts once)
fn content_bytes(ops: &[Op], more: &[OpKind]) -> u64 {
    let mut seen = std::collections::HashSet::new();
    let mut total = 0u64;
    for k in ops.iter().map(|o| &o.kind).chain(more.iter()) {
        if let OpKind::Put { blob, size, .. } | OpKind::NewFile { blob, size, .. } = k {
            if seen.insert(blob.clone()) {
                total += *size;
            }
        }
    }
    total
}
fn fit_on(env: &dyn Env, data: &Path, r: &Reality, sim: &mut Tree, kinds: Vec<OpKind>) -> (Vec<OpKind>, Vec<Value>) {
    let mut added = vec![];
    let mut rejected = vec![];
    for k in kinds {
        // new contents have to be kept here, whole, for the change to be made later
        if let OpKind::Put { blob, size, .. } | OpKind::NewFile { blob, size, .. } = &k {
            if !super::blobs::has(data, blob, *size) {
                rejected.push(json!({ "op": k, "why": "The new contents for this aren’t available" }));
                continue;
            }
        }
        let can = can_delete(env, r) || !matches!(k, OpKind::Delete { .. });
        let res = if can { sim.apply(&k, None).map(|_| ()) } else { Err("This drive has no Recycle Bin, so deleting isn’t safe here".into()) };
        match res {
            Ok(()) => added.push(k),
            Err(e) => rejected.push(json!({ "op": k, "why": e })),
        }
    }
    (added, rejected)
}

pub fn preset(env: &dyn Env, data: &Path, id: &str, kind: &str, scope: &str) -> R {
    let r = load(data, id)?;
    let scope = norm(scope)?;
    let rp = reality::replay(&r.base, r.ci, &r.ops, can_delete(env, &r));
    if !scope.is_empty() && rp.tree.get(&scope).map(|n| n.kind != Kind::Dir).unwrap_or(true) {
        return Err("Choose a folder".into());
    }
    let (label, ops) = match kind {
        "type" => ("Sort by type", super::presets::by_type(&rp.tree, &scope)),
        "month" => ("Sort by month", super::presets::by_month(&rp.tree, &scope)),
        "flatten" => ("Flatten folders", super::presets::flatten(&rp.tree, &scope)),
        _ => return Err("unknown preset".into()),
    };
    if ops.is_empty() {
        return Ok(json!({ "added": [], "rejected": [], "empty": true, "view": view_of(env, &r)? }));
    }
    add_ops(env, data, id, label, &json!(ops))
}

pub fn toggle(env: &dyn Env, data: &Path, id: &str, which: &Value, on: bool) -> R {
    let _g = BUSY.lock();
    let mut r = load(data, id)?;
    if r.applied.is_some() {
        return Err("These changes have been made already".into());
    }
    let w = ids(which);
    for o in r.ops.iter_mut().filter(|o| w.contains(&o.id)) {
        o.on = on;
    }
    reality::save(data, &r)?;
    view_of(env, &r)
}

pub fn remove_ops(env: &dyn Env, data: &Path, id: &str, which: &Value) -> R {
    let _g = BUSY.lock();
    let mut r = load(data, id)?;
    if r.applied.is_some() {
        return Err("These changes have been made already".into());
    }
    let w = ids(which);
    r.ops.retain(|o| !w.contains(&o.id));
    reality::save(data, &r)?;
    gc_blobs(data, 120);
    view_of(env, &r)
}

/// Look at the folder again. The changes stay; the ones that no longer fit are marked.
pub fn rebase(env: &dyn Env, data: &Path, id: &str) -> R {
    let _g = BUSY.lock();
    let mut r = load(data, id)?;
    if r.applied.is_some() {
        return Err("These changes have been made already".into());
    }
    r.base = reality::scan(env, Path::new(&r.root))?;
    reality::save(data, &r)?;
    view_of(env, &r)
}

/// Is the folder as it was when the reality was made? Nothing is changed.
pub fn check(env: &dyn Env, data: &Path, id: &str) -> R {
    let r = load(data, id)?;
    let rp = reality::replay(&r.base, r.ci, &r.ops, can_delete(env, &r));
    let drift = exec::preflight(env, Path::new(&r.root), &r.base, &rp.foot);
    Ok(json!({ "ok": drift.is_empty(), "drift": drift, "changes": rp.acts.len() }))
}

pub fn apply(env: &dyn Env, data: &Path, id: &str) -> R {
    let _g = BUSY.lock();
    let mut r = load(data, id)?;
    if r.applied.is_some() {
        return Err("These changes have been made already".into());
    }
    let root = PathBuf::from(&r.root);
    let rp = reality::replay(&r.base, r.ci, &r.ops, can_delete(env, &r));
    if rp.acts.is_empty() {
        return Err("There is nothing switched on to make".into());
    }
    let jd = jdir(data);
    let rid = reality::new_id();
    let ctx = Ctx { env, root: &root, jdir: &jd, rid: &rid, owner: &r.id };
    match exec::apply(&ctx, &r.base, &rp.foot, &rp.acts) {
        Ok(o) => {
            let n = o.steps.len();
            r.applied = Some(Applied { at: reality::now(), steps: o.steps, notes: o.notes.clone() });
            // if this fails the changes are still made and the journal is gone; the folder is safe, only Undo is lost
            let saved = reality::save(data, &r);
            Ok(json!({ "ok": true, "steps": n, "notes": o.notes, "saved": saved.is_ok(), "view": view_of(env, &r)? }))
        }
        Err(ApplyError::Drift(d)) => Ok(json!({ "ok": false, "kind": "drift", "drift": d, "message": "The folder has changed since this reality was made, so nothing was done. Look at the folder again to update the reality." })),
        Err(ApplyError::Refused(m)) => Ok(json!({ "ok": false, "kind": "refused", "message": m })),
        Err(ApplyError::Failed { why, problems }) => Ok(json!({
            "ok": false, "kind": "failed", "message": format!("{why}. Everything done so far {}", if problems.is_empty() { "was put back, so the folder is as it was." } else { "was put back except what is listed below. Dogfile will try again the next time it starts." }),
            "problems": problems
        })),
        Err(ApplyError::Crashed) => Err("stopped".into()),
    }
}

pub fn undo(env: &dyn Env, data: &Path, id: &str) -> R {
    let _g = BUSY.lock();
    let mut r = load(data, id)?;
    let Some(ap) = r.applied.clone() else { return Err("Nothing to undo".into()) };
    let root = PathBuf::from(&r.root);
    let jd = jdir(data);
    let ctx = Ctx { env, root: &root, jdir: &jd, rid: "undo", owner: &r.id };
    let bad = exec::undo_check(&ctx, &ap.steps);
    if !bad.is_empty() {
        return Ok(json!({ "ok": false, "kind": "blocked", "problems": bad, "message": "The folder has changed since these changes were made, so nothing was undone." }));
    }
    let (left, problems) = exec::undo(&ctx, &ap.steps);
    if left.is_empty() {
        r.applied = None;
        reality::save(data, &r)?;
        return Ok(json!({ "ok": true, "view": view_of(env, &r)? }));
    }
    r.applied = Some(Applied { at: ap.at, steps: left, notes: ap.notes });
    reality::save(data, &r)?;
    Ok(json!({ "ok": false, "kind": "partial", "problems": problems, "message": "Undo stopped part way. What is left can be undone again.", "view": view_of(env, &r)? }))
}

pub fn rename(data: &Path, id: &str, name: &str) -> R {
    let mut r = load(data, id)?;
    r.name = name.trim().chars().take(80).collect();
    reality::save(data, &r)?;
    Ok(json!(true))
}

/// Remove the what-if copy. If its changes were made, this also drops the ability to undo them, so that needs `forget`.
pub fn discard(data: &Path, id: &str, forget: bool) -> R {
    let _g = BUSY.lock();
    let r = load(data, id)?;
    if r.applied.is_some() && !forget {
        return Err("Its changes were made and can still be undone. Discarding it means they can’t be undone from here.".into());
    }
    reality::remove(data, id);
    gc_blobs(data, 120);
    Ok(json!(true))
}

/// Finish or reverse what a run that was cut short left half done. Called when Dogfile starts.
pub fn recover(env: &dyn Env, data: &Path) -> Value {
    let _g = BUSY.lock();
    let rs = exec::recover_all(env, &jdir(data));
    gc_blobs(data, 120);
    let mut out: Vec<Value> = vec![];
    for x in &rs {
        // a run that was finished from its journal still has its steps: give them to the reality that made them so it can be undone
        if x.result != "reversed" && !x.steps.is_empty() {
            if let Ok(mut r) = reality::load(data, &x.owner) {
                if r.applied.is_none() {
                    r.applied = Some(Applied { at: reality::now(), steps: x.steps.clone(), notes: x.problems.clone() });
                    let _ = reality::save(data, &r);
                }
            }
        }
        out.push(json!({ "root": x.root, "owner": x.owner, "result": x.result, "problems": x.problems }));
    }
    json!(out)
}

// ---------- several realities of one folder ----------

/// A second what-if copy that starts as a copy of this one: same starting point, same changes, then it goes its own way.
pub fn fork(data: &Path, id: &str, name: &str) -> R {
    let _g = BUSY.lock();
    let r = load(data, id)?;
    let mut f = r.clone();
    f.id = reality::new_id();
    f.name = if name.trim().is_empty() { format!("{} (copy)", r.name) } else { name.trim().chars().take(80).collect() };
    f.created = reality::now();
    // a copy has not been made real, whatever the one it came from did
    f.applied = None;
    reality::save(data, &f)?;
    Ok(json!({ "id": f.id }))
}

fn same_folder(a: &Reality, b: &Reality) -> bool {
    if a.ci || b.ci { a.root.to_lowercase() == b.root.to_lowercase() } else { a.root == b.root }
}

/// Where each thing from the starting folder ends up in a reality (None = gone), keyed by where it started
fn placement(r: &Reality, can_del: bool) -> (reality::Replay, std::collections::HashMap<String, String>) {
    let rp = reality::replay(&r.base, r.ci, &r.ops, can_del);
    let mut m = std::collections::HashMap::new();
    for n in rp.tree.nodes() {
        if !n.copy {
            if let Some(o) = &n.origin {
                m.insert(if r.ci { o.to_lowercase() } else { o.clone() }, n.path.clone());
            }
        }
    }
    (rp, m)
}

/// How two what-if copies of the same folder differ: for each thing that was in the folder, where it ends up in each.
/// What simply came along inside a moved folder is not listed on its own.
pub fn compare(env: &dyn Env, data: &Path, a_id: &str, b_id: &str) -> R {
    let a = load(data, a_id)?;
    let b = load(data, b_id)?;
    if !same_folder(&a, &b) {
        return Err("Those are what-if copies of different folders".into());
    }
    let (ra, ma) = placement(&a, can_delete(env, &a));
    let (rb, mb) = placement(&b, can_delete(env, &b));
    let ci = a.ci;
    let key = |p: &str| if ci { p.to_lowercase() } else { p.to_string() };
    // everything that was in the folder in either starting point
    let mut starts: std::collections::BTreeMap<String, (String, Kind)> = std::collections::BTreeMap::new();
    for e in a.base.iter().chain(b.base.iter()) {
        starts.entry(key(&e.path)).or_insert((e.path.clone(), e.kind));
    }
    let came_along = |m: &std::collections::HashMap<String, String>, origin: &str, pos: &Option<&String>| -> bool {
        let Some(pos) = pos else { return false };
        match m.get(&key(parent_of(origin))) {
            Some(pp) => **pos == join(pp, name_of(origin)),
            // the parent is the folder itself
            None => parent_of(origin).is_empty() && **pos == name_of(origin),
        }
    };
    let mut rows = vec![];
    let mut same = 0usize;
    for (k, (origin, kind)) in &starts {
        let (pa, pb) = (ma.get(k), mb.get(k));
        let (xa, xb) = (pa.map(|s| key(s)), pb.map(|s| key(s)));
        if xa == xb {
            same += 1;
            continue;
        }
        // inside a folder that went somewhere else in one or both: it came along
        let ca = came_along(&ma, origin, &pa);
        let cb = came_along(&mb, origin, &pb);
        if ca && cb {
            continue;
        }
        // a thing in a deleted folder is gone along with it
        let parent_gone = |m: &std::collections::HashMap<String, String>| !parent_of(origin).is_empty() && !m.contains_key(&key(parent_of(origin)));
        if pa.is_none() && pb.is_none() {
            continue;
        }
        if (pa.is_none() && parent_gone(&ma)) && cb {
            continue;
        }
        if (pb.is_none() && parent_gone(&mb)) && ca {
            continue;
        }
        rows.push(json!({ "origin": origin, "k": kind, "a": pa, "b": pb }));
    }
    rows.truncate(2000);
    // what only one of them makes: new folders and copies
    let made = |rp: &reality::Replay| -> std::collections::BTreeMap<String, String> {
        rp.tree
            .nodes()
            // a new folder, or the top of a copy (what is inside a copy came with it)
            .filter(|n| if n.copy { !rp.tree.get(parent_of(&n.path)).map(|p| p.copy).unwrap_or(false) } else { n.origin.is_none() })
            .map(|n| (key(&n.path), n.path.clone()))
            .collect()
    };
    let (xa, xb) = (made(&ra), made(&rb));
    let only_a: Vec<&String> = xa.iter().filter(|(k, _)| !xb.contains_key(*k)).map(|(_, v)| v).collect();
    let only_b: Vec<&String> = xb.iter().filter(|(k, _)| !xa.contains_key(*k)).map(|(_, v)| v).collect();
    Ok(json!({
        "a": { "id": a.id, "name": a.name, "ops": a.ops.len() }, "b": { "id": b.id, "name": b.name, "ops": b.ops.len() },
        "same": same, "differ": rows.len(), "rows": rows, "onlyA": only_a, "onlyB": only_b,
        "identical": rows.is_empty() && only_a.is_empty() && only_b.is_empty(),
    }))
}

/// Bring some of the changes of another what-if copy of the same folder into this one (each is checked, and one that doesn't
/// fit here is left out and says why).
pub fn take_ops(env: &dyn Env, data: &Path, into: &str, from: &str, which: &Value) -> R {
    let to = load(data, into)?;
    let src = load(data, from)?;
    if to.id == src.id {
        return Err("That is the same what-if copy".into());
    }
    if !same_folder(&to, &src) {
        return Err("Those are what-if copies of different folders".into());
    }
    let w = ids(which);
    let kinds: Vec<Value> = src.ops.iter().filter(|o| w.contains(&o.id)).map(|o| json!(o.kind)).collect();
    if kinds.is_empty() {
        return Err("Choose the changes to bring over".into());
    }
    add_ops(env, data, into, &format!("From “{}”", src.name), &json!(kinds))
}

// ---------- share packages ----------

/// Save a what-if copy as a package file. Only the changes go in it (and the names they mention), never file contents
/// except new content that was written in the what-if copy.
pub fn export_pack(_env: &dyn Env, data: &Path, id: &str, dest: &str) -> R {
    let r = load(data, id)?;
    let dest_p = Path::new(dest);
    if dest.trim().is_empty() || !dest_p.is_absolute() {
        return Err("Choose where to save it".into());
    }
    if dest_p.is_dir() {
        return Err("Choose a file name, not a folder".into());
    }
    let folder_name = Path::new(&r.root).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let pack = super::pack::Pack {
        format: super::pack::FORMAT.into(),
        version: super::pack::VERSION,
        name: r.name.clone(),
        folder_name,
        created: reality::now(),
        ops: r.ops.iter().map(|o| super::pack::PackOp { group: o.group.clone(), kind: o.kind.clone(), on: o.on }).collect(),
        blobs: Default::default(),
    };
    let mut pack = pack;
    {
        use base64::Engine;
        for o in &pack.ops.clone() {
            if let OpKind::Put { blob, .. } | OpKind::NewFile { blob, .. } = &o.kind {
                if !pack.blobs.contains_key(blob) {
                    let b = super::blobs::read(data, blob).map_err(|_| "Some of the new contents are missing, so this can’t be shared".to_string())?;
                    pack.blobs.insert(blob.clone(), base64::engine::general_purpose::STANDARD.encode(b));
                }
            }
        }
    }
    if pack.ops.is_empty() {
        return Err("There are no changes to share yet".into());
    }
    let bytes = super::pack::encode(&pack)?;
    if bytes.len() as u64 > super::pack::MAX_PACK_BYTES {
        return Err("That has too much new content to share as one package".into());
    }
    crate::util::write_atomic(dest_p, &bytes).map_err(|e| format!("Couldn’t save it: {e}"))?;
    Ok(json!({ "path": dest, "ops": pack.ops.len(), "bytes": bytes.len() }))
}

fn read_pack(path: &str) -> Result<super::pack::Pack, String> {
    let p = Path::new(path);
    let md = std::fs::metadata(p).map_err(|_| "Couldn’t open that file".to_string())?;
    if !md.is_file() {
        return Err("That isn’t a file".into());
    }
    if md.len() > super::pack::MAX_PACK_BYTES {
        return Err("That file is too big to be a Multiverse package".into());
    }
    let b = std::fs::read(p).map_err(|_| "Couldn’t open that file".to_string())?;
    super::pack::decode(&b)
}

/// What is in a package, before anything is done with it.
pub fn inspect_pack(path: &str) -> R {
    let p = read_pack(path)?;
    let mut groups: Vec<(String, usize)> = vec![];
    for o in &p.ops {
        match groups.last_mut() {
            Some(g) if g.0 == o.group => g.1 += 1,
            _ => groups.push((o.group.clone(), 1)),
        }
    }
    Ok(json!({ "name": p.name, "folderName": p.folder_name, "created": p.created, "ops": p.ops.len(), "blobs": p.blobs.len(), "groups": groups.iter().map(|(g, n)| json!({ "group": g, "n": n })).collect::<Vec<_>>() }))
}

/// Bring a package's changes onto a folder: a new what-if copy of that folder (looked at now) with each change that fits.
/// Nothing on disk changes. What doesn't fit (a file that isn't there, a name already taken) is left out and listed.
pub fn import_pack(env: &dyn Env, data: &Path, path: &str, root: &str, name: &str) -> R {
    let _g = BUSY.lock();
    let p = read_pack(path)?;
    if root.trim().is_empty() || !Path::new(root).is_absolute() {
        return Err("Choose the folder to bring them to".into());
    }
    let nm = if name.trim().is_empty() { p.name.clone() } else { name.to_string() };
    let mut r = Reality::new(env, &nm, root)?;
    // the new contents come with it, each checked against its name; one that doesn't check out is left out, and so is its change
    let mut bad_blobs: std::collections::HashSet<String> = std::collections::HashSet::new();
    for id in p.blobs.keys() {
        match super::pack::blob_bytes(&p, id).and_then(|b| super::blobs::store(data, &b)) {
            Ok(_) => {}
            Err(_) => {
                bad_blobs.insert(id.clone());
            }
        }
    }
    let mut rejected: Vec<Value> = vec![];
    let mut sim = Tree::from_base(&r.base, r.ci);
    let mut i = 0;
    while i < p.ops.len() {
        // changes made together stay together
        let g = &p.ops[i].group;
        let mut j = i;
        while j < p.ops.len() && p.ops[j].group == *g {
            j += 1;
        }
        // one at a time, each tried on top of the ones before it; switched on or off as in the package
        for o in &p.ops[i..j] {
            if let OpKind::Put { blob, .. } | OpKind::NewFile { blob, .. } = &o.kind {
                if bad_blobs.contains(blob) || !p.blobs.contains_key(blob) {
                    rejected.push(json!({ "op": o.kind, "why": "Its new contents aren’t in the package, or are damaged" }));
                    continue;
                }
            }
            let (added, rej) = fit_on(env, data, &r, &mut sim, vec![o.kind.clone()]);
            rejected.extend(rej);
            for id in r.add(g, added) {
                if let Some(op) = r.ops.iter_mut().find(|x| x.id == id) {
                    op.on = o.on;
                }
            }
        }
        i = j;
    }
    reality::save(data, &r)?;
    Ok(json!({ "view": view_of(env, &r)?, "rejected": rejected, "total": p.ops.len() }))
}

// ---------- new contents ----------

/// Remove the stored new contents that no what-if copy uses any more (ones younger than `min_age` seconds are left, so
/// content just made, whose change isn't added yet, is not taken away).
pub fn gc_blobs(data: &Path, min_age: u64) {
    let mut keep = std::collections::HashSet::new();
    for r in reality::list(data) {
        for o in &r.ops {
            if let OpKind::Put { blob, .. } | OpKind::NewFile { blob, .. } = &o.kind {
                keep.insert(blob.clone());
            }
        }
    }
    super::blobs::gc(data, &keep, min_age);
}

const TEXT_MAX: u64 = 8 << 20;
const EDIT_FILES_MAX: usize = 2000;

/// What a text edit does to a file's text.
fn edit_one(spec: &Value, text: &str) -> Result<(String, usize), String> {
    match spec["kind"].as_str().unwrap_or("") {
        "replace" => {
            let find = spec["find"].as_str().unwrap_or("");
            let with = spec["with"].as_str().unwrap_or("");
            if find.is_empty() {
                return Err("Say what to look for".into());
            }
            if find.chars().count() > 500 || with.chars().count() > 5000 {
                return Err("That is too long".into());
            }
            let case = spec["matchCase"].as_bool().unwrap_or(false);
            let pat = if spec["regex"].as_bool().unwrap_or(false) { find.to_string() } else { regex::escape(find) };
            let re = regex::RegexBuilder::new(&pat).case_insensitive(!case).size_limit(1 << 20).dfa_size_limit(4 << 20).build().map_err(|_| "That isn’t a pattern Dogfile understands".to_string())?;
            let n = re.find_iter(text).count();
            if n == 0 {
                return Ok((text.to_string(), 0));
            }
            // a plain replacement is taken literally ($ means $); a pattern's replacement may use $1
            let out = if spec["regex"].as_bool().unwrap_or(false) { re.replace_all(text, with).into_owned() } else { re.replace_all(text, regex::NoExpand(with)).into_owned() };
            Ok((out, n))
        }
        "eol" => {
            let lf = text.replace("\r\n", "\n");
            let out = if spec["to"].as_str() == Some("crlf") { lf.replace('\n', "\r\n") } else { lf };
            let n = if out == text { 0 } else { 1 };
            Ok((out, n))
        }
        "trim" => {
            let crlf = text.contains("\r\n");
            let mut out = String::with_capacity(text.len());
            let mut n = 0;
            for (i, line) in text.split('\n').enumerate() {
                if i > 0 {
                    out.push('\n');
                }
                let (body, cr) = match line.strip_suffix('\r') {
                    Some(b) => (b, true),
                    None => (line, false),
                };
                let t = body.trim_end_matches([' ', '\t']);
                if t.len() != body.len() {
                    n += 1;
                }
                out.push_str(t);
                if cr {
                    out.push('\r');
                }
            }
            let _ = crlf;
            Ok((out, n))
        }
        _ => Err("That kind of edit isn’t known".into()),
    }
}

fn edit_name(spec: &Value) -> String {
    let short = |t: &str| -> String { let c: String = t.chars().take(24).collect(); if t.chars().count() > 24 { format!("{c}…") } else { c } };
    match spec["kind"].as_str().unwrap_or("") {
        "replace" => format!("Replace “{}” with “{}”", short(spec["find"].as_str().unwrap_or("")), short(spec["with"].as_str().unwrap_or(""))),
        "eol" => if spec["to"].as_str() == Some("crlf") { "Line endings: Windows (CRLF)".into() } else { "Line endings: Unix (LF)".into() },
        "trim" => "Trim spaces at line ends".into(),
        _ => "Edit text".into(),
    }
}

/// Change the text in some files, in the what-if copy. `scope` is the files and folders to look in (a folder means every
/// file in it). Only plain text files are touched, and only ones that are as they were when the copy was made. Nothing
/// on disk changes. With `dry`, only says what would change.
pub fn edit_text(env: &dyn Env, data: &Path, id: &str, scope: &Value, spec: &Value, dry: bool) -> R {
    let r = load(data, id)?;
    if r.applied.is_some() {
        return Err("These changes have been made. Undo them, or make a new reality, to change more.".into());
    }
    // find out now if the edit means anything at all
    edit_one(spec, "")?;
    let root = PathBuf::from(&r.root);
    let rp = reality::replay(&r.base, r.ci, &r.ops, can_delete(env, &r));
    let scopes: Vec<String> = scope.as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(norm_loose)).collect()).unwrap_or_default();
    if scopes.is_empty() {
        return Err("Choose the files or folders to change".into());
    }
    let mut cands: Vec<Node> = vec![];
    let mut seen = std::collections::HashSet::new();
    for sc in &scopes {
        let mut v: Vec<&Node> = vec![];
        if sc.is_empty() {
            v.extend(rp.tree.below(""));
        } else if let Some(n) = rp.tree.get(sc) {
            v.push(n);
            v.extend(rp.tree.below(sc));
        }
        for n in v {
            if n.kind == Kind::File && seen.insert(rp.tree.key(&n.path)) {
                cands.push(n.clone());
            }
        }
    }
    cands.sort_by(|a, b| a.path.cmp(&b.path));
    let mut skipped: Vec<Value> = vec![];
    let mut would: Vec<Value> = vec![];
    let mut kinds: Vec<OpKind> = vec![];
    let mut unchanged = 0usize;
    let mut total_new = content_bytes(&r.ops, &[]);
    let skip = |skipped: &mut Vec<Value>, p: &str, why: &str| {
        if skipped.len() < 100 {
            skipped.push(json!({ "path": p, "why": why }));
        }
    };
    for n in cands.iter().take(20_000) {
        if would.len() >= EDIT_FILES_MAX {
            skip(&mut skipped, "", "Only the first 2000 files are changed at a time");
            break;
        }
        if n.copy || n.origin.is_none() {
            skip(&mut skipped, &n.path, "made in this what-if copy, not in the folder");
            continue;
        }
        if n.put.is_some() {
            skip(&mut skipped, &n.path, "its contents are already changed here");
            continue;
        }
        if n.size > TEXT_MAX {
            skip(&mut skipped, &n.path, "too big to change here");
            continue;
        }
        let disk = super::exec::dp(&root, n.origin.as_ref().unwrap());
        let stat_ok = |d: &Path| matches!(env.stat(d), Ok(Some(m)) if m.kind == Kind::File && m.size == n.size && m.mtime == n.mtime);
        if !stat_ok(&disk) {
            skip(&mut skipped, &n.path, "has changed since the what-if copy was made (look at the folder again)");
            continue;
        }
        let Ok(bytes) = std::fs::read(&disk) else {
            skip(&mut skipped, &n.path, "couldn’t be read");
            continue;
        };
        if !stat_ok(&disk) {
            skip(&mut skipped, &n.path, "was changing while it was read");
            continue;
        }
        let (bom, body) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { (&bytes[..3], &bytes[3..]) } else { (&bytes[..0], &bytes[..]) };
        if body.contains(&0) {
            skip(&mut skipped, &n.path, "isn’t a plain text file");
            continue;
        }
        let Ok(text) = std::str::from_utf8(body) else {
            skip(&mut skipped, &n.path, "isn’t plain text (UTF-8)");
            continue;
        };
        let (out, count) = edit_one(spec, text)?;
        if out == text {
            unchanged += 1;
            continue;
        }
        let mut new_bytes = bom.to_vec();
        new_bytes.extend_from_slice(out.as_bytes());
        if new_bytes.len() as u64 > super::blobs::MAX_BLOB {
            skip(&mut skipped, &n.path, "would be too big");
            continue;
        }
        would.push(json!({ "path": n.path, "count": count }));
        if dry {
            continue;
        }
        total_new += new_bytes.len() as u64;
        if total_new > super::blobs::MAX_TOTAL {
            return Err("That is more new content than one what-if copy can hold. Try fewer files.".into());
        }
        let (blob, size) = super::blobs::store(data, &new_bytes)?;
        kinds.push(OpKind::Put { path: n.path.clone(), blob, size, from_size: n.size, from_mtime: n.mtime, from_hash: super::blobs::hash_bytes(&bytes) });
    }
    if dry {
        return Ok(json!({ "dry": true, "changed": would.len(), "unchanged": unchanged, "skipped": skipped, "files": would.iter().take(200).collect::<Vec<_>>() }));
    }
    if kinds.is_empty() {
        return Ok(json!({ "changed": 0, "unchanged": unchanged, "skipped": skipped, "rejected": [], "view": view_of(env, &r)? }));
    }
    let n = kinds.len();
    let added = add_ops(env, data, id, &edit_name(spec), &json!(kinds))?;
    let rejected = added["rejected"].clone();
    let nrej = rejected.as_array().map(|a| a.len()).unwrap_or(0);
    Ok(json!({ "changed": n - nrej, "unchanged": unchanged, "skipped": skipped, "rejected": rejected, "view": added["view"] }))
}

/// A new text file in the what-if copy.
pub fn new_file(env: &dyn Env, data: &Path, id: &str, path: &str, text: &str) -> R {
    if text.len() > 1 << 20 {
        return Err("That is too much text for a new file".into());
    }
    let (blob, size) = super::blobs::store(data, text.as_bytes())?;
    add_ops(env, data, id, "New file", &json!([{ "op": "newFile", "path": path, "blob": blob, "size": size }]))
}
