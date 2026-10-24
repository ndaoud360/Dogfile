//! The assistant's model run by llama.cpp's own server program (llama-server, from the official llama.cpp releases).
//!
//! Those builds are made with clang and OpenMP and pick the best code for the processor when they start. The copy of
//! llama.cpp compiled into Dogfile (MSVC, no OpenMP) measured several times slower on Intel hybrid processors, where
//! its threads wait on the slow cores. So when llama-server is there (it ships in Dogfile's folder, or is downloaded
//! once into the models folder), the worker in llm.rs hands requests to it; otherwise the built-in engine runs.
//!
//! The long fixed part of the prompt is read once: a warm-up request ends four tokens past it, which makes the server
//! keep a checkpoint right at its end (the model's memory can't be rewound otherwise), and the slot is saved to disk so
//! the next start restores it instead of reading it again. Each request then reads only its own few lines.
//! The server listens on 127.0.0.1 only, on a free port, and dies with Dogfile (a Windows job object).
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use crate::llm::Job;

#[cfg(windows)]
const EXE: &str = "llama-server.exe";
#[cfg(not(windows))]
const EXE: &str = "llama-server";

/// where llama-server is: DOGFILE_LLAMA_SERVER, Dogfile's llama/ folder, or the copy downloaded into the models folder
pub fn find() -> Option<PathBuf> {
    if std::env::var("DOGFILE_LLAMA_OFF").is_ok() {
        return None;
    }
    if let Ok(p) = std::env::var("DOGFILE_LLAMA_SERVER") {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let mut c = vec![];
    if let Some(s) = crate::try_st() {
        c.push(s.res_dir.join("llama").join(EXE));
    }
    if crate::try_st().is_some() || std::env::var("ATLAS_MODELS_DIR").is_ok() {
        c.push(downloaded_dir().join(EXE));
    }
    c.into_iter().find(|p| p.is_file())
}
pub fn downloaded_dir() -> PathBuf {
    crate::ai::models_dir().join("llama-server")
}

/// Download llama-server once when Dogfile's folder doesn't have it (a copy updated without the llama/ folder). The
/// address and checksum come from the build (CI fetched the same files for the setup program). Returns true when a new
/// copy is in place.
pub async fn fetch_if_missing() -> Result<bool, String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    static BUSY: AtomicBool = AtomicBool::new(false);
    let (Some(url), Some(sha)) = (option_env!("DOGFILE_LLAMA_URL"), option_env!("DOGFILE_LLAMA_SHA256")) else { return Ok(false) };
    if find().is_some() || BUSY.swap(true, Ordering::SeqCst) {
        return Ok(false);
    }
    let r = async {
        let bytes = crate::util::http().get(url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.bytes().await.map_err(|e| e.to_string())?;
        use sha2::{Digest, Sha256};
        let got: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        if got != sha {
            return Err("llama-server download didn't match its checksum".to_string());
        }
        let dir = downloaded_dir();
        let tmp = dir.with_extension("part");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).map_err(|e| e.to_string())?;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
            let name = f.name().rsplit(['/', '\\']).next().unwrap_or("").to_string();
            let lower = name.to_lowercase();
            if f.is_dir() || !(lower.ends_with(".dll") || lower == EXE) {
                continue;
            }
            let mut out = std::fs::File::create(tmp.join(&name)).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
        }
        if !tmp.join(EXE).is_file() {
            return Err("llama-server wasn't in the download".to_string());
        }
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::rename(&tmp, &dir).map_err(|e| e.to_string())?;
        Ok(true)
    }
    .await;
    BUSY.store(false, Ordering::SeqCst);
    r
}

