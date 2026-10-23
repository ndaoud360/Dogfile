// fs:* — folder listings, file details, small reads and writes, renames, links, hashes.
use crate::args::{err, Args, R};
use crate::util::{self, basename, ms};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

fn io_code(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind::*;
    match e.kind() {
        NotFound => "ENOENT",
        PermissionDenied => "EACCES",
        AlreadyExists => "EEXIST",
        _ => {
            #[cfg(windows)]
            {
                match e.raw_os_error() {
                    Some(32) | Some(33) => return "EBUSY",
                    Some(5) => return "EPERM",
                    Some(145) => return "ENOTEMPTY",
                    _ => {}
                }
            }
            "EIO"
        }
    }
}
pub fn friendly(e: &std::io::Error) -> String {
    match io_code(e) {
        "ENOENT" => "This location could not be found".into(),
        "EACCES" | "EPERM" => "Access denied".into(),
        "EBUSY" => "The file is in use by another program".into(),
        _ => e.to_string(),
    }
}

/// natural order: "file 2" before "file 10", without case
pub fn nat_cmp(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let mut n1 = String::new();
                while let Some(&c) = x.peek() { if c.is_ascii_digit() { n1.push(c); x.next(); } else { break } }
                let mut n2 = String::new();
                while let Some(&d) = y.peek() { if d.is_ascii_digit() { n2.push(d); y.next(); } else { break } }
                let (t1, t2) = (n1.trim_start_matches('0'), n2.trim_start_matches('0'));
                let o = t1.len().cmp(&t2.len()).then(t1.cmp(t2));
                if o != Ordering::Equal { return o }
            }
            (Some(c), Some(d)) => {
                if c != d { return c.cmp(&d) }
                x.next();
                y.next();
            }
        }
    }
}

pub fn is_hidden(md: &std::fs::Metadata, name: &str) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let _ = name;
        md.file_attributes() & 0x2 != 0
    }
    #[cfg(not(windows))]
    {
        let _ = md;
        name.starts_with('.')
    }
}
pub fn readonly(md: &std::fs::Metadata) -> bool {
    md.permissions().readonly()
}

pub fn entry_json(path: &Path, md: &std::fs::Metadata) -> Value {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned());
    let is_dir = md.is_dir();
    json!({
        "name": name, "path": path.to_string_lossy(), "isDir": is_dir, "size": if is_dir { Value::Null } else { json!(md.len()) },
        "mtime": ms(md.modified()), "ctime": ctime(md), "atime": ms(md.accessed()), "hidden": is_hidden(md, &name),
        "ext": if is_dir { String::new() } else { util::ext(&name) },
    })
}
pub fn ctime(md: &std::fs::Metadata) -> f64 {
    let c = ms(md.created());
    if c != 0.0 { c } else { ms(md.modified()) }
}
fn mode_of(md: &std::fs::Metadata) -> u32 {
    (if md.is_dir() { 0o040000 } else { 0o100000 }) | if readonly(md) { 0o444 } else { 0o666 }
}

pub async fn list(a: &Args) -> R {
    let dir = a.s(0)?;
    // \\server: its shares
    if regex::Regex::new(r"^\\\\[^\\]+\\?$").unwrap().is_match(&dir) {
        let server = dir.trim_end_matches('\\').to_string();
        let shares = crate::sys::net_view(&server).await;
        let items: Vec<Value> = shares
            .iter()
            .map(|s| json!({ "name": s, "path": format!("{server}\\{s}"), "isDir": true, "size": null, "mtime": 0, "ctime": 0, "hidden": false, "system": false, "ext": "", "share": true }))
            .collect();
        return Ok(json!({ "path": dir, "items": items }));
    }
    match crate::engine::list(&dir).await {
        Ok(r) => Ok(json!({ "path": dir, "items": r["items"] })),
        Err(e) => {
            let (msg, code) = match e.as_str() {
                "EACCES" => ("Access denied".to_string(), "EACCES".to_string()),
                "ENOENT" => ("This location could not be found".to_string(), "ENOENT".to_string()),
                _ => (e.clone(), "EIO".to_string()),
            };
            Ok(json!({ "path": dir, "items": [], "error": msg, "code": code }))
        }
    }
}

