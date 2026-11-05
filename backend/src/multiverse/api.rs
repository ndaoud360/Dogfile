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
    let (mut moved, mut renamed, mut created, mut copies) = (0u32, 0u32, 0u32, 0u32);
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
                created += 1;
                "new"
            }
            Change::Copy => {
                copies += 1;
                "copy"
            }
        };
        rows.push(json!({ "p": n.path, "k": n.kind, "s": n.size, "m": n.mtime, "c": tag, "o": if c == Change::Moved || c == Change::Renamed { n.origin.clone() } else { None } }));
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
        "stats": { "moved": moved, "renamed": renamed, "new": created, "copies": copies, "deleted": gone.len(), "blocked": blocked, "on": rp.acts.len() },
        "canDelete": can_delete(env, r),
        "applied": r.applied.as_ref().map(|a| json!({ "at": a.at, "notes": a.notes, "steps": a.steps.len() })),
    }))
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
    let rp = reality::replay(&r.base, r.ci, &r.ops, can_delete(env, &r));
    let mut sim = rp.tree;
    let mut added = vec![];
    let mut rejected = vec![];
    for k in kinds {
        let can = can_delete(env, &r) || !matches!(k, OpKind::Delete { .. });
        let res = if can { sim.apply(&k, None).map(|_| ()) } else { Err("This drive has no Recycle Bin, so deleting isn’t safe here".into()) };
        match res {
            Ok(()) => added.push(k),
            Err(e) => rejected.push(json!({ "op": k, "why": e })),
        }
    }
    let new_ids = r.add(group, added);
    reality::save(data, &r)?;
    Ok(json!({ "added": new_ids, "rejected": rejected, "view": view_of(env, &r)? }))
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
    Ok(json!(true))
}

/// Finish or reverse what a run that was cut short left half done. Called when Dogfile starts.
pub fn recover(env: &dyn Env, data: &Path) -> Value {
    let _g = BUSY.lock();
    let rs = exec::recover_all(env, &jdir(data));
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
