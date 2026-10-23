// The file-operation queue: copy / move / delete / recycle / extract / compress / archive edits, in the background,
// with progress, speed, pause, cancel, "what to do about this name clash" questions, retries and undo records.
use crate::args::{Args, R};
use crate::util::{self, basename, is_inside, same_path, same_volume};
use crate::{archive, events, setting, setting_bool, st};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct JobData {
    pub status: String,
    pub title: String,
    pub total: u64,
    pub done: u64,
    pub files_total: u64,
    pub files_done: u64,
    pub current: String,
    pub error: Option<String>,
    pub errors: Vec<String>,
    pub started: f64,
    pub finished: Option<f64>,
    pub speed: f64,
    pub locked: Vec<String>,
    pub indeterminate: bool,
    pub undo: Value,
    pub failed: Vec<String>,
    pub policy: Option<String>,
    dirty: bool,
}
pub struct Job {
    pub id: u64,
    pub kind: String,
    pub sources: Vec<String>,
    pub dest: Option<String>,
    pub opts: Value,
    pub spec: Value,
    pub network: bool,
    pub cancelled: AtomicBool,
    pub paused: AtomicBool,
    pub d: Mutex<JobData>,
}
pub struct Cancelled;

impl Job {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
    /// waits while paused; Err when cancelled
    pub fn checkpoint(&self) -> Result<(), Cancelled> {
        while self.paused.load(Ordering::Relaxed) && !self.is_cancelled() {
            std::thread::sleep(Duration::from_millis(150));
        }
        if self.is_cancelled() { Err(Cancelled) } else { Ok(()) }
    }
    pub fn set_current(&self, s: &str) {
        let mut d = self.d.lock();
        d.current = s.chars().rev().take(120).collect::<Vec<_>>().into_iter().rev().collect();
        drop(d);
        emit(self);
    }
    pub fn add_done(&self, n: u64) {
        self.d.lock().done += n;
        emit(self);
    }
    pub fn err(&self, s: String) {
        self.d.lock().errors.push(s);
    }
}

struct Ops {
    jobs: HashMap<u64, Arc<Job>>,
    order: Vec<u64>,
    queue: Vec<u64>,
    running: usize,
    net_running: usize,
}
fn ops() -> &'static Mutex<Ops> {
    static O: OnceLock<Mutex<Ops>> = OnceLock::new();
    O.get_or_init(|| Mutex::new(Ops { jobs: HashMap::new(), order: vec![], queue: vec![], running: 0, net_running: 0 }))
}
static NEXT: AtomicU64 = AtomicU64::new(1);
struct Cfg {
    parallel: usize,
    sequential: bool,
    throttle_mbps: f64,
    network_queue: bool,
}
fn cfg() -> &'static Mutex<Cfg> {
    static C: OnceLock<Mutex<Cfg>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Cfg { parallel: 2, sequential: false, throttle_mbps: 0.0, network_queue: true }))
}
pub fn configure_from_settings() {
    let mut c = cfg().lock();
    c.sequential = setting_bool("sequentialOps", false);
    c.throttle_mbps = setting("throttleMBps").as_f64().unwrap_or(0.0);
    c.network_queue = setting_bool("networkQueue", true);
}
pub fn configure(a: &Args) -> R {
    let s = a.v(0);
    let mut c = cfg().lock();
    if let Some(v) = s["sequential"].as_bool() { c.sequential = v }
    if let Some(v) = s["throttle"].as_f64() { c.throttle_mbps = v }
    if let Some(v) = s["networkQueue"].as_bool() { c.network_queue = v }
    if let Some(v) = s["parallel"].as_u64() { c.parallel = v.max(1) as usize }
    Ok(json!(true))
}