pub async fn subdirs(a: &Args) -> R {
    let dir = a.s(0)?;
    let include_hidden = a.b(1);
    tokio::task::spawn_blocking(move || {
        let mut out = vec![];
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let Ok(md) = std::fs::metadata(e.path()) else { continue };
                if !md.is_dir() { continue }
                if !include_hidden {
                    let lmd = e.metadata().unwrap_or(md);
                    if is_hidden(&lmd, &name) { continue }
                }
                out.push(name);
            }
        }
        out.sort_by(|a, b| nat_cmp(a, b));
        Ok(json!(out))
    })
    .await
    .map_err(err)?
}

pub async fn stat(a: &Args) -> R {
    let p = a.s(0)?;
    Ok(match tokio::fs::metadata(&p).await {
        Ok(md) => json!({ "isDir": md.is_dir(), "size": md.len(), "mtime": ms(md.modified()), "ctime": ctime(&md), "atime": ms(md.accessed()), "mode": mode_of(&md) }),
        Err(_) => Value::Null,
    })
}
pub async fn stat_many(a: &Args) -> R {
    let mut out = vec![];
    for p in a.strs(0) {
        out.push(match tokio::fs::metadata(&p).await {
            Ok(md) => {
                let d = md.is_dir();
                let b = basename(&p);
                let name = if b.is_empty() { p.clone() } else { b };
                json!({ "name": name, "path": p, "isDir": d, "size": if d { Value::Null } else { json!(md.len()) }, "mtime": ms(md.modified()), "ctime": ctime(&md), "ext": if d { String::new() } else { util::ext(&p) }, "hidden": false })
            }
            Err(_) => Value::Null,
        });
    }
    Ok(json!(out))
}
pub async fn exists(a: &Args) -> R {
    Ok(json!(tokio::fs::symlink_metadata(a.s(0)?).await.is_ok()))
}
pub async fn is_dir(a: &Args) -> R {
    Ok(json!(tokio::fs::metadata(a.s(0)?).await.map(|m| m.is_dir()).unwrap_or(false)))
}
pub async fn mkdir(a: &Args) -> R {
    let p = a.s(0)?;
    tokio::fs::create_dir(&p).await.map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { format!("\"{}\" already exists", basename(&p)) } else { friendly(&e) })?;
    Ok(json!(p))
}
pub async fn new_file(a: &Args) -> R {
    let p = a.s(0)?;
    let content = a.s_or(1, "");
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&p).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { format!("\"{}\" already exists", basename(&p)) } else { friendly(&e) })?;
    use std::io::Write;
    f.write_all(content.as_bytes()).map_err(err)?;
    Ok(json!(p))
}
pub async fn rename(a: &Args) -> R {
    let (from, to) = (a.s(0)?, a.s(1)?);
    if from == to {
        return Ok(json!(to));
    }
    let case_only = from.to_lowercase() == to.to_lowercase();
    if !case_only && util::exists(Path::new(&to)) {
        return Err(format!("\"{}\" already exists", basename(&to)));
    }
    if case_only && util::IS_WIN {
        let tmp = format!("{from}.dogfile-tmp-{}", util::now_ms() as u64);
        std::fs::rename(&from, &tmp).map_err(|e| friendly(&e))?;
        std::fs::rename(&tmp, &to).map_err(|e| friendly(&e))?;
    } else {
        std::fs::rename(&from, &to).map_err(|e| friendly(&e))?;
    }
    Ok(json!(to))
}
pub async fn unique_name(a: &Args) -> R {
    Ok(json!(util::unique_name(&a.s(0)?, &a.s(1)?, &a.s_or(2, "copy"))))
}

