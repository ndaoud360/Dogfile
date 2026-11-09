// Parts of Dogfile that are big and only some people use are downloaded the first time they're needed, so the program
// itself stays small (the Microsoft Store package especially):
//   ffmpeg  the media engine (Dogfile Player's conversions, thumbnails, trimming, transcripts)
//   ocr     Tesseract, for selecting text in photos and screenshots
//   ort     ONNX Runtime, for the stem separator and the on-device AI helpers
//   psd     the Photoshop helper, for opening PSD files with their layers and saving them back as layered PSDs
// (the assistant's llama-server has its own fetch: llm_server::fetch_if_missing.)
// Every part comes from one address with one SHA-256, both written into the program when it was built, so a download
// that isn't exactly the file that was built and tested is thrown away. Parts live in <data>/components and are never
// run from anywhere else. A build that still carries a part (Linux, macOS, a development copy) never downloads it.
use crate::args::{Args, R};
use crate::{st, util};
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

struct Part {
    name: &'static str,
    label: &'static str,
    /// what it's for, in the words of the question the window asks
    why: &'static str,
    url: Option<&'static str>,
    sha: Option<&'static str>,
    /// bytes, when the server doesn't say
    size: u64,
}
fn size_of(s: Option<&'static str>, d: u64) -> u64 {
    s.and_then(|s| s.parse().ok()).unwrap_or(d)
}
fn parts() -> [Part; 5] {
    [
        Part { name: "ffmpeg", label: "Media engine (FFmpeg)", why: "plays and converts the video and audio formats Windows can't open by itself", url: option_env!("DOGFILE_FFMPEG_URL"), sha: option_env!("DOGFILE_FFMPEG_SHA256"), size: size_of(option_env!("DOGFILE_FFMPEG_SIZE"), 75_000_000) },
        Part { name: "ocr", label: "Text recognition (Tesseract)", why: "reads the text in photos and screenshots so you can select and copy it", url: option_env!("DOGFILE_OCR_URL"), sha: option_env!("DOGFILE_OCR_SHA256"), size: size_of(option_env!("DOGFILE_OCR_SIZE"), 15_000_000) },
        Part { name: "ort", label: "On-device AI runtime (ONNX)", why: "runs the stem separator and the on-device helpers on this PC", url: option_env!("DOGFILE_ORT_URL"), sha: option_env!("DOGFILE_ORT_SHA256"), size: size_of(option_env!("DOGFILE_ORT_SIZE"), 5_500_000) },
        Part { name: "psd", label: "Photoshop layers (PSD)", why: "opens Photoshop files with their layers, so you can switch layers on and off, edit them and save a PSD Photoshop still opens", url: option_env!("DOGFILE_PSD_URL"), sha: option_env!("DOGFILE_PSD_SHA256"), size: size_of(option_env!("DOGFILE_PSD_SIZE"), 70_000_000) },
        Part { name: "rclone", label: "More cloud drives (rclone)", why: "lets Dogfile browse Box, MEGA, pCloud, Proton Drive, Yandex Disk, Backblaze B2 and dozens more cloud drives like folders", url: option_env!("DOGFILE_RCLONE_URL"), sha: option_env!("DOGFILE_RCLONE_SHA256"), size: size_of(option_env!("DOGFILE_RCLONE_SIZE"), 25_000_000) },
    ]
}
fn part(name: &str) -> Option<Part> {
    parts().into_iter().find(|p| p.name == name)
}

pub fn dir() -> PathBuf {
    std::env::var("ATLAS_COMPONENTS_DIR").map(PathBuf::from).unwrap_or_else(|_| st().data_dir.join("components"))
}
/// where the interface's own vendor files (vendor/ort, vendor/tesseract) are served from when the program doesn't carry them
pub fn web_dir() -> PathBuf {
    dir().join("web")
}
/// the folder of the downloaded media engine
pub fn ffmpeg_dir() -> PathBuf {
    dir().join("ffmpeg")
}
/// the folder of the downloaded rclone (rclone.exe)
pub fn rclone_dir() -> PathBuf {
    dir().join("rclone")
}
/// the folder of the downloaded Photoshop helper (dogfile-psd.exe and its libraries)
pub fn psd_dir() -> PathBuf {
    dir().join("psd")
}
fn marker(name: &str) -> PathBuf {
    dir().join(format!("{name}.ok"))
}
/// the program carries this part itself (the interface files are packed into it, or ffmpeg is found next to it)
fn carried(name: &str) -> bool {
    if crate::try_st().is_none() {
        return false;
    }
    match name {
        "ffmpeg" => crate::media::bundled_dir().is_some(),
        "ocr" => crate::http::ui_bytes("vendor/tesseract/worker.min.js").is_some(),
        "ort" => crate::http::ui_bytes("vendor/ort/ort.bundle.min.mjs").is_some(),
        "psd" => crate::psd::bundled().is_some(),
        "rclone" => crate::rclone::bundled().is_some(),
        _ => false,
    }
}
/// the part is here and is the version this program was built with
pub fn ready(name: &str) -> bool {
    if carried(name) {
        return true;
    }
    let Some(p) = part(name) else { return false };
    match (std::fs::read_to_string(marker(name)), p.sha) {
        (Ok(m), Some(sha)) => m.trim() == sha,
        // a development build with no pinned address: whatever was put there by hand
        (Ok(_), None) => true,
        _ => false,
    }
}

