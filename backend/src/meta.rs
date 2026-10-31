// Deep metadata: photos' EXIF / XMP / IPTC (JPEG, PNG, HEIC, TIFF, WebP and camera RAW: CR2, CR3, NEF, ARW,
// DNG, ORF, RAF, RW2…) read and written with ExifTool, the standard free tool for it. Dogfile fetches ExifTool
// once from exiftool.org the first time it's needed. Plus NTFS alternate data streams: the hidden extra
// contents a file can carry (the "downloaded from the internet" mark, thumbnails, notes left by other programs).
use crate::args::{Args, R};
use crate::{st, util};
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

// ---------------------------------------------------------------------------------------------------------------
// ExifTool: found, or fetched once

fn tool_dir() -> PathBuf {
    st().data_dir.join("tools").join("exiftool")
}
pub fn exiftool() -> Option<PathBuf> {
    if !util::IS_WIN {
        return util::which("exiftool");
    }
    let mine = tool_dir().join("exiftool.exe");
    if mine.is_file() && tool_dir().join("exiftool_files").is_dir() {
        return Some(mine);
    }
    let bundled = st().res_dir.join("exiftool").join("exiftool.exe");
    if bundled.is_file() {
        return Some(bundled);
    }
    util::which("exiftool")
}

#[derive(Default, Clone)]
struct Fetch {
    running: bool,
    received: u64,
    total: u64,
    error: Option<String>,
}
fn fetch() -> &'static Mutex<Fetch> {
    static F: OnceLock<Mutex<Fetch>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(Fetch::default()))
}
/// meta:status: {ready, downloading, received, total, error}
pub fn status(_a: &Args) -> R {
    let f = fetch().lock().clone();
    Ok(json!({ "ready": exiftool().is_some(), "downloading": f.running, "received": f.received, "total": f.total, "error": f.error, "windows": util::IS_WIN }))
}
/// meta:install: fetch ExifTool (Windows): the latest version from exiftool.org, SourceForge if that fails
pub fn install(_a: &Args) -> R {
    if exiftool().is_some() {
        return Ok(json!({ "ready": true }));
    }
    if !util::IS_WIN {
        return Err("Install ExifTool with your package manager".into());
    }
    {
        let mut f = fetch().lock();
        if f.running {
            return Ok(json!({ "downloading": true }));
        }
        *f = Fetch { running: true, ..Default::default() };
    }
    st().rt.spawn(async {
        let r = get_exiftool().await;
        let mut f = fetch().lock();
        f.running = false;
        f.error = r.err();
    });
    Ok(json!({ "downloading": true }))
}
async fn get_exiftool() -> Result<(), String> {
    let http = util::http();
    let ver = http.get("https://exiftool.org/ver.txt").send().await.map_err(|e| format!("Couldn’t reach exiftool.org: {e}"))?.text().await.map_err(|e| e.to_string())?;
    let ver = ver.trim().to_string();
    if !ver.chars().all(|c| c.is_ascii_digit() || c == '.') || ver.is_empty() {
        return Err("exiftool.org answered oddly".into());
    }
    let name = format!("exiftool-{ver}_64.zip");
    let mut resp = None;
    for url in [format!("https://exiftool.org/{name}"), format!("https://sourceforge.net/projects/exiftool/files/{name}/download")] {
        if let Ok(r) = http.get(&url).send().await {
            if r.status().is_success() {
                resp = Some(r);
                break;
            }
        }
    }
    let r = resp.ok_or("ExifTool couldn’t be downloaded")?;
    fetch().lock().total = r.content_length().unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("dogfile-{name}"));
    {
        let mut out = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut s = r.bytes_stream();
        while let Some(c) = s.next().await {
            let c = c.map_err(|e| e.to_string())?;
            out.write_all(&c).map_err(|e| e.to_string())?;
            fetch().lock().received += c.len() as u64;
        }
    }
    // exiftool.org publishes a SHA-256 for every download: a copy that doesn't match (damaged, or swapped on a
    // mirror) is never unpacked or run
    if let Ok(sums) = async { http.get("https://exiftool.org/checksums.txt").send().await?.error_for_status()?.text().await }.await {
        let want = sums.lines().filter(|l| l.contains(&name) && l.to_uppercase().contains("256")).find_map(|l| l.split(|c: char| !c.is_ascii_hexdigit()).find(|w| w.len() == 64).map(|w| w.to_lowercase()));
        if let Some(want) = want {
            use sha2::{Digest, Sha256};
            let got: String = Sha256::digest(std::fs::read(&tmp).map_err(|e| e.to_string())?).iter().map(|b| format!("{b:02x}")).collect();
            if got != want {
                let _ = std::fs::remove_file(&tmp);
                return Err("The ExifTool download didn’t match the checksum exiftool.org publishes, so it wasn’t installed. Try again later.".into());
            }
        }
    }
    // the zip holds exiftool-<ver>_64/exiftool(-k).exe and exiftool_files/: unpack without the top folder
    let dir = tool_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(&tmp).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..z.len() {
        let mut e = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = e.enclosed_name() else { continue };
        let rel: PathBuf = rel.components().skip(1).collect();
        if rel.as_os_str().is_empty() {
            continue;
        }
        let mut to = dir.join(&rel);
        if rel.file_name().map(|n| n.to_string_lossy().starts_with("exiftool(")).unwrap_or(false) {
            to = dir.join("exiftool.exe");
        }
        if e.is_dir() {
            std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = to.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut w = std::fs::File::create(&to).map_err(|e| e.to_string())?;
            std::io::copy(&mut e, &mut w).map_err(|e| e.to_string())?;
        }
    }
    let _ = std::fs::remove_file(&tmp);
    if exiftool().is_none() {
        return Err("ExifTool didn’t unpack as expected".into());
    }
    Ok(())
}

