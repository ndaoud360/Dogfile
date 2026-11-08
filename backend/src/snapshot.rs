// Multiverse Mode: take a snapshot of a folder (and everything under it), work in the folder for real, then either
// make it real or go back to the snapshot.
//
// How it stays safe:
// - The snapshot is a hidden folder inside the folder (".dogfile-snapshot"). Every file is hard-linked into it, so it costs
//   almost no space and no time to copy; a file that can't be linked (another kind of drive) is copied instead, up to a limit.
//   Dogfile writes files by making a new file and swapping it in, so the linked original is never changed in place.
// - Deleting while in Multiverse Mode moves things into a temporary trash inside the snapshot (nothing reaches the real
//   Recycle Bin). Making it real moves them back to where they were and then sends them to the Recycle Bin.
// - Going back puts every file and folder back from the snapshot. Anything new that was made is sent to the Recycle Bin
//   (not deleted), so even that can be brought back.
use crate::args::{err, Args, R};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

pub const STORE: &str = ".dogfile-snapshot";
/// the most that is copied (not linked) into the snapshot, when a drive can't link files
const COPY_LIMIT: u64 = 1 << 30;
const LIST_CAP: usize = 300;

#[derive(Clone, Serialize, Deserialize)]
struct FileRec {
    rel: String,
    size: u64,
    mtime: i64,
    /// true when a copy of this file is held in the snapshot
    kept: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct TrashRec {
    id: u64,
    rel: String,
    name: String,
    is_dir: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct Session {
    root: String,
    started: i64,
    /// lower-case relative path -> file
    files: BTreeMap<String, FileRec>,
    /// relative folder paths (original case)
    dirs: Vec<String>,
    unprotected: u64,
    trash: Vec<TrashRec>,
    next_id: u64,
}

fn session() -> &'static Mutex<Option<Session>> {
    static S: std::sync::OnceLock<Mutex<Option<Session>>> = std::sync::OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
fn mtime_ms(md: &std::fs::Metadata) -> i64 {
    md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}
fn key(rel: &str) -> String {
    rel.to_lowercase()
}
fn store_of(root: &Path) -> PathBuf {
    root.join(STORE)
}
fn rel_path(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for part in rel.split('/').filter(|s| !s.is_empty()) {
        p.push(part);
    }
    p
}
fn is_store_name(name: &str) -> bool {
    name.to_lowercase().starts_with(STORE)
}
fn registry_file() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("Dogfile").join("multiverse-mode.json"))
}
fn write_registry(root: &str) {
    if cfg!(test) {
        return;
    }
    if let Some(f) = registry_file() {
        if let Some(d) = f.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(f, json!({ "root": root }).to_string());
    }
}
fn clear_registry() {
    if cfg!(test) {
        return;
    }
    if let Some(f) = registry_file() {
        let _ = std::fs::remove_file(f);
    }
}

/// hide the snapshot folder from Explorer (best effort)
fn hide(p: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("attrib").arg("+h").arg("+s").arg(p).creation_flags(0x0800_0000).status();
    }
    #[cfg(not(windows))]
    {
        let _ = p;
    }
}

/// every folder and file under `root` (not following links, not entering the snapshot folder)
fn scan(root: &Path) -> (Vec<(String, bool, u64, i64)>, u64) {
    let mut out: Vec<(String, bool, u64, i64)> = vec![];
    let mut skipped = 0u64;
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(root.to_path_buf(), String::new(), 0)];
    while let Some((dir, rel, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            skipped += 1;
            continue;
        };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if is_store_name(&name) {
                continue;
            }
            let Ok(md) = std::fs::symlink_metadata(e.path()) else {
                skipped += 1;
                continue;
            };
            if md.file_type().is_symlink() {
                skipped += 1;
                continue;
            }
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if md.is_dir() {
                out.push((r.clone(), true, 0, 0));
                if depth < 64 {
                    stack.push((e.path(), r, depth + 1));
                }
            } else {
                out.push((r, false, md.len(), mtime_ms(&md)));
            }
        }
    }
    (out, skipped)
}