fn decode_text(buf: &[u8]) -> String {
    if buf.len() >= 2 && buf[0] == 0xff && buf[1] == 0xfe {
        let u: Vec<u16> = buf[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u);
    }
    if buf.len() >= 2 && buf[0] == 0xfe && buf[1] == 0xff {
        let u: Vec<u16> = buf[2..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u);
    }
    let b = if buf.starts_with(&[0xef, 0xbb, 0xbf]) { &buf[3..] } else { buf };
    String::from_utf8_lossy(b).into_owned()
}
pub async fn read_text(a: &Args) -> R {
    let p = a.s(0)?;
    let max = a.u(1, 512 * 1024);
    tokio::task::spawn_blocking(move || {
        let mut f = std::fs::File::open(&p).map_err(|e| friendly(&e))?;
        let size = f.metadata().map(|m| m.len()).unwrap_or(0);
        let len = size.min(max) as usize;
        let mut buf = vec![0u8; len];
        let n = read_full(&mut f, &mut buf);
        buf.truncate(n);
        let head = &buf[..buf.len().min(8000)];
        let utf16 = buf.len() >= 2 && buf[0] == 0xff && buf[1] == 0xfe;
        let binary = head.contains(&0) && !utf16;
        Ok(json!({ "text": decode_text(&buf), "truncated": size > max, "size": size, "binary": binary }))
    })
    .await
    .map_err(err)?
}
fn read_full(f: &mut std::fs::File, buf: &mut [u8]) -> usize {
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(_) => break,
        }
    }
    n
}
pub async fn read_bytes(a: &Args) -> R {
    let p = a.s(0)?;
    let n = a.u(1, 4096).min(64 * 1024 * 1024) as usize;
    let off = a.u(2, 0);
    let mut f = std::fs::File::open(&p).map_err(|e| friendly(&e))?;
    f.seek(SeekFrom::Start(off)).map_err(err)?;
    let mut buf = vec![0u8; n];
    let k = read_full(&mut f, &mut buf);
    buf.truncate(k);
    Ok(json!(buf))
}
/// fs:compareBinary a b [maxRanges]: where two files differ, byte by byte (streamed: any size).
/// Differences closer than 16 bytes are one range. {sizeA, sizeB, identical, diffBytes, ranges: [[start, end]], truncated}
pub async fn compare_binary(a: &Args) -> R {
    let (pa, pb) = (a.s(0)?, a.s(1)?);
    let max = a.u(2, 500).clamp(1, 10_000) as usize;
    tokio::task::spawn_blocking(move || -> R {
        let mut fa = std::fs::File::open(&pa).map_err(|e| friendly(&e))?;
        let mut fb = std::fs::File::open(&pb).map_err(|e| friendly(&e))?;
        let (la, lb) = (fa.metadata().map_err(err)?.len(), fb.metadata().map_err(err)?.len());
        let mut ba = vec![0u8; 1 << 20];
        let mut bb = vec![0u8; 1 << 20];
        let mut ranges: Vec<(u64, u64)> = vec![];
        let (mut diff, mut off, mut truncated) = (0u64, 0u64, false);
        loop {
            let na = read_full(&mut fa, &mut ba);
            let nb = read_full(&mut fb, &mut bb);
            let n = na.min(nb);
            if ba[..n] != bb[..n] {
                for i in 0..n {
                    if ba[i] != bb[i] {
                        diff += 1;
                        let at = off + i as u64;
                        let n_ranges = ranges.len();
                        match ranges.last_mut() {
                            Some(r) if at <= r.1 + 16 => r.1 = at + 1,
                            _ if n_ranges < max => ranges.push((at, at + 1)),
                            _ => truncated = true,
                        }
                    }
                }
            }
            off += n as u64;
            if na < ba.len() || nb < bb.len() {
                break;
            }
        }
        // the longer file's tail is a difference too
        if la != lb {
            let (s, e) = (la.min(lb), la.max(lb));
            if ranges.len() < max { ranges.push((s, e)) } else { truncated = true }
        }
        Ok(json!({ "sizeA": la, "sizeB": lb, "identical": diff == 0 && la == lb, "diffBytes": diff, "extra": la.abs_diff(lb), "ranges": ranges.iter().map(|r| [r.0, r.1]).collect::<Vec<_>>(), "truncated": truncated }))
    })
    .await
    .map_err(err)?
}
pub async fn write_text(a: &Args) -> R {
    tokio::fs::write(a.s(0)?, a.s_or(1, "")).await.map_err(|e| friendly(&e))?;
    Ok(json!(true))
}
pub async fn write_data_url(a: &Args) -> R {
    let p = a.s(0)?;
    let d = a.s(1)?;
    let b = d.split_once(',').map(|x| x.1).unwrap_or("");
    tokio::fs::write(&p, util::unb64(b)?).await.map_err(|e| friendly(&e))?;
    Ok(json!(p))
}
pub async fn copy_file(a: &Args) -> R {
    let (x, y) = (a.s(0)?, a.s(1)?);
    tokio::fs::copy(&x, &y).await.map_err(|e| friendly(&e))?;
    Ok(json!(y))
}
pub async fn write_image(a: &Args) -> R {
    let p = a.s(0)?;
    match crate::clip::image_png() {
        Some(png) => {
            tokio::fs::write(&p, png).await.map_err(|e| friendly(&e))?;
            Ok(json!(true))
        }
        None => Ok(json!(false)),
    }
}
pub async fn hash(a: &Args) -> R {
    use md5::Digest;
    let p = a.s(0)?;
    let mut algos = a.strs(1);
    if algos.is_empty() {
        algos = vec!["md5".into(), "sha1".into(), "sha256".into()];
    }
    tokio::task::spawn_blocking(move || {
        let mut f = std::fs::File::open(&p).map_err(|e| friendly(&e))?;
        let mut m5 = md5::Md5::new();
        let mut s1 = sha1::Sha1::new();
        let mut s2 = sha2::Sha256::new();
        let mut s5 = sha2::Sha512::new();
        let want = |n: &str| algos.iter().any(|a| a == n);
        let mut buf = vec![0u8; 4 << 20];
        loop {
            let k = f.read(&mut buf).map_err(err)?;
            if k == 0 { break }
            let c = &buf[..k];
            if want("md5") { m5.update(c) }
            if want("sha1") { s1.update(c) }
            if want("sha256") { s2.update(c) }
            if want("sha512") { s5.update(c) }
        }
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        let mut out = serde_json::Map::new();
        if want("md5") { out.insert("md5".into(), json!(hex(&m5.finalize()))); }
        if want("sha1") { out.insert("sha1".into(), json!(hex(&s1.finalize()))); }
        if want("sha256") { out.insert("sha256".into(), json!(hex(&s2.finalize()))); }
        if want("sha512") { out.insert("sha512".into(), json!(hex(&s5.finalize()))); }
        Ok(Value::Object(out))
    })
    .await
    .map_err(err)?
}