/// run ExifTool with arguments from a UTF-8 argument file (any number of files, any characters in names)
async fn run(args: &[String], files: &[String]) -> Result<util::Output, String> {
    let exe = exiftool().ok_or("NEED_EXIFTOOL")?;
    let argfile = std::env::temp_dir().join(format!("dogfile-exif-{}.args", util::now_ms() as u64));
    let mut body = String::new();
    for a in args.iter().chain(files.iter()) {
        // one argument per line; a line break inside a value would split it
        body.push_str(&a.replace(['\r', '\n'], " "));
        body.push('\n');
    }
    std::fs::write(&argfile, body).map_err(|e| e.to_string())?;
    let all = vec!["-charset".into(), "filename=utf8".into(), "-charset".into(), "utf8".into(), "-@".into(), argfile.to_string_lossy().to_string()];
    let o = util::run(&exe, &all, None, 600_000).await.map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&argfile);
    o
}

/// meta:read [paths]: every tag of each file, grouped ({ "SourceFile", "EXIF:Make": …, "XMP:Rating": … }),
/// numbers as numbers where that's useful (-n for GPS)
pub async fn read(a: &Args) -> R {
    let files = a.strs(0);
    if files.is_empty() {
        return Ok(json!([]));
    }
    let o = run(&["-json".into(), "-G1".into(), "-a".into(), "-s".into(), "-struct".into(), "-c".into(), "%+.6f".into(), "-api".into(), "LargeFileSupport=1".into()], &files).await?;
    let v: Value = serde_json::from_slice(&o.stdout).map_err(|_| {
        let e = String::from_utf8_lossy(&o.stderr).trim().to_string();
        if e.is_empty() { "ExifTool couldn’t read these files".to_string() } else { e }
    })?;
    Ok(v)
}