fn within(root: &str, p: &str) -> Option<String> {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
    let (r, q) = (norm(root), norm(p));
    let (rl, ql) = (r.to_lowercase(), q.to_lowercase());
    if ql == rl || !ql.starts_with(&format!("{rl}/")) {
        return None;
    }
    Some(q[r.len() + 1..].to_string())
}

fn save_trash(s: &Session) {
    let f = store_of(Path::new(&s.root)).join("trash.json");
    if let Ok(b) = serde_json::to_vec(&s.trash) {
        let _ = std::fs::write(f, b);
    }
}

fn load_from_disk(root: &Path) -> Option<Session> {
    let store = store_of(root);
    let mut s: Session = serde_json::from_slice(&std::fs::read(store.join("manifest.json")).ok()?).ok()?;
    s.root = root.to_string_lossy().to_string();
    if let Ok(b) = std::fs::read(store.join("trash.json")) {
        if let Ok(t) = serde_json::from_slice::<Vec<TrashRec>>(&b) {
            s.next_id = t.iter().map(|x| x.id + 1).max().unwrap_or(1).max(s.next_id);
            s.trash = t;
        }
    }
    Some(s)
}

fn trash_path(s: &Session, t: &TrashRec) -> PathBuf {
    store_of(Path::new(&s.root)).join("trash").join(t.id.to_string()).join(&t.name)
}

fn dir_size(p: &Path) -> u64 {
    let (items, _) = scan(p);
    items.iter().filter(|i| !i.1).map(|i| i.2).sum()
}

fn friendly(e: &std::io::Error) -> String {
    crate::fsx::friendly(e)
}

// ---------- begin ----------
pub async fn begin(a: &Args) -> R {
    let root = a.s(0)?;
    tokio::task::spawn_blocking(move || begin_sync(&root)).await.map_err(err)?
}

fn begin_sync(root_s: &str) -> R {
    let root = PathBuf::from(root_s);
    if session().lock().is_some() {
        return Err("A Multiverse is already open. Make it real or discard it first.".into());
    }
    if !root.is_dir() {
        return Err("Multiverse works on a folder on this PC".into());
    }
    if root.parent().is_none() || root.to_string_lossy().trim_end_matches(['\\', '/']).ends_with(':') {
        return Err("Pick a folder (like Downloads), not a whole drive".into());
    }
    let store = store_of(&root);
    if store.exists() {
        return Err("A snapshot from an earlier session is still in this folder. Open Multiverse again to finish it.".into());
    }
    std::fs::create_dir_all(store.join("files")).map_err(|e| friendly(&e))?;
    std::fs::create_dir_all(store.join("trash")).map_err(|e| friendly(&e))?;
    hide(&store);
    let (items, skipped) = scan(&root);
    let mut s = Session { root: root_s.to_string(), started: now_ms(), files: BTreeMap::new(), dirs: vec![], unprotected: skipped, trash: vec![], next_id: 1 };
    let mut copied = 0u64;
    let (mut linked, mut copies) = (0u64, 0u64);
    for (rel, is_dir, size, mtime) in items {
        let dst = rel_path(&store.join("files"), &rel);
        if is_dir {
            let _ = std::fs::create_dir_all(&dst);
            s.dirs.push(rel);
            continue;
        }
        if let Some(d) = dst.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let src = rel_path(&root, &rel);
        let mut kept = true;
        if std::fs::hard_link(&src, &dst).is_ok() {
            linked += 1;
        } else if copied + size <= COPY_LIMIT && std::fs::copy(&src, &dst).is_ok() {
            if let Ok(md) = std::fs::metadata(&src) {
                let _ = filetime::set_file_mtime(&dst, filetime::FileTime::from_last_modification_time(&md));
            }
            copied += size;
            copies += 1;
        } else {
            kept = false;
            s.unprotected += 1;
        }
        s.files.insert(key(&rel), FileRec { rel, size, mtime, kept });
    }
    let bytes = serde_json::to_vec(&s).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::write(store.join("manifest.json"), bytes) {
        let _ = std::fs::remove_dir_all(&store);
        return Err(friendly(&e));
    }
    write_registry(root_s);
    let out = json!({ "root": root_s, "files": s.files.len(), "folders": s.dirs.len(), "linked": linked, "copied": copies, "unprotected": s.unprotected, "started": s.started });
    *session().lock() = Some(s);
    Ok(out)
}

