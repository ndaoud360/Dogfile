// The window's web requests: interface files, local files (with byte ranges for video), media made by ffmpeg,
// AI model files, and `invoke` calls. Shared by the app's custom scheme and the development server.
use crate::{dispatch, st};
use bytes::Bytes;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub struct Req {
    pub method: String,
    /// path without the query, e.g. /app/index.html
    pub path: String,
    pub query: HashMap<String, String>,
    pub raw_query: String,
    /// lower-case header names
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
    /// the window that asked
    pub win: String,
}
pub enum Body {
    Bytes(Vec<u8>),
    /// live output (ffmpeg converting a video as it plays)
    Stream(tokio::sync::mpsc::Receiver<Bytes>),
}
pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Body,
}
impl Resp {
    pub fn bytes(status: u16, ctype: &str, b: Vec<u8>) -> Resp {
        Resp { status, headers: vec![("Content-Type".into(), ctype.into()), ("Access-Control-Allow-Origin".into(), "*".into())], body: Body::Bytes(b) }
    }
    pub fn text(status: u16, t: &str) -> Resp {
        Resp::bytes(status, "text/plain; charset=utf-8", t.as_bytes().to_vec())
    }
    pub fn json(v: &Value) -> Resp {
        Resp::bytes(200, "application/json", serde_json::to_vec(v).unwrap_or_default())
    }
    pub fn header(mut self, k: &str, v: &str) -> Resp {
        self.headers.push((k.into(), v.into()));
        self
    }
}

pub fn parse_query(q: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for part in q.split('&').filter(|x| !x.is_empty()) {
        let (k, v) = part.split_once('=').unwrap_or((part, ""));
        let dec = |s: &str| urlencoding::decode(&s.replace('+', " ")).map(|c| c.into_owned()).unwrap_or_else(|_| s.to_string());
        m.insert(dec(k), dec(v));
    }
    m
}

pub fn mime(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "wasm" => "application/wasm",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "apng" => "image/apng",
        "tif" | "tiff" => "image/tiff",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "opus" => "audio/opus",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" => "text/plain; charset=utf-8",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "vtt" => "text/vtt",
        _ => "application/octet-stream",
    }
}

pub async fn handle(req: Req) -> Resp {
    let path = req.path.clone();
    if path == "/invoke" && req.method == "POST" {
        return invoke(req).await;
    }
    if let Some(rest) = path.strip_prefix("/app/") {
        return app_file(rest);
    }
    if path == "/f" || path == "/f/" {
        let Some(p) = req.query.get("p").cloned() else { return Resp::text(400, "missing") };
        return tokio::task::spawn_blocking(move || serve_file(Path::new(&p), req.headers.get("range").map(|s| s.as_str()), false, "max-age=60")).await.unwrap_or_else(|_| Resp::text(500, "error"));
    }
    if let Some(route) = path.strip_prefix("/media/") {
        return crate::media::handle(route, &req).await;
    }
    // pictures the web view can't show (PSD, TGA, DDS, EXR, HDR, 16-bit TIFF…), as PNG; w = longest side
    if path == "/img" {
        let p = req.query.get("p").cloned().unwrap_or_default();
        let w: u32 = req.query.get("w").and_then(|s| s.parse().ok()).unwrap_or(0).min(16384);
        return match tokio::task::spawn_blocking(move || crate::imgdec::png(&p, w)).await {
            Ok(Ok(b)) => { let mut r = Resp::bytes(200, "image/png", b); r.headers.push(("cache-control".into(), "max-age=600".into())); r }
            Ok(Err(e)) => Resp::text(415, &e),
            Err(_) => Resp::text(500, "error"),
        };
    }
    if path == "/thumb" {
        #[cfg(windows)]
        {
            let p = req.query.get("p").cloned().unwrap_or_default();
            let size: u32 = req.query.get("s").and_then(|s| s.parse().ok()).unwrap_or(256);
            let v = req.query.get("v").cloned().unwrap_or_default();
            return crate::win::thumbs::serve(&p, size, &v).await;
        }
        #[cfg(not(windows))]
        return Resp::text(404, "No thumbnail");
    }
    if let Some(rest) = path.strip_prefix("/models/") {
        return crate::ai::serve(rest);
    }
    if path == "/" || path.is_empty() {
        return Resp::text(200, "Dogfile");
    }
    Resp::text(404, "Not found")
}