pub fn public(j: &Job) -> Value {
    let d = j.d.lock();
    let queue_pos = if d.status == "queued" { ops().try_lock().map(|o| o.queue.iter().position(|x| *x == j.id).map(|p| p + 1).unwrap_or(0)).unwrap_or(0) } else { 0 };
    json!({
        "id": j.id, "type": j.kind, "title": d.title, "status": d.status, "total": d.total, "done": d.done, "filesTotal": d.files_total,
        "filesDone": d.files_done, "current": d.current, "error": d.error, "errors": d.errors.iter().rev().take(20).rev().collect::<Vec<_>>(),
        "started": d.started, "speed": d.speed, "dest": j.dest, "paused": j.paused.load(Ordering::Relaxed), "locked": d.locked.iter().take(50).collect::<Vec<_>>(),
        "indeterminate": d.indeterminate, "undo": if d.status == "done" { d.undo.clone() } else { Value::Null }, "finished": d.finished,
        "failed": d.failed, "sourceCount": j.sources.len(), "canRetry": matches!(j.kind.as_str(), "copy" | "move" | "delete" | "trash" | "extract" | "compress"),
        "queuePos": queue_pos,
    })
}

static EMIT_PENDING: AtomicBool = AtomicBool::new(false);
pub fn emit(j: &Job) {
    j.d.lock().dirty = true;
    if EMIT_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    st().rt.spawn(async {
        tokio::time::sleep(Duration::from_millis(120)).await;
        EMIT_PENDING.store(false, Ordering::SeqCst);
        let list: Vec<Arc<Job>> = ops().lock().jobs.values().cloned().collect();
        for jj in list {
            let dirty = std::mem::replace(&mut jj.d.lock().dirty, false);
            if dirty {
                events::to_main("ops:update", public(&jj));
            }
        }
    });
}
fn emit_now(j: &Job) {
    j.d.lock().dirty = false;
    events::to_main("ops:update", public(j));
}

pub fn start(spec: Value) -> u64 {
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let kind = spec["type"].as_str().unwrap_or("").to_string();
    let sources = crate::args::strs(&spec["sources"]);
    let dest = spec["dest"].as_str().map(String::from);
    let mut title = spec["title"].as_str().unwrap_or("").to_string();
    if title.is_empty() {
        let what = if sources.len() == 1 { format!("\"{}\"", basename(&sources[0])) } else { format!("{} items", sources.len()) };
        let db = dest.as_deref().map(basename).unwrap_or_default();
        title = match kind.as_str() {
            "copy" => format!("Copying {what}"),
            "move" => format!("Moving {what}"),
            "delete" => format!("Deleting {what}"),
            "trash" => format!("Recycling {what}"),
            "extract" => format!("Extracting {what}"),
            "compress" => format!("Compressing {what}"),
            "archiveAdd" => format!("Adding {what} to {db}"),
            "archiveDelete" => format!("Removing from {db}"),
            "archiveRename" => format!("Renaming in {db}"),
            "convert" => format!("Converting {what}"),
            k => k.to_string(),
        };
    }
    let j = Arc::new(Job {
        id,
        kind,
        sources,
        dest,
        opts: if spec["opts"].is_object() { spec["opts"].clone() } else { json!({}) },
        network: spec["network"].as_bool().unwrap_or(false),
        spec,
        cancelled: AtomicBool::new(false),
        paused: AtomicBool::new(false),
        d: Mutex::new(JobData { status: "queued".into(), title, started: util::now_ms(), undo: Value::Null, ..Default::default() }),
    });
    {
        let mut o = ops().lock();
        o.jobs.insert(id, j.clone());
        o.order.push(id);
        o.queue.push(id);
    }
    emit_now(&j);
    pump();
    id
}
pub fn start_call(a: &Args) -> R {
    Ok(json!(start(a.v(0))))
}

fn pump() {
    let c = cfg().lock();
    let limit = if c.sequential { 1 } else { c.parallel.max(1) };
    let netq = c.network_queue;
    drop(c);
    let mut to_run = vec![];
    {
        let mut o = ops().lock();
        let mut i = 0;
        while i < o.queue.len() {
            let id = o.queue[i];
            let Some(j) = o.jobs.get(&id).cloned() else { o.queue.remove(i); continue };
            if j.is_cancelled() { o.queue.remove(i); continue }
            let net = j.network && netq;
            if net && o.net_running > 0 { i += 1; continue }
            if !net && o.running - o.net_running >= limit { i += 1; continue }
            o.queue.remove(i);
            o.running += 1;
            if net { o.net_running += 1 }
            to_run.push((j, net));
        }
    }
    for (j, net) in to_run {
        std::thread::spawn(move || {
            run(&j);
            {
                let mut o = ops().lock();
                o.running -= 1;
                if net { o.net_running -= 1 }
            }
            pump();
        });
    }
}