/// the folder a Multiverse is open on (other background work stays out of it)
pub fn active_root() -> Option<String> {
    session().lock().as_ref().map(|s| s.root.clone())
}

// ---------- status / recover ----------
fn summary(s: &Session) -> Value {
    let trashed = s.trash.iter().filter(|t| trash_path(s, t).exists()).count();
    json!({ "active": true, "root": s.root, "started": s.started, "files": s.files.len(), "folders": s.dirs.len(), "unprotected": s.unprotected, "trashed": trashed })
}

pub async fn status(_a: &Args) -> R {
    Ok(match &*session().lock() {
        Some(s) => summary(s),
        None => json!({ "active": false }),
    })
}

/// at start: a Multiverse left open by a crash or a closed window is found again, so it can be made real or discarded
pub async fn recover(_a: &Args) -> R {
    if let Some(s) = &*session().lock() {
        return Ok(summary(s));
    }
    let Some(f) = registry_file() else { return Ok(json!({ "active": false })) };
    let Ok(raw) = std::fs::read(&f) else { return Ok(json!({ "active": false })) };
    let root = serde_json::from_slice::<Value>(&raw).ok().and_then(|v| v["root"].as_str().map(String::from));
    let Some(root) = root else {
        clear_registry();
        return Ok(json!({ "active": false }));
    };
    match load_from_disk(Path::new(&root)) {
        Some(s) => {
            let out = summary(&s);
            *session().lock() = Some(s);
            Ok(out)
        }
        None => {
            clear_registry();
            Ok(json!({ "active": false, "lost": root }))
        }
    }
}

fn get() -> Result<Session, String> {
    session().lock().clone().ok_or_else(|| "No Multiverse is open".to_string())
}

// ---------- delete into the temporary trash ----------
/// move things into the temporary trash (the work of `trash` and of a plain delete while a Multiverse is open)
fn trash_into(s: &mut Session, paths: Vec<String>) -> Value {
    let mut pairs: Vec<Value> = vec![];
    let mut problems: Vec<String> = vec![];
    for p in paths {
        let Some(rel) = within(&s.root, &p) else {
            problems.push(format!("{p}: it is outside the Multiverse folder"));
            continue;
        };
        let src = PathBuf::from(&p);
        let Ok(md) = std::fs::symlink_metadata(&src) else {
            problems.push(format!("{p}: not found"));
            continue;
        };
        let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let rec = TrashRec { id: s.next_id, rel, name, is_dir: md.is_dir() };
        let dest = trash_path(s, &rec);
        if let Some(d) = dest.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        match std::fs::rename(&src, &dest) {
            Ok(()) => {
                s.next_id += 1;
                pairs.push(json!([p, dest.to_string_lossy()]));
                s.trash.push(rec);
            }
            Err(e) => problems.push(format!("{p}: {}", friendly(&e))),
        }
    }
    save_trash(s);
    json!({ "pairs": pairs, "problems": problems })
}

pub async fn trash(a: &Args) -> R {
    let paths: Vec<String> = a.v(0).as_array().map(|v| v.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let mut guard = session().lock();
        let Some(s) = guard.as_mut() else { return Err("No Multiverse is open".to_string()) };
        Ok(trash_into(s, paths))
    })
    .await
    .map_err(err)?
}

/// a delete that reaches the backend directly (not through a file job) while a Multiverse is open: `None` when the path is
/// not in it, so the normal delete goes ahead
pub fn divert(p: &str) -> Option<Result<(), String>> {
    let mut guard = session().lock();
    let s = guard.as_mut()?;
    within(&s.root, p)?;
    let r = trash_into(s, vec![p.to_string()]);
    Some(match r["problems"].as_array().and_then(|a| a.first()).and_then(|x| x.as_str()) {
        Some(m) => Err(m.to_string()),
        None => Ok(()),
    })
}

