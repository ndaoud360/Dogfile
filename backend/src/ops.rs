// The file-operation queue: copy / move / delete / recycle / extract / compress / archive edits, in the background,
// with progress, speed, pause, cancel, "what to do about this name clash" questions, retries and undo records.
use crate::args::{Args, R};
use crate::util::{self, basename, is_inside, same_path, same_volume};
use crate::{archive, events, setting, setting_bool, st};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
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
    /// recycling: items on a drive without a Recycle Bin, left alone so the person can decide
    pub nobin: Vec<String>,
    /// copies and moves: what the drive at the other end is connected through (USB speed, Thunderbolt…), if known
    pub link: Value,
    /// when the speed was last worked out, and how much was done then
    speed_mark: Option<(Instant, u64)>,
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
        let mut d = self.d.lock();
        d.done += n;
        // the speed, about every 0.7 s and smoothed a little, so it also moves during one big file
        let now = Instant::now();
        match d.speed_mark {
            None => d.speed_mark = Some((now, d.done - n)),
            Some((t, before)) if now.duration_since(t) >= Duration::from_millis(700) => {
                let sp = d.done.saturating_sub(before) as f64 / now.duration_since(t).as_secs_f64();
                d.speed = if d.speed > 0.0 { d.speed * 0.5 + sp * 0.5 } else { sp };
                d.speed_mark = Some((now, d.done));
            }
            _ => {}
        }
        drop(d);
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
    /// fast transfers: big files unbuffered, small files several at a time
    fast: bool,
    /// how many small files are copied at once with fast transfers (on SSDs and network drives)
    workers: usize,
    /// read every copy back and compare it with the original before it takes its name
    verify: bool,
}
fn cfg() -> &'static Mutex<Cfg> {
    static C: OnceLock<Mutex<Cfg>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Cfg { parallel: 2, sequential: false, throttle_mbps: 0.0, network_queue: true, fast: true, workers: 8, verify: false }))
}
pub fn configure_from_settings() {
    let mut c = cfg().lock();
    c.sequential = setting_bool("sequentialOps", false);
    c.throttle_mbps = setting("throttleMBps").as_f64().unwrap_or(0.0);
    c.network_queue = true;
    c.fast = setting_bool("fastTransfers", true);
    c.verify = setting_bool("verifyCopies", false);
}
pub fn configure(a: &Args) -> R {
    let s = a.v(0);
    let mut c = cfg().lock();
    if let Some(v) = s["sequential"].as_bool() { c.sequential = v }
    if let Some(v) = s["throttle"].as_f64() { c.throttle_mbps = v }
    if let Some(v) = s["parallel"].as_u64() { c.parallel = v.max(1) as usize }
    if let Some(v) = s["fast"].as_bool() { c.fast = v }
    if let Some(v) = s["workers"].as_u64() { c.workers = v.clamp(1, 32) as usize }
    if let Some(v) = s["verify"].as_bool() { c.verify = v }
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
        "queuePos": queue_pos, "noRecycleBin": d.nobin, "link": d.link, "quiet": j.spec["quiet"].as_bool().unwrap_or(false),
    })
}

