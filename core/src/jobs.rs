// The background jobs Dogfile used to run in a Node worker, now native and parallel. Messages keep the same
// shapes ({type: results | progress | done | error}) so the app treats them exactly as before.
use crate::matcher::Spec;
use crate::proto::{self, Batcher, Progress};
use crate::util;
use crate::walk::{self, Ent, Visit, WalkOpts};
use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

fn roots_of(j: &Value) -> Vec<PathBuf> {
    j["roots"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(PathBuf::from).collect()).unwrap_or_default()
}
fn skip_of(j: &Value) -> Vec<String> {
    j["skipDirs"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

pub fn item_json(e: &Ent) -> Value {
    json!({ "name": e.name, "path": util::path_str(&e.path), "isDir": e.is_dir, "size": if e.is_dir { 0 } else { e.size },
            "mtime": e.mtime, "ctime": e.ctime, "atime": e.atime, "isLink": e.is_link })
}

// ---------------- search (walking the folders) ----------------
fn content_match(path: &Path, size: u64, s: &Spec) -> bool {
    let Some(re) = &s.content else { return true };
    if size > s.max_content { return false }
    let Ok(mut f) = File::open(path) else { return false };
    let mut buf = Vec::with_capacity(size.min(1 << 24) as usize);
    if f.read_to_end(&mut buf).is_err() { return false }
    let utf16 = buf.len() >= 2 && buf[0] == 0xff && buf[1] == 0xfe;
    if !utf16 && memchr::memchr(0, &buf[..buf.len().min(8192)]).is_some() { return false } // binary
    if utf16 {
        let u: Vec<u16> = buf[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return re.is_match(String::from_utf16_lossy(&u).as_bytes());
    }
    re.is_match(&buf)
}

pub fn search(id: u64, j: &Value, cancel: &AtomicBool) -> Result<Value, String> {
    let spec = Spec::from_job(j)?;
    let roots = roots_of(j);
    let max = j["maxResults"].as_u64().unwrap_or(20000);
    let skip = skip_of(j);
    let batch = Batcher::new(id);
    let count = AtomicU64::new(0);
    let scanned = AtomicU64::new(0);
    let opts = WalkOpts { recursive: j["recursive"].as_bool() != Some(false), skip_dirs: &skip, cancel: Some(cancel) };
    walk::walk(&roots, &opts, |_, e| {
        let sc = scanned.fetch_add(1, Ordering::Relaxed) + 1;
        if !spec.include_hidden && e.name.starts_with('.') { return Visit::SkipChildren }
        let low = e.name.to_lowercase();
        // hidden-by-attribute items are still walked into; the old search only skipped dot-names
        let ok = spec.name_ok(&e.name, &low, e.is_dir, false)
            && spec.meta_ok(e.is_dir, e.size, e.mtime, e.ctime, e.atime)
            && (!spec.has_path_words() || spec.path_ok(&util::path_str(&e.path).to_lowercase()))
            && (spec.content.is_none() || (!e.is_dir && content_match(&e.path, e.size, &spec)));
        if ok {
            let c = count.fetch_add(1, Ordering::Relaxed) + 1;
            if c <= max { batch.push(item_json(e), sc) }
            if c >= max { cancel.store(true, Ordering::Relaxed) }
        } else if sc % 512 == 0 {
            batch.tick(sc);
        }
        Visit::Continue
    }, |_, _| {});
    let sc = scanned.load(Ordering::Relaxed);
    batch.flush(sc);
    Ok(json!({ "scanned": sc }))
}

// ---------------- folder size ----------------
pub fn size(id: u64, j: &Value, cancel: &AtomicBool) -> Result<Value, String> {
    let root = PathBuf::from(j["root"].as_str().ok_or("root missing")?);
    let with_children = j["children"].as_bool().unwrap_or(false);
    let total = AtomicU64::new(0);
    let files = AtomicU64::new(0);
    let dirs = AtomicU64::new(0);
    // top-level child -> (size, files)
    let children: Mutex<HashMap<PathBuf, (bool, u64, u64)>> = Mutex::new(HashMap::new());
    let prog = Progress::new(id, 300);
    let opts = WalkOpts { recursive: true, skip_dirs: &[], cancel: Some(cancel) };
    let top_of = |p: &Path| -> Option<PathBuf> { p.strip_prefix(&root).ok().and_then(|r| r.components().next()).map(|c| root.join(c.as_os_str())) };
    walk::walk(std::slice::from_ref(&root), &opts, |parent, e| {
        if e.is_dir {
            if !e.is_link { dirs.fetch_add(1, Ordering::Relaxed); }
            if with_children && parent == root { children.lock().unwrap().entry(e.path.clone()).or_insert((true, 0, 0)); }
        } else if !e.is_link {
            total.fetch_add(e.size, Ordering::Relaxed);
            files.fetch_add(1, Ordering::Relaxed);
            if with_children {
                let key = if parent == root { e.path.clone() } else { top_of(parent).unwrap_or_else(|| e.path.clone()) };
                let mut c = children.lock().unwrap();
                let ent = c.entry(key).or_insert((parent != root, 0, 0));
                ent.1 += e.size;
                ent.2 += 1;
            }
        }
        if prog.due() {
            let ch: Option<Vec<Value>> = if with_children { Some(children_json(&children.lock().unwrap())) } else { None };
            prog.send(json!({ "total": total.load(Ordering::Relaxed), "files": files.load(Ordering::Relaxed), "dirs": dirs.load(Ordering::Relaxed), "current": util::path_str(parent), "children": ch }));
        }
        Visit::Continue
    }, |_, _| {});
    let mut out = json!({ "total": total.load(Ordering::Relaxed), "files": files.load(Ordering::Relaxed), "dirs": dirs.load(Ordering::Relaxed) });
    if with_children {
        let mut ch = children_json(&children.lock().unwrap());
        ch.sort_by(|a, b| b["size"].as_u64().cmp(&a["size"].as_u64()));
        out["children"] = Value::Array(ch);
    }
    Ok(out)
}
fn children_json(m: &HashMap<PathBuf, (bool, u64, u64)>) -> Vec<Value> {
    m.iter().map(|(p, (d, s, f))| json!({ "path": util::path_str(p), "name": p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), "isDir": d, "size": s, "files": f })).collect()
}

// ---------------- duplicates ----------------
fn hash_xxh(path: &Path, limit: Option<u64>) -> Option<u128> {
    let mut f = File::open(path).ok()?;
    let mut h = xxhash_rust::xxh3::Xxh3::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut left = limit.unwrap_or(u64::MAX);
    while left > 0 {
        let want = (buf.len() as u64).min(left) as usize;
        let n = f.read(&mut buf[..want]).ok()?;
        if n == 0 { break }
        h.update(&buf[..n]);
        left -= n as u64;
    }
    Some(h.digest128())
}

pub fn dupes(id: u64, j: &Value, cancel: &AtomicBool) -> Result<Value, String> {
    let roots = roots_of(j);
    let min = j["minSize"].as_u64().unwrap_or(1);
    let by_size: Mutex<HashMap<u64, Vec<Ent>>> = Mutex::new(HashMap::new());
    let prog = Progress::new(id, 300);
    let scanned = AtomicU64::new(0);
    let opts = WalkOpts { recursive: true, skip_dirs: &[], cancel: Some(cancel) };
    walk::walk(&roots, &opts, |parent, e| {
        let n = scanned.fetch_add(1, Ordering::Relaxed);
        if !e.is_dir && !e.is_link && e.size >= min {
            by_size.lock().unwrap().entry(e.size).or_default().push(e.clone());
        }
        if prog.due() { prog.send(json!({ "phase": "Scanning", "scanned": n, "current": util::path_str(parent) })); }
        Visit::Continue
    }, |_, _| {});
    let cands: Vec<Vec<Ent>> = by_size.into_inner().unwrap().into_values().filter(|v| v.len() > 1).collect();
    let total = cands.len();
    let done = AtomicUsize::new(0);
    let groups: Mutex<Vec<(u64, Vec<Ent>)>> = Mutex::new(Vec::new());
    cands.into_par_iter().for_each(|arr| {
        if cancel.load(Ordering::Relaxed) { return }
        let size = arr[0].size;
        // first 64 KB, then (if still alike) the whole file
        let mut by_head: HashMap<u128, Vec<Ent>> = HashMap::new();
        for f in arr { if let Some(h) = hash_xxh(&f.path, Some(65536)) { by_head.entry(h).or_default().push(f) } }
        for (_, a) in by_head {
            if a.len() < 2 { continue }
            if size <= 65536 { groups.lock().unwrap().push((size, a)); continue }
            let mut by_full: HashMap<u128, Vec<Ent>> = HashMap::new();
            for f in a { if let Some(h) = hash_xxh(&f.path, None) { by_full.entry(h).or_default().push(f) } }
            for (_, b) in by_full { if b.len() > 1 { groups.lock().unwrap().push((size, b)) } }
        }
        let d = done.fetch_add(1, Ordering::Relaxed) + 1;
        if prog.due() { prog.send(json!({ "phase": "Comparing", "scanned": d, "of": total, "groups": groups.lock().unwrap().len() })); }
    });
    let mut g = groups.into_inner().unwrap();
    g.sort_by(|a, b| (b.0 * b.1.len() as u64).cmp(&(a.0 * a.1.len() as u64)));
    let out: Vec<Value> = g.iter().map(|(s, files)| json!({ "size": s, "files": files.iter().map(|f| json!({ "path": util::path_str(&f.path), "name": f.name, "size": f.size, "mtime": f.mtime })).collect::<Vec<_>>() })).collect();
    Ok(json!({ "groups": out }))
}

// ---------------- storage inventory (cleanup center) ----------------
fn cat_of(ext: &str) -> &'static str {
    const CAT: [(&str, &[&str]); 7] = [
        ("Pictures", &["jpg", "jpeg", "jfif", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "raw", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "psd", "svg", "ico"]),
        ("Videos", &["mp4", "m4v", "mkv", "mov", "avi", "wmv", "webm", "flv", "mpg", "mpeg", "m2ts", "mts", "ts", "vob", "3gp"]),
        ("Music & audio", &["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "wma", "aif", "aiff", "alac", "mid", "midi"]),
        ("Documents", &["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "epub", "xls", "xlsx", "csv", "ods", "ppt", "pptx", "odp", "pages", "numbers", "key"]),
        ("Archives & disk images", &["zip", "rar", "7z", "gz", "tgz", "xz", "bz2", "tar", "iso", "img", "vhd", "vhdx", "dmg", "cab"]),
        ("Programs & installers", &["exe", "msi", "msix", "msixbundle", "appx", "dll", "sys", "apk"]),
        ("Code & projects", &["js", "ts", "jsx", "tsx", "py", "cs", "cpp", "c", "h", "java", "go", "rs", "json", "html", "css", "map", "lock", "pyc", "o", "obj", "pdb", "class", "jar"]),
    ];
    for (n, list) in CAT { if list.contains(&ext) { return n } }
    "Other"
}
fn is_temp_name(name: &str) -> bool {
    let l = name.to_lowercase();
    l.starts_with("~$") || l == "thumbs.db" || l == ".ds_store" || l == "desktop.ini.bak"
        || [".tmp", ".temp", ".crdownload", ".part", ".partial", ".dmp", ".old", ".bak", ".chk", ".gid", ".log1", ".etl"].iter().any(|s| l.ends_with(s))
}

pub fn inventory(id: u64, j: &Value, cancel: &AtomicBool) -> Result<Value, String> {
    let now = util::now_ms();
    const DAY: f64 = 86_400_000.0;
    let roots = roots_of(j);
    let skip = skip_of(j);
    let temp_roots: Vec<String> = j["tempRoots"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.to_lowercase()).collect()).unwrap_or_default();
    let dl_roots: Vec<String> = j["downloads"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.to_lowercase()).collect()).unwrap_or_default();
    let installer_days = j["installerDays"].as_f64().unwrap_or(14.0);
    let large_old_mb = j["largeOldMB"].as_f64().unwrap_or(500.0);
    let large_old_days = j["largeOldDays"].as_f64().unwrap_or(365.0);

    #[derive(Default)]
    struct Acc {
        total: u64, files: u64, dirs: u64,
        by_type: HashMap<&'static str, u64>, by_age: [u64; 5], by_folder: HashMap<String, u64>,
        installers: Vec<Value>, temp: Vec<Value>, large_old: Vec<Value>, big: Vec<Value>, docs: Vec<Value>, images: Vec<Value>,
        counts: HashMap<PathBuf, usize>, parents: HashMap<PathBuf, PathBuf>,
    }
    let acc = Mutex::new(Acc::default());
    let prog = Progress::new(id, 300);
    let scanned = AtomicU64::new(0);
    let opts = WalkOpts { recursive: true, skip_dirs: &skip, cancel: Some(cancel) };
    let top_of = |p: &Path| -> Option<String> {
        for r in &roots { if let Ok(rel) = p.strip_prefix(r) { return rel.components().next().map(|c| util::path_str(&r.join(c.as_os_str()))) } }
        None
    };
    let lim = |v: &mut Vec<Value>, x: Value, n: usize| { if v.len() < n { v.push(x) } };
    walk::walk(&roots, &opts, |parent, e| {
        let sc = scanned.fetch_add(1, Ordering::Relaxed);
        let is_root_parent = roots.iter().any(|r| r == parent);
        if e.is_dir {
            if e.is_link || util::is_skip_dir(&e.name) || skip.contains(&e.name) { return Visit::SkipChildren }
            let mut a = acc.lock().unwrap();
            a.dirs += 1;
            a.parents.insert(e.path.clone(), parent.to_path_buf());
            if is_root_parent { a.by_folder.entry(util::path_str(&e.path)).or_insert(0); }
            return Visit::Continue;
        }
        if e.is_link { return Visit::Continue }
        let ext = util::ext_of(&e.name);
        let cat = cat_of(&ext);
        let age = (now - e.mtime) / DAY;
        let item = json!({ "path": util::path_str(&e.path), "name": e.name, "size": e.size, "mtime": e.mtime, "ext": ext });
        let low = util::path_str(&e.path).to_lowercase();
        let in_temp = temp_roots.iter().any(|r| low.starts_with(r));
        let folder_key = if is_root_parent { "(files here)".to_string() } else { top_of(parent).unwrap_or_else(|| "(files here)".into()) };
        let mut a = acc.lock().unwrap();
        a.total += e.size;
        a.files += 1;
        *a.by_type.entry(cat).or_insert(0) += e.size;
        let bucket = if age < 30.0 { 0 } else if age < 182.0 { 1 } else if age < 365.0 { 2 } else if age < 1095.0 { 3 } else { 4 };
        a.by_age[bucket] += e.size;
        *a.by_folder.entry(folder_key).or_insert(0) += e.size;
        let with_why = |why: String| { let mut x = item.clone(); x["why"] = json!(why); x };
        if matches!(ext.as_str(), "exe" | "msi" | "msix" | "msixbundle" | "appx" | "appxbundle") && dl_roots.iter().any(|r| low.starts_with(r)) && age > installer_days {
            let x = with_why(format!("installer, downloaded {} days ago", age.round()));
            lim(&mut a.installers, x, 4000);
        } else if (in_temp && age > 1.0) || (is_temp_name(&e.name) && age > 2.0) {
            let x = with_why(if in_temp { "in the temporary files folder".into() } else { "leftover temporary file".into() });
            lim(&mut a.temp, x, 4000);
        }
        if e.size as f64 >= large_old_mb * 1048576.0 && age > large_old_days {
            let x = with_why(format!("{:.1} GB, untouched for {} months", e.size as f64 / 1073741824.0, (age / 30.0).round()));
            lim(&mut a.large_old, x, 4000);
        }
        if e.size >= 100 * 1048576 { lim(&mut a.big, item.clone(), 2000) }
        if cat == "Documents" && e.size > 0 { lim(&mut a.docs, item, 20000) }
        else if cat == "Pictures" && e.size > 10240 && matches!(ext.as_str(), "jpg" | "jpeg" | "jfif" | "png" | "webp" | "bmp" | "gif" | "heic" | "avif" | "tif" | "tiff") { lim(&mut a.images, item, 20000) }
        drop(a);
        if prog.due() { let a = acc.lock().unwrap(); prog.send(json!({ "scanned": sc, "files": a.files, "total": a.total, "current": util::path_str(parent) })); }
        Visit::Continue
    }, |dir, n| { acc.lock().unwrap().counts.insert(dir.to_path_buf(), if n == usize::MAX { 1 } else { n }); });
    let mut a = acc.into_inner().unwrap();
    // empty folders (and folders holding only empty folders): deepest first
    let mut dirs: Vec<PathBuf> = a.counts.keys().cloned().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    let mut empty_kids: HashMap<PathBuf, usize> = HashMap::new();
    let mut empty: std::collections::HashSet<PathBuf> = Default::default();
    for d in &dirs {
        if roots.contains(d) { continue }
        let c = a.counts.get(d).copied().unwrap_or(0);
        if c - empty_kids.get(d).copied().unwrap_or(0).min(c) == 0 {
            empty.insert(d.clone());
            if let Some(p) = a.parents.get(d) { *empty_kids.entry(p.clone()).or_insert(0) += 1; }
        }
    }
    let mut empty_dirs = Vec::new();
    for d in &empty {
        if a.parents.get(d).map(|p| empty.contains(p)).unwrap_or(false) { continue }
        if empty_dirs.len() < 4000 { empty_dirs.push(json!({ "path": util::path_str(d), "name": d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), "size": 0, "isDir": true, "why": "empty folder" })); }
    }
    a.big.sort_by(|x, y| y["size"].as_u64().cmp(&x["size"].as_u64()));
    let mut folders: Vec<(String, u64)> = a.by_folder.into_iter().collect();
    folders.sort_by(|x, y| y.1.cmp(&x.1));
    let by_folder: Vec<Value> = folders.into_iter().take(40).map(|(p, s)| json!({ "path": p, "name": Path::new(&p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(p.clone()), "size": s })).collect();
    let ages = ["Last 30 days", "1-6 months", "6-12 months", "1-3 years", "Over 3 years"];
    let by_age: serde_json::Map<String, Value> = ages.iter().zip(a.by_age.iter()).map(|(k, v)| (k.to_string(), json!(v))).collect();
    Ok(json!({ "total": a.total, "files": a.files, "dirs": a.dirs, "byType": a.by_type, "byAge": by_age, "byFolder": by_folder,
        "installers": a.installers, "temp": a.temp, "emptyDirs": empty_dirs, "largeOld": a.large_old, "big": a.big, "docs": a.docs, "images": a.images }))
}

// ---------------- checksums ----------------
fn hash_algo(path: &Path, algo: &str, bytes: &AtomicU64) -> Result<String, String> {
    use sha2::Digest;
    let mut f = File::open(path).map_err(|e| e.kind().to_string())?;
    let mut buf = vec![0u8; 1 << 20];
    macro_rules! run { ($h:expr) => {{
        let mut h = $h;
        loop { let n = f.read(&mut buf).map_err(|e| e.kind().to_string())?; if n == 0 { break } h.update(&buf[..n]); bytes.fetch_add(n as u64, Ordering::Relaxed); }
        Ok(h.finalize().iter().map(|b| format!("{:02x}", b)).collect())
    }}}
    match algo {
        "sha1" => run!(sha1::Sha1::new()),
        "md5" => run!(md5::Md5::new()),
        "sha512" => run!(sha2::Sha512::new()),
        _ => run!(sha2::Sha256::new()),
    }
}

pub fn hashfiles(id: u64, j: &Value, cancel: &AtomicBool) -> Result<Value, String> {
    let algo = j["algo"].as_str().unwrap_or("sha256").to_string();
    let mut list: Vec<(PathBuf, String, Option<u64>)> = Vec::new(); // abs, rel, size (None = missing)
    for f in j["files"].as_array().cloned().unwrap_or_default() {
        let abs = PathBuf::from(f["abs"].as_str().unwrap_or(""));
        let rel = f["rel"].as_str().unwrap_or("").to_string();
        match std::fs::metadata(&abs) {
            Err(_) => list.push((abs, rel, None)),
            Ok(m) if !m.is_dir() => list.push((abs, rel, Some(m.len()))),
            Ok(_) => {
                let found: Mutex<Vec<(PathBuf, String, Option<u64>)>> = Mutex::new(Vec::new());
                let opts = WalkOpts { recursive: true, skip_dirs: &[], cancel: Some(cancel) };
                walk::walk(std::slice::from_ref(&abs), &opts, |_, e| {
                    if !e.is_dir && !e.is_link {
                        let lname = e.name.to_lowercase();
                        if ![".sha256", ".sha1", ".md5", ".sfv"].iter().any(|s| lname.ends_with(s)) {
                            let r = e.path.strip_prefix(&abs).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                            let r = if rel.is_empty() { r } else { format!("{rel}/{r}") };
                            found.lock().unwrap().push((e.path.clone(), r, Some(e.size)));
                        }
                    }
                    Visit::Continue
                }, |_, _| {});
                let mut v = found.into_inner().unwrap();
                v.sort_by(|a, b| a.1.cmp(&b.1));
                list.extend(v);
            }
        }
    }
    let total: u64 = list.iter().filter_map(|x| x.2).sum();
    let bytes = AtomicU64::new(0);
    let done = AtomicUsize::new(0);
    let prog = Progress::new(id, 250);
    let n = list.len();
    let out: Vec<Value> = list.par_iter().map(|(abs, rel, size)| {
        if cancel.load(Ordering::Relaxed) { return json!({ "rel": rel, "abs": util::path_str(abs), "error": "cancelled" }) }
        let r = match size {
            None => json!({ "rel": rel, "abs": util::path_str(abs), "missing": true }),
            Some(s) => match hash_algo(abs, &algo, &bytes) {
                Ok(h) => json!({ "rel": rel, "abs": util::path_str(abs), "hash": h, "size": s }),
                Err(e) => json!({ "rel": rel, "abs": util::path_str(abs), "error": e }),
            },
        };
        let d = done.fetch_add(1, Ordering::Relaxed) + 1;
        if prog.due() { prog.send(json!({ "done": d, "of": n, "bytes": bytes.load(Ordering::Relaxed), "total": total, "current": rel })); }
        r
    }).collect();
    Ok(json!({ "files": out }))
}

// ---------------- one folder's listing (fs:list) ----------------
pub fn list(j: &Value) -> Result<Value, String> {
    let dir = j["path"].as_str().ok_or("path missing")?;
    let rd = std::fs::read_dir(dir).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => "EACCES".to_string(),
        std::io::ErrorKind::NotFound => "ENOENT".to_string(),
        _ => e.to_string(),
    })?;
    let ents: Vec<std::fs::DirEntry> = rd.flatten().collect();
    let items: Vec<Value> = ents.par_iter().filter_map(|d| {
        let ft = d.file_type().ok()?;
        let is_link = ft.is_symlink();
        let md = d.metadata().ok()?;
        let name = d.file_name().to_string_lossy().into_owned();
        let a = util::attrs(&md, &name);
        let (is_dir, broken, tmd) = if is_link {
            match std::fs::metadata(d.path()) { Ok(t) => (t.is_dir(), false, t), Err(_) => (false, true, md.clone()) }
        } else { (ft.is_dir(), false, md.clone()) };
        Some(json!({ "name": name, "path": util::path_str(&d.path()), "isDir": is_dir, "isLink": is_link, "broken": broken,
            "size": if is_dir { Value::Null } else { json!(tmd.len()) }, "mtime": util::ms(tmd.modified()), "ctime": util::ctime(&tmd),
            "atime": util::ms(tmd.accessed()), "hidden": a.hidden, "system": a.system, "readonly": a.readonly,
            "ext": if is_dir { String::new() } else { util::ext_of(&name) } }))
    }).collect();
    Ok(json!({ "path": dir, "items": items }))
}

/// Run a job and report: messages keep the old worker's shape.
pub fn run(id: u64, kind: &str, j: Value) {
    let cancel = proto::register(id);
    let r = match kind {
        "search" => search(id, &j, &cancel),
        "size" => size(id, &j, &cancel),
        "dupes" => dupes(id, &j, &cancel),
        "inventory" => inventory(id, &j, &cancel),
        "hashfiles" => hashfiles(id, &j, &cancel),
        _ => Err(format!("unknown job {kind}")),
    };
    proto::unregister(id);
    match r {
        Ok(v) => proto::send(id, "done", v),
        Err(e) => proto::send(id, "error", json!({ "error": e })),
    }
}