pub async fn trash_list(_a: &Args) -> R {
    let s = get()?;
    let mut items: Vec<Value> = vec![];
    for t in &s.trash {
        let tp = trash_path(&s, t);
        if let Ok(md) = std::fs::symlink_metadata(&tp) {
            let size = if t.is_dir { dir_size(&tp) } else { md.len() };
            items.push(json!({ "id": t.id, "rel": t.rel, "name": t.name, "isDir": t.is_dir, "size": size }));
        }
    }
    Ok(json!({ "items": items }))
}

/// put one thing from the temporary trash back where it was
pub async fn restore(a: &Args) -> R {
    let id = a.u(0, 0);
    tokio::task::spawn_blocking(move || {
        let mut guard = session().lock();
        let Some(s) = guard.as_mut() else { return Err("No Multiverse is open".to_string()) };
        let Some(t) = s.trash.iter().find(|t| t.id == id).cloned() else { return Err("That item isn’t in the trash".to_string()) };
        let from = trash_path(s, &t);
        let mut to = rel_path(Path::new(&s.root), &t.rel);
        if to.exists() {
            let stem = to.file_stem().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
            let ext = to.extension().map(|x| format!(".{}", x.to_string_lossy())).unwrap_or_default();
            to = to.with_file_name(format!("{stem} (restored){ext}"));
        }
        if let Some(d) = to.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        std::fs::rename(&from, &to).map_err(|e| friendly(&e))?;
        s.trash.retain(|x| x.id != id);
        save_trash(s);
        Ok(json!({ "path": to.to_string_lossy() }))
    })
    .await
    .map_err(err)?
}

// ---------- what has changed ----------
struct Diff {
    created: Vec<String>,
    changed: Vec<String>,
    removed: Vec<String>,
    moved: Vec<(String, String)>,
    folders_created: Vec<String>,
    folders_removed: Vec<String>,
}

fn diff(s: &Session) -> Diff {
    let root = Path::new(&s.root);
    let (live, _) = scan(root);
    let mut live_files: HashMap<String, (String, u64, i64)> = HashMap::new();
    let mut live_dirs: HashMap<String, String> = HashMap::new();
    for (rel, is_dir, size, mtime) in live {
        if is_dir {
            live_dirs.insert(key(&rel), rel);
        } else {
            live_files.insert(key(&rel), (rel, size, mtime));
        }
    }
    let mut created: Vec<(String, u64, i64)> = vec![];
    let mut changed: Vec<String> = vec![];
    let mut missing: Vec<&FileRec> = vec![];
    for (k, (rel, size, mtime)) in &live_files {
        match s.files.get(k) {
            None => created.push((rel.clone(), *size, *mtime)),
            Some(m) if m.size != *size || m.mtime != *mtime => changed.push(rel.clone()),
            _ => {}
        }
    }
    // what waits in the temporary trash is deleted, not lost
    let mut trash_keys: Vec<String> = vec![];
    let mut trash_sigs: HashSet<(u64, i64)> = HashSet::new();
    for t in &s.trash {
        let tp = trash_path(s, t);
        let Ok(md) = std::fs::symlink_metadata(&tp) else { continue };
        trash_keys.push(key(&t.rel));
        if t.is_dir {
            let (items, _) = scan(&tp);
            for it in items.iter().filter(|i| !i.1) {
                trash_sigs.insert((it.2, it.3));
            }
        } else {
            trash_sigs.insert((md.len(), mtime_ms(&md)));
        }
    }
    let under_trash = |rel: &str| {
        let k = key(rel);
        trash_keys.iter().any(|t| k == *t || k.starts_with(&format!("{t}/")))
    };
    for (k, m) in &s.files {
        if !live_files.contains_key(k) && !under_trash(&m.rel) && !trash_sigs.contains(&(m.size, m.mtime)) {
            missing.push(m);
        }
    }
    // a file that is gone from one place and the same size and time at another was moved or renamed
    let mut by_sig: HashMap<(u64, i64), Vec<usize>> = HashMap::new();
    for (i, c) in created.iter().enumerate() {
        by_sig.entry((c.1, c.2)).or_default().push(i);
    }
    let mut used: HashSet<usize> = HashSet::new();
    let mut moved: Vec<(String, String)> = vec![];
    let mut removed: Vec<String> = vec![];
    missing.sort_by(|a, b| a.rel.cmp(&b.rel));
    for m in missing {
        let hit = by_sig.get(&(m.size, m.mtime)).and_then(|v| v.iter().find(|i| !used.contains(*i)).copied());
        match hit {
            Some(i) => {
                used.insert(i);
                moved.push((m.rel.clone(), created[i].0.clone()));
            }
            None => removed.push(m.rel.clone()),
        }
    }
    let mut created_names: Vec<String> = created.iter().enumerate().filter(|(i, _)| !used.contains(i)).map(|(_, c)| c.0.clone()).collect();
    created_names.sort();
    changed.sort();
    moved.sort();
    let snap_dirs: HashSet<String> = s.dirs.iter().map(|d| key(d)).collect();
    let mut folders_created: Vec<String> = live_dirs.iter().filter(|(k, _)| !snap_dirs.contains(*k)).map(|(_, v)| v.clone()).collect();
    let mut folders_removed: Vec<String> = s.dirs.iter().filter(|d| !live_dirs.contains_key(&key(d)) && !under_trash(d)).cloned().collect();
    folders_created.sort();
    folders_removed.sort();
    Diff { created: created_names, changed, removed, moved, folders_created, folders_removed }
}