#[derive(Default, Clone)]
struct Fetch {
    running: bool,
    received: u64,
    total: u64,
    stage: String,
    error: Option<String>,
}
fn fetches() -> &'static Mutex<HashMap<&'static str, Fetch>> {
    static F: OnceLock<Mutex<HashMap<&'static str, Fetch>>> = OnceLock::new();
    F.get_or_init(Default::default)
}

/// components:status → { ffmpeg: { ready, label, why, bytes, downloadable, downloading, received, total, stage, error }, … }
pub fn status(_a: &Args) -> R {
    let f = fetches().lock().clone();
    let mut out = serde_json::Map::new();
    for p in parts() {
        let s = f.get(p.name).cloned().unwrap_or_default();
        out.insert(
            p.name.to_string(),
            json!({ "ready": ready(p.name), "label": p.label, "why": p.why, "bytes": p.size, "downloadable": p.url.is_some() && p.sha.is_some(),
                "downloading": s.running, "received": s.received, "total": s.total, "stage": s.stage, "error": s.error }),
        );
    }
    Ok(Value::Object(out))
}
/// components:install(name): fetch the part in the background; poll components:status
pub fn install(a: &Args) -> R {
    let name = a.s(0)?;
    let p = part(&name).ok_or("Unknown component")?;
    if ready(p.name) {
        return Ok(json!({ "ready": true }));
    }
    let (Some(url), Some(sha)) = (p.url, p.sha) else { return Err(format!("{} isn't available to download in this copy of Dogfile", p.label)) };
    {
        let mut m = fetches().lock();
        let e = m.entry(p.name).or_default();
        if e.running {
            return Ok(json!({ "downloading": true }));
        }
        *e = Fetch { running: true, total: p.size, stage: "Downloading".into(), ..Default::default() };
    }
    st().rt.spawn(async move {
        let r = get(p.name, url, sha).await;
        let mut m = fetches().lock();
        let e = m.entry(p.name).or_default();
        e.running = false;
        e.error = r.err();
    });
    Ok(json!({ "downloading": true }))
}

fn set_stage(name: &'static str, s: &str) {
    fetches().lock().entry(name).or_default().stage = s.to_string();
}

async fn get(name: &'static str, url: &str, sha: &str) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let root = dir();
    std::fs::create_dir_all(&root).map_err(|e| format!("Couldn’t make the components folder: {e}"))?;
    let part_file = root.join(format!("{name}.zip.part"));
    let _ = std::fs::remove_file(&part_file);
    let r = util::http().get(url).timeout(std::time::Duration::from_secs(3600)).send().await.map_err(|e| format!("Couldn’t reach the download: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("The download failed (HTTP {})", r.status().as_u16()));
    }
    if let Some(n) = r.content_length() {
        fetches().lock().entry(name).or_default().total = n;
    }
    let mut file = tokio::fs::File::create(&part_file).await.map_err(|e| format!("Couldn’t save the download: {e}"))?;
    let mut hasher = Sha256::new();
    let mut stream = r.bytes_stream();
    while let Some(c) = stream.next().await {
        let c = c.map_err(|e| format!("The download was interrupted: {e}"))?;
        hasher.update(&c);
        file.write_all(&c).await.map_err(|e| format!("Couldn’t save the download: {e}"))?;
        fetches().lock().entry(name).or_default().received += c.len() as u64;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if !got.eq_ignore_ascii_case(sha) {
        let _ = std::fs::remove_file(&part_file);
        return Err("The download wasn’t the file Dogfile expected, so it was thrown away".into());
    }
    set_stage(name, "Installing");
    let target = match name {
        "ffmpeg" => ffmpeg_dir(),
        "psd" => psd_dir(),
        "rclone" => rclone_dir(),
        _ => web_dir(),
    };
    // a new copy of the Photoshop helper replaces the old one whole (its folders must not mix with the old version's)
    if name == "psd" || name == "rclone" {
        let _ = std::fs::remove_dir_all(&target);
    }
    let zip_path = part_file.clone();
    let res = tokio::task::spawn_blocking(move || extract(&zip_path, &target, name == "ffmpeg" || name == "rclone")).await.map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&part_file);
    res?;
    std::fs::write(marker(name), sha).map_err(|e| format!("Couldn’t finish installing: {e}"))
}

/// unpack the zip into `target` (files only, names kept inside it, nothing outside it). `flat`: every file goes straight
/// into `target` (the media engine's programs and libraries must sit together).
fn extract(zip_path: &Path, target: &Path, flat: bool) -> Result<(), String> {
    let f = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(f)).map_err(|e| format!("The download wasn’t a valid package: {e}"))?;
    // a whole new copy beside the old one, swapped in at the end: a half-unpacked part is never used
    let tmp = target.with_extension("part");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    // web parts share one folder (tesseract/, ort/): start from what's there so installing one keeps the other
    if !flat && target.is_dir() {
        copy_dir(target, &tmp).map_err(|e| e.to_string())?;
    }
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let raw = f.name().map_err(|e| e.to_string())?.replace('\\', "/");
        if f.is_dir() || raw.split('/').any(|s| s == "..") || raw.starts_with('/') || raw.contains(':') {
            continue;
        }
        let rel: PathBuf = if flat { PathBuf::from(raw.rsplit('/').next().unwrap_or("")) } else { raw.split('/').collect() };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = tmp.join(&rel);
        if let Some(d) = out.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let mut o = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut o).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(target);
    std::fs::rename(&tmp, target).map_err(|e| format!("Couldn’t finish installing: {e}"))
}
fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    for e in std::fs::read_dir(from)?.flatten() {
        let (p, q) = (e.path(), to.join(e.file_name()));
        if p.is_dir() {
            std::fs::create_dir_all(&q)?;
            copy_dir(&p, &q)?;
        } else {
            std::fs::copy(&p, &q)?;
        }
    }
    Ok(())
}