fn run(j: &Arc<Job>) {
    {
        let mut d = j.d.lock();
        d.status = "running".into();
        d.started = util::now_ms();
    }
    emit_now(j);
    let r = match j.kind.as_str() {
        "copy" | "move" => copy_move(j),
        "delete" => del(j),
        "trash" => trash(j),
        "extract" => archive::extract(j),
        "compress" => archive::compress(j),
        "archiveAdd" => archive::add(j),
        "archiveDelete" => archive::delete(j),
        "archiveRename" => archive::rename(j),
        "convert" => archive::convert(j),
        k => Err(Err(format!("Unknown operation {k}"))),
    };
    {
        let mut d = j.d.lock();
        match r {
            Ok(()) => d.status = if j.is_cancelled() { "cancelled".into() } else { "done".into() },
            Err(Ok(Cancelled)) => d.status = "cancelled".into(),
            Err(Err(e)) => {
                d.status = "error".into();
                d.error = Some(e);
            }
        }
        if j.is_cancelled() && d.status == "done" {
            d.status = "cancelled".into();
        }
        d.current.clear();
        d.finished = Some(util::now_ms());
        if !d.errors.is_empty() || d.status == "error" || d.status == "cancelled" {
            let errs: Vec<String> = d.errors.iter().map(|e| util::low(e)).collect();
            d.failed = if d.status == "error" || d.status == "cancelled" { j.sources.clone() } else { j.sources.iter().filter(|s| errs.iter().any(|e| e.starts_with(&util::low(s)))).cloned().collect() };
            if d.failed.is_empty() && !d.errors.is_empty() {
                d.failed = j.sources.clone();
            }
        }
    }
    emit_now(j);
    events::to_main("ops:finished", public(j));
}

pub type JR = Result<(), Result<Cancelled, String>>;
fn cancelled() -> Result<Cancelled, String> {
    Ok(Cancelled)
}

// ---------------- name clashes ----------------
type ConflictTx = std::sync::mpsc::Sender<Value>;
fn conflicts() -> &'static Mutex<HashMap<String, ConflictTx>> {
    static C: OnceLock<Mutex<HashMap<String, ConflictTx>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn resolve_conflict(a: &Args) -> R {
    let id = a.s(0)?;
    if let Some(tx) = conflicts().lock().remove(&id) {
        let _ = tx.send(a.v(1));
    }
    Ok(json!(true))
}
fn ask_conflict(j: &Job, src: &str, dst: &str) -> Result<String, Result<Cancelled, String>> {
    if let Some(m) = j.opts["conflictMap"].as_object() {
        if let Some(a) = m.get(&util::low(dst)).and_then(|v| v.as_str()) {
            return Ok(a.to_string());
        }
    }
    if let Some(p) = j.d.lock().policy.clone() {
        return Ok(p);
    }
    if let Some(c) = j.opts["conflict"].as_str() {
        return Ok(c.to_string());
    }
    let s = std::fs::metadata(src).ok();
    let d = std::fs::metadata(dst).ok();
    j.d.lock().status = "waiting".into();
    emit_now(j);
    let id = util::uuid();
    let (tx, rx) = std::sync::mpsc::channel();
    conflicts().lock().insert(id.clone(), tx);
    let info = json!({
        "jobId": j.id, "src": src, "dst": dst, "srcSize": s.as_ref().map(|m| m.len()), "srcMtime": s.as_ref().map(|m| util::ms(m.modified())),
        "dstSize": d.as_ref().map(|m| m.len()), "dstMtime": d.as_ref().map(|m| util::ms(m.modified())), "isDir": s.as_ref().map(|m| m.is_dir()), "conflictId": id,
    });
    let host = &st().host;
    let target = host.main_windows().into_iter().next();
    let decision = match target {
        Some(w) => {
            host.emit(&w, "ops:conflict", info);
            loop {
                match rx.recv_timeout(Duration::from_millis(300)) {
                    Ok(v) => break v,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if j.is_cancelled() { break json!({ "action": "cancel" }) }
                    }
                    Err(_) => break json!({ "action": "skip" }),
                }
            }
        }
        None => json!({ "action": "skip" }),
    };
    j.d.lock().status = "running".into();
    emit_now(j);
    let action = decision["action"].as_str().unwrap_or("skip").to_string();
    if action == "cancel" {
        j.cancelled.store(true, Ordering::SeqCst);
        return Err(cancelled());
    }
    if decision["applyAll"].as_bool().unwrap_or(false) {
        j.d.lock().policy = Some(action.clone());
    }
    Ok(action)
}

