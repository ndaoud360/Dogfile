// Media through the bundled ffmpeg: reading details, converting video on the fly for the player, thumbnails,
// cover art, waveforms, PCM for BPM / key / speech, subtitles, exports (trim, convert…) and contact sheets.
use crate::args::{Args, R};
use crate::http::{Body, Req, Resp};
use crate::util::{self, basename};
use crate::{events, st};
use bytes::Bytes;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::io::AsyncReadExt;

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };
fn ff_dir() -> Option<PathBuf> {
    static D: OnceLock<Option<PathBuf>> = OnceLock::new();
    D.get_or_init(|| {
        let s = st();
        let plat = if cfg!(windows) { "win32" } else { "linux" };
        let mut c: Vec<PathBuf> = vec![];
        if let Ok(d) = std::env::var("ATLAS_FFMPEG_DIR") {
            c.push(PathBuf::from(d));
        }
        c.push(s.res_dir.join("ffmpeg"));
        c.push(s.res_dir.join("vendor").join("ffmpeg").join(plat));
        c.into_iter().find(|d| d.join(format!("ffmpeg{EXE}")).is_file())
    })
    .clone()
}
pub fn ffmpeg() -> PathBuf {
    ff_dir().map(|d| d.join(format!("ffmpeg{EXE}"))).unwrap_or_else(|| PathBuf::from("ffmpeg"))
}
fn ffprobe() -> PathBuf {
    ff_dir().map(|d| d.join(format!("ffprobe{EXE}"))).unwrap_or_else(|| PathBuf::from("ffprobe"))
}
pub fn available() -> bool {
    ff_dir().is_some() || util::which("ffmpeg").is_some()
}