fn capped(v: &[String]) -> Value {
    json!(v.iter().take(LIST_CAP).collect::<Vec<_>>())
}

pub async fn plan(_a: &Args) -> R {
    tokio::task::spawn_blocking(|| {
        let s = get()?;
        let d = diff(&s);
        let mut trashed: Vec<Value> = vec![];
        let mut trashed_bytes = 0u64;
        let mut trashed_count = 0usize;
        for t in &s.trash {
            let tp = trash_path(&s, t);
            if let Ok(md) = std::fs::symlink_metadata(&tp) {
                let size = if t.is_dir { dir_size(&tp) } else { md.len() };
                trashed_bytes += size;
                trashed_count += 1;
                if trashed.len() < LIST_CAP {
                    trashed.push(json!({ "rel": t.rel, "isDir": t.is_dir, "size": size }));
                }
            }
        }
        let moved: Vec<Value> = d.moved.iter().take(LIST_CAP).map(|(a, b)| json!([a, b])).collect();
        Ok(json!({
            "root": s.root,
            "unprotected": s.unprotected,
            "created": capped(&d.created), "createdCount": d.created.len(),
            "changed": capped(&d.changed), "changedCount": d.changed.len(),
            "moved": moved, "movedCount": d.moved.len(),
            "removed": capped(&d.removed), "removedCount": d.removed.len(),
            "foldersCreated": capped(&d.folders_created), "foldersCreatedCount": d.folders_created.len(),
            "foldersRemoved": capped(&d.folders_removed), "foldersRemovedCount": d.folders_removed.len(),
            "trashed": trashed, "trashedCount": trashed_count, "trashedBytes": trashed_bytes,
        }))
    })
    .await
    .map_err(err)?
}

// ---------- make it real ----------
pub async fn commit(_a: &Args) -> R {
    tokio::task::spawn_blocking(|| {
        let s = get()?;
        let root = PathBuf::from(&s.root);
        let mut problems: Vec<String> = vec![];
        let mut recycled = 0usize;
        for t in &s.trash {
            let tp = trash_path(&s, t);
            if !tp.exists() {
                continue;
            }
            // back to where it was (so the Recycle Bin remembers the place), then to the Recycle Bin
            let mut to = rel_path(&root, &t.rel);
            if to.exists() {
                let stem = to.file_stem().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
                let ext = to.extension().map(|x| format!(".{}", x.to_string_lossy())).unwrap_or_default();
                to = to.with_file_name(format!("{stem} (deleted in Multiverse){ext}"));
            }
            if let Some(d) = to.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            if let Err(e) = std::fs::rename(&tp, &to) {
                problems.push(format!("{}: {}", t.rel, friendly(&e)));
                continue;
            }
            match trash::delete(&to) {
                Ok(()) => recycled += 1,
                Err(e) => {
                    problems.push(format!("{}: {e}", t.rel));
                    // it stays where it was, not lost
                }
            }
        }
        let _ = std::fs::remove_dir_all(store_of(&root));
        *session().lock() = None;
        clear_registry();
        Ok(json!({ "recycled": recycled, "problems": problems }))
    })
    .await
    .map_err(err)?
}