// ---------------- copy / move ----------------
struct Entry {
    src: PathBuf,
    dst: PathBuf,
    dir: bool,
    size: u64,
    link: bool,
    mtime: std::time::SystemTime,
    atime: std::time::SystemTime,
}
fn walk(j: &Job, src: &Path, dst: &Path, out: &mut Vec<Entry>) -> Result<(), String> {
    let md = std::fs::symlink_metadata(src).map_err(|e| format!("{}: {}", src.display(), crate::fsx::friendly(&e)))?;
    let mtime = md.modified().unwrap_or(std::time::UNIX_EPOCH);
    let atime = md.accessed().unwrap_or(mtime);
    if md.is_dir() {
        out.push(Entry { src: src.into(), dst: dst.into(), dir: true, size: 0, link: false, mtime, atime });
        match std::fs::read_dir(src) {
            Ok(rd) => {
                for e in rd.flatten() {
                    if j.is_cancelled() { return Ok(()) }
                    let _ = walk(j, &e.path(), &dst.join(e.file_name()), out).map_err(|e| j.err(e));
                }
            }
            Err(e) => j.err(format!("{}: {}", src.display(), crate::fsx::friendly(&e))),
        }
    } else {
        let link = md.file_type().is_symlink();
        let size = crate::demo::size(src, md.len());
        out.push(Entry { src: src.into(), dst: dst.into(), dir: false, size, link, mtime, atime });
        let mut d = j.d.lock();
        d.total += size;
        d.files_total += 1;
    }
    Ok(())
}

fn rm_any(p: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(p),
        Ok(_) => std::fs::remove_file(p),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
fn clear_readonly(p: &Path) {
    if let Ok(md) = std::fs::symlink_metadata(p) {
        let mut perm = md.permissions();
        if perm.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perm.set_readonly(false);
            let _ = std::fs::set_permissions(p, perm);
        }
        if md.is_dir() {
            if let Ok(rd) = std::fs::read_dir(p) {
                for e in rd.flatten() {
                    clear_readonly(&e.path());
                }
            }
        }
    }
}

/// copy one file with progress, pause, cancel and the speed limit
fn copy_file(j: &Job, src: &Path, dst: &Path, size: u64) -> JR {
    let throttle = cfg().lock().throttle_mbps;
    // demo mode: a pretend file takes the time its pretend size would (about 280 MB/s, at most 6 s each)
    if crate::demo::active() && crate::demo::inside(src) {
        let real = std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);
        if size > real {
            let mut speed = (size as f64 / 6.0).max(280.0 * 1048576.0);
            if throttle > 0.0 {
                speed = speed.min(throttle * 1048576.0);
            }
            let t0 = Instant::now();
            let mut done: u64 = 0;
            while done < size {
                if j.checkpoint().is_err() {
                    return Err(cancelled());
                }
                let step = (size - done).min((speed * 0.05) as u64).max(1);
                done += step;
                j.add_done(step);
                let ahead = (done as f64 / speed) * 1000.0 - t0.elapsed().as_millis() as f64;
                if ahead > 1.0 {
                    std::thread::sleep(Duration::from_millis(ahead as u64));
                }
            }
            return std::fs::copy(src, dst).map(|_| ()).map_err(|e| Err(crate::fsx::friendly(&e)));
        }
    }
    #[cfg(windows)]
    if throttle <= 0.0 {
        return crate::win::copy_file_progress(j, src, dst, size);
    }
    use std::io::{Read, Write};
    let mut r = std::fs::File::open(src).map_err(|e| Err(crate::fsx::friendly(&e)))?;
    let mut w = std::fs::File::create(dst).map_err(|e| Err(crate::fsx::friendly(&e)))?;
    let mut buf = vec![0u8; 4 << 20];
    let t0 = Instant::now();
    let mut here: u64 = 0;
    loop {
        if j.checkpoint().is_err() {
            drop(w);
            let _ = std::fs::remove_file(dst);
            return Err(cancelled());
        }
        let n = r.read(&mut buf).map_err(|e| Err(crate::fsx::friendly(&e)))?;
        if n == 0 { break }
        w.write_all(&buf[..n]).map_err(|e| Err(crate::fsx::friendly(&e)))?;
        here += n as u64;
        j.add_done(n as u64);
        if throttle > 0.0 {
            let lim = throttle * 1048576.0;
            let ahead = (here as f64 / lim) * 1000.0 - t0.elapsed().as_millis() as f64;
            if ahead > 15.0 {
                std::thread::sleep(Duration::from_millis(ahead as u64));
            }
        }
    }
    let _ = size;
    Ok(())
}