pub async fn probe(file: &str) -> Result<Value, String> {
    let args: Vec<String> = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", file].iter().map(|s| s.to_string()).collect();
    let o = util::run(ffprobe(), &args, None, 20000).await.map_err(|e| format!("Could not read media: {e}"))?;
    if !o.ok {
        return Err(format!("Could not read media: {}", util::last_line(&o.err())));
    }
    serde_json::from_slice(&o.stdout).map_err(|e| e.to_string())
}
pub async fn probe_call(a: &Args) -> R {
    probe(&a.s(0)?).await
}
pub async fn quick_probe(a: &Args) -> R {
    let mut out = vec![];
    for p in a.strs(0).into_iter().take(64) {
        match probe(&p).await {
            Ok(i) => {
                let v = i["streams"].as_array().and_then(|ss| ss.iter().find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"].as_i64().unwrap_or(0) == 0)).cloned().unwrap_or(Value::Null);
                let rot = v["tags"]["rotate"].as_str().and_then(|r| r.parse::<i64>().ok()).or_else(|| v["side_data_list"].as_array().and_then(|l| l.iter().find_map(|d| d["rotation"].as_i64()))).unwrap_or(0).abs();
                let ac = i["streams"].as_array().and_then(|ss| ss.iter().find(|s| s["codec_type"] == "audio")).map(|s| s["codec_name"].as_str().unwrap_or("").to_string()).unwrap_or_default();
                out.push(json!({ "dur": i["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).unwrap_or(0.0), "w": v["width"].as_u64().unwrap_or(0), "h": v["height"].as_u64().unwrap_or(0), "rot": rot, "vcodec": v["codec_name"].as_str().unwrap_or(""), "acodec": ac }));
            }
            Err(_) => out.push(json!({})),
        }
    }
    Ok(json!(out))
}

// ---- the best H.264 encoder (GPU first), tested once ----
pub async fn best_encoder() -> String {
    static E: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    E.get_or_init(|| async {
        let order: &[&str] = if cfg!(windows) { &["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libx264"] } else { &["h264_nvenc", "libx264"] };
        for enc in order {
            let args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=s=320x240:d=0.2", "-c:v", enc, "-f", "null", "-"].iter().map(|s| s.to_string()).collect();
            if let Ok(o) = util::run(ffmpeg(), &args, None, 8000).await {
                if o.ok {
                    return enc.to_string();
                }
            }
        }
        "libx264".to_string()
    })
    .await
    .clone()
}
pub async fn best_encoder_call() -> R {
    Ok(json!(best_encoder().await))
}
fn enc_args(enc: &str) -> Vec<String> {
    let v: &[&str] = match enc {
        "h264_nvenc" => &["-c:v", "h264_nvenc", "-preset", "p3", "-tune", "ll", "-rc", "vbr", "-cq", "21", "-b:v", "0"],
        "h264_qsv" => &["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "22"],
        "h264_amf" => &["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22"],
        "h264_mf" => &["-c:v", "h264_mf", "-hw_encoding", "1", "-b:v", "14M"],
        _ => &["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"],
    };
    v.iter().map(|s| s.to_string()).collect()
}

fn procs() -> &'static Mutex<HashMap<u32, ()>> {
    static P: OnceLock<Mutex<HashMap<u32, ()>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn kill_all() {
    for pid in procs().lock().keys() {
        kill_pid(*pid);
    }
}
fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = util::std_cmd("taskkill.exe").args(["/PID", &pid.to_string(), "/F"]).status();
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

/// ffmpeg's output, as it's made
fn stream_process(args: Vec<String>) -> Body {
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(16);
    tokio::spawn(async move {
        let mut c = util::cmd(ffmpeg());
        c.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        let Ok(mut child) = c.spawn() else { return };
        let pid = child.id().unwrap_or(0);
        procs().lock().insert(pid, ());
        let mut out = child.stdout.take().unwrap();
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            match out.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(Bytes::copy_from_slice(&buf[..n])).await.is_err() {
                        break; // the player stopped listening
                    }
                }
            }
        }
        let _ = child.kill().await;
        procs().lock().remove(&pid);
    });
    Body::Stream(rx)
}
pub async fn run_buffer(args: &[String], timeout: u64) -> Option<Vec<u8>> {
    let o = util::run(ffmpeg(), args, None, timeout).await.ok()?;
    if o.stdout.is_empty() { None } else { Some(o.stdout) }
}
fn sv(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}
const CORS: [(&str, &str); 2] = [("Access-Control-Allow-Origin", "*"), ("Cache-Control", "no-store")];
fn img(ctype: &str, b: Option<Vec<u8>>, cache: &str) -> Resp {
    match b {
        Some(b) if !b.is_empty() => Resp::bytes(200, ctype, b).header("Cache-Control", cache),
        _ => Resp::bytes(404, "text/plain", vec![]),
    }
}

pub async fn handle(route: &str, req: &Req) -> Resp {
    let q = &req.query;
    let Some(file) = q.get("p").cloned() else { return Resp::text(400, "missing") };
    let qf = |k: &str, d: f64| q.get(k).and_then(|v| v.parse::<f64>().ok()).unwrap_or(d);
    match route {
        "stream" => {
            let ss = qf("ss", 0.0);
            let a = q.get("a").cloned();
            let vmode = q.get("v").cloned().unwrap_or("copy".into());
            let vcodec = q.get("vc").cloned().unwrap_or_default();
            let mut args = sv(&["-hide_banner", "-loglevel", "error", "-nostdin"]);
            let mut enc = String::new();
            if vmode == "enc" {
                enc = best_encoder().await;
                args.extend(sv(&["-hwaccel", "auto"]));
            }
            if ss > 0.0 {
                args.extend(["-ss".into(), ss.to_string()]);
            }
            args.extend(["-i".into(), file.clone()]);
            if vmode != "none" {
                args.extend(sv(&["-map", "0:V:0?"]));
            }
            let a_none = a.as_deref() == Some("none");
            if !a_none {
                args.extend(["-map".into(), format!("0:a:{}?", a.clone().filter(|x| !x.is_empty()).unwrap_or("0".into()))]);
            }
            args.extend(sv(&["-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1"]));
            if vmode == "copy" {
                args.extend(sv(&["-c:v", "copy"]));
                if vcodec == "hevc" {
                    args.extend(sv(&["-tag:v", "hvc1"]));
                }
            } else if vmode == "enc" {
                args.extend(enc_args(&enc));
                let soft = enc == "libx264";
                args.extend(["-vf".into(), if soft { "scale='min(1920,iw)':-2:flags=fast_bilinear,format=yuv420p".into() } else { "format=yuv420p".to_string() }]);
                args.extend(sv(&["-g", "60", "-bf", "0"]));
            }
            if !a_none {
                args.extend(sv(&["-c:a", "aac", "-b:a", "384k", "-af", "aresample=async=1:first_pts=0"]));
            }
            args.extend(sv(&["-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "500000", "-max_muxing_queue_size", "4096", "pipe:1"]));
            let mut r = Resp { status: 200, headers: vec![("Content-Type".into(), if vmode == "none" { "audio/mp4".into() } else { "video/mp4".into() })], body: stream_process(args) };
            for (k, v) in CORS {
                r.headers.push((k.into(), v.into()));
            }
            r
        }
        "sub" => {
            let s = q.get("s").cloned().filter(|x| !x.is_empty());
            if util::ext(&file) == "vtt" {
                return Resp::bytes(200, "text/vtt", std::fs::read(&file).unwrap_or_default());
            }
            let mut args = sv(&["-hide_banner", "-loglevel", "error", "-nostdin"]);
            // external .srt files are often in legacy encodings: let ffmpeg detect it for them
            if s.is_some() {
                args.extend(sv(&["-sub_charenc", "UTF-8"]));
            }
            args.extend(["-i".into(), file.clone()]);
            if let Some(s) = s {
                args.extend(["-map".into(), format!("0:s:{s}")]);
            }
            args.extend(sv(&["-f", "webvtt", "pipe:1"]));
            Resp::bytes(200, "text/vtt; charset=utf-8", run_buffer(&args, 60000).await.unwrap_or_default())
        }
        "art" => {
            let args = sv(&["-hide_banner", "-loglevel", "error", "-nostdin", "-i", &file, "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=600:-2", "-f", "image2", "-c:v", "mjpeg", "pipe:1"]);
            img("image/jpeg", run_buffer(&args, 15000).await, "max-age=3600")
        }
        "still" => {
            let args = sv(&["-hide_banner", "-loglevel", "error", "-nostdin", "-i", &file, "-frames:v", "1", "-f", "image2", "-c:v", "png", "pipe:1"]);
            img("image/png", run_buffer(&args, 30000).await, "max-age=600")
        }
        "pcm" => {
            let ss = qf("ss", 0.0);
            let t = qf("t", 360.0);
            let sr = q.get("sr").filter(|s| ["16000", "22050", "44100", "48000"].contains(&s.as_str())).cloned().unwrap_or("22050".into());
            let args = sv(&["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", &ss.to_string(), "-t", &t.to_string(), "-i", &file, "-vn", "-ac", "1", "-ar", &sr, "-f", "f32le", "pipe:1"]);
            img("application/octet-stream", run_buffer(&args, 120000).await, "no-store")
        }
        "wave" => {
            let w = qf("w", 600.0).min(1600.0) as u32;
            let h = qf("h", 200.0).min(600.0) as u32;
            let col = q.get("c").filter(|c| c.len() == 6 && c.chars().all(|x| x.is_ascii_hexdigit())).cloned().unwrap_or("3b82f6".into());
            let filter = format!("aformat=channel_layouts=mono,showwavespic=s={w}x{h}:colors=0x{col}:scale=sqrt");
            let args = sv(&["-hide_banner", "-loglevel", "error", "-nostdin", "-t", "600", "-i", &file, "-filter_complex", &filter, "-frames:v", "1", "-f", "image2", "-c:v", "png", "pipe:1"]);
            img("image/png", run_buffer(&args, 20000).await, "max-age=3600")
        }
        "thumb" => {
            let t = qf("t", 0.0).max(0.0);
            let w = qf("w", 200.0) as u32;
            let vf = format!("scale={w}:-2");
            let args = sv(&["-hide_banner", "-loglevel", "error", "-nostdin", "-skip_frame", "nokey", "-ss", &t.to_string(), "-i", &file, "-frames:v", "1", "-vf", &vf, "-f", "image2", "-c:v", "mjpeg", "-q:v", "6", "pipe:1"]);
            let mut b = run_buffer(&args, 10000).await;
            if b.is_none() {
                // few key frames (screen recordings): decode up to the moment instead
                let args = sv(&["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", &t.to_string(), "-i", &file, "-frames:v", "1", "-vf", &vf, "-f", "image2", "-c:v", "mjpeg", "-q:v", "6", "pipe:1"]);
                b = run_buffer(&args, 10000).await;
            }
            img("image/jpeg", b, "max-age=600")
        }
        _ => Resp::text(404, "not found"),
    }
}

pub async fn screenshot_dir() -> R {
    let d = dirs::picture_dir().unwrap_or_else(std::env::temp_dir).join("Dogfile Screenshots");
    let _ = std::fs::create_dir_all(&d);
    Ok(json!(d.to_string_lossy()))
}

// ---------------- exports: trim, remove / extract audio, convert ----------------
struct Export {
    pct: Mutex<f64>,
    done: AtomicBool,
    error: Mutex<Option<String>>,
    out: String,
    cancelled: AtomicBool,
    pid: AtomicU64,
}
fn exports() -> &'static Mutex<HashMap<u64, Arc<Export>>> {
    static E: OnceLock<Mutex<HashMap<u64, Arc<Export>>>> = OnceLock::new();
    E.get_or_init(|| Mutex::new(HashMap::new()))
}
static EXPORT_SEQ: AtomicU64 = AtomicU64::new(0);
fn audio_codec(ext: &str) -> Option<Vec<String>> {
    Some(sv(match ext {
        "mp3" => &["-c:a", "libmp3lame", "-q:a", "2"],
        "m4a" | "aac" => &["-c:a", "aac", "-b:a", "256k"],
        "flac" => &["-c:a", "flac"],
        "wav" => &["-c:a", "pcm_s16le"],
        "ogg" => &["-c:a", "libvorbis", "-q:a", "6"],
        "opus" => &["-c:a", "libopus", "-b:a", "160k"],
        _ => return None,
    }))
}
pub async fn export(a: &Args) -> R {
    let o = a.v(0);
    let id = EXPORT_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let out = o["out"].as_str().unwrap_or("").to_string();
    let src = o["src"].as_str().unwrap_or("").to_string();
    let oext = util::ext(&out);
    let audio_only = audio_codec(&oext).is_some() && (o["audioOnly"].as_bool().unwrap_or(false) || !o["hasVideo"].as_bool().unwrap_or(false));
    let start = o["start"].as_f64().unwrap_or(0.0).max(0.0);
    let end = o["end"].as_f64().unwrap_or(0.0);
    let len = if end > start { end - start } else { (o["duration"].as_f64().unwrap_or(0.0) - start).max(0.0) };
    let precise = o["mode"] == "precise" || audio_only || o["normalize"].as_bool().unwrap_or(false) || (o["convert"].as_bool().unwrap_or(false) && !o["copyOk"].as_bool().unwrap_or(false));
    let mut args = sv(&["-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats"]);
    if start > 0.0 {
        args.extend(["-ss".into(), format!("{start:.3}")]);
    }
    if end > start {
        args.extend(["-t".into(), format!("{len:.3}")]);
    }
    args.extend(["-i".into(), src.clone()]);
    let mp4ish = ["mp4", "m4v", "mov"].contains(&oext.as_str());
    let remove_audio = o["removeAudio"].as_bool().unwrap_or(false);
    if audio_only {
        args.extend(["-vn".into(), "-map".into(), format!("0:a:{}", o["audioTrack"].as_u64().unwrap_or(0))]);
        let mut ac = audio_codec(&oext).unwrap_or_default();
        // a chosen bitrate ("320kbps MP3") replaces the default quality setting
        if let Some(k) = o["bitrate"].as_u64().filter(|k| (32..=640).contains(k)) {
            if let Some(i) = ac.iter().position(|x| x == "-q:a" || x == "-b:a") {
                ac[i] = "-b:a".into();
                ac[i + 1] = format!("{k}k");
            }
        }
        args.extend(ac);
        if oext == "mp3" {
            args.extend(sv(&["-id3v2_version", "3"]));
        }
        args.extend(sv(&["-map_metadata", "0"]));
    } else {
        args.extend(sv(&["-map", "0:v:0?"]));
        if !remove_audio {
            args.extend(sv(&["-map", "0:a?"]));
        }
        if !mp4ish && !remove_audio {
            args.extend(sv(&["-map", "0:s?"]));
        }
        if precise {
            let enc = if o["gpu"] == json!(false) { "libx264".to_string() } else { best_encoder().await };
            if enc == "libx264" {
                args.extend(sv(&["-c:v", "libx264", "-preset", "medium", "-crf", "18"]));
            } else {
                args.extend(enc_args(&enc));
            }
            args.extend(sv(&["-pix_fmt", "yuv420p"]));
            if !remove_audio {
                args.extend(sv(&["-c:a", "aac", "-b:a", "256k"]));
            }
            if !mp4ish {
                args.extend(sv(&["-c:s", "copy"]));
            }
        } else {
            args.extend(sv(&["-c", "copy", "-avoid_negative_ts", "make_zero"]));
        }
        if remove_audio {
            args.push("-an".into());
        }
        if mp4ish {
            args.extend(sv(&["-movflags", "+faststart", "-sn"]));
        }
    }
    if o["normalize"].as_bool().unwrap_or(false) {
        args.extend(sv(&["-af", "loudnorm=I=-14:TP=-1:LRA=11"]));
    }
    let overwrite = o["overwrite"].as_bool().unwrap_or(false);
    let target = if overwrite { util::join(&util::dirname(&out), &format!(".{}.atlas-tmp.{oext}", basename(&out))) } else { out.clone() };
    args.push(target.clone());
    let job = Arc::new(Export { pct: Mutex::new(0.0), done: AtomicBool::new(false), error: Mutex::new(None), out: out.clone(), cancelled: AtomicBool::new(false), pid: AtomicU64::new(0) });
    exports().lock().insert(id, job.clone());
    let mut c = util::cmd(ffmpeg());
    c.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    job.pid.store(child.id().unwrap_or(0) as u64, Ordering::SeqCst);
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let j2 = job.clone();
    tokio::spawn(async move {
        let errt = tokio::spawn(async move {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s).await;
            s
        });
        let re = regex::Regex::new(r"out_time_(?:us|ms)=(\d+)").unwrap();
        let mut buf = vec![0u8; 8192];
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let s = String::from_utf8_lossy(&buf[..n]);
                    if let Some(m) = re.captures_iter(&s).last() {
                        if len > 0.0 {
                            let us: f64 = m[1].parse().unwrap_or(0.0);
                            *j2.pct.lock() = (us / 1e6 / len * 100.0).min(99.0);
                        }
                    }
                }
            }
        }
        let status = child.wait().await;
        let err = errt.await.unwrap_or_default();
        if j2.cancelled.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&target);
            *j2.error.lock() = Some("Cancelled".into());
        } else if !status.map(|s| s.success()).unwrap_or(false) {
            let _ = std::fs::remove_file(&target);
            let l = util::last_line(&err);
            *j2.error.lock() = Some(if l.is_empty() { "ffmpeg failed".into() } else { l });
        } else if overwrite {
            // the player lets go of the file first; Windows may hold a handle a little longer
            let mut ok = false;
            for _ in 0..20 {
                if std::fs::rename(&target, &j2.out).is_ok() {
                    ok = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            if !ok {
                *j2.error.lock() = Some("The original file is in use, so it could not be replaced. The edit was kept next to it.".into());
                let edited = regex::Regex::new(r"(\.[^.]+)$").unwrap().replace(&j2.out, " (edited)$1").to_string();
                let _ = std::fs::rename(&target, edited);
            } else {
                *j2.pct.lock() = 100.0;
            }
        } else {
            *j2.pct.lock() = 100.0;
        }
        j2.done.store(true, Ordering::SeqCst);
    });
    Ok(json!(id))
}
pub fn job_status(a: &Args) -> R {
    let id = a.u(0, 0);
    let Some(j) = exports().lock().get(&id).cloned() else { return Ok(Value::Null) };
    let done = j.done.load(Ordering::SeqCst);
    if done {
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            exports().lock().remove(&id);
        });
    }
    Ok(json!({ "id": id, "pct": *j.pct.lock(), "done": done, "error": *j.error.lock(), "out": j.out }))
}
pub fn cancel_job(a: &Args) -> R {
    let id = a.u(0, 0);
    if let Some(j) = exports().lock().get(&id).cloned() {
        if !j.done.load(Ordering::SeqCst) {
            j.cancelled.store(true, Ordering::SeqCst);
            kill_pid(j.pid.load(Ordering::SeqCst) as u32);
        }
    }
    Ok(Value::Null)
}

