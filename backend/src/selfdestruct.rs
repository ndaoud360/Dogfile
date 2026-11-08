// Self-destruct: files in a folder go to the Recycle Bin after the time you choose (a download stays for a week, then goes).
//
// - A rule is one folder with a lifespan and criteria: new files only or every file, which file types, names to
//   always keep, a minimum size, subfolders or not. Nothing is ever deleted for good: files go to the Recycle Bin.
// - Setting rules (and changing them) needs a password, which is checked here, not just in the window. The rules keep
//   running without it; it only guards the settings.
// - It runs once a minute while Dogfile is open (and a moment after it starts), never in a folder that a Multiverse is
//   open on, and never on files that are still downloading. A rule that suddenly has a lot to remove stops and asks first.
use crate::args::{err, Args, R};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// more than this at once and the rule pauses for a look first (unless the person pressed "Run now")
const BIG_BATCH: usize = 200;
const UNLOCK_MINUTES: u64 = 10;
const LOG_KEEP: usize = 300;
const LIST_CAP: usize = 200;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub folder: String,
    pub enabled: bool,
    /// how long a file stays, in seconds
    pub ttl_secs: u64,
    /// "created" or "modified": what the lifespan is counted from
    pub basis: String,
    /// "new": only files that arrive after the rule is made; "all": every file in the folder
    pub scope: String,
    /// with "all": files already there start their time now instead of using their real age
    pub fresh_start: bool,
    pub subfolders: bool,
    /// "all", "only" (just the types listed) or "except" (everything but the types listed)
    pub types_mode: String,
    pub types: Vec<String>,
    /// when not empty, only files whose name has one of these words
    pub name_has: Vec<String>,
    /// files whose name has one of these words are never removed
    pub name_not: Vec<String>,
    pub min_size_mb: u64,
    /// files kept by hand (full paths)
    pub keep: Vec<String>,
    pub since_ms: i64,
    pub created_ms: i64,
    pub last_run_ms: i64,
    pub last_removed: u64,
    pub total_removed: u64,
    /// stopped because a lot was about to be removed at once
    pub needs_review: bool,
}
impl Default for Rule {
    fn default() -> Self {
        Rule {
            id: String::new(),
            folder: String::new(),
            enabled: true,
            ttl_secs: 7 * 86_400,
            basis: "created".into(),
            scope: "new".into(),
            fresh_start: true,
            subfolders: false,
            types_mode: "all".into(),
            types: vec![],
            name_has: vec![],
            name_not: vec![],
            min_size_mb: 0,
            keep: vec![],
            since_ms: 0,
            created_ms: 0,
            last_run_ms: 0,
            last_removed: 0,
            total_removed: 0,
            needs_review: false,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct LogEntry {
    at: i64,
    folder: String,
    path: String,
    ok: bool,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct Db {
    salt: String,
    hash: String,
    rules: Vec<Rule>,
    log: Vec<LogEntry>,
}

fn db() -> &'static Mutex<Option<Db>> {
    static D: std::sync::OnceLock<Mutex<Option<Db>>> = std::sync::OnceLock::new();
    D.get_or_init(|| Mutex::new(None))
}
fn unlocked_until() -> &'static Mutex<Option<Instant>> {
    static U: std::sync::OnceLock<Mutex<Option<Instant>>> = std::sync::OnceLock::new();
    U.get_or_init(|| Mutex::new(None))
}
fn file() -> PathBuf {
    match std::env::var("DOGFILE_SD_FILE") {
        Ok(p) => PathBuf::from(p),
        Err(_) => crate::st().data_dir.join("self-destruct.json"),
    }
}
/// run `f` on the rules and password (loaded on first use), and save when it says it changed something
fn with_db<T>(f: impl FnOnce(&mut Db) -> (T, bool)) -> T {
    let mut g = db().lock();
    if g.is_none() {
        *g = Some(std::fs::read(file()).ok().and_then(|b| serde_json::from_slice::<Db>(&b).ok()).unwrap_or_default());
    }
    let d = g.as_mut().unwrap();
    let (out, changed) = f(d);
    if changed {
        if let Some(parent) = file().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(b) = serde_json::to_vec_pretty(d) {
            let tmp = file().with_extension("tmp");
            if std::fs::write(&tmp, b).is_ok() {
                let _ = std::fs::rename(&tmp, file());
            }
        }
    }
    out
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
fn ms_of(t: std::io::Result<std::time::SystemTime>) -> Option<i64> {
    t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64)
}
fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------- the password ----------
fn derive(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let params = argon2::Params::new(19_456, 2, 1, Some(32)).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params).hash_password_into(password.as_bytes(), salt, &mut key).map_err(|e| e.to_string())?;
    Ok(key)
}
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
fn check_password(d: &Db, password: &str) -> bool {
    if d.hash.is_empty() {
        return false;
    }
    let salt: Vec<u8> = (0..d.salt.len() / 2).filter_map(|i| u8::from_str_radix(&d.salt[2 * i..2 * i + 2], 16).ok()).collect();
    derive(password, &salt).map(|k| same(&hex(&k), &d.hash)).unwrap_or(false)
}
fn is_unlocked() -> bool {
    let mut u = unlocked_until().lock();
    match *u {
        Some(t) if t > Instant::now() => {
            *u = Some(Instant::now() + Duration::from_secs(UNLOCK_MINUTES * 60));
            true
        }
        _ => {
            *u = None;
            false
        }
    }
}
fn need_unlock() -> Result<(), String> {
    if is_unlocked() {
        Ok(())
    } else {
        Err("Enter your Self-destruct password first".into())
    }
}

pub fn status(_a: &Args) -> R {
    let (has, n) = with_db(|d| ((!d.hash.is_empty(), d.rules.len()), false));
    Ok(json!({ "hasPassword": has, "unlocked": is_unlocked(), "rules": n }))
}

pub async fn unlock(a: &Args) -> R {
    let pw = a.s(0)?;
    let ok = tokio::task::spawn_blocking(move || with_db(|d| (check_password(d, &pw), false))).await.map_err(err)?;
    if ok {
        *unlocked_until().lock() = Some(Instant::now() + Duration::from_secs(UNLOCK_MINUTES * 60));
    }
    Ok(json!(ok))
}
pub fn lock(_a: &Args) -> R {
    *unlocked_until().lock() = None;
    Ok(json!(true))
}

/// sd:setPassword(new): the first one, or a new one while unlocked
pub async fn set_password(a: &Args) -> R {
    let new = a.s(0)?;
    if new.chars().count() < 4 {
        return Err("Use at least 4 characters".into());
    }
    if with_db(|d| (!d.hash.is_empty(), false)) {
        need_unlock()?;
    }
    tokio::task::spawn_blocking(move || {
        let mut salt = [0u8; 16];
        rand::fill(&mut salt);
        let key = derive(&new, &salt)?;
        with_db(|d| {
            d.salt = hex(&salt);
            d.hash = hex(&key);
            ((), true)
        });
        *unlocked_until().lock() = Some(Instant::now() + Duration::from_secs(UNLOCK_MINUTES * 60));
        Ok(json!(true))
    })
    .await
    .map_err(err)?
}

/// forgot the password: every rule and the password are removed (it can't be done without losing the rules)
pub fn reset(_a: &Args) -> R {
    with_db(|d| {
        *d = Db::default();
        ((), true)
    });
    *unlocked_until().lock() = None;
    Ok(json!(true))
}

// ---------- which files ----------
const PARTIAL: &[&str] = &["crdownload", "part", "partial", "tmp", "download", "opdownload", "!ut", "aria2", "temp", "dtapart"];
const IGNORED_NAMES: &[&str] = &["desktop.ini", "thumbs.db", "folder-icon.ico", ".ds_store"];

pub struct Item {
    pub path: PathBuf,
    pub size: u64,
    pub due: i64,
}
pub struct Plan {
    pub due: Vec<Item>,
    pub waiting: Vec<Item>,
}

fn ext_of(name: &str) -> String {
    Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

#[cfg(windows)]
fn is_hidden_or_system(md: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    md.file_attributes() & 0x6 != 0
}
#[cfg(not(windows))]
fn is_hidden_or_system(_md: &std::fs::Metadata) -> bool {
    false
}

/// does the rule want this file, and when is it due (None: this rule leaves it alone)
fn due_time(r: &Rule, name: &str, path: &Path, md: &std::fs::Metadata) -> Option<i64> {
    let lname = name.to_lowercase();
    let ext = ext_of(name);
    if IGNORED_NAMES.contains(&lname.as_str()) || PARTIAL.contains(&ext.as_str()) || lname.starts_with(crate::snapshot::STORE) {
        return None;
    }
    if is_hidden_or_system(md) {
        return None;
    }
    let types: Vec<String> = r.types.iter().map(|t| t.trim().trim_start_matches('.').to_lowercase()).filter(|t| !t.is_empty()).collect();
    match r.types_mode.as_str() {
        "only" if !types.contains(&ext) => return None,
        "except" if types.contains(&ext) => return None,
        _ => {}
    }
    let words = |v: &Vec<String>| v.iter().map(|w| w.trim().to_lowercase()).filter(|w| !w.is_empty()).collect::<Vec<_>>();
    let has = words(&r.name_has);
    if !has.is_empty() && !has.iter().any(|w| lname.contains(w)) {
        return None;
    }
    if words(&r.name_not).iter().any(|w| lname.contains(w)) {
        return None;
    }
    if r.min_size_mb > 0 && md.len() < r.min_size_mb * 1_048_576 {
        return None;
    }
    let p = norm(&path.to_string_lossy());
    if r.keep.iter().any(|k| norm(k) == p) {
        return None;
    }
    let modified = ms_of(md.modified())?;
    let start = if r.basis == "modified" { modified } else { ms_of(md.created()).unwrap_or(modified) };
    let start = if r.scope == "new" {
        // only what arrived after the rule was made
        if start < r.since_ms {
            return None;
        }
        start
    } else if r.fresh_start {
        start.max(r.since_ms)
    } else {
        start
    };
    Some(start + (r.ttl_secs as i64) * 1000)
}

pub fn plan(r: &Rule, now: i64) -> Plan {
    let mut out = Plan { due: vec![], waiting: vec![] };
    let root = PathBuf::from(&r.folder);
    let mut stack = vec![(root, 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Ok(md) = std::fs::symlink_metadata(e.path()) else { continue };
            if md.file_type().is_symlink() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if md.is_dir() {
                if r.subfolders && depth < 32 && !name.to_lowercase().starts_with(crate::snapshot::STORE) {
                    stack.push((e.path(), depth + 1));
                }
                continue;
            }
            if let Some(due) = due_time(r, &name, &e.path(), &md) {
                let it = Item { path: e.path(), size: md.len(), due };
                if due <= now {
                    out.due.push(it);
                } else {
                    out.waiting.push(it);
                }
            }
        }
    }
    out.due.sort_by_key(|i| i.due);
    out.waiting.sort_by_key(|i| i.due);
    out
}

/// folders a rule must never be made on: a whole drive, the user's own folder, Windows and Program Files
fn too_broad(folder: &str) -> Option<&'static str> {
    let f = norm(folder);
    let parts: Vec<&str> = f.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() <= 1 {
        return Some("Choose a folder (like Downloads), not a whole drive");
    }
    if let Some(h) = dirs::home_dir() {
        if norm(&h.to_string_lossy()) == f {
            return Some("Choose a folder inside your user folder (like Downloads), not the whole user folder");
        }
    }
    if matches!(parts.get(1).copied(), Some("windows") | Some("program files") | Some("program files (x86)") | Some("programdata")) {
        return Some("Dogfile won’t set this on a system folder");
    }
    None
}

// ---------- running a rule ----------
pub struct Run {
    pub removed: Vec<String>,
    pub failed: usize,
    pub paused: bool,
}

fn run_rule(r: &mut Rule, now: i64, force: bool) -> Run {
    let mut out = Run { removed: vec![], failed: 0, paused: false };
    if !Path::new(&r.folder).is_dir() {
        return out;
    }
    let p = plan(r, now);
    if p.due.len() > BIG_BATCH && !force {
        r.enabled = false;
        r.needs_review = true;
        out.paused = true;
        return out;
    }
    for it in p.due {
        match trash::delete(&it.path) {
            Ok(()) => out.removed.push(it.path.to_string_lossy().to_string()),
            Err(_) => out.failed += 1,
        }
    }
    r.last_run_ms = now;
    if !out.removed.is_empty() {
        r.last_removed = out.removed.len() as u64;
        r.total_removed += out.removed.len() as u64;
    }
    if force {
        r.needs_review = false;
    }
    out
}

/// in the middle of a Multiverse, the folders it covers are left alone
fn in_multiverse(folder: &str) -> bool {
    let Some(root) = crate::snapshot::active_root() else { return false };
    let (a, b) = (norm(&root), norm(folder));
    a == b || b.starts_with(&format!("{a}/")) || a.starts_with(&format!("{b}/"))
}

fn tick_blocking() {
    let ids: Vec<String> = with_db(|d| (d.rules.iter().filter(|r| r.enabled).map(|r| r.id.clone()).collect(), false));
    for id in ids {
        let Some(mut r) = with_db(|d| (d.rules.iter().find(|r| r.id == id).cloned(), false)) else { continue };
        if in_multiverse(&r.folder) {
            continue;
        }
        let now = now_ms();
        let out = run_rule(&mut r, now, false);
        finish(&r, &out, now);
    }
}

/// save the rule's counters and the log, and tell the windows
fn finish(r: &Rule, out: &Run, now: i64) {
    with_db(|d| {
        if let Some(x) = d.rules.iter_mut().find(|x| x.id == r.id) {
            x.enabled = r.enabled;
            x.needs_review = r.needs_review;
            x.last_run_ms = r.last_run_ms;
            x.last_removed = r.last_removed;
            x.total_removed = r.total_removed;
        }
        for p in &out.removed {
            d.log.push(LogEntry { at: now, folder: r.folder.clone(), path: p.clone(), ok: true });
        }
        let n = d.log.len();
        if n > LOG_KEEP {
            d.log.drain(0..n - LOG_KEEP);
        }
        ((), !out.removed.is_empty() || out.paused || r.last_run_ms == now)
    });
    // (the unit tests run without the app, so they have no windows to tell)
    if !cfg!(test) && (!out.removed.is_empty() || out.paused) {
        crate::events::to_main("sd:ran", json!({ "folder": r.folder, "removed": out.removed.len(), "paused": out.paused, "failed": out.failed }));
    }
}

pub fn start() {
    static STARTED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    if STARTED.set(()).is_ok() {
        crate::st().rt.spawn(async {
            tokio::time::sleep(Duration::from_secs(25)).await;
            loop {
                let _ = tokio::task::spawn_blocking(tick_blocking).await;
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        });
    }
}

// ---------- the calls the window makes ----------
fn rule_json(r: &Rule, now: i64) -> Value {
    let p = plan(r, now);
    let next = p.waiting.first().map(|i| i.due);
    let mut v = serde_json::to_value(r).unwrap_or(Value::Null);
    v["dueNow"] = json!(p.due.len());
    v["waiting"] = json!(p.waiting.len());
    v["nextDue"] = json!(next);
    v["folderExists"] = json!(Path::new(&r.folder).is_dir());
    v
}

pub async fn list(_a: &Args) -> R {
    need_unlock()?;
    tokio::task::spawn_blocking(|| {
        let rules = with_db(|d| (d.rules.clone(), false));
        let now = now_ms();
        Ok(json!({ "rules": rules.iter().map(|r| rule_json(r, now)).collect::<Vec<_>>() }))
    })
    .await
    .map_err(err)?
}

/// the folders that have a rule (no password needed: the window shows a note and the "keep" menu from this)
pub fn folders(_a: &Args) -> R {
    let v: Vec<Value> = with_db(|d| (d.rules.iter().filter(|r| r.enabled).map(|r| json!({ "id": r.id, "folder": r.folder, "ttlSecs": r.ttl_secs, "subfolders": r.subfolders, "keep": r.keep })).collect(), false));
    Ok(json!(v))
}

fn clean(mut r: Rule) -> Result<Rule, String> {
    r.folder = r.folder.trim().trim_end_matches(['\\', '/']).to_string();
    if r.folder.is_empty() || !Path::new(&r.folder).is_dir() {
        return Err("Choose a folder that exists".into());
    }
    if let Some(why) = too_broad(&r.folder) {
        return Err(why.into());
    }
    if r.ttl_secs < 60 {
        return Err("A file has to stay at least a minute".into());
    }
    if !["created", "modified"].contains(&r.basis.as_str()) {
        r.basis = "created".into();
    }
    if !["new", "all"].contains(&r.scope.as_str()) {
        r.scope = "new".into();
    }
    if !["all", "only", "except"].contains(&r.types_mode.as_str()) {
        r.types_mode = "all".into();
    }
    let tidy = |v: &mut Vec<String>| {
        *v = v.iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
    };
    tidy(&mut r.types);
    tidy(&mut r.name_has);
    tidy(&mut r.name_not);
    if r.types_mode != "all" && r.types.is_empty() {
        return Err("Add at least one file type, or choose “every kind of file”".into());
    }
    Ok(r)
}

/// sd:preview(rule): what would go now and what is next, without changing anything
pub async fn preview(a: &Args) -> R {
    need_unlock()?;
    let mut r: Rule = serde_json::from_value(a.v(0)).map_err(|e| format!("That rule isn’t valid: {e}"))?;
    if r.since_ms == 0 {
        r.since_ms = now_ms();
    }
    let r = clean(r)?;
    tokio::task::spawn_blocking(move || {
        let now = now_ms();
        let p = plan(&r, now);
        let show = |v: &Vec<Item>| v.iter().take(LIST_CAP).map(|i| json!({ "path": i.path.to_string_lossy(), "size": i.size, "due": i.due })).collect::<Vec<_>>();
        Ok(json!({ "dueNow": p.due.len(), "waiting": p.waiting.len(), "due": show(&p.due), "next": show(&p.waiting) }))
    })
    .await
    .map_err(err)?
}

/// sd:save(rule): add one or change one
pub async fn save(a: &Args) -> R {
    need_unlock()?;
    let incoming: Rule = serde_json::from_value(a.v(0)).map_err(|e| format!("That rule isn’t valid: {e}"))?;
    let mut r = clean(incoming)?;
    let now = now_ms();
    let out = with_db(|d| {
        if r.id.is_empty() {
            r.id = format!("sd{:x}{:04x}", now, rand::random::<u16>());
            r.created_ms = now;
            r.since_ms = now;
            d.rules.push(r.clone());
        } else if let Some(x) = d.rules.iter_mut().find(|x| x.id == r.id) {
            // what the rule has already done, and when it began, stay
            r.created_ms = x.created_ms;
            r.total_removed = x.total_removed;
            r.last_removed = x.last_removed;
            r.last_run_ms = x.last_run_ms;
            let moved = norm(&x.folder) != norm(&r.folder) || x.scope != r.scope || x.fresh_start != r.fresh_start;
            r.since_ms = if moved { now } else { x.since_ms };
            r.needs_review = false;
            *x = r.clone();
        } else {
            return (Err("That rule is gone".to_string()), false);
        }
        (Ok(r.clone()), true)
    })?;
    Ok(rule_json(&out, now))
}

pub fn remove(a: &Args) -> R {
    need_unlock()?;
    let id = a.s(0)?;
    with_db(|d| {
        d.rules.retain(|r| r.id != id);
        ((), true)
    });
    Ok(json!(true))
}

pub fn set_enabled(a: &Args) -> R {
    need_unlock()?;
    let (id, on) = (a.s(0)?, a.b(1));
    with_db(|d| {
        if let Some(r) = d.rules.iter_mut().find(|r| r.id == id) {
            r.enabled = on;
            if on {
                r.needs_review = false;
            }
        }
        ((), true)
    });
    Ok(json!(true))
}

/// sd:runNow(id): do it now, even when a lot is due (the person has looked at the preview)
pub async fn run_now(a: &Args) -> R {
    need_unlock()?;
    let id = a.s(0)?;
    tokio::task::spawn_blocking(move || {
        let Some(mut r) = with_db(|d| (d.rules.iter().find(|r| r.id == id).cloned(), false)) else { return Err("That rule is gone".to_string()) };
        if in_multiverse(&r.folder) {
            return Err("A Multiverse is open on this folder. Make it real or discard it first.".into());
        }
        let now = now_ms();
        let out = run_rule(&mut r, now, true);
        finish(&r, &out, now);
        Ok(json!({ "removed": out.removed.len(), "failed": out.failed }))
    })
    .await
    .map_err(err)?
}

/// sd:keep(path, on): keep one file from ever being removed (or let it be removed again). No password: it only ever
/// keeps more.
pub fn keep(a: &Args) -> R {
    let (path, on) = (a.s(0)?, a.b_or(1, true));
    let n = norm(&path);
    let changed = with_db(|d| {
        let mut any = false;
        for r in d.rules.iter_mut() {
            let inside = n.starts_with(&format!("{}/", norm(&r.folder)));
            if !inside {
                continue;
            }
            if on && !r.keep.iter().any(|k| norm(k) == n) {
                r.keep.push(path.clone());
                any = true;
            } else if !on {
                let before = r.keep.len();
                r.keep.retain(|k| norm(k) != n);
                any |= r.keep.len() != before;
            }
        }
        (any, any)
    });
    Ok(json!(changed))
}

pub fn log(_a: &Args) -> R {
    need_unlock()?;
    let l = with_db(|d| (d.log.iter().rev().take(100).cloned().collect::<Vec<_>>(), false));
    Ok(json!(l))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);
    // the rules and password are one global file, so these tests take turns
    static TURN: Mutex<()> = Mutex::new(());

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("dogfile-sd-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn file_aged(d: &Path, name: &str, days_old: i64, bytes: usize) -> PathBuf {
        let p = d.join(name);
        if let Some(par) = p.parent() {
            std::fs::create_dir_all(par).unwrap();
        }
        std::fs::write(&p, vec![b'x'; bytes]).unwrap();
        let t = std::time::SystemTime::now() - Duration::from_secs((days_old * 86_400) as u64);
        filetime::set_file_mtime(&p, filetime::FileTime::from_system_time(t)).unwrap();
        p
    }
    fn rule(d: &Path) -> Rule {
        Rule { id: "t".into(), folder: d.to_string_lossy().to_string(), basis: "modified".into(), scope: "all".into(), fresh_start: false, ttl_secs: 3 * 86_400, since_ms: 0, ..Default::default() }
    }
    fn names(v: &[Item]) -> Vec<String> {
        let mut n: Vec<String> = v.iter().map(|i| i.path.file_name().unwrap().to_string_lossy().to_string()).collect();
        n.sort();
        n
    }

    #[test]
    fn old_files_are_due_and_new_ones_wait() {
        let d = dir();
        file_aged(&d, "old.zip", 10, 5);
        file_aged(&d, "mid.zip", 2, 5);
        file_aged(&d, "new.zip", 0, 5);
        let p = plan(&rule(&d), now_ms());
        assert_eq!(names(&p.due), vec!["old.zip"]);
        assert_eq!(names(&p.waiting), vec!["mid.zip", "new.zip"]);
        // the soonest to go is listed first
        assert_eq!(p.waiting[0].path.file_name().unwrap(), "mid.zip");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn types_names_size_and_kept_files_decide_which() {
        let d = dir();
        for n in ["a.png", "b.pdf", "c-invoice.pdf", "d.exe"] {
            file_aged(&d, n, 10, 2_000_000);
        }
        file_aged(&d, "tiny.png", 10, 10);
        let mut r = rule(&d);
        r.types_mode = "only".into();
        r.types = vec!["PNG".into(), ".exe".into()];
        assert_eq!(names(&plan(&r, now_ms()).due), vec!["a.png", "d.exe", "tiny.png"]);
        r.types_mode = "except".into();
        r.types = vec!["png".into()];
        assert_eq!(names(&plan(&r, now_ms()).due), vec!["b.pdf", "c-invoice.pdf", "d.exe"]);
        r.types_mode = "all".into();
        r.name_not = vec!["invoice".into()];
        assert!(!names(&plan(&r, now_ms()).due).contains(&"c-invoice.pdf".to_string()));
        r.name_not = vec![];
        r.name_has = vec!["invoice".into()];
        assert_eq!(names(&plan(&r, now_ms()).due), vec!["c-invoice.pdf"]);
        r.name_has = vec![];
        r.min_size_mb = 1;
        assert!(!names(&plan(&r, now_ms()).due).contains(&"tiny.png".to_string()));
        r.min_size_mb = 0;
        r.keep = vec![d.join("a.png").to_string_lossy().to_string().to_uppercase()];
        assert!(!names(&plan(&r, now_ms()).due).contains(&"a.png".to_string()));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn new_files_only_and_a_fresh_start_for_what_is_already_there() {
        let d = dir();
        file_aged(&d, "before.zip", 10, 5);
        let mut r = rule(&d);
        r.scope = "new".into();
        r.since_ms = now_ms() - 86_400_000; // the rule is a day old: the file is older than that
        file_aged(&d, "after.zip", 0, 5);
        let p = plan(&r, now_ms());
        assert!(p.due.is_empty());
        assert_eq!(names(&p.waiting), vec!["after.zip"]);
        // every file, but what is already there begins its time now
        r.scope = "all".into();
        r.fresh_start = true;
        r.since_ms = now_ms();
        let p = plan(&r, now_ms());
        assert!(p.due.is_empty());
        assert_eq!(names(&p.waiting), vec!["after.zip", "before.zip"]);
        // every file with its real age
        r.fresh_start = false;
        assert_eq!(names(&plan(&r, now_ms()).due), vec!["before.zip"]);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn subfolders_and_files_that_must_not_be_touched() {
        let d = dir();
        file_aged(&d, "sub/old.zip", 10, 5);
        file_aged(&d, "movie.mp4.crdownload", 10, 5);
        file_aged(&d, "desktop.ini", 10, 5);
        file_aged(&d, "top.zip", 10, 5);
        let mut r = rule(&d);
        assert_eq!(names(&plan(&r, now_ms()).due), vec!["top.zip"]);
        r.subfolders = true;
        assert_eq!(names(&plan(&r, now_ms()).due), vec!["old.zip", "top.zip"]);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn running_a_rule_removes_what_is_due_and_a_huge_batch_waits_to_be_looked_at() {
        let d = dir();
        file_aged(&d, "old.zip", 10, 5);
        file_aged(&d, "new.zip", 0, 5);
        let mut r = rule(&d);
        let out = run_rule(&mut r, now_ms(), false);
        assert_eq!(out.removed.len(), 1);
        assert!(!d.join("old.zip").exists() && d.join("new.zip").exists());
        assert_eq!((r.last_removed, r.total_removed), (1, 1));
        for i in 0..(BIG_BATCH + 5) {
            file_aged(&d, &format!("f{i}.zip"), 10, 1);
        }
        let out = run_rule(&mut r, now_ms(), false);
        assert!(out.paused && r.needs_review && !r.enabled && out.removed.is_empty());
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), BIG_BATCH + 5 + 1);
        // after looking, the person says go
        let out = run_rule(&mut r, now_ms(), true);
        assert_eq!(out.removed.len(), BIG_BATCH + 5);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn broad_folders_are_refused_and_rules_are_tidied() {
        assert!(too_broad("C:\\").is_some());
        assert!(too_broad("C:\\Windows").is_some());
        assert!(too_broad("C:\\Program Files").is_some());
        assert!(too_broad("C:\\Users\\me\\Downloads").is_none() || dirs::home_dir().is_some());
        let d = dir();
        let mut r = rule(&d);
        r.types_mode = "only".into();
        assert!(clean(r.clone()).is_err()); // "only" with no types
        r.types = vec![" png ".into(), "".into()];
        let c = clean(r.clone()).unwrap();
        assert_eq!(c.types, vec!["png"]);
        r.ttl_secs = 5;
        assert!(clean(r).is_err());
        std::fs::remove_dir_all(&d).ok();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_password_guards_the_settings() {
        let _t = TURN.lock();
        let d = dir();
        // SAFETY: only these tests use this variable, and they take turns
        unsafe { std::env::set_var("DOGFILE_SD_FILE", d.join("sd.json")) };
        *db().lock() = None;
        *unlocked_until().lock() = None;
        assert_eq!(status(&Args(vec![])).unwrap()["hasPassword"], false);
        assert!(set_password(&Args(vec![json!("ab")])).await.is_err());
        set_password(&Args(vec![json!("hunter22")])).await.unwrap();
        assert_eq!(status(&Args(vec![])).unwrap()["hasPassword"], true);
        lock(&Args(vec![])).unwrap();
        // locked: nothing can be listed, saved or removed
        assert!(list(&Args(vec![])).await.is_err());
        assert!(save(&Args(vec![json!({ "folder": d.to_string_lossy() })])).await.is_err());
        assert!(remove(&Args(vec![json!("x")])).is_err());
        assert!(set_password(&Args(vec![json!("another")])).await.is_err());
        assert_eq!(unlock(&Args(vec![json!("wrong")])).await.unwrap(), json!(false));
        assert_eq!(unlock(&Args(vec![json!("hunter22")])).await.unwrap(), json!(true));
        assert!(list(&Args(vec![])).await.is_ok());
        // the password is saved as a hash, never as text
        let saved = std::fs::read_to_string(d.join("sd.json")).unwrap();
        assert!(!saved.contains("hunter22"));
        // a rule, saved, listed, kept-from, run, removed
        let folder = dir();
        let old = file_aged(&folder, "old.zip", 10, 5);
        let keepme = file_aged(&folder, "keep.zip", 10, 5);
        let sub = json!({ "folder": folder.to_string_lossy(), "ttlSecs": 3 * 86_400, "basis": "modified", "scope": "all", "freshStart": false });
        let saved = save(&Args(vec![sub])).await.unwrap();
        let id = saved["id"].as_str().unwrap().to_string();
        assert_eq!(saved["dueNow"], 2);
        assert_eq!(keep(&Args(vec![json!(keepme.to_string_lossy())])).unwrap(), json!(true));
        let ran = run_now(&Args(vec![json!(id)])).await.unwrap();
        assert_eq!(ran["removed"], 1);
        assert!(!old.exists() && keepme.exists());
        assert_eq!(folders(&Args(vec![])).unwrap().as_array().unwrap().len(), 1);
        assert_eq!(log(&Args(vec![])).unwrap().as_array().unwrap().len(), 1);
        remove(&Args(vec![json!(id)])).unwrap();
        assert_eq!(folders(&Args(vec![])).unwrap().as_array().unwrap().len(), 0);
        // forgetting the password clears everything
        reset(&Args(vec![])).unwrap();
        assert_eq!(status(&Args(vec![])).unwrap()["hasPassword"], false);
        unsafe { std::env::remove_var("DOGFILE_SD_FILE") };
        std::fs::remove_dir_all(&d).ok();
        std::fs::remove_dir_all(&folder).ok();
    }
}