pub async fn attributes(a: &Args) -> R {
    let p = a.s(0)?;
    let md = std::fs::symlink_metadata(&p).map_err(|e| friendly(&e))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let at = md.file_attributes();
        let created = crate::util::time_from_ms(ctime(&md));
        return Ok(json!({ "readonly": at & 1 != 0, "hidden": at & 2 != 0, "system": at & 4 != 0, "archive": at & 32 != 0, "compressed": at & 2048 != 0, "encrypted": at & 16384 != 0, "created": iso(created) }));
    }
    #[cfg(not(windows))]
    Ok(json!({ "readonly": readonly(&md), "hidden": basename(&p).starts_with('.'), "system": false, "archive": false }))
}
pub fn iso(t: std::time::SystemTime) -> String {
    let ms = util::ms(Ok(t)) as i64;
    iso_ms(ms)
}
/// UTC ISO 8601 text for a time in milliseconds
pub fn iso_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let milli = ms.rem_euclid(1000);
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil from days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}
pub async fn set_attributes(a: &Args) -> R {
    let paths = a.strs(0);
    let at = a.v(1);
    #[cfg(windows)]
    for p in &paths {
        crate::win::set_attributes(p, &at)?;
    }
    #[cfg(not(windows))]
    for p in &paths {
        if let Some(ro) = at.get("readonly").and_then(|v| v.as_bool()) {
            if let Ok(md) = std::fs::metadata(p) {
                let mut perm = md.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                perm.set_readonly(ro);
                let _ = std::fs::set_permissions(p, perm);
            }
        }
    }
    Ok(json!(true))
}
pub async fn set_times(a: &Args) -> R {
    let p = a.s(0)?;
    let t = a.v(1);
    let md = std::fs::metadata(&p).map_err(|e| friendly(&e))?;
    let at = t["atime"].as_f64().map(util::time_from_ms).unwrap_or(md.accessed().unwrap_or(std::time::SystemTime::now()));
    let mt = t["mtime"].as_f64().map(util::time_from_ms).unwrap_or(md.modified().unwrap_or(std::time::SystemTime::now()));
    filetime::set_file_times(&p, filetime::FileTime::from_system_time(at), filetime::FileTime::from_system_time(mt)).map_err(|e| friendly(&e))?;
    #[cfg(windows)]
    if let Some(c) = t["ctime"].as_f64() {
        let _ = crate::win::set_creation_time(&p, c);
    }
    Ok(json!(true))
}
pub async fn symlink(a: &Args) -> R {
    let (target, link) = (a.s(0)?, a.s(1)?);
    let kind = a.os(2);
    let dir = std::fs::metadata(&target).map(|m| m.is_dir()).unwrap_or(false);
    #[cfg(windows)]
    {
        let k = kind.unwrap_or_else(|| if dir { "junction".into() } else { "file".into() });
        if k == "junction" {
            crate::win::create_junction(&target, &link)?;
        } else if k == "dir" || dir {
            std::os::windows::fs::symlink_dir(&target, &link).map_err(|e| friendly(&e))?;
        } else {
            std::os::windows::fs::symlink_file(&target, &link).map_err(|e| friendly(&e))?;
        }
    }
    #[cfg(unix)]
    {
        let _ = (kind, dir);
        std::os::unix::fs::symlink(&target, &link).map_err(|e| friendly(&e))?;
    }
    Ok(json!(true))
}
pub async fn shortcut(a: &Args) -> R {
    let (lnk, target) = (a.s(0)?, a.s(1)?);
    #[cfg(windows)]
    {
        crate::win::create_shortcut(&lnk, &target)?;
        return Ok(json!(true));
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, lnk.trim_end_matches(".lnk")).map_err(|e| friendly(&e))?;
        Ok(json!(true))
    }
}
pub fn strip_verbatim(p: String) -> String {
    if let Some(r) = p.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{r}");
    }
    p.strip_prefix(r"\\?\").map(String::from).unwrap_or(p)
}
pub async fn read_link(a: &Args) -> R {
    let p = a.s(0)?;
    #[cfg(windows)]
    if p.to_lowercase().ends_with(".lnk") {
        return Ok(crate::win::read_shortcut(&p).map(Value::String).unwrap_or(Value::Null));
    }
    Ok(std::fs::canonicalize(&p).map(|x| json!(strip_verbatim(x.to_string_lossy().into_owned()))).unwrap_or(Value::Null))
}
pub async fn recent_windows() -> R {
    #[cfg(windows)]
    {
        let Some(dir) = dirs::data_dir().map(|d| d.join("Microsoft").join("Windows").join("Recent")) else { return Ok(json!([])) };
        let list = tokio::task::spawn_blocking(move || {
            let mut out: Vec<(f64, String)> = vec![];
            let mut ents: Vec<(f64, std::path::PathBuf)> = std::fs::read_dir(&dir).map(|rd| rd.flatten().filter(|e| e.file_name().to_string_lossy().to_lowercase().ends_with(".lnk")).map(|e| (e.metadata().map(|m| ms(m.modified())).unwrap_or(0.0), e.path())).collect()).unwrap_or_default();
            ents.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(Ordering::Equal));
            crate::win::com_init();
            for (t, p) in ents.into_iter().take(200) {
                if let Some(target) = crate::win::read_shortcut(&p.to_string_lossy()) {
                    out.push((t, target));
                }
                if out.len() >= 150 { break }
            }
            out
        })
        .await
        .map_err(err)?;
        return Ok(json!(list.into_iter().map(|(t, target)| json!({ "target": target, "time": t })).collect::<Vec<_>>()));
    }
    #[cfg(not(windows))]
    Ok(json!([]))
}