// ---------------- contact sheets ----------------
fn sheets() -> &'static Mutex<HashMap<String, Arc<(AtomicBool, AtomicU64)>>> {
    static S: OnceLock<Mutex<HashMap<String, Arc<(AtomicBool, AtomicU64)>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn sheet_cancel(a: &Args) -> R {
    if let Some(j) = sheets().lock().get(&a.s_or(0, "")).cloned() {
        j.0.store(true, Ordering::SeqCst);
        kill_pid(j.1.load(Ordering::SeqCst) as u32);
    }
    Ok(json!(true))
}
fn hms(t: f64) -> String {
    let s = t.floor() as u64;
    format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
}
pub async fn contact_sheet(win: &str, a: &Args) -> R {
    let file = a.s(0)?;
    let o = a.v(1);
    let info = probe(&file).await?;
    let dur = info["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).unwrap_or(0.0);
    if dur <= 0.0 {
        return Err("Can’t read the length of this video".into());
    }
    let cols = o["cols"].as_u64().unwrap_or(4);
    let rows = o["rows"].as_u64().unwrap_or(4);
    let n = cols * rows;
    let w = o["width"].as_u64().unwrap_or(360);
    let out = o["out"].as_str().map(String::from).unwrap_or_else(|| regex::Regex::new(r"\.[^.\\/]+$").unwrap().replace(&file, "").to_string() + " - contact sheet.jpg");
    let job_id = o["jobId"].as_str().map(String::from).unwrap_or_else(|| (util::now_ms() as u64).to_string());
    let job = Arc::new((AtomicBool::new(false), AtomicU64::new(0)));
    sheets().lock().insert(job_id.clone(), job.clone());
    let tmp = util::temp_dir("sheet").map_err(|e| e.to_string())?;
    let run = |args: Vec<String>| {
        let job = job.clone();
        async move {
            if job.0.load(Ordering::SeqCst) {
                return Err("Cancelled".to_string());
            }
            let mut c = util::cmd(ffmpeg());
            c.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
            let child = c.spawn().map_err(|e| e.to_string())?;
            job.1.store(child.id().unwrap_or(0) as u64, Ordering::SeqCst);
            let o = child.wait_with_output().await.map_err(|e| e.to_string())?;
            if job.0.load(Ordering::SeqCst) {
                return Err("Cancelled".into());
            }
            if o.status.success() { Ok(()) } else { Err(util::last_line(&String::from_utf8_lossy(&o.stderr))).map_err(|e: String| if e.is_empty() { "ffmpeg failed".into() } else { e }) }
        }
    };
    let result: Result<Value, String> = async {
        let mut draw_text = true;
        let mut i = 0;
        while i < n {
            let t = dur * (0.02 + 0.96 * (i as f64 + 0.5) / n as f64);
            let f = tmp.join(format!("f{i:03}.jpg"));
            let label = hms(t).replace(':', "\\:");
            let vf = format!("scale={w}:-2") + &if draw_text { format!(",drawtext=text='{label}':x=8:y=h-th-8:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=4") } else { String::new() };
            let args = sv(&["-hide_banner", "-loglevel", "error", "-y", "-ss", &format!("{t:.2}"), "-i", &file, "-frames:v", "1", "-vf", &vf, "-q:v", "3", &f.to_string_lossy()]);
            match run(args).await {
                Ok(()) => {}
                Err(e) if e == "Cancelled" => return Err(e),
                Err(e) if draw_text && (e.contains("drawtext") || e.to_lowercase().contains("font")) => {
                    draw_text = false;
                    continue;
                }
                Err(e) => return Err(e),
            }
            events::emit(win, "media:sheetProgress", json!({ "jobId": job_id, "done": i + 1, "total": n + 1 }));
            i += 1;
        }
        let tile = format!("tile={cols}x{rows}:padding=6:margin=6:color=0x1b1b1d");
        let args = sv(&["-hide_banner", "-loglevel", "error", "-y", "-framerate", "1", "-i", &tmp.join("f%03d.jpg").to_string_lossy(), "-vf", &tile, "-frames:v", "1", "-q:v", "3", &out]);
        run(args).await?;
        events::emit(win, "media:sheetProgress", json!({ "jobId": job_id, "done": n + 1, "total": n + 1 }));
        Ok(json!(out))
    }
    .await;
    sheets().lock().remove(&job_id);
    let _ = std::fs::remove_dir_all(&tmp);
    result
}
