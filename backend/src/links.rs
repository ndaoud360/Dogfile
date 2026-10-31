// Linked files: which files use which. A web page uses its styles and pictures, a music project (Ableton Live,
// REAPER, FL Studio) uses its samples, a video project its clips, a playlist its songs, a 3D model its textures, a
// shortcut its target. Dogfile reads those project files, keeps a list of who uses what, and:
//  - marks a file with a red dot when a file in another folder uses it,
//  - shows both directions in "See what's linked",
//  - warns before a used file is moved, renamed or deleted, saying what would break.
// The list is built in the background from the instant index (or a walk of the user's folders) and kept fresh for
// the folder being looked at. Everything stays on this PC.
use crate::args::{Args, R};
use crate::util;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

/// project files Dogfile can read, and what they're called
pub const SOURCES: &[(&str, &str)] = &[
    ("html", "Web page"), ("htm", "Web page"), ("css", "Style sheet"), ("svg", "Drawing"), ("md", "Markdown"),
    ("m3u", "Playlist"), ("m3u8", "Playlist"), ("pls", "Playlist"), ("xspf", "Playlist"), ("wpl", "Playlist"), ("cue", "CD sheet"),
    ("als", "Ableton Live set"), ("rpp", "REAPER project"), ("flp", "FL Studio project"),
    ("mlt", "Shotcut project"), ("kdenlive", "Kdenlive project"), ("prproj", "Premiere Pro project"),
    ("obj", "3D model"), ("mtl", "3D materials"), ("gltf", "3D model"), ("lnk", "Shortcut"),
];
fn label(ext: &str) -> &'static str {
    SOURCES.iter().find(|x| x.0 == ext).map(|x| x.1).unwrap_or("File")
}
fn re(cell: &'static OnceLock<Regex>, s: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(s).expect("regex"))
}
const MAX_SOURCE: u64 = 64 << 20;

// ---------------------------------------------------------------------------------------------------------------
// reading project files: the paths they mention, as written
fn gunzip(b: &[u8]) -> Option<String> {
    let mut d = flate2::read::GzDecoder::new(b);
    let mut s = String::new();
    d.by_ref().take(256 << 20).read_to_string(&mut s).ok()?;
    Some(s)
}
fn xml_unescape(s: &str) -> String {
    s.replace("&quot;", "\"").replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}
/// UTF-16 strings in a binary file that end like a file name (FL Studio keeps sample paths this way)
fn utf16_paths(b: &[u8], exts: &[&str]) -> Vec<String> {
    let mut out = vec![];
    for off in 0..2 {
        let mut cur: Vec<u16> = vec![];
        let mut i = off;
        while i + 1 < b.len() {
            let c = u16::from_le_bytes([b[i], b[i + 1]]);
            if c >= 0x20 && c != 0xffff {
                cur.push(c);
            } else {
                if cur.len() >= 5 {
                    let s = String::from_utf16_lossy(&cur);
                    let low = s.to_lowercase();
                    if (s.contains('\\') || s.contains('/')) && exts.iter().any(|e| low.ends_with(&format!(".{e}"))) {
                        // stray characters before the path (the bytes before it can read as letters): start at the drive
                        let b = s.as_bytes();
                        let start = (0..b.len().saturating_sub(2)).find(|&i| b[i].is_ascii_alphabetic() && b[i + 1] == b':' && (b[i + 2] == b'\\' || b[i + 2] == b'/') && s.is_char_boundary(i));
                        out.push(match start { Some(i) => s[i..].to_string(), None => s });
                    }
                }
                cur.clear();
            }
            i += 2;
        }
    }
    out
}
/// the target of a Windows shortcut (.lnk): the local path in its LinkInfo
fn lnk_target(b: &[u8]) -> Option<String> {
    let u32_at = |o: usize| b.get(o..o + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]) as usize);
    let u16_at = |o: usize| b.get(o..o + 2).map(|x| u16::from_le_bytes([x[0], x[1]]) as usize);
    if u32_at(0)? != 0x4c {
        return None;
    }
    let flags = u32_at(0x14)?;
    let mut p = 0x4c;
    if flags & 1 != 0 {
        p += 2 + u16_at(p)?;
    }
    if flags & 2 == 0 {
        return None;
    }
    let li = p;
    let header = u32_at(li + 4)?;
    let li_flags = u32_at(li + 8)?;
    if li_flags & 1 == 0 {
        return None; // not a local path (a network share)
    }
    if header >= 0x24 {
        if let Some(uo) = u32_at(li + 28).filter(|&o| o > 0) {
            let mut v = vec![];
            let mut q = li + uo;
            while let Some(c) = u16_at(q) {
                if c == 0 {
                    break;
                }
                v.push(c as u16);
                q += 2;
            }
            if !v.is_empty() {
                return Some(String::from_utf16_lossy(&v));
            }
        }
    }
    let o = li + u32_at(li + 16)?;
    let end = b[o..].iter().position(|&c| c == 0)?;
    Some(b[o..o + end].iter().map(|&c| c as char).collect())
}