async fn invoke(req: Req) -> Resp {
    let v: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
    let name = v["name"].as_str().unwrap_or("").to_string();
    let args = match v["args"].clone() {
        Value::Array(a) => a,
        _ => vec![],
    };
    let win = if req.win.is_empty() { v["win"].as_str().unwrap_or("main-1").to_string() } else { req.win.clone() };
    // folder listings: written straight to JSON (a folder of 25,000 files is a 6 MB answer)
    if name == "fs:list" {
        if let Some(dir) = args.first().and_then(|d| d.as_str()).map(String::from) {
            // (demo folders go the long way: their files report their pretend sizes)
            let demo = crate::demo::active() && crate::demo::inside(Path::new(&dir));
            if !demo && (!dir.starts_with("\\\\") || dir.trim_end_matches('\\').matches('\\').count() > 2) {
                let d2 = dir.clone();
                if let Ok(Ok(raw)) = tokio::task::spawn_blocking(move || dogfile_core::jobs::list_raw(&d2)).await {
                    let mut b = Vec::with_capacity(raw.len() + 16);
                    b.extend_from_slice(b"{\"ok\":true,\"v\":");
                    b.extend_from_slice(raw.as_bytes());
                    b.push(b'}');
                    return Resp::bytes(200, "application/json", b);
                }
            }
        }
    }
    // a bug that panics inside a call still gets an answer (an error the window can show), instead of leaving the
    // window waiting forever with no sign that anything went wrong
    use futures_util::FutureExt;
    match std::panic::AssertUnwindSafe(dispatch::call(&win, &name, args)).catch_unwind().await {
        Ok(Ok(v)) => Resp::json(&json!({ "ok": true, "v": v })),
        Ok(Err(e)) => Resp::json(&json!({ "ok": false, "error": e })),
        Err(p) => {
            let why = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_default();
            crate::errlog(&format!("{name} stopped unexpectedly: {why}"));
            Resp::json(&json!({ "ok": false, "error": "Something went wrong inside Dogfile. It’s been noted, and Report a bug will include it." }))
        }
    }
}

/// the bridge (window.atlas) goes first in every page
const BRIDGE_TAG: &str = "<script src=\"/app/js/bridge.js\"></script>";
/// an interface file as stored (packed into the program, or from the folder in development), without changes
pub fn ui_bytes(rel: &str) -> Option<Vec<u8>> {
    if rel.split(['/', '\\']).any(|seg| seg == "..") {
        return None;
    }
    match st().ui.as_ref() {
        Some(p) => p.get(rel),
        None => std::fs::read(st().renderer_dir.join(rel)).ok(),
    }
}
fn app_file(rest: &str) -> Resp {
    let rel = urlencoding::decode(rest).map(|c| c.into_owned()).unwrap_or_else(|_| rest.to_string());
    if rel.split(['/', '\\']).any(|seg| seg == "..") {
        return Resp::text(403, "Forbidden");
    }
    let root = &st().renderer_dir;
    let file: PathBuf = root.join(&rel);
    let ext = crate::util::ext(&rel);
    // the interface packed into the program
    let packed = st().ui.as_ref().map(|p| p.get(&rel.replace('\\', "/")));
    if packed == Some(None) {
        return Resp::text(404, "Not found");
    }
    if ext == "html" {
        let html = match packed {
            Some(Some(b)) => String::from_utf8(b).ok(),
            _ => std::fs::read_to_string(&file).ok(),
        };
        let Some(mut html) = html else { return Resp::text(404, "Not found") };
        if let Some(i) = html.find("<head>") {
            html.insert_str(i + 6, BRIDGE_TAG);
        } else {
            html.insert_str(0, BRIDGE_TAG);
        }
        let r = Resp::bytes(200, mime("html"), html.into_bytes()).header("Cache-Control", "no-cache");
        // test runs can profile the page
        return if st().test_mode { r.header("Document-Policy", "js-profiling") } else { r };
    }
    let mut r = match packed {
        Some(Some(b)) => Resp::bytes(200, mime(&ext), b).header("Cache-Control", "no-cache"),
        _ => serve_file(&file, None, true, "no-cache"),
    };
    // the feature sandbox may run the feature's code but can't load other scripts or reach the network
    if rel.ends_with("js/ext-worker.js") {
        r.headers.push(("Content-Security-Policy".into(), "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'; worker-src 'none'".into()));
    }
    r
}