// ---------------------------------------------------------------------------------------------------------------
// the server process
struct Server {
    child: Child,
    port: u16,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// processor cores to use: the fast ones on hybrid processors (Intel 12th gen and later), else the physical cores; at most 8
pub fn threads() -> i32 {
    if let Some(n) = std::env::var("BRAIN_THREADS").ok().and_then(|v| v.split(',').next().and_then(|x| x.trim().parse::<i32>().ok())) {
        return n.max(1);
    }
    let n = fast_cores().unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(4));
    (n as i32).clamp(2, 8)
}
#[cfg(windows)]
fn fast_cores() -> Option<usize> {
    let mut len = 0u32;
    unsafe {
        win::GetLogicalProcessorInformationEx(0, std::ptr::null_mut(), &mut len);
    }
    if len == 0 || len > 1 << 20 {
        return None;
    }
    let mut buf = vec![0u8; len as usize];
    if unsafe { win::GetLogicalProcessorInformationEx(0, buf.as_mut_ptr(), &mut len) } == 0 {
        return None;
    }
    // entries: Relationship (u32), Size (u32), then PROCESSOR_RELATIONSHIP { Flags (u8), EfficiencyClass (u8), … }
    let mut classes = vec![];
    let mut i = 0usize;
    while i + 10 <= len as usize {
        let size = u32::from_le_bytes([buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]]) as usize;
        if size == 0 {
            break;
        }
        classes.push(buf[i + 9]);
        i += size;
    }
    let top = *classes.iter().max()?;
    let n = classes.iter().filter(|&&c| c == top).count();
    (n > 0).then_some(n)
}
#[cfg(not(windows))]
fn fast_cores() -> Option<usize> {
    None
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

fn start(exe: &Path, model: &Path, state_dir: &Path, n_ctx: u32, status: &dyn Fn(&str)) -> Result<Server, String> {
    let port = free_port()?;
    let t = threads();
    let slots = state_dir.join("slots");
    let _ = std::fs::create_dir_all(&slots);
    let log = state_dir.join("llama-server.log");
    let out = std::fs::File::create(&log).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.arg("-m").arg(model)
        .args(["--host", "127.0.0.1", "--port", &port.to_string()])
        .args(["-c", &n_ctx.to_string(), "-np", "1", "-t", &t.to_string(), "-tb", &t.to_string()])
        .args(["--cache-ram", "0", "--no-webui"])
        .arg("--slot-save-path").arg(&slots)
        .stdin(Stdio::null()).stdout(Stdio::from(out)).stderr(Stdio::from(err));
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // no console window
    }
    let child = cmd.spawn().map_err(|e| format!("llama-server didn't start: {e}"))?;
    #[cfg(windows)]
    win::adopt(&child);
    status(&format!("server: {} | threads {t} | port {port}", exe.display()));
    let mut s = Server { child, port };
    // ready when /health answers 200 (503 while the model loads)
    let t0 = Instant::now();
    loop {
        if let Ok(Some(code)) = s.child.try_wait() {
            return Err(format!("llama-server stopped ({code}): {}", log_tail(&log)));
        }
        if let Ok((200, _)) = http(s.port, "GET", "/health", None, Duration::from_secs(5)) {
            return Ok(s);
        }
        if t0.elapsed() > Duration::from_secs(180) {
            let _ = s.child.kill();
            return Err(format!("llama-server didn't get ready: {}", log_tail(&log)));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn log_tail(p: &Path) -> String {
    let s = std::fs::read_to_string(p).unwrap_or_default();
    let lines: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(4)..].join(" | ")
}

// ---------------------------------------------------------------------------------------------------------------
// a small HTTP/1.1 client (the server is on this PC; one request per connection)
fn http(port: u16, method: &str, path: &str, body: Option<&Value>, timeout: Duration) -> Result<(u16, Value), String> {
    let mut s = TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_secs(3)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(timeout)).ok();
    s.set_write_timeout(Some(Duration::from_secs(30))).ok();
    let b = body.map(|b| b.to_string()).unwrap_or_default();
    let req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", b.len());
    s.write_all(req.as_bytes()).and_then(|_| s.write_all(b.as_bytes())).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").ok_or("bad answer from llama-server")?;
    let head = String::from_utf8_lossy(&buf[..split]).to_string();
    let code: u16 = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let mut body = buf[split + 4..].to_vec();
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        body = dechunk(&body);
    }
    let v = serde_json::from_slice(&body).unwrap_or_else(|_| json!({ "text": String::from_utf8_lossy(&body) }));
    Ok((code, v))
}
fn dechunk(b: &[u8]) -> Vec<u8> {
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        let Some(e) = b[i..].windows(2).position(|w| w == b"\r\n") else { break };
        let n = usize::from_str_radix(String::from_utf8_lossy(&b[i..i + e]).trim().split(';').next().unwrap_or("0"), 16).unwrap_or(0);
        i += e + 2;
        if n == 0 || i + n > b.len() {
            break;
        }
        out.extend_from_slice(&b[i..i + n]);
        i += n + 2;
    }
    out
}
fn post(port: u16, path: &str, body: Value, timeout: Duration) -> Result<Value, String> {
    let (code, v) = http(port, "POST", path, Some(&body), timeout)?;
    if code != 200 {
        let msg = v["error"]["message"].as_str().or(v["text"].as_str()).unwrap_or("").to_string();
        return Err(format!("llama-server {path}: {code} {msg}"));
    }
    Ok(v)
}
fn tokenize(port: u16, text: &str) -> Result<Vec<i64>, String> {
    let v = post(port, "/tokenize", json!({ "content": text, "add_special": false, "parse_special": true }), Duration::from_secs(60))?;
    v["tokens"].as_array().map(|a| a.iter().filter_map(|t| t.as_i64()).collect()).ok_or_else(|| "llama-server /tokenize: no tokens".to_string())
}