pub async fn find_under(a: &Args) -> R {
    let root = a.s(0)?;
    let q = a.s_or(1, "").to_lowercase();
    let limit = a.u(2, 300) as usize;
    if q.is_empty() {
        return Ok(json!([]));
    }
    tokio::task::spawn_blocking(move || {
        let skip = ["node_modules", ".git", "$recycle.bin", "system volume information", "windows", "appdata"];
        let t0 = std::time::Instant::now();
        let mut out = vec![];
        let mut queue = std::collections::VecDeque::from([std::path::PathBuf::from(&root)]);
        while let Some(dir) = queue.pop_front() {
            if out.len() >= limit || t0.elapsed().as_millis() > 4000 { break }
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                if name.to_lowercase().contains(&q) {
                    let md = e.metadata().ok();
                    out.push(json!({ "path": e.path().to_string_lossy(), "name": name, "isDir": is_dir, "size": md.as_ref().map(|m| m.len()).unwrap_or(0), "mtime": md.as_ref().map(|m| ms(m.modified())).unwrap_or(0.0) }));
                    if out.len() >= limit { break }
                }
                if is_dir && !name.starts_with('.') && !skip.contains(&name.to_lowercase().as_str()) {
                    queue.push_back(e.path());
                }
            }
        }
        Ok(json!(out))
    })
    .await
    .map_err(err)?
}