/// A file, whole or the byte range asked for. Open-ended ranges are answered in pieces (the player asks again).
pub fn serve_file(file: &Path, range: Option<&str>, app: bool, cache: &str) -> Resp {
    let Ok(mut f) = std::fs::File::open(file) else { return Resp::text(404, "Not found") };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut ctype = mime(&crate::util::ext(&file.to_string_lossy()));
    // People's own files (not the app's): a page, script or drawing from disk must never run as part of Dogfile, where
    // it could use everything the interface can. Scripts are served as plain text; pages and drawings opened directly
    // get a sandbox (no scripts, an origin of their own). Pictures, video, sound and PDFs are unaffected.
    // Dogfile's own data folder holds its downloaded, checksum-checked helpers (the CAD reader): those run as before
    let own = app || crate::try_st().map(|st| file.starts_with(&st.data_dir)).unwrap_or(false);
    let active = !own && (ctype.contains("html") || ctype.contains("svg") || ctype.contains("xml") || ctype.contains("javascript"));
    if !own && ctype.contains("javascript") {
        ctype = "text/plain; charset=utf-8";
    }
    let base = |status: u16, body: Vec<u8>| {
        let mut r = Resp::bytes(status, ctype, body);
        r.headers.push(("Accept-Ranges".into(), "bytes".into()));
        r.headers.push(("Cache-Control".into(), cache.into()));
        if !app {
            r.headers.push(("X-Content-Type-Options".into(), "nosniff".into()));
        }
        if active {
            r.headers.push(("Content-Security-Policy".into(), "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src 'self' data:".into()));
        }
        r
    };
    if let Some(range) = range.filter(|_| !app) {
        let re = regex::Regex::new(r"bytes=(\d*)-(\d*)").unwrap();
        if let Some(c) = re.captures(range) {
            let (a, b) = (c.get(1).map(|m| m.as_str()).unwrap_or(""), c.get(2).map(|m| m.as_str()).unwrap_or(""));
            let (mut start, mut end): (u64, u64);
            if a.is_empty() && !b.is_empty() {
                let n: u64 = b.parse().unwrap_or(0);
                start = size.saturating_sub(n);
                end = size.saturating_sub(1);
            } else {
                start = a.parse().unwrap_or(0);
                end = if b.is_empty() { size.saturating_sub(1) } else { b.parse::<u64>().unwrap_or(size.saturating_sub(1)) };
                // open-ended: a few megabytes at a time
                if b.is_empty() {
                    end = end.min(start + 8 * 1024 * 1024 - 1);
                }
            }
            end = end.min(size.saturating_sub(1));
            if size == 0 || start > end {
                start = 0;
                end = 0;
                if size == 0 {
                    return base(200, vec![]);
                }
            }
            let len = (end - start + 1) as usize;
            let mut buf = vec![0u8; len];
            if f.seek(SeekFrom::Start(start)).is_err() {
                return Resp::text(416, "Range");
            }
            let mut n = 0;
            while n < len {
                match f.read(&mut buf[n..]) {
                    Ok(0) | Err(_) => break,
                    Ok(k) => n += k,
                }
            }
            buf.truncate(n);
            let mut r = base(206, buf);
            r.headers.push(("Content-Range".into(), format!("bytes {start}-{}/{size}", start + n as u64 - 1)));
            return r;
        }
    }
    let mut buf = Vec::with_capacity(size as usize);
    if f.read_to_end(&mut buf).is_err() {
        return Resp::text(500, "Read error");
    }
    base(200, buf)
}