fn copy_move(j: &Arc<Job>) -> JR {
    let is_move = j.kind == "move";
    let dest = j.dest.clone().ok_or_else(|| Err("No destination".to_string()))?;
    std::fs::create_dir_all(&dest).map_err(|e| Err(crate::fsx::friendly(&e)))?;
    let mut created: Vec<String> = vec![];
    let mut moved: Vec<Value> = vec![];
    let mut plans: Vec<(String, String)> = vec![];
    for src in &j.sources {
        if j.is_cancelled() { break }
        let name = basename(src);
        let mut dst = util::join(&dest, &name);
        if is_inside(&dest, src) && !same_path(&util::dirname(src), &dest) {
            j.err(format!("Can't put \"{name}\" inside itself"));
            continue;
        }
        if same_path(src, &dst) {
            if is_move { continue }
            dst = util::unique_name(&dest, &name, "copy");
        }
        plans.push((src.clone(), dst));
    }
    // moves on the same drive: rename the top-level items
    let mut slow: Vec<(String, String)> = vec![];
    for (src, dst0) in plans {
        if j.is_cancelled() { break }
        j.checkpoint().map_err(|_| cancelled())?;
        if is_move && same_volume(&src, &dst0) {
            let mut dst = dst0.clone();
            if util::exists(Path::new(&dst)) {
                let sd = std::fs::metadata(&src).map(|m| m.is_dir()).unwrap_or(false);
                let dd = std::fs::metadata(&dst).map(|m| m.is_dir()).unwrap_or(false);
                if sd && dd { slow.push((src, dst)); continue } // merge folders file by file
                let a = ask_conflict(j, &src, &dst)?;
                match a.as_str() {
                    "skip" => continue,
                    "keepBoth" => dst = util::unique_name(&dest, &basename(&src), "number"),
                    "skipIdentical" | "newer" => {
                        let (s1, s2) = (std::fs::metadata(&src).ok(), std::fs::metadata(&dst).ok());
                        let (m1, m2) = (s1.as_ref().map(|m| util::ms(m.modified())).unwrap_or(0.0), s2.as_ref().map(|m| util::ms(m.modified())).unwrap_or(0.0));
                        if a == "skipIdentical" && s1.as_ref().map(|m| m.len()) == s2.as_ref().map(|m| m.len()) && (m1 - m2).abs() < 2000.0 { continue }
                        if a == "newer" && m1 <= m2 { continue }
                        let _ = rm_any(Path::new(&dst));
                    }
                    _ => { let _ = rm_any(Path::new(&dst)); }
                }
            }
            j.set_current(&basename(&src));
            match std::fs::rename(&src, &dst) {
                Ok(()) => {
                    moved.push(json!([src, dst]));
                    j.d.lock().files_done += 1;
                }
                Err(e) if e.raw_os_error() == Some(17) || e.raw_os_error() == Some(18) => slow.push((src, dst)),
                Err(e) => j.err(format!("{src}: {}", crate::fsx::friendly(&e))),
            }
        } else {
            slow.push((src, dst0));
        }
    }
    if slow.is_empty() {
        j.d.lock().undo = json!({ "type": "moved", "pairs": moved });
        return Ok(());
    }
    let mut entries: Vec<Entry> = vec![];
    for (s, d) in &slow {
        if j.is_cancelled() { break }
        if let Err(e) = walk(j, Path::new(s), Path::new(d), &mut entries) {
            j.err(e);
        }
    }
    emit_now(j);
    let tops: Vec<PathBuf> = slow.iter().map(|(_, d)| PathBuf::from(d)).collect();
    let mut last_t = Instant::now();
    let mut last_done = 0u64;
    for e in &entries {
        j.checkpoint().map_err(|_| cancelled())?;
        j.set_current(&e.src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        if last_t.elapsed().as_millis() > 700 {
            let mut d = j.d.lock();
            d.speed = (d.done.saturating_sub(last_done)) as f64 / last_t.elapsed().as_secs_f64();
            last_done = d.done;
            last_t = Instant::now();
        }
        let res: JR = (|| {
            if e.dir {
                if !util::exists(&e.dst) {
                    std::fs::create_dir_all(&e.dst).map_err(|er| Err(crate::fsx::friendly(&er)))?;
                    if tops.contains(&e.dst) { created.push(e.dst.to_string_lossy().into_owned()) }
                }
                return Ok(());
            }
            let mut dst = e.dst.clone();
            if util::exists(&dst) {
                let a = ask_conflict(j, &e.src.to_string_lossy(), &dst.to_string_lossy())?;
                let dmd = std::fs::metadata(&dst).ok();
                let dm = dmd.as_ref().map(|m| util::ms(m.modified())).unwrap_or(0.0);
                let sm = util::ms(Ok(e.mtime));
                match a.as_str() {
                    "skip" => { j.add_done(e.size); j.d.lock().files_done += 1; return Ok(()) }
                    "skipIdentical" if dmd.as_ref().map(|m| m.len()) == Some(e.size) && (dm - sm).abs() < 2000.0 => { j.add_done(e.size); j.d.lock().files_done += 1; return Ok(()) }
                    "newer" if sm <= dm => { j.add_done(e.size); j.d.lock().files_done += 1; return Ok(()) }
                    "keepBoth" => dst = PathBuf::from(util::unique_name(&dst.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(), &dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), "number")),
                    _ => { clear_readonly(&dst); let _ = std::fs::remove_file(&dst); }
                }
            }
            if e.link {
                let t = std::fs::read_link(&e.src).map_err(|er| Err(er.to_string()))?;
                #[cfg(unix)]
                std::os::unix::fs::symlink(&t, &dst).map_err(|er| Err(er.to_string()))?;
                #[cfg(windows)]
                {
                    if t.is_dir() { std::os::windows::fs::symlink_dir(&t, &dst) } else { std::os::windows::fs::symlink_file(&t, &dst) }.map_err(|er| Err(er.to_string()))?;
                }
            } else {
                copy_file(j, &e.src, &dst, e.size)?;
                let _ = filetime::set_file_times(&dst, filetime::FileTime::from_system_time(e.atime), filetime::FileTime::from_system_time(e.mtime));
            }
            if tops.contains(&e.dst) { created.push(dst.to_string_lossy().into_owned()) }
            j.d.lock().files_done += 1;
            Ok(())
        })();
        match res {
            Ok(()) => {}
            Err(Ok(c)) => return Err(Ok(c)),
            Err(Err(msg)) => {
                j.err(format!("{}: {msg}", e.src.display()));
                if msg.contains("in use") || msg.contains("denied") {
                    j.d.lock().locked.push(e.src.to_string_lossy().into_owned());
                }
            }
        }
    }
    // folder dates after their files are written
    for e in entries.iter().filter(|e| e.dir) {
        let _ = filetime::set_file_times(&e.dst, filetime::FileTime::from_system_time(e.atime), filetime::FileTime::from_system_time(e.mtime));
    }
    if is_move && !j.is_cancelled() {
        for (s, d) in &slow {
            let had = j.d.lock().errors.iter().any(|er| er.starts_with(s.as_str()));
            if !had {
                match rm_any(Path::new(s)) {
                    Ok(()) => moved.push(json!([s, d])),
                    Err(er) => j.err(format!("{s}: {}", crate::fsx::friendly(&er))),
                }
            }
        }
        j.d.lock().undo = json!({ "type": "moved", "pairs": moved });
    } else {
        j.d.lock().undo = json!({ "type": "created", "paths": created });
    }
    Ok(())
}