const AUDIO: &[&str] = &["wav", "aif", "aiff", "mp3", "flac", "ogg", "m4a", "aac", "wma", "opus", "rex", "rx2", "mid", "midi", "sf2", "fst", "dwp"];
/// every path a project file mentions (relative or absolute, as written)
pub fn refs_of(file: &Path) -> Vec<String> {
    let ext = util::ext(&file.to_string_lossy());
    let Ok(md) = std::fs::metadata(file) else { return vec![] };
    if md.len() > MAX_SOURCE || md.is_dir() {
        return vec![];
    }
    let Ok(bytes) = std::fs::read(file) else { return vec![] };
    let text = || String::from_utf8_lossy(&bytes).into_owned();
    static HTML: OnceLock<Regex> = OnceLock::new();
    static CSS: OnceLock<Regex> = OnceLock::new();
    static MD: OnceLock<Regex> = OnceLock::new();
    static ALS: OnceLock<Regex> = OnceLock::new();
    static RPP: OnceLock<Regex> = OnceLock::new();
    static MLT: OnceLock<Regex> = OnceLock::new();
    static PR: OnceLock<Regex> = OnceLock::new();
    static XSPF: OnceLock<Regex> = OnceLock::new();
    static WPL: OnceLock<Regex> = OnceLock::new();
    static CUE: OnceLock<Regex> = OnceLock::new();
    static MTL: OnceLock<Regex> = OnceLock::new();
    static GLTF: OnceLock<Regex> = OnceLock::new();
    let caps = |r: &Regex, s: &str, i: usize| r.captures_iter(s).filter_map(|c| c.get(i).map(|m| xml_unescape(m.as_str().trim()))).collect::<Vec<_>>();
    match ext.as_str() {
        "html" | "htm" | "svg" => {
            let s = text();
            let mut v = caps(re(&HTML, r#"(?i)\b(?:src|href|poster|data-src|xlink:href)\s*=\s*["']([^"'#?][^"']*)["']"#), &s, 1);
            v.extend(caps(re(&CSS, r#"(?i)url\(\s*["']?([^"')]+)["']?\s*\)|@import\s+["']([^"']+)["']"#), &s, 1));
            v
        }
        "css" => {
            let s = text();
            re(&CSS, r#"(?i)url\(\s*["']?([^"')]+)["']?\s*\)|@import\s+["']([^"']+)["']"#).captures_iter(&s).filter_map(|c| c.get(1).or(c.get(2)).map(|m| m.as_str().trim().to_string())).collect()
        }
        "md" => caps(re(&MD, r#"!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)"#), &text(), 1),
        "m3u" | "m3u8" => text().lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(String::from).collect(),
        "pls" => text().lines().filter_map(|l| l.trim().split_once('=').filter(|(k, _)| k.to_ascii_lowercase().starts_with("file")).map(|(_, v)| v.trim().to_string())).collect(),
        "xspf" => caps(re(&XSPF, r"(?i)<location>([^<]+)</location>"), &text(), 1),
        "wpl" => caps(re(&WPL, r#"(?i)<media\s+src="([^"]+)""#), &text(), 1),
        "cue" => caps(re(&CUE, r#"(?im)^\s*FILE\s+"([^"]+)""#), &text(), 1),
        "als" => {
            // Ableton Live: gzip'd XML; each sample has a Path (absolute) and often a RelativePath
            let s = gunzip(&bytes).unwrap_or_default();
            caps(re(&ALS, r#"<(?:Path|RelativePath)\s+Value="([^"]+)""#), &s, 1)
        }
        "rpp" => caps(re(&RPP, r#"(?m)^\s*FILE\s+"?([^"\r\n]+?)"?\s*$"#), &text(), 1),
        "flp" => utf16_paths(&bytes, AUDIO),
        "mlt" | "kdenlive" => caps(re(&MLT, r#"<property name="(?:resource|kdenlive:originalurl)">([^<]+)</property>"#), &text(), 1),
        "prproj" => {
            let s = gunzip(&bytes).unwrap_or_else(text);
            caps(re(&PR, r"<(?:ActualMediaFilePath|FilePath)>([^<]+)</(?:ActualMediaFilePath|FilePath)>"), &s, 1)
        }
        "obj" => text().lines().filter_map(|l| l.trim().strip_prefix("mtllib ").map(|x| x.trim().to_string())).collect(),
        "mtl" => caps(re(&MTL, r"(?im)^\s*(?:map_\w+|bump|disp|decal|refl)\s+(?:-\S+\s+(?:\S+\s+)*?)?(\S+\.[a-z0-9]{2,5})\s*$"), &text(), 1),
        "gltf" => caps(re(&GLTF, r#""uri"\s*:\s*"([^"]+)""#), &text(), 1),
        "lnk" => lnk_target(&bytes).into_iter().collect(),
        _ => vec![],
    }
}

/// a mentioned path, as a full path on this PC (None for web addresses, data, anchors…)
pub fn resolve(source: &Path, r: &str) -> Option<PathBuf> {
    let r = r.trim();
    let low = r.to_ascii_lowercase();
    if r.is_empty() || r.starts_with('#') || r.starts_with("//") || r.contains("{{") || r.contains("${") {
        return None;
    }
    let r = if let Some(rest) = low.strip_prefix("file:///").map(|_| &r[8..]) {
        urlencoding::decode(rest).map(|c| c.into_owned()).unwrap_or_else(|_| rest.to_string())
    } else if low.contains("://") || ["data:", "mailto:", "javascript:", "tel:", "about:", "blob:"].iter().any(|p| low.starts_with(p)) {
        return None;
    } else {
        let no_q = r.split(['?', '#']).next().unwrap_or(r);
        if no_q.contains('%') { urlencoding::decode(no_q).map(|c| c.into_owned()).unwrap_or_else(|_| no_q.to_string()) } else { no_q.to_string() }
    };
    if r.is_empty() {
        return None;
    }
    let win_abs = r.len() > 2 && r.as_bytes()[1] == b':' && r.as_bytes()[0].is_ascii_alphabetic();
    let p = if win_abs || r.starts_with("\\\\") || (cfg!(not(windows)) && r.starts_with('/')) {
        PathBuf::from(if cfg!(windows) { r.replace('/', "\\") } else { r.clone() })
    } else if r.starts_with('/') {
        return None; // site-root paths ("/img/x.png") depend on the web server
    } else {
        source.parent()?.join(if cfg!(windows) { r.replace('/', "\\") } else { r.replace('\\', "/") })
    };
    // tidy "a/./b/../c"
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            x => out.push(x.as_os_str()),
        }
    }
    Some(out)
}
fn key(p: &str) -> String {
    if cfg!(windows) { p.to_lowercase().replace('/', "\\") } else { p.to_string() }
}
fn sep() -> char {
    if cfg!(windows) { '\\' } else { '/' }
}

// ---------------------------------------------------------------------------------------------------------------
// the list: for each project file, its date and the files it uses; and the other way round
#[derive(Default)]
struct Map {
    demo: bool,
    loaded: bool,
    /// source path -> (mtime, targets)
    sources: HashMap<String, (f64, Vec<String>)>,
    /// key(target) -> sources
    users: HashMap<String, Vec<String>>,
    dirty: bool,
    scanning: bool,
    last_scan: u64,
}
fn map() -> &'static Mutex<Map> {
    static M: OnceLock<Mutex<Map>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(Map::default()))
}
fn ensure_loaded(m: &mut Map) {
    let demo = crate::demo::active();
    if m.loaded && m.demo == demo {
        return;
    }
    *m = Map { demo, loaded: true, ..Default::default() };
    if let Some(v) = crate::store::get("links") {
        for (s, x) in v["sources"].as_object().into_iter().flatten() {
            let t: Vec<String> = x["t"].as_array().into_iter().flatten().filter_map(|y| y.as_str().map(String::from)).collect();
            m.sources.insert(s.clone(), (x["m"].as_f64().unwrap_or(0.0), t));
        }
        m.last_scan = v["lastScan"].as_u64().unwrap_or(0);
    }
    rebuild_users(m);
}
fn rebuild_users(m: &mut Map) {
    m.users.clear();
    for (s, (_, ts)) in &m.sources {
        for t in ts {
            m.users.entry(key(t)).or_default().push(s.clone());
        }
    }
}
fn save(m: &mut Map) {
    if !m.dirty {
        return;
    }
    let mut o = serde_json::Map::new();
    for (s, (mt, t)) in &m.sources {
        o.insert(s.clone(), json!({ "m": mt, "t": t }));
    }
    let _ = crate::store::set("links", &json!({ "version": 1, "lastScan": m.last_scan, "sources": o }));
    m.dirty = false;
}
fn mtime(p: &Path) -> f64 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}
fn is_source(p: &str) -> bool {
    let e = util::ext(p);
    SOURCES.iter().any(|x| x.0 == e)
}
/// read one project file if it changed (true when its list changed)
fn refresh_source(m: &mut Map, p: &str) -> bool {
    let path = Path::new(p);
    let mt = mtime(path);
    if mt == 0.0 {
        return m.sources.remove(p).is_some();
    }
    if m.sources.get(p).is_some_and(|x| x.0 == mt) {
        return false;
    }
    let mut seen = HashSet::new();
    let targets: Vec<String> = refs_of(path).iter().filter_map(|r| resolve(path, r)).map(|t| t.to_string_lossy().into_owned()).filter(|t| t != p && seen.insert(key(t))).take(5000).collect();
    m.sources.insert(p.to_string(), (mt, targets));
    true
}

/// project files under the user's folders: from the instant index, else a walk
async fn find_sources() -> Vec<String> {
    let exts = SOURCES.iter().map(|x| x.0).collect::<Vec<_>>().join(";");
    if !crate::demo::active() {
        let q = json!({ "query": format!("ext:{exts} file:"), "typed": true, "limit": 200000, "skipDirs": ["node_modules", ".git", "$recycle.bin", "windows", "program files", "program files (x86)", "programdata", "appdata", "site-packages", ".cache", "target"] });
        if let Ok(r) = crate::engine::request("index.search", q).await {
            if r["indexed"].as_bool() == Some(true) {
                return r["items"].as_array().into_iter().flatten().filter_map(|i| i["path"].as_str().map(String::from)).filter(|p| !p.to_ascii_lowercase().contains("\\microsoft\\windows\\start menu")).collect();
            }
        }
    }
    let root = if crate::demo::active() { Some(crate::demo::root()) } else { dirs::home_dir() };
    let Some(root) = root else { return vec![] };
    tokio::task::spawn_blocking(move || {
        let mut out = vec![];
        let mut stack = vec![(root, 0usize)];
        while let Some((d, depth)) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || ["node_modules", "appdata", "$recycle.bin", "library", "target"].contains(&name.to_lowercase().as_str()) {
                    continue;
                }
                let Ok(ft) = e.file_type() else { continue };
                let p = e.path().to_string_lossy().into_owned();
                if ft.is_dir() && depth < 10 {
                    stack.push((e.path(), depth + 1));
                } else if ft.is_file() && is_source(&p) {
                    out.push(p);
                }
                if out.len() > 50000 {
                    return out;
                }
            }
        }
        out
    })
    .await
    .unwrap_or_default()
}

/// look through every project file again (changed ones are read; gone ones dropped)
pub async fn scan() {
    {
        let mut m = map().lock();
        ensure_loaded(&mut m);
        if m.scanning {
            return;
        }
        m.scanning = true;
    }
    let found = find_sources().await;
    let r = tokio::task::spawn_blocking(move || {
        let mut changed = false;
        let known: Vec<String> = map().lock().sources.keys().cloned().collect();
        let found_set: HashSet<String> = found.iter().cloned().collect();
        for (i, p) in found.iter().enumerate() {
            let mut m = map().lock();
            changed |= refresh_source(&mut m, p);
            drop(m);
            if i % 200 == 199 {
                std::thread::yield_now();
            }
        }
        let mut m = map().lock();
        for k in known {
            if !found_set.contains(&k) && !Path::new(&k).exists() {
                m.sources.remove(&k);
                changed = true;
            }
        }
        if changed {
            rebuild_users(&mut m);
            m.dirty = true;
        }
        m.last_scan = now();
        m.dirty = true;
        save(&mut m);
        changed
    })
    .await
    .unwrap_or(false);
    map().lock().scanning = false;
    if r {
        crate::events::broadcast("links:changed", json!({}));
    }
}
fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
/// the background look-through: a minute after start, then every half hour
pub fn start() {
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        loop {
            if crate::setting_bool("linkedFiles", true) {
                scan().await;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1800)).await;
        }
    });
}

fn dir_of(p: &str) -> String {
    util::dirname(p)
}
fn user_info(s: &str) -> Value {
    json!({ "path": s, "name": util::basename(s), "kind": label(&util::ext(s)), "dir": dir_of(s) })
}

/// links:forDir {dir, paths}: for the files shown, which are used by a file in another folder (the red dot) or in their
/// own folder. Project files in this folder are read first, so what's on screen is up to date.
pub async fn for_dir(a: &Args) -> R {
    if !crate::setting_bool("linkedFiles", true) {
        return Ok(json!({}));
    }
    let o = a.v(0);
    let dir = o["dir"].as_str().unwrap_or("").to_string();
    let paths: Vec<String> = o["paths"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect();
    tokio::task::spawn_blocking(move || {
        let mut m = map().lock();
        ensure_loaded(&mut m);
        let mut changed = false;
        for p in paths.iter().filter(|p| is_source(p)) {
            changed |= refresh_source(&mut m, p);
        }
        if changed {
            rebuild_users(&mut m);
            m.dirty = true;
            save(&mut m);
        }
        let _ = dir;
        let mut out = serde_json::Map::new();
        for p in &paths {
            let users = m.users.get(&key(p)).cloned().unwrap_or_default();
            let used_by = users.iter().filter(|s| Path::new(s).exists()).count();
            // the red dot: used from another folder (moving one without the other breaks the link)
            let dk = key(&dir_of(p));
            let outside = users.iter().filter(|s| key(&dir_of(s)) != dk && Path::new(s).exists()).count();
            let uses = if is_source(p) { m.sources.get(p).map(|x| x.1.len()).unwrap_or(0) } else { 0 };
            if used_by > 0 || uses > 0 {
                out.insert(p.clone(), json!({ "usedBy": used_by, "outside": outside, "uses": uses }));
            }
        }
        Ok(Value::Object(out))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// links:of {path}: who uses this file, and (for a project file) what it uses, with missing files marked
pub async fn of(a: &Args) -> R {
    let p = a.s(0)?;
    tokio::task::spawn_blocking(move || {
        let mut m = map().lock();
        ensure_loaded(&mut m);
        if is_source(&p) && refresh_source(&mut m, &p) {
            rebuild_users(&mut m);
            m.dirty = true;
            save(&mut m);
        }
        let used_by: Vec<Value> = m.users.get(&key(&p)).cloned().unwrap_or_default().iter().filter(|s| Path::new(s).exists()).map(|s| user_info(s)).collect();
        let uses: Vec<Value> = m.sources.get(&p).map(|x| x.1.clone()).unwrap_or_default().iter().map(|t| json!({ "path": t, "name": util::basename(t), "dir": dir_of(t), "missing": !Path::new(t).exists() })).collect();
        Ok(json!({ "path": p, "kind": if is_source(&p) { label(&util::ext(&p)) } else { "" }, "usedBy": used_by, "uses": uses, "lastScan": m.last_scan, "scanning": m.scanning }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// links:check {paths, op: move|delete|rename, dest?}: what would break. For each file (or anything inside a folder)
/// used by a project file that isn't being moved with it; and project files whose relative links would point
/// nowhere once they move without the files they use.
pub async fn check(a: &Args) -> R {
    if !crate::setting_bool("linkedFiles", true) {
        return Ok(json!({ "problems": [] }));
    }
    let o = a.v(0);
    let paths: Vec<String> = o["paths"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect();
    let op = o["op"].as_str().unwrap_or("move").to_string();
    tokio::task::spawn_blocking(move || {
        let mut m = map().lock();
        ensure_loaded(&mut m);
        let moving: Vec<String> = paths.iter().map(|p| key(p)).collect();
        let inside_moving = |k: &str| moving.iter().any(|mv| k == mv || k.starts_with(&format!("{mv}{}", sep())));
        let mut problems = vec![];
        for p in &paths {
            let kp = key(p);
            let prefix = format!("{kp}{}", sep());
            // used files: the item itself, or anything inside it (a folder)
            let mut hits: Vec<(String, Vec<String>)> = vec![];
            for (t, users) in &m.users {
                if t == &kp || t.starts_with(&prefix) {
                    let outside: Vec<String> = users.iter().filter(|s| !inside_moving(&key(s)) && Path::new(s).exists()).cloned().collect();
                    if !outside.is_empty() {
                        hits.push((t.clone(), outside));
                    }
                }
            }
            if !hits.is_empty() {
                let mut by: Vec<String> = hits.iter().flat_map(|h| h.1.clone()).collect();
                by.sort();
                by.dedup();
                let files = hits.len();
                problems.push(json!({ "path": p, "name": util::basename(p), "kind": "usedBy", "files": files, "users": by.iter().take(12).map(|s| user_info(s)).collect::<Vec<_>>(), "moreUsers": by.len().saturating_sub(12) }));
            }
            // project files moving away from the files they use (relative links break; absolute ones don't move)
            if op != "delete" && is_source(p) {
                let left: Vec<&String> = m.sources.get(p).map(|x| x.1.iter().filter(|t| !inside_moving(&key(t)) && Path::new(t).exists()).collect()).unwrap_or_default();
                if !left.is_empty() && op == "move" {
                    problems.push(json!({ "path": p, "name": util::basename(p), "kind": "uses", "count": left.len(), "targets": left.iter().take(8).map(|t| util::basename(t)).collect::<Vec<_>>() }));
                }
            }
        }
        Ok(json!({ "problems": problems }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// links:scan: look through everything now
pub async fn scan_call(_a: &Args) -> R {
    scan().await;
    let m = map().lock();
    Ok(json!({ "sources": m.sources.len(), "lastScan": m.last_scan }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_and_resolves_project_files() {
        let d = std::env::temp_dir().join(format!("dogfile-links-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("site/img")).unwrap();
        std::fs::create_dir_all(d.join("Samples")).unwrap();
        std::fs::write(d.join("site/index.html"), r##"<link href="styles.css" rel="stylesheet"><img src="img/logo.png"><a href="https://x.com">x</a><a href="#top">t</a><script src="../shared/app.js?v=2"></script>"##).unwrap();
        std::fs::write(d.join("site/styles.css"), "body{background:url('img/bg.jpg')} @import \"base.css\";").unwrap();
        std::fs::write(d.join("mix.m3u8"), "#EXTM3U\n#EXTINF:1,a\nSamples/kick.wav\nhttp://radio/x.mp3\n").unwrap();
        // an Ableton Live set is gzip'd XML
        let xml = r#"<Ableton><SampleRef><FileRef><RelativePath Value="Samples/kick.wav" /><Path Value="C:\Music\Samples\kick.wav" /></FileRef></SampleRef></Ableton>"#;
        let mut gz = flate2::write::GzEncoder::new(vec![], flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, xml.as_bytes()).unwrap();
        std::fs::write(d.join("Song.als"), gz.finish().unwrap()).unwrap();
        let names = |f: &str| refs_of(&d.join(f)).iter().filter_map(|r| resolve(&d.join(f), r)).map(|p| p.strip_prefix(&d).map(|x| x.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| p.to_string_lossy().into_owned())).collect::<Vec<_>>();
        assert_eq!(names("site/index.html"), vec!["site/styles.css", "site/img/logo.png", "shared/app.js"]);
        assert_eq!(names("site/styles.css"), vec!["site/img/bg.jpg", "site/base.css"]);
        assert_eq!(names("mix.m3u8"), vec!["Samples/kick.wav"]);
        assert!(names("Song.als").contains(&"Samples/kick.wav".to_string()));
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn finds_sample_paths_in_binary_projects() {
        let mut b = vec![0u8, 1, 2, 3];
        for c in "C:\\Samples\\snare 02.wav".encode_utf16() {
            b.extend(c.to_le_bytes());
        }
        b.extend([0, 0, 9, 9]);
        assert_eq!(utf16_paths(&b, AUDIO), vec!["C:\\Samples\\snare 02.wav"]);
    }
}