// ---------------------------------------------------------------------------------------------------------------
/// Run the model through llama-server until the channel closes (same jobs and answers as llm::serve).
pub fn serve(exe: &Path, model: &Path, state_dir: &Path, rx: &Receiver<Job>, status: &dyn Fn(&str)) -> Result<(), String> {
    status("loading");
    let n_ctx = crate::llm::N_CTX;
    let srv = start(exe, model, state_dir, n_ctx, status)?;
    let port = srv.port;
    let grammar = crate::llm::grammar()?;
    let sys = crate::llm::system_prompt();
    let sys_toks = tokenize(port, &sys)?;
    // four tokens past the fixed part (the start of every request), so the server checkpoints the end of the fixed part
    let pad = tokenize(port, "<|im_start|>user\nRequest:")?;
    let mut warm: Vec<i64> = sys_toks.clone();
    warm.extend(pad.iter().cycle().take(4));
    let meta = std::fs::metadata(exe).map(|m| format!("{}-{:?}", m.len(), m.modified().ok())).unwrap_or_default();
    let slot_file = format!("brain-{}.bin", crate::llm::hash(&format!("{}|{}|{}|{}", model.display(), sys, meta, n_ctx)));
    let slots = state_dir.join("slots");
    let mut ready = false;
    if slots.join(&slot_file).is_file() {
        match post(port, "/slots/0?action=restore", json!({ "filename": slot_file }), Duration::from_secs(60)) {
            Ok(v) if v["n_restored"].as_u64() == Some(warm.len() as u64) => ready = true,
            _ => {}
        }
    }
    if !ready {
        status("reading");
        let _ = post(port, "/slots/0?action=erase", json!({}), Duration::from_secs(10));
        post(port, "/completion", json!({ "prompt": warm, "n_predict": 1, "cache_prompt": true, "temperature": 0.0 }), Duration::from_secs(900))?;
        // old saves (another model, prompt or server) go
        if let Ok(rd) = std::fs::read_dir(&slots) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with("brain-") && name != slot_file {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        let _ = post(port, "/slots/0?action=save", json!({ "filename": slot_file }), Duration::from_secs(60));
    }
    status("ready");

    while let Ok(job) = rx.recv() {
        let t0 = Instant::now();
        let r = (|| -> Result<Value, String> {
            let mut toks = sys_toks.clone();
            let req = tokenize(port, &crate::llm::request_prompt(&job.context))?;
            if toks.len() + req.len() + crate::llm::MAX_OUT > n_ctx as usize {
                return Err("That request is too long for the assistant".into());
            }
            toks.extend(&req);
            let v = post(port, "/completion", json!({
                "prompt": toks, "grammar": grammar, "n_predict": crate::llm::MAX_OUT, "cache_prompt": true,
                "temperature": 0.0, "top_k": 1, "stream": false,
            }), Duration::from_secs(240))?;
            let text = v["content"].as_str().unwrap_or("").to_string();
            let plan: Value = serde_json::from_str(text.trim()).map_err(|e| format!("The assistant gave an answer that couldn't be read ({e})"))?;
            let tm = &v["timings"];
            Ok(json!({ "plan": plan, "ms": t0.elapsed().as_millis() as u64, "tokensIn": req.len(), "tokensOut": tm["predicted_n"],
                "timing": { "engine": "llama-server", "readMs": tm["prompt_ms"], "read": tm["prompt_n"], "cached": tm["cache_n"], "decodeMs": tm["predicted_ms"] } }))
        })();
        if r.is_err() {
            // the server died: report it, and let the next request start a fresh one
            if let Ok((200, _)) = http(port, "GET", "/health", None, Duration::from_secs(3)) {
            } else {
                let _ = job.reply.send(r);
                return Err("The assistant stopped; try again".into());
            }
        }
        let _ = job.reply.send(r);
    }
    drop(srv);
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *const c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(job: *mut c_void, class: i32, info: *const c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn SetPriorityClass(process: *mut c_void, class: u32) -> i32;
        fn SetProcessInformation(process: *mut c_void, class: i32, info: *const c_void, len: u32) -> i32;
        pub fn GetLogicalProcessorInformationEx(rel: i32, buf: *mut u8, len: *mut u32) -> i32;
    }
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        per_process_user_time: i64,
        per_job_user_time: i64,
        limit_flags: u32,
        min_ws: usize,
        max_ws: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: [u64; 6],
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    struct Job(*mut c_void);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    /// one job for Dogfile's lifetime: when Dogfile ends (even if it crashes) Windows ends the server with it
    fn job() -> Option<*mut c_void> {
        static J: OnceLock<Option<Job>> = OnceLock::new();
        J.get_or_init(|| unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let mut info = ExtendedLimits::default();
            info.basic.limit_flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            SetInformationJobObject(h, 9, &info as *const _ as *const c_void, std::mem::size_of::<ExtendedLimits>() as u32);
            Some(Job(h))
        })
        .as_ref()
        .map(|j| j.0)
    }
    pub fn adopt(child: &std::process::Child) {
        let h = child.as_raw_handle() as *mut c_void;
        unsafe {
            if let Some(j) = job() {
                AssignProcessToJobObject(j, h);
            }
            SetPriorityClass(h, 0x8000); // above normal: answers come back while other programs are busy
            // no power throttling (Windows 11 otherwise moves it onto the slow cores when Dogfile isn't in front)
            let st: [u32; 3] = [1, 1, 0];
            SetProcessInformation(h, 4, st.as_ptr() as *const c_void, 12);
        }
    }
}