pub async fn trash(a: &Args) -> R {
    let p = a.s(0)?;
    tokio::task::spawn_blocking(move || trash::delete(&p).map_err(|e| e.to_string())).await.map_err(err)??;
    Ok(json!(true))
}

// ---------- text files with encodings (Dogfile Notepad) ----------
pub async fn read_buffer(a: &Args) -> R {
    let p = a.s(0)?;
    let max = a.u(1, 64 * 1024 * 1024);
    let md = std::fs::metadata(&p).map_err(|e| friendly(&e))?;
    if md.len() > max {
        return Err(format!("File is too large to edit ({} MB)", md.len() / 1048576));
    }
    let buf = tokio::fs::read(&p).await.map_err(|e| friendly(&e))?;
    Ok(json!({ "data": util::b64(&buf), "mtime": ms(md.modified()), "size": md.len(), "readonly": readonly(&md) }))
}
fn cp1252(c: u32) -> u8 {
    match c {
        0x20ac => 0x80, 0x201a => 0x82, 0x0192 => 0x83, 0x201e => 0x84, 0x2026 => 0x85, 0x2020 => 0x86, 0x2021 => 0x87, 0x02c6 => 0x88,
        0x2030 => 0x89, 0x0160 => 0x8a, 0x2039 => 0x8b, 0x0152 => 0x8c, 0x017d => 0x8e, 0x2018 => 0x91, 0x2019 => 0x92, 0x201c => 0x93,
        0x201d => 0x94, 0x2022 => 0x95, 0x2013 => 0x96, 0x2014 => 0x97, 0x02dc => 0x98, 0x2122 => 0x99, 0x0161 => 0x9a, 0x203a => 0x9b,
        0x0153 => 0x9c, 0x017e => 0x9e, 0x0178 => 0x9f,
        c if c < 0x80 || (0xa0..=0xff).contains(&c) => c as u8,
        _ => b'?',
    }
}
pub fn encode_text(text: &str, enc: &str) -> Vec<u8> {
    match enc {
        "utf8" => text.as_bytes().to_vec(),
        "utf8bom" => [&[0xef, 0xbb, 0xbf][..], text.as_bytes()].concat(),
        "utf16le" => {
            let mut v = vec![0xff, 0xfe];
            for u in text.encode_utf16() { v.extend_from_slice(&u.to_le_bytes()) }
            v
        }
        "utf16be" => {
            let mut v = vec![0xfe, 0xff];
            for u in text.encode_utf16() { v.extend_from_slice(&u.to_be_bytes()) }
            v
        }
        _ => text.chars().map(|c| cp1252(c as u32)).collect(),
    }
}
pub async fn write_encoded(a: &Args) -> R {
    let p = a.s(0)?;
    let data = encode_text(&a.s_or(1, ""), &a.s_or(2, "utf8"));
    tokio::fs::write(&p, data).await.map_err(|e| friendly(&e))?;
    let md = std::fs::metadata(&p).map_err(|e| friendly(&e))?;
    Ok(json!({ "mtime": ms(md.modified()), "size": md.len() }))
}