// ---------------- delete / recycle ----------------
fn del(j: &Arc<Job>) -> JR {
    j.d.lock().files_total = j.sources.len() as u64;
    for p in &j.sources {
        j.checkpoint().map_err(|_| cancelled())?;
        j.set_current(&basename(p));
        let path = Path::new(p);
        let r = rm_any(path).or_else(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                clear_readonly(path);
                rm_any(path)
            } else {
                Err(e)
            }
        });
        if let Err(e) = r {
            j.err(format!("{p}: {}", crate::fsx::friendly(&e)));
            j.d.lock().locked.push(p.clone());
        }
        j.d.lock().files_done += 1;
        emit(j);
    }
    Ok(())
}
fn trash(j: &Arc<Job>) -> JR {
    j.d.lock().files_total = j.sources.len() as u64;
    let mut done = vec![];
    for p in &j.sources {
        j.checkpoint().map_err(|_| cancelled())?;
        j.set_current(&basename(p));
        match trash::delete(p) {
            Ok(()) => done.push(p.clone()),
            Err(e) => {
                j.err(format!("{p}: {e}"));
                j.d.lock().locked.push(p.clone());
            }
        }
        j.d.lock().files_done += 1;
        emit(j);
    }
    j.d.lock().undo = json!({ "type": "trashed", "paths": done });
    Ok(())
}