/// tags anyone may set from the editor (the values are passed to ExifTool as they are)
fn tag_ok(t: &str) -> bool {
    regex::Regex::new(r"^[A-Za-z0-9-]+(:[A-Za-z0-9-]+)?$").unwrap().is_match(t)
}
/// meta:write [paths] {tag: value | null (remove)} {keepBackup}: writes into the files (dates of the files kept)
pub async fn write(a: &Args) -> R {
    let files = a.strs(0);
    let changes = a.v(1);
    let opts = a.v(2);
    let Some(ch) = changes.as_object() else { return Err("Nothing to change".into()) };
    let mut args: Vec<String> = vec!["-m".into(), "-P".into()];
    if opts["keepBackup"].as_bool() != Some(true) {
        args.push("-overwrite_original".into());
    }
    for (k, v) in ch {
        if !tag_ok(k) {
            return Err(format!("“{k}” isn’t a tag name"));
        }
        match v {
            Value::Null => args.push(format!("-{k}=")),
            Value::Array(list) => {
                // a list (keywords): replace it
                args.push(format!("-{k}="));
                for x in list {
                    args.push(format!("-{k}+={}", x.as_str().map(String::from).unwrap_or_else(|| x.to_string())));
                }
            }
            Value::String(s) if s.is_empty() => args.push(format!("-{k}=")),
            Value::String(s) => args.push(format!("-{k}={s}")),
            x => args.push(format!("-{k}={x}")),
        }
    }
    // GPS written as numbers takes the right hemisphere from the sign
    if ch.keys().any(|k| k.starts_with("GPSLatitude") || k.starts_with("GPSLongitude")) {
        args.push("-n".into());
    }
    finish(run(&args, &files).await?)
}
/// meta:stripGps [paths]: the location out of photos (EXIF GPS and XMP location), nothing else touched
pub async fn strip_gps(a: &Args) -> R {
    let files = a.strs(0);
    let args: Vec<String> = ["-m", "-P", "-overwrite_original", "-gps:all=", "-xmp:geotag=", "-xmp-exif:GPS*=", "-xmp-iptcExt:LocationCreated=", "-xmp-iptcExt:LocationShown=", "-xmp-photoshop:City=", "-xmp-photoshop:State=", "-xmp-photoshop:Country="].iter().map(|s| s.to_string()).collect();
    finish(run(&args, &files).await?)
}
/// meta:stripAll [paths]: all metadata out (orientation and colour profile kept so pictures still look right);
/// RAW files are left alone (their makers' data is needed to develop them)
pub async fn strip_all(a: &Args) -> R {
    let raw = regex::Regex::new(r"(?i)\.(cr2|cr3|crw|nef|nrw|arw|srf|sr2|dng|orf|raf|rw2|pef|srw|x3f|3fr|erf|kdc|mef|mos|mrw|rwl|iiq)$").unwrap();
    let (skip, files): (Vec<String>, Vec<String>) = a.strs(0).into_iter().partition(|f| raw.is_match(f));
    let mut out = if files.is_empty() {
        json!({ "updated": 0, "unchanged": 0, "errors": [] })
    } else {
        let args: Vec<String> = ["-m", "-P", "-overwrite_original", "-all=", "-tagsfromfile", "@", "-Orientation", "-ICC_Profile", "-ColorSpaceTags"].iter().map(|s| s.to_string()).collect();
        finish(run(&args, &files).await?)?
    };
    out["skippedRaw"] = json!(skip.len());
    Ok(out)
}
/// ExifTool's summary as {updated, unchanged, errors}
fn finish(o: util::Output) -> R {
    let text = format!("{}\n{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
    let num = |re: &str| regex::Regex::new(re).unwrap().captures(&text).and_then(|c| c[1].parse::<u64>().ok()).unwrap_or(0);
    let errors: Vec<String> = text.lines().filter(|l| l.starts_with("Error")).map(|l| l.trim_start_matches("Error: ").to_string()).take(20).collect();
    let updated = num(r"(\d+) image files? updated");
    if updated == 0 && !errors.is_empty() {
        return Err(errors[0].clone());
    }
    Ok(json!({ "updated": updated, "unchanged": num(r"(\d+) image files? unchanged"), "errors": errors }))
}

// ---------------------------------------------------------------------------------------------------------------
// NTFS alternate data streams

/// meta:streams path: [{name, size}] (the main contents are left out)
pub fn streams(a: &Args) -> R {
    let p = a.s(0)?;
    #[cfg(windows)]
    {
        return Ok(json!(win::list(&p)?.into_iter().map(|(n, s)| json!({ "name": n, "size": s })).collect::<Vec<_>>()));
    }
    #[allow(unreachable_code)]
    {
        let _ = p;
        Ok(json!([]))
    }
}
/// meta:streamsMany [paths]: {path: [{name, size}]} for the files that have any
pub fn streams_many(a: &Args) -> R {
    let mut out = serde_json::Map::new();
    #[cfg(windows)]
    for p in a.strs(0) {
        if let Ok(l) = win::list(&p) {
            if !l.is_empty() {
                out.insert(p, json!(l.into_iter().map(|(n, s)| json!({ "name": n, "size": s })).collect::<Vec<_>>()));
            }
        }
    }
    let _ = a;
    Ok(Value::Object(out))
}
fn stream_path(p: &str, name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("That isn’t a stream name".into());
    }
    Ok(format!("{p}:{name}"))
}
/// meta:streamRead path name [max]: the stream's bytes (base64) and whether it reads as text
pub fn stream_read(a: &Args) -> R {
    let sp = stream_path(&a.s(0)?, &a.s(1)?)?;
    let max = a.u(2, 256 * 1024) as usize;
    let mut b = std::fs::read(&sp).map_err(|e| e.to_string())?;
    let size = b.len();
    b.truncate(max);
    let text = std::str::from_utf8(&b).ok().filter(|t| !t.contains('\0')).map(String::from);
    Ok(json!({ "size": size, "text": text, "data": util::b64(&b) }))
}
/// meta:streamWrite path name text: adds or replaces a stream
pub fn stream_write(a: &Args) -> R {
    let sp = stream_path(&a.s(0)?, &a.s(1)?)?;
    std::fs::write(&sp, a.s_or(2, "")).map_err(|e| e.to_string())?;
    Ok(json!(true))
}
/// meta:streamRemove [paths] name|"*": removes a stream from each file ("*" = all of them)
pub fn stream_remove(a: &Args) -> R {
    let name = a.s(1)?;
    let mut n = 0;
    let mut errors = vec![];
    for p in a.strs(0) {
        #[cfg(windows)]
        let names: Vec<String> = if name == "*" { win::list(&p).map(|l| l.into_iter().map(|x| x.0).collect()).unwrap_or_default() } else { vec![name.clone()] };
        #[cfg(not(windows))]
        let names: Vec<String> = vec![];
        for s in names {
            match stream_path(&p, &s).and_then(|sp| std::fs::remove_file(&sp).map_err(|e| e.to_string())) {
                Ok(()) => n += 1,
                Err(e) => errors.push(format!("{}: {e}", util::basename(&p))),
            }
        }
    }
    Ok(json!({ "removed": n, "errors": errors }))
}