// ---------- go back to the snapshot ----------
fn recycle_or_remove(p: &Path, known: &HashSet<(u64, i64)>, recycled: &mut usize, removed_copies: &mut usize, problems: &mut Vec<String>) {
    let sig = std::fs::symlink_metadata(p).ok().map(|m| (m.len(), mtime_ms(&m)));
    // the same size and time as something in the snapshot: that data is safe in the snapshot, so this is just a duplicate
    if sig.is_some_and(|s| known.contains(&s)) && std::fs::remove_file(p).is_ok() {
        *removed_copies += 1;
        return;
    }
    match trash::delete(p) {
        Ok(()) => *recycled += 1,
        Err(e) => problems.push(format!("{}: {e}", p.display())),
    }
}

pub async fn discard(_a: &Args) -> R {
    tokio::task::spawn_blocking(|| {
        let s = get()?;
        let root = PathBuf::from(&s.root);
        let store = store_of(&root);
        let mut problems: Vec<String> = vec![];
        let mut warnings: Vec<String> = vec![];
        let (mut restored, mut recycled, mut removed_copies) = (0usize, 0usize, 0usize);
        let known: HashSet<(u64, i64)> = s.files.values().map(|f| (f.size, f.mtime)).collect();
        // folders first, shallowest first
        let mut dirs = s.dirs.clone();
        dirs.sort_by_key(|d| d.matches('/').count());
        for d in &dirs {
            let p = rel_path(&root, d);
            if !p.is_dir() {
                if let Err(e) = std::fs::create_dir_all(&p) {
                    problems.push(format!("{d}: {}", friendly(&e)));
                }
            }
        }
        // files the snapshot did not hold a copy of come back out of the trash, when they were deleted there
        for f in s.files.values() {
            let p = rel_path(&root, &f.rel);
            let intact = std::fs::symlink_metadata(&p).map(|m| m.is_file() && m.len() == f.size && mtime_ms(&m) == f.mtime).unwrap_or(false);
            if intact {
                continue;
            }
            if std::fs::symlink_metadata(&p).is_ok() {
                // something else is at this place now
                recycle_or_remove(&p, &known, &mut recycled, &mut removed_copies, &mut problems);
            }
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let held = rel_path(&store.join("files"), &f.rel);
            if f.kept {
                if std::fs::hard_link(&held, &p).is_ok() || std::fs::copy(&held, &p).is_ok() {
                    restored += 1;
                    let same = std::fs::metadata(&held).map(|m| m.len() == f.size && mtime_ms(&m) == f.mtime).unwrap_or(false);
                    if !same {
                        warnings.push(format!("{}: another program changed this file while Multiverse was open, so the original can’t be brought back", f.rel));
                    }
                } else {
                    problems.push(format!("{}: couldn’t be put back", f.rel));
                }
            } else if let Some(t) = s.trash.iter().find(|t| key(&t.rel) == key(&f.rel)).filter(|t| trash_path(&s, t).exists()) {
                if std::fs::rename(trash_path(&s, t), &p).is_ok() {
                    restored += 1;
                } else {
                    problems.push(format!("{}: couldn’t be put back", f.rel));
                }
            } else {
                problems.push(format!("{}: this file could not be protected, so it can’t be put back", f.rel));
            }
        }
        // anything that is not in the snapshot goes
        let (live, _) = scan(&root);
        let mut extra_dirs: Vec<String> = vec![];
        let snap_dirs: HashSet<String> = s.dirs.iter().map(|d| key(d)).collect();
        for (rel, is_dir, _, _) in live {
            if is_dir {
                if !snap_dirs.contains(&key(&rel)) {
                    extra_dirs.push(rel);
                }
            } else if !s.files.contains_key(&key(&rel)) {
                recycle_or_remove(&rel_path(&root, &rel), &known, &mut recycled, &mut removed_copies, &mut problems);
            }
        }
        extra_dirs.sort_by_key(|d| std::cmp::Reverse(d.matches('/').count()));
        for d in extra_dirs {
            let p = rel_path(&root, &d);
            if std::fs::remove_dir(&p).is_err() && p.exists() {
                // not empty: it holds something that could not be moved, so it stays
                problems.push(format!("{d}: not empty, so it was left"));
            }
        }
        if problems.is_empty() {
            let _ = std::fs::remove_dir_all(&store);
            *session().lock() = None;
            clear_registry();
        }
        Ok(json!({ "restored": restored, "recycled": recycled, "duplicatesRemoved": removed_copies, "problems": problems, "warnings": warnings, "finished": problems.is_empty() }))
    })
    .await
    .map_err(err)?
}