/// the file for an interface request like `vendor/tesseract/worker.min.js`, from the downloaded parts
pub fn web_file(rel: &str) -> Option<PathBuf> {
    let rest = rel.strip_prefix("vendor/")?;
    let top = rest.split('/').next()?;
    let part = match top {
        "tesseract" => "ocr",
        "ort" => "ort",
        _ => return None,
    };
    if !ready(part) || rest.split('/').any(|s| s == ".." || s.is_empty()) {
        return None;
    }
    let f = web_dir().join(rest);
    f.is_file().then_some(f)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_of(files: &[(&str, &[u8])]) -> PathBuf {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!("dogfile-comp-{}-{}.zip", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        let mut z = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
        for (n, b) in files {
            z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b).unwrap();
        }
        z.finish().unwrap();
        p
    }

    #[test]
    fn a_web_part_keeps_its_folders_and_the_other_part_survives() {
        let base = std::env::temp_dir().join(format!("dogfile-web-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        extract(&zip_of(&[("tesseract/worker.min.js", b"w"), ("tesseract/lang/eng.gz", b"l")]), &base, false).unwrap();
        extract(&zip_of(&[("ort/ort.wasm", b"o"), ("ort/b.mjs", b"m")]), &base, false).unwrap();
        assert_eq!(std::fs::read(base.join("tesseract/lang/eng.gz")).unwrap(), b"l");
        assert_eq!(std::fs::read(base.join("ort/ort.wasm")).unwrap(), b"o");
        let _ = std::fs::remove_dir_all(&base);
    }
    /// a one-request web server on this PC that answers with `body`
    fn serve_once(body: Vec<u8>) -> String {
        use std::io::Read;
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut c, _)) = l.accept() {
                let mut buf = [0u8; 2048];
                let _ = c.read(&mut buf);
                let _ = c.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes());
                let _ = c.write_all(&body);
            }
        });
        format!("http://127.0.0.1:{port}/part.zip")
    }
    fn sha_of(b: &[u8]) -> String {
        Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
    }

    #[tokio::test]
    async fn a_download_is_checked_unpacked_and_marked_ready_and_a_wrong_one_is_refused() {
        let root = std::env::temp_dir().join(format!("dogfile-dl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        // SAFETY: only this test touches this variable
        unsafe { std::env::set_var("ATLAS_COMPONENTS_DIR", &root) };
        let z = std::fs::read(zip_of(&[("ort/ort.bundle.min.mjs", b"export default 1"), ("ort/ort.wasm", b"\0asm")])).unwrap();
        // the wrong checksum: thrown away, nothing installed
        let bad = get("ort", &serve_once(z.clone()), &sha_of(b"something else")).await;
        assert!(bad.unwrap_err().contains("wasn’t the file"));
        assert!(!marker("ort").exists() && !web_dir().join("ort").exists() && !root.join("ort.zip.part").exists());
        // the right one
        get("ort", &serve_once(z.clone()), &sha_of(&z)).await.unwrap();
        assert_eq!(std::fs::read(web_dir().join("ort/ort.wasm")).unwrap(), b"\0asm");
        assert_eq!(std::fs::read_to_string(marker("ort")).unwrap(), sha_of(&z));
        assert!(!root.join("ort.zip.part").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_media_engine_is_unpacked_flat_and_paths_cannot_climb_out() {
        let base = std::env::temp_dir().join(format!("dogfile-ff-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        extract(&zip_of(&[("bin/ffmpeg.exe", b"f"), ("../evil.dll", b"x"), ("avcodec.dll", b"a"), ("C:/win.dll", b"w")]), &base, true).unwrap();
        assert!(base.join("ffmpeg.exe").is_file() && base.join("avcodec.dll").is_file());
        assert!(!base.parent().unwrap().join("evil.dll").exists() && !base.join("win.dll").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