#[cfg(windows)]
mod win {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{FindClose, FindFirstStreamW, FindNextStreamW, FindStreamInfoStandard, WIN32_FIND_STREAM_DATA};
    /// the file's extra streams: (name, size), without the main one
    pub fn list(p: &str) -> Result<Vec<(String, u64)>, String> {
        let mut out = vec![];
        unsafe {
            let mut d = WIN32_FIND_STREAM_DATA::default();
            let h = match FindFirstStreamW(&HSTRING::from(p), FindStreamInfoStandard, &mut d as *mut _ as *mut core::ffi::c_void, 0) {
                Ok(h) => h,
                // no streams at all (folders on some drives, or not NTFS)
                Err(_) => return Ok(out),
            };
            loop {
                let n = d.cStreamName.iter().position(|&c| c == 0).unwrap_or(d.cStreamName.len());
                let full = String::from_utf16_lossy(&d.cStreamName[..n]);
                // ":name:$DATA"; the main contents are "::$DATA"
                let name = full.trim_start_matches(':').trim_end_matches(":$DATA").to_string();
                if !name.is_empty() {
                    out.push((name, d.StreamSize.max(0) as u64));
                }
                if FindNextStreamW(h, &mut d as *mut _ as *mut core::ffi::c_void).is_err() {
                    break;
                }
            }
            let _ = FindClose(h);
        }
        Ok(out)
    }
}