/// the snapshot folder is kept after a problem; this removes it (and the session) when the person decides to let go of it
pub async fn forget(_a: &Args) -> R {
    let s = get()?;
    let _ = std::fs::remove_dir_all(store_of(Path::new(&s.root)));
    *session().lock() = None;
    clear_registry();
    Ok(json!(true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dogfile-snap-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn within_means_strictly_inside() {
        assert_eq!(within("C:\\Users\\me\\Downloads", "C:\\Users\\me\\Downloads\\a\\b.txt").as_deref(), Some("a/b.txt"));
        assert_eq!(within("C:\\Users\\me\\Downloads", "c:\\users\\ME\\downloads\\x").as_deref(), Some("x"));
        assert!(within("C:\\Users\\me\\Downloads", "C:\\Users\\me\\Downloads").is_none());
        assert!(within("C:\\Users\\me\\Downloads", "C:\\Users\\me").is_none());
        assert!(within("C:\\Users\\me\\Downloads", "C:\\Users\\me\\Downloads2\\x").is_none());
    }

    #[test]
    fn scan_skips_the_snapshot_folder() {
        let d = tmp("scan");
        std::fs::create_dir_all(d.join("a")).unwrap();
        std::fs::write(d.join("a").join("x.txt"), "hi").unwrap();
        std::fs::create_dir_all(d.join(STORE).join("files")).unwrap();
        std::fs::write(d.join(STORE).join("files").join("x.txt"), "hi").unwrap();
        let (items, _) = scan(&d);
        assert!(items.iter().all(|i| !i.0.to_lowercase().starts_with(STORE)));
        assert_eq!(items.iter().filter(|i| !i.1).count(), 1);
        std::fs::remove_dir_all(&d).ok();
    }

    // the session is one global, so these tests take turns
    static TURN: Mutex<()> = Mutex::new(());

    fn read(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap_or_default()
    }

    fn make_tree(name: &str) -> PathBuf {
        let d = tmp(name);
        std::fs::create_dir_all(d.join("sub").join("deep")).unwrap();
        std::fs::write(d.join("one.txt"), "one").unwrap();
        std::fs::write(d.join("sub").join("two.txt"), "two!").unwrap();
        std::fs::write(d.join("sub").join("deep").join("three.txt"), "three!!").unwrap();
        d
    }

    #[test]
    fn changes_are_seen_as_renames_and_new_files() {
        let _t = TURN.lock();
        let d = make_tree("diff");
        let out = begin_sync(&d.to_string_lossy()).unwrap();
        assert_eq!(out["files"], 3);
        assert_eq!(out["folders"], 2);
        std::fs::rename(d.join("one.txt"), d.join("uno.txt")).unwrap();
        std::fs::write(d.join("new.txt"), "brand new").unwrap();
        std::fs::create_dir_all(d.join("fresh")).unwrap();
        let df = diff(&get().unwrap());
        assert_eq!(df.moved, vec![("one.txt".to_string(), "uno.txt".to_string())]);
        assert_eq!(df.created, vec!["new.txt".to_string()]);
        assert_eq!(df.folders_created, vec!["fresh".to_string()]);
        assert!(df.removed.is_empty() && df.changed.is_empty());
        std::fs::remove_dir_all(store_of(&d)).ok();
        *session().lock() = None;
        std::fs::remove_dir_all(&d).ok();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn going_back_puts_everything_as_it_was() {
        let _t = TURN.lock();
        let d = make_tree("discard");
        begin_sync(&d.to_string_lossy()).unwrap();
        // rename, move into another folder, make new things, delete a file and a folder (into the temporary trash)
        std::fs::rename(d.join("one.txt"), d.join("uno.txt")).unwrap();
        std::fs::rename(d.join("sub").join("two.txt"), d.join("sub").join("deep").join("two-moved.txt")).unwrap();
        std::fs::write(d.join("new.txt"), "brand new").unwrap();
        std::fs::create_dir_all(d.join("fresh")).unwrap();
        std::fs::write(d.join("fresh").join("inside.txt"), "inside").unwrap();
        let gone = vec![d.join("sub").join("deep").join("three.txt").to_string_lossy().to_string()];
        let r = trash(&Args(vec![json!(gone)])).await.unwrap();
        assert_eq!(r["pairs"].as_array().unwrap().len(), 1);
        assert!(!d.join("sub").join("deep").join("three.txt").exists());
        let p = plan(&Args(vec![])).await.unwrap();
        assert_eq!(p["trashedCount"], 1);
        assert_eq!(p["movedCount"], 2);
        assert_eq!(p["removedCount"], 0, "{p}");
        assert_eq!(p["foldersRemovedCount"], 0, "{p}");
        let r = discard(&Args(vec![])).await.unwrap();
        assert_eq!(r["finished"], true, "{r}");
        assert_eq!(read(&d.join("one.txt")), "one");
        assert_eq!(read(&d.join("sub").join("two.txt")), "two!");
        assert_eq!(read(&d.join("sub").join("deep").join("three.txt")), "three!!");
        assert!(!d.join("uno.txt").exists());
        assert!(!d.join("new.txt").exists());
        assert!(!d.join("fresh").exists());
        assert!(!d.join("sub").join("deep").join("two-moved.txt").exists());
        assert!(!store_of(&d).exists());
        assert!(session().lock().is_none());
        std::fs::remove_dir_all(&d).ok();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn making_it_real_keeps_the_changes_and_sends_the_trash_away() {
        let _t = TURN.lock();
        let d = make_tree("commit");
        begin_sync(&d.to_string_lossy()).unwrap();
        std::fs::rename(d.join("one.txt"), d.join("uno.txt")).unwrap();
        let gone = vec![d.join("sub").to_string_lossy().to_string()];
        let r = trash(&Args(vec![json!(gone)])).await.unwrap();
        assert_eq!(r["pairs"].as_array().unwrap().len(), 1);
        assert!(!d.join("sub").exists());
        let r = commit(&Args(vec![])).await.unwrap();
        assert_eq!(r["recycled"], 1, "{r}");
        assert!(r["problems"].as_array().unwrap().is_empty());
        assert_eq!(read(&d.join("uno.txt")), "one");
        assert!(!d.join("one.txt").exists());
        assert!(!d.join("sub").exists());
        assert!(!store_of(&d).exists());
        std::fs::remove_dir_all(&d).ok();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn something_from_the_trash_can_be_put_back_and_the_outside_is_refused() {
        let _t = TURN.lock();
        let d = make_tree("restore");
        begin_sync(&d.to_string_lossy()).unwrap();
        let one = d.join("one.txt").to_string_lossy().to_string();
        let outside = d.parent().unwrap().join("not-inside.txt").to_string_lossy().to_string();
        let r = trash(&Args(vec![json!([one, outside])])).await.unwrap();
        assert_eq!(r["pairs"].as_array().unwrap().len(), 1);
        assert_eq!(r["problems"].as_array().unwrap().len(), 1);
        let list = trash_list(&Args(vec![])).await.unwrap();
        let id = list["items"][0]["id"].as_u64().unwrap();
        restore(&Args(vec![json!(id)])).await.unwrap();
        assert_eq!(read(&d.join("one.txt")), "one");
        let p = plan(&Args(vec![])).await.unwrap();
        assert_eq!(p["trashedCount"], 0);
        forget(&Args(vec![])).await.unwrap();
        assert!(!store_of(&d).exists());
        std::fs::remove_dir_all(&d).ok();
    }
}