static EMIT_PENDING: AtomicBool = AtomicBool::new(false);
pub fn emit(j: &Job) {
    j.d.lock().dirty = true;
    if crate::try_st().is_none() {
        return; // tests run jobs without the app around them
    }
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
    if crate::try_st().is_none() {
        return;
    }
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
            // the PC doesn't fall asleep in the middle of a copy (the screen may still turn off)
            let _awake = KeepAwake::new();
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

/// while a job runs on this thread, Windows doesn't put the PC to sleep for being idle
struct KeepAwake;
impl KeepAwake {
    fn new() -> Self {
        #[cfg(windows)]
        unsafe {
            use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
        }
        KeepAwake
    }
}
impl Drop for KeepAwake {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}
/// copies, moves and other file work still running or waiting (closing the last window waits for them)
pub fn busy() -> bool {
    let o = ops().lock();
    o.running > 0 || !o.queue.is_empty()
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
    // keep the last 200 finished operations (each holds its whole file list); older ones are forgotten
    let mut o = ops().lock();
    let finished: Vec<u64> = o.order.iter().copied().filter(|id| o.jobs.get(id).map(|x| matches!(x.d.lock().status.as_str(), "done" | "error" | "cancelled")).unwrap_or(true)).collect();
    if finished.len() > 200 {
        for id in &finished[..finished.len() - 200] {
            o.jobs.remove(id);
        }
        let keep: std::collections::HashSet<u64> = o.jobs.keys().copied().collect();
        o.order.retain(|id| keep.contains(id));
    }
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
    util::remove_any(p)
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

/// Copy one file to `dst`. The data goes into a work file beside it first and only takes the real name once it's
/// complete, so a cancel, a full disk or a crash never leaves a half-copied file under the real name, and a file
/// being replaced stays intact until its replacement is whole. `replace`: whether something at `dst` may be replaced.
fn copy_file(j: &Job, src: &Path, dst: &Path, size: u64, replace: bool) -> JR {
    let work = util::temp_beside(dst, "copy");
    let r = copy_bytes(j, src, &work, size);
    if let Err(e) = r {
        let _ = std::fs::remove_file(&work);
        return Err(e);
    }
    // "check every copy": the copy is read back and compared with the original before it gets its name (and, for a
    // move, before the original goes)
    if cfg().lock().verify {
        match same_contents(j, src, &work) {
            Ok(true) => {}
            Ok(false) => {
                let _ = std::fs::remove_file(&work);
                return Err(Err("The copy didn't match the original when it was checked, so it was removed. The original is untouched".into()));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&work);
                return Err(e);
            }
        }
    }
    // a read-only original makes a read-only copy (as Windows' own copy does), set once the copy has its name
    let ro = std::fs::metadata(src).map(|m| m.permissions().readonly()).unwrap_or(false);
    if ro {
        util::set_readonly(&work, false);
    }
    let placed = if replace { util::replace_file(&work, dst) } else { util::rename_noreplace(&work, dst) };
    if placed.is_ok() {
        util::set_readonly(dst, ro);
    }
    placed.map_err(|e| {
        let _ = std::fs::remove_file(&work);
        if e.kind() == std::io::ErrorKind::AlreadyExists || e.raw_os_error() == Some(183) || e.raw_os_error() == Some(80) {
            Err("Something with this name appeared there while copying; nothing was replaced".to_string())
        } else {
            Err(crate::fsx::friendly(&e))
        }
    })
}
/// free space and file system of the destination
fn dest_space(dest: &Path) -> Option<(u64, String)> {
    #[cfg(windows)]
    return crate::win::space_and_fs(dest);
    #[cfg(unix)]
    {
        let (total, free) = crate::sys::statvfs(&dest.to_string_lossy());
        if total == 0 { None } else { Some((free, String::new())) }
    }
}
/// why these files can't go to `dest` (not enough free space, or a file too big for a FAT32 drive), before copying
fn room_problem(dest: &Path, entries: &[Entry]) -> Option<String> {
    let (avail, fs) = dest_space(dest)?;
    if fs.eq_ignore_ascii_case("FAT32") || fs.eq_ignore_ascii_case("FAT") {
        if let Some(e) = entries.iter().find(|e| !e.dir && e.size >= 4u64 << 30) {
            return Some(format!(
                "{} is {}, and the destination drive uses FAT32, which can't hold files of 4 GB or more. Nothing was copied. Reformat the drive as exFAT or NTFS (it erases it), or use another drive",
                e.src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                util::human_size(e.size)
            ));
        }
    }
    // only what will really be written: files already there with the same name aren't counted twice
    let need: u64 = entries.iter().filter(|e| !e.dir && !util::exists(&e.dst)).map(|e| e.size).sum();
    if need > avail {
        return Some(format!("Not enough free space: this needs {}, and the destination has {} free. Nothing was copied", util::human_size(need), util::human_size(avail)));
    }
    None
}
/// byte-for-byte comparison of two files (the copy check)
fn same_contents(j: &Job, a: &Path, b: &Path) -> Result<bool, Result<Cancelled, String>> {
    use std::io::Read;
    let open = |p: &Path| std::fs::File::open(p).map_err(|e| Err(crate::fsx::friendly(&e)));
    let (mut fa, mut fb) = (open(a)?, open(b)?);
    if fa.metadata().map(|m| m.len()).ok() != fb.metadata().map(|m| m.len()).ok() {
        return Ok(false);
    }
    let (mut ba, mut bb) = (vec![0u8; 4 << 20], vec![0u8; 4 << 20]);
    loop {
        if j.checkpoint().is_err() {
            return Err(Ok(Cancelled));
        }
        let n = read_full(&mut fa, &mut ba).map_err(|e| Err(crate::fsx::friendly(&e)))?;
        let m = read_full(&mut fb, &mut bb).map_err(|e| Err(crate::fsx::friendly(&e)))?;
        if n != m || ba[..n] != bb[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
    fn read_full(f: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut got = 0;
        while got < buf.len() {
            let n = f.read(&mut buf[got..])?;
            if n == 0 { break }
            got += n;
        }
        Ok(got)
    }
}
/// from this size up, fast transfers copy to USB drives and memory cards without Windows' file cache
const BIG_FILE: u64 = 256 << 20;
/// up to this size, files that aren't at the destination yet are copied several at a time
const SMALL_FILE: u64 = 16 << 20;

/// the bytes of one file, with progress, pause, cancel and the speed limit
/// a USB drive, memory card or other removable drive
#[cfg(windows)]
fn to_external(dst: &Path) -> bool {
    let p = dst.to_string_lossy();
    if !crate::win::has_recycle_bin(&p) && !p.starts_with("\\\\") {
        return true; // removable (USB stick, memory card)
    }
    crate::win::link::drive_link(&p).map(|v| v["external"] == true).unwrap_or(false)
}
fn copy_bytes(j: &Job, src: &Path, dst: &Path, size: u64) -> JR {
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
        // Big files skip Windows' file cache only on the way to a USB drive or memory card: there the progress bar
        // then shows what has really reached the drive, so "done" means it can be unplugged. Between internal drives
        // the cache is faster (File Explorer uses it too: the copy is done as soon as Windows has it, and Windows
        // finishes writing in the background), and measured on CI, skipping it made a 3 GB copy 2-12x slower.
        let unbuffered = cfg().lock().fast && size >= BIG_FILE && to_external(dst);
        return crate::win::copy_file_progress(j, src, dst, size, unbuffered);
    }
    use std::io::{Read, Write};
    let mut r = std::fs::File::open(src).map_err(|e| Err(crate::fsx::friendly(&e)))?;
    let mut w = std::fs::OpenOptions::new().write(true).create_new(true).open(dst).map_err(|e| Err(crate::fsx::friendly(&e)))?;
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
    w.sync_all().map_err(|e| Err(crate::fsx::friendly(&e)))?;
    Ok(())
}

/// What each answer to "this name is already there" means. Only "replace" (and "newer" when the incoming file is
/// newer) ever replaces anything; any other or unknown answer leaves the existing item alone.
fn decide(a: &str, src_size: u64, src_mtime: f64, dst: &Path) -> Clash {
    let dmd = std::fs::metadata(dst).ok();
    let dm = dmd.as_ref().map(|m| util::ms(m.modified())).unwrap_or(0.0);
    match a {
        "replace" | "overwrite" => Clash::Replace,
        "keepBoth" => Clash::KeepBoth,
        "skipIdentical" if dmd.as_ref().map(|m| m.len()) == Some(src_size) && (dm - src_mtime).abs() < 2000.0 => Clash::Skip,
        "skipIdentical" => Clash::Replace,
        "newer" if src_mtime > dm => Clash::Replace,
        _ => Clash::Skip,
    }
}
#[derive(PartialEq)]
enum Clash {
    Skip,
    Replace,
    KeepBoth,
}

/// Same-drive move of one whole item onto a name that's taken, replacing what's there: the existing item is first
/// renamed aside, so if the move fails it goes straight back and nothing is lost.
fn move_replacing(src: &str, dst: &str) -> Result<(), String> {
    let (sd, dd) = (std::fs::symlink_metadata(src).map(|m| m.is_dir()).unwrap_or(false), std::fs::symlink_metadata(dst).map(|m| m.is_dir()).unwrap_or(false));
    if sd != dd {
        return Err(if dd { "A folder with this name is already there".into() } else { "A file with this name is already there".into() });
    }
    let aside = util::temp_beside(Path::new(dst), "old");
    std::fs::rename(dst, &aside).map_err(|e| crate::fsx::friendly(&e))?;
    match util::rename_noreplace(Path::new(src), Path::new(dst)) {
        Ok(()) => {
            let _ = rm_any(&aside);
            Ok(())
        }
        Err(e) => {
            let msg = crate::fsx::friendly(&e);
            // the file that was there must go back; if it can't, say where it is rather than leave it hidden
            match std::fs::rename(&aside, dst) {
                Ok(()) => Err(msg),
                Err(back) => Err(format!("{msg}. The file that was there couldn't be put back ({}); it is kept as {}", crate::fsx::friendly(&back), aside.display())),
            }
        }
    }
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
            j.err(format!("{src}: Can't put \"{name}\" inside itself"));
            continue;
        }
        if !util::exists(Path::new(src)) {
            j.err(format!("{src}: It isn't there any more"));
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
            let mut replace = false;
            if util::exists(Path::new(&dst)) {
                let sd = std::fs::metadata(&src).map(|m| m.is_dir()).unwrap_or(false);
                let dd = std::fs::metadata(&dst).map(|m| m.is_dir()).unwrap_or(false);
                if sd && dd { slow.push((src, dst)); continue } // merge folders file by file
                let a = ask_conflict(j, &src, &dst)?;
                let smd = std::fs::metadata(&src).ok();
                match decide(&a, smd.as_ref().map(|m| m.len()).unwrap_or(0), smd.as_ref().map(|m| util::ms(m.modified())).unwrap_or(0.0), Path::new(&dst)) {
                    Clash::Skip => continue,
                    Clash::KeepBoth => dst = util::unique_name(&dest, &basename(&src), "number"),
                    Clash::Replace => replace = true,
                }
            }
            j.set_current(&basename(&src));
            let r = if replace { move_replacing(&src, &dst).map_err(Some) } else { util::rename_noreplace(Path::new(&src), Path::new(&dst)).map_err(|e| if e.raw_os_error() == Some(17) || e.raw_os_error() == Some(18) { None } else { Some(crate::fsx::friendly(&e)) }) };
            match r {
                Ok(()) => {
                    moved.push(json!([src, dst]));
                    j.d.lock().files_done += 1;
                }
                // on another volume after all (a drive mounted in a folder): copy, then remove the original
                Err(None) => slow.push((src, dst)),
                Err(Some(e)) => j.err(format!("{src}: {e}")),
            }
        } else {
            slow.push((src, dst0));
        }
    }
    if slow.is_empty() {
        j.d.lock().undo = json!({ "type": "moved", "pairs": moved });
        return Ok(());
    }
    // what each end is plugged in through (USB speed and so on), worked out while the folders are read
    let probe = {
        let (src0, dest0) = (slow.first().map(|x| x.0.clone()).unwrap_or_default(), dest.clone());
        std::thread::spawn(move || (drive_link(&src0), drive_link(&dest0)))
    };
    let mut entries: Vec<Entry> = vec![];
    for (s, d) in &slow {
        if j.is_cancelled() { break }
        if let Err(e) = walk(j, Path::new(s), Path::new(d), &mut entries) {
            j.err(e);
        }
    }
    emit_now(j);
    // before anything is written: is there room, and can the drive hold files this big? (a copy that fails at 90 %
    // because the disk is full, or because a USB stick formatted FAT32 can't take a 5 GB file, wastes everyone's time)
    if !j.is_cancelled() && !crate::demo::active() {
        if let Some(msg) = room_problem(Path::new(&dest), &entries) {
            return Err(Err(msg));
        }
    }
    let (src_link, dst_link) = probe.join().unwrap_or((None, None));
    let external = |l: &Option<Value>| l.as_ref().map(|v| v["external"].as_bool().unwrap_or(false)).unwrap_or(false);
    let shown = if external(&dst_link) { dst_link.clone().map(|mut v| { v["side"] = json!("to"); v }) } else if external(&src_link) { src_link.clone().map(|mut v| { v["side"] = json!("from"); v }) } else { None };
    if let Some(l) = shown {
        j.d.lock().link = l;
        emit(j);
    }
    // small files several at a time, except on spinning hard drives (they'd only seek back and forth)
    let rotating = [&src_link, &dst_link].iter().any(|l| l.as_ref().map(|v| v["rotating"].as_bool().unwrap_or(false)).unwrap_or(false));
    let workers = {
        let c = cfg().lock();
        if !c.fast || c.throttle_mbps > 0.0 || rotating || crate::demo::active() { 1 } else { c.workers }
    };
    let tops: Vec<PathBuf> = slow.iter().map(|(_, d)| PathBuf::from(d)).collect();
    let small_new = |e: &Entry| !e.dir && !e.link && e.size < SMALL_FILE && !tops.contains(&e.dst) && !util::exists(&e.dst);
    // moving: each original goes only once its copy is complete; anything skipped or failed stays where it was
    let mut moved_files = 0u64;
    let mut kept = 0u64;
    let mut stopped = false;
    let mut i = 0;
    while i < entries.len() {
        if j.checkpoint().is_err() {
            stopped = true;
            break;
        }
        // a run of small files that aren't at the destination yet: several at once (each still lands safely)
        if workers > 1 && small_new(&entries[i]) {
            let mut k = i;
            while k < entries.len() && k - i < 512 && small_new(&entries[k]) {
                k += 1;
            }
            if k - i >= 4 {
                let batch = &entries[i..k];
                for (e, r) in batch.iter().zip(copy_batch(j, batch, workers, is_move)) {
                    match r {
                        Ok(()) => { if is_move { moved_files += 1 } }
                        Err(Ok(_)) => stopped = true,
                        Err(Err(msg)) => {
                            if msg.contains("in use") || msg.contains("denied") {
                                j.d.lock().locked.push(e.src.to_string_lossy().into_owned());
                            }
                            j.err(format!("{}: {msg}", e.src.display()));
                        }
                    }
                }
                if stopped { break }
                i = k;
                continue;
            }
        }
        let e = &entries[i];
        i += 1;
        j.set_current(&e.src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        // Ok(true): in place at the destination; Ok(false): left alone (skipped)
        let res: Result<bool, Result<Cancelled, String>> = (|| {
            if e.dir {
                match std::fs::symlink_metadata(&e.dst) {
                    Ok(m) if m.is_dir() => {}
                    Ok(_) => return Err(Err("A file with this name is already there, so the folder couldn't go there".into())),
                    Err(_) => {
                        std::fs::create_dir_all(&e.dst).map_err(|er| Err(crate::fsx::friendly(&er)))?;
                        if tops.contains(&e.dst) { created.push(e.dst.to_string_lossy().into_owned()) }
                    }
                }
                return Ok(true);
            }
            let mut dst = e.dst.clone();
            let mut replace = false;
            if util::exists(&dst) {
                if std::fs::symlink_metadata(&dst).map(|m| m.is_dir()).unwrap_or(false) {
                    return Err(Err("A folder with this name is already there".into()));
                }
                let a = ask_conflict(j, &e.src.to_string_lossy(), &dst.to_string_lossy())?;
                match decide(&a, e.size, util::ms(Ok(e.mtime)), &dst) {
                    Clash::Skip => { j.add_done(e.size); j.d.lock().files_done += 1; return Ok(false) }
                    Clash::KeepBoth => dst = PathBuf::from(util::unique_name(&dst.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(), &dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), "number")),
                    Clash::Replace => replace = true,
                }
            }
            if e.link {
                // the link itself is copied, not what it points to
                let t = std::fs::read_link(&e.src).map_err(|er| Err(er.to_string()))?;
                if replace { let _ = rm_any(&dst); }
                #[cfg(unix)]
                std::os::unix::fs::symlink(&t, &dst).map_err(|er| Err(er.to_string()))?;
                #[cfg(windows)]
                {
                    let to_dir = std::fs::metadata(&e.src).map(|m| m.is_dir()).unwrap_or(false);
                    if to_dir { std::os::windows::fs::symlink_dir(&t, &dst) } else { std::os::windows::fs::symlink_file(&t, &dst) }.map_err(|er| Err(crate::fsx::friendly(&er)))?;
                }
            } else {
                copy_file(j, &e.src, &dst, e.size, replace)?;
                let _ = filetime::set_file_times(&dst, filetime::FileTime::from_system_time(e.atime), filetime::FileTime::from_system_time(e.mtime));
            }
            // a copy that replaced something isn't in the undo list: undoing it would remove the file and the older
            // version it replaced is gone, leaving neither
            if tops.contains(&e.dst) && !replace { created.push(dst.to_string_lossy().into_owned()) }
            j.d.lock().files_done += 1;
            Ok(true)
        })();
        match res {
            Ok(true) if is_move && !e.dir => {
                // the copy is complete and in place: now the original can go
                let r = rm_any(&e.src).or_else(|er| {
                    if er.kind() == std::io::ErrorKind::PermissionDenied { util::set_readonly(&e.src, false); rm_any(&e.src) } else { Err(er) }
                });
                match r {
                    Ok(()) => moved_files += 1,
                    Err(er) => j.err(format!("{}: copied, but the original couldn't be removed: {}", e.src.display(), crate::fsx::friendly(&er))),
                }
            }
            Ok(false) => kept += 1,
            Ok(_) => {}
            Err(Ok(_)) => { stopped = true; break }
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
    if is_move {
        // folders left empty by the move go too (deepest first); a folder that still has something in it stays
        for e in entries.iter().rev().filter(|e| e.dir) {
            let _ = std::fs::remove_dir(&e.src);
        }
        for (s, d) in &slow {
            if !util::exists(Path::new(s)) {
                moved.push(json!([s, d]));
            }
        }
        if kept > 0 {
            j.err(format!("{}: {kept} item{} that were already at the destination stayed where they were", slow.first().map(|x| util::dirname(&x.0)).unwrap_or_default(), if kept == 1 { "" } else { "s" }));
        }
        if stopped {
            let total = entries.iter().filter(|e| !e.dir).count();
            j.err(format!("{}: stopped after moving {moved_files} of {total} files; the rest are still where they were", slow.first().map(|x| util::dirname(&x.0)).unwrap_or_default()));
        }
        j.d.lock().undo = json!({ "type": "moved", "pairs": moved });
    } else {
        j.d.lock().undo = json!({ "type": "created", "paths": created });
    }
    if stopped { Err(cancelled()) } else { Ok(()) }
}

/// Copies small new files with several workers. Each file goes through `copy_file` like any other (work file, then
/// its real name, never replacing anything), and a move removes an original only once its copy is in place.
fn copy_batch(j: &Job, batch: &[Entry], workers: usize, is_move: bool) -> Vec<JR> {
    let next = AtomicUsize::new(0);
    let results: Vec<Mutex<Option<JR>>> = batch.iter().map(|_| Mutex::new(None)).collect();
    std::thread::scope(|s| {
        for _ in 0..workers.min(batch.len()) {
            s.spawn(|| loop {
                let n = next.fetch_add(1, Ordering::SeqCst);
                let Some(e) = batch.get(n) else { break };
                let r = if j.checkpoint().is_err() {
                    Err(cancelled())
                } else {
                    j.set_current(&e.src.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default());
                    copy_file(j, &e.src, &e.dst, e.size, false).and_then(|()| {
                        let _ = filetime::set_file_times(&e.dst, filetime::FileTime::from_system_time(e.atime), filetime::FileTime::from_system_time(e.mtime));
                        j.d.lock().files_done += 1;
                        if !is_move {
                            return Ok(());
                        }
                        let gone = rm_any(&e.src).or_else(|er| {
                            if er.kind() == std::io::ErrorKind::PermissionDenied { util::set_readonly(&e.src, false); rm_any(&e.src) } else { Err(er) }
                        });
                        gone.map_err(|er| Err(format!("copied, but the original couldn't be removed: {}", crate::fsx::friendly(&er))))
                    })
                };
                *results[n].lock() = Some(r);
            });
        }
    });
    results.into_iter().map(|m| m.into_inner().unwrap_or_else(|| Err(cancelled()))).collect()
}

/// what a drive is connected through (Windows); elsewhere nothing
fn drive_link(path: &str) -> Option<Value> {
    #[cfg(windows)]
    {
        if path.is_empty() || crate::demo::active() {
            return None;
        }
        std::panic::catch_unwind(|| crate::win::link::drive_link(path)).ok().flatten()
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

// ---------------- delete / recycle ----------------
fn del(j: &Arc<Job>) -> JR {
    j.d.lock().files_total = j.sources.len() as u64;
    for p in &j.sources {
        j.checkpoint().map_err(|_| cancelled())?;
        j.set_current(&basename(p));
        if util::protected_from_delete(p) {
            j.err(format!("{p}: Dogfile won't delete this folder for good. Delete what's inside it instead, or send it to the Recycle Bin."));
            j.d.lock().files_done += 1;
            continue;
        }
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
        // no Recycle Bin on this drive: Windows would delete it for good without asking, so it's left for the person
        // to decide (Dogfile offers to delete it permanently, with a warning)
        #[cfg(windows)]
        if !crate::win::has_recycle_bin(p) {
            j.err(format!("{p}: this drive has no Recycle Bin"));
            j.d.lock().nobin.push(p.clone());
            j.d.lock().files_done += 1;
            continue;
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn job(kind: &str, sources: Vec<String>, dest: Option<String>, conflict: &str) -> Arc<Job> {
        Arc::new(Job {
            id: 0,
            kind: kind.into(),
            sources,
            dest,
            opts: json!({ "conflict": conflict }),
            spec: json!({}),
            network: false,
            cancelled: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            d: Mutex::new(JobData { status: "running".into(), ..Default::default() }),
        })
    }
    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("dogfile-ops-test-{:x}", rand::random::<u64>()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn write(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }
    fn read(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap_or_else(|_| "<missing>".into())
    }
    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }
    fn no_work_files(dir: &Path) -> bool {
        walkdir(dir).iter().all(|p| !p.file_name().unwrap().to_string_lossy().starts_with("~$"))
    }
    fn walkdir(dir: &Path) -> Vec<PathBuf> {
        let mut out = vec![];
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            out.push(e.path());
            if e.path().is_dir() { out.extend(walkdir(&e.path())) }
        }
        out
    }

    // Moving a folder into one that already has some of the same files, answering "skip": the skipped originals must
    // stay where they were (they used to be deleted with the rest of the source folder).
    #[test]
    fn move_merge_with_skip_keeps_skipped_originals() {
        let t = tmp();
        let (a, b) = (t.join("a/photos"), t.join("b"));
        write(&a.join("one.txt"), "new one");
        write(&a.join("two.txt"), "new two");
        write(&b.join("photos/one.txt"), "old one");
        let j = job("move", vec![s(&a)], Some(s(&b)), "skip");
        // force the copy path (a merge), which is what a cross-drive move takes
        assert!(copy_move(&j).is_ok());
        assert_eq!(read(&b.join("photos/one.txt")), "old one");
        assert_eq!(read(&b.join("photos/two.txt")), "new two");
        assert_eq!(read(&a.join("one.txt")), "new one", "the skipped original was lost");
        assert!(!a.join("two.txt").exists(), "a moved original should be gone");
        assert!(no_work_files(&t));
        std::fs::remove_dir_all(&t).ok();
    }

    // Deleting a link removes only the link: a folder link must never get its target emptied.
    #[test]
    fn deleting_a_link_leaves_what_it_points_to() {
        let t = tmp();
        write(&t.join("real/keep.txt"), "keep");
        let link = t.join("link");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(t.join("real"), &link).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(t.join("real"), &link).is_ok();
        #[cfg(not(any(unix, windows)))]
        let made = false;
        // Windows only lets some accounts make links; there is nothing to check without one
        if made {
            assert!(util::remove_any(&link).is_ok());
            assert!(std::fs::symlink_metadata(&link).is_err(), "the link should be gone");
            assert_eq!(read(&t.join("real/keep.txt")), "keep", "deleting the link deleted what it points to");
        }
        std::fs::remove_dir_all(&t).ok();
    }

    // A copy that can't fit, or a 4 GB file headed for FAT32, is refused before anything is written.
    #[test]
    fn room_is_checked_before_copying() {
        let t = tmp();
        let e = |name: &str, size: u64| Entry { src: t.join(name), dst: t.join("out").join(name), dir: false, size, link: false, mtime: std::time::UNIX_EPOCH, atime: std::time::UNIX_EPOCH };
        assert!(room_problem(&t, &[e("small.txt", 10)]).is_none());
        let msg = room_problem(&t, &[e("huge.bin", u64::MAX / 4)]).expect("an impossible size must be refused");
        assert!(msg.starts_with("Not enough free space"), "{msg}");
        assert_eq!(util::human_size(5 << 30), "5.0 GB");
        std::fs::remove_dir_all(&t).ok();
    }

    // The copy check compares every byte: identical files pass, a file that differs anywhere fails.
    #[test]
    fn copy_check_compares_every_byte() {
        let t = tmp();
        let big: Vec<u8> = (0..(9u32 << 20)).map(|i| (i % 251) as u8).collect();
        std::fs::write(t.join("a.bin"), &big).unwrap();
        std::fs::write(t.join("b.bin"), &big).unwrap();
        let mut other = big.clone();
        other[(8 << 20) + 5] ^= 1;
        std::fs::write(t.join("c.bin"), &other).unwrap();
        let j = job("copy", vec![], None, "ask");
        assert!(matches!(same_contents(&j, &t.join("a.bin"), &t.join("b.bin")), Ok(true)));
        assert!(matches!(same_contents(&j, &t.join("a.bin"), &t.join("c.bin")), Ok(false)));
        // with the check on, a copy still lands whole
        cfg().lock().verify = true;
        let j2 = job("copy", vec![s(&t.join("a.bin"))], Some(s(&t.join("out"))), "ask");
        let r = copy_move(&j2);
        cfg().lock().verify = false;
        assert!(r.is_ok());
        assert_eq!(std::fs::read(t.join("out/a.bin")).unwrap(), big);
        assert!(no_work_files(&t));
        std::fs::remove_dir_all(&t).ok();
    }

    // Many small files go several at a time: every one arrives intact, in its folder, with nothing left over.
    #[test]
    fn many_small_files_copy_in_parallel() {
        let t = tmp();
        for i in 0..60 {
            write(&t.join(format!("src/pics/sub{}/f{i}.txt", i % 3)), &format!("file {i}"));
        }
        let j = job("copy", vec![s(&t.join("src/pics"))], Some(s(&t.join("dst"))), "ask");
        assert!(copy_move(&j).is_ok());
        for i in 0..60 {
            assert_eq!(read(&t.join(format!("dst/pics/sub{}/f{i}.txt", i % 3))), format!("file {i}"));
        }
        assert_eq!(j.d.lock().files_done, 60);
        assert!(j.d.lock().errors.is_empty(), "{:?}", j.d.lock().errors);
        assert!(no_work_files(&t));
        std::fs::remove_dir_all(&t).ok();
    }

    // Moving many small files into a folder that already has one of them, answering "skip": the parallel path must
    // leave the clashing file alone on both sides and move the rest.
    #[test]
    fn many_small_files_move_keeps_clashes() {
        let t = tmp();
        for i in 0..30 {
            write(&t.join(format!("a/docs/d{i}.txt"), ), &format!("new {i}"));
        }
        write(&t.join("b/docs/d7.txt"), "old 7");
        let j = job("move", vec![s(&t.join("a/docs"))], Some(s(&t.join("b"))), "skip");
        assert!(copy_move(&j).is_ok());
        assert_eq!(read(&t.join("b/docs/d7.txt")), "old 7");
        assert_eq!(read(&t.join("a/docs/d7.txt")), "new 7", "the skipped original was lost");
        for i in (0..30).filter(|i| *i != 7) {
            assert_eq!(read(&t.join(format!("b/docs/d{i}.txt"))), format!("new {i}"));
            assert!(!t.join(format!("a/docs/d{i}.txt")).exists(), "a moved original should be gone");
        }
        assert!(no_work_files(&t));
        std::fs::remove_dir_all(&t).ok();
    }

    // Replacing during a merge: the new content arrives and nothing half-written is left behind.
    #[test]
    fn copy_replace_puts_whole_file_in_place() {
        let t = tmp();
        write(&t.join("src/x.txt"), "fresh");
        write(&t.join("dst/x.txt"), "stale");
        let j = job("copy", vec![s(&t.join("src/x.txt"))], Some(s(&t.join("dst"))), "replace");
        assert!(copy_move(&j).is_ok());
        assert_eq!(read(&t.join("dst/x.txt")), "fresh");
        assert_eq!(read(&t.join("src/x.txt")), "fresh");
        assert!(no_work_files(&t));
        std::fs::remove_dir_all(&t).ok();
    }

    // A copy that can't complete (the source vanished) must leave an existing file it would have replaced untouched.
    #[test]
    fn failed_copy_never_destroys_the_file_it_would_replace() {
        let t = tmp();
        write(&t.join("dst/x.txt"), "keep me");
        let j = job("copy", vec![], Some(s(&t.join("dst"))), "replace");
        let r = copy_file(&j, &t.join("missing.txt"), &t.join("dst/x.txt"), 0, true);
        assert!(r.is_err());
        assert_eq!(read(&t.join("dst/x.txt")), "keep me");
        assert!(no_work_files(&t));
        std::fs::remove_dir_all(&t).ok();
    }

    // Same-drive move onto a taken name with "replace": done by moving the old one aside first.
    #[test]
    fn same_drive_move_replace() {
        let t = tmp();
        write(&t.join("a/x.txt"), "incoming");
        write(&t.join("b/x.txt"), "existing");
        let j = job("move", vec![s(&t.join("a/x.txt"))], Some(s(&t.join("b"))), "replace");
        assert!(copy_move(&j).is_ok());
        assert_eq!(read(&t.join("b/x.txt")), "incoming");
        assert!(!t.join("a/x.txt").exists());
        assert!(no_work_files(&t));
        std::fs::remove_dir_all(&t).ok();
    }

    // A file never replaces a folder of the same name (that used to remove the whole folder).
    #[test]
    fn file_never_replaces_a_folder() {
        let t = tmp();
        write(&t.join("a/thing"), "a file");
        write(&t.join("b/thing/inside.txt"), "precious");
        let j = job("move", vec![s(&t.join("a/thing"))], Some(s(&t.join("b"))), "replace");
        let _ = copy_move(&j);
        assert_eq!(read(&t.join("b/thing/inside.txt")), "precious");
        assert_eq!(read(&t.join("a/thing")), "a file");
        std::fs::remove_dir_all(&t).ok();
    }

    // An unknown answer to a name clash is treated as "skip", never as "replace".
    #[test]
    fn unknown_conflict_answer_skips() {
        let t = tmp();
        write(&t.join("a/x.txt"), "incoming");
        write(&t.join("b/x.txt"), "existing");
        let j = job("copy", vec![s(&t.join("a/x.txt"))], Some(s(&t.join("b"))), "something-else");
        assert!(copy_move(&j).is_ok());
        assert_eq!(read(&t.join("b/x.txt")), "existing");
        std::fs::remove_dir_all(&t).ok();
    }

    // "Keep both" gives the incoming file a new name and touches neither.
    #[test]
    fn keep_both() {
        let t = tmp();
        write(&t.join("a/x.txt"), "incoming");
        write(&t.join("b/x.txt"), "existing");
        let j = job("copy", vec![s(&t.join("a/x.txt"))], Some(s(&t.join("b"))), "keepBoth");
        assert!(copy_move(&j).is_ok());
        assert_eq!(read(&t.join("b/x.txt")), "existing");
        assert_eq!(read(&t.join("b/x (2).txt")), "incoming");
        std::fs::remove_dir_all(&t).ok();
    }

    // A folder can't go inside itself, and nothing is touched when that's asked.
    #[test]
    fn no_folder_inside_itself() {
        let t = tmp();
        write(&t.join("a/x.txt"), "x");
        let j = job("move", vec![s(&t.join("a"))], Some(s(&t.join("a/sub"))), "skip");
        let _ = copy_move(&j);
        assert_eq!(read(&t.join("a/x.txt")), "x");
        assert!(!j.d.lock().errors.is_empty());
        std::fs::remove_dir_all(&t).ok();
    }

    // Cancelling a move partway leaves every file either at the destination or still at the source, never lost.
    #[test]
    fn cancelled_move_loses_nothing() {
        let t = tmp();
        for i in 0..20 { write(&t.join(format!("a/f{i}.txt")), &format!("data {i}")); }
        write(&t.join("b/a/keep.txt"), "x"); // a merge, so it takes the file-by-file path
        let j = job("move", vec![s(&t.join("a"))], Some(s(&t.join("b"))), "skip");
        j.cancelled.store(true, Ordering::SeqCst);
        let _ = copy_move(&j);
        for i in 0..20 {
            let at_src = t.join(format!("a/f{i}.txt")).exists();
            let at_dst = t.join(format!("b/a/f{i}.txt")).exists();
            assert!(at_src || at_dst, "f{i} was lost");
        }
        assert!(no_work_files(&t));
        std::fs::remove_dir_all(&t).ok();
    }

    // Deleting for good refuses drive roots and the user's own folders.
    #[test]
    fn protected_folders() {
        assert!(util::protected_from_delete("/"));
        if let Some(h) = dirs::home_dir() {
            assert!(util::protected_from_delete(&h.to_string_lossy()));
        }
        assert!(!util::protected_from_delete(&s(&tmp())));
    }

    // Safe whole-file writes replace the content and leave no work file.
    #[test]
    fn write_atomic_replaces() {
        let t = tmp();
        let f = t.join("doc.txt");
        write(&f, "old");
        util::write_atomic(&f, b"new").unwrap();
        assert_eq!(read(&f), "new");
        assert!(no_work_files(&t));
        std::fs::remove_dir_all(&t).ok();
    }

    // Renaming never replaces something already there.
    #[test]
    fn rename_noreplace_refuses_taken_names() {
        let t = tmp();
        write(&t.join("a.txt"), "a");
        write(&t.join("b.txt"), "b");
        assert!(util::rename_noreplace(&t.join("a.txt"), &t.join("b.txt")).is_err());
        assert_eq!(read(&t.join("b.txt")), "b");
        assert_eq!(read(&t.join("a.txt")), "a");
        std::fs::remove_dir_all(&t).ok();
    }
}