pub fn control(a: &Args) -> R {
    let id = a.u(0, 0);
    let action = a.s_or(1, "");
    let Some(j) = ops().lock().jobs.get(&id).cloned() else { return Ok(json!(false)) };
    match action.as_str() {
        "pause" => j.paused.store(true, Ordering::SeqCst),
        "resume" => j.paused.store(false, Ordering::SeqCst),
        "cancel" => {
            j.cancelled.store(true, Ordering::SeqCst);
            j.paused.store(false, Ordering::SeqCst);
            let mut d = j.d.lock();
            if d.status == "queued" { d.status = "cancelled".into() }
        }
        "dismiss" => {
            let st = j.d.lock().status.clone();
            if !matches!(st.as_str(), "running" | "queued" | "waiting") {
                let mut o = ops().lock();
                o.jobs.remove(&id);
                o.order.retain(|x| *x != id);
                return Ok(json!(true));
            }
        }
        "prioritize" => {
            let mut o = ops().lock();
            if let Some(i) = o.queue.iter().position(|x| *x == id) {
                let v = o.queue.remove(i);
                o.queue.insert(0, v);
            }
            let qs: Vec<Arc<Job>> = o.queue.iter().filter_map(|q| o.jobs.get(q).cloned()).collect();
            drop(o);
            for q in qs { emit(&q) }
        }
        "retry" | "retryAll" => {
            let failed = j.d.lock().failed.clone();
            let sources = if action == "retry" && !failed.is_empty() { failed } else { j.sources.clone() };
            let mut spec = j.spec.clone();
            spec["sources"] = json!(sources);
            let t = j.d.lock().title.clone();
            spec["title"] = json!(format!("Retry: {}", t.trim_start_matches("Retry: ")));
            {
                let mut o = ops().lock();
                o.jobs.remove(&id);
                o.order.retain(|x| *x != id);
            }
            events::to_main("ops:removed", json!({ "id": id }));
            return Ok(json!(start(spec)));
        }
        _ => {}
    }
    emit_now(&j);
    Ok(json!(true))
}
pub fn list() -> R {
    let o = ops().lock();
    let js: Vec<Arc<Job>> = o.order.iter().filter_map(|id| o.jobs.get(id).cloned()).collect();
    drop(o);
    Ok(json!(js.iter().map(|j| public(j)).collect::<Vec<_>>()))
}
