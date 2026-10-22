// Archives: full 7-Zip when installed (adds RAR/ISO/… reading), otherwise the bundled 7za (7z, zip, tar, gz,
// bz2, xz, wim, cab) plus Windows' own tar.exe for reading RAR and others. WinRAR creates RAR files if present.
use crate::args::{Args, R};
use crate::ops::{Cancelled, Job, JR};
use crate::util::{self, basename, same_path};
use crate::st;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::Arc;

fn first(c: &[PathBuf]) -> Option<PathBuf> {
    c.iter().find(|p| p.is_file()).cloned()
}
pub fn find_full_7z() -> Option<PathBuf> {
    if !util::IS_WIN {
        return util::which("7z");
    }
    // the full 7-Zip that ships with Dogfile (7z.exe + 7z.dll: RAR, ISO, DMG, VHD… too), else an installed one
    let s = st();
    first(&[s.res_dir.join("7zip").join("7z.exe"), PathBuf::from(r"C:\Program Files\7-Zip\7z.exe"), PathBuf::from(r"C:\Program Files (x86)\7-Zip\7z.exe")])
        .filter(|p| p.parent().map(|d| d.join("7z.dll").is_file()).unwrap_or(false))
}
pub fn find_bundled_7z() -> Option<PathBuf> {
    let exe = if util::IS_WIN { "7za.exe" } else { "7za" };
    let s = st();
    let plat = if util::IS_WIN { "win32" } else { "linux" };
    first(&[s.res_dir.join("7zip").join(exe), s.res_dir.join("vendor").join("7zip").join(plat).join(exe), s.res_dir.join("7zip").join(plat).join(exe)])
}
pub fn find_7z() -> Option<PathBuf> {
    find_full_7z().or_else(find_bundled_7z)
}
fn find_rar() -> Option<PathBuf> {
    first(&[PathBuf::from(r"C:\Program Files\WinRAR\Rar.exe"), PathBuf::from(r"C:\Program Files (x86)\WinRAR\Rar.exe")])
}
fn bundled_ok(f: &str) -> bool {
    regex::Regex::new(r"(?i)\.(7z|zip|zipx|jar|tar|gz|tgz|bz2|tbz2?|xz|txz|cab|wim|lzma|z|taz|epub|docx|xlsx|pptx|odt|ods|apk|xpi)$").unwrap().is_match(f)
}
pub fn is_tarball(f: &str) -> bool {
    regex::Regex::new(r"(?i)\.(tar\.(gz|xz|bz2|zst)|tgz|txz|tbz2?)$").unwrap().is_match(f)
}
pub fn seven_for(f: &str) -> Option<PathBuf> {
    if let Some(full) = find_full_7z() {
        return Some(full);
    }
    if bundled_ok(f) { find_bundled_7z() } else { None }
}
fn tar_exe() -> PathBuf {
    if util::IS_WIN {
        PathBuf::from(std::env::var("SystemRoot").unwrap_or("C:\\Windows".into())).join("System32").join("tar.exe")
    } else {
        PathBuf::from("tar")
    }
}

/// archive:list
pub async fn list_call(a: &Args) -> R {
    let f = a.s(0)?;
    tokio::task::spawn_blocking(move || list(&f)).await.map_err(|e| e.to_string())?.map(Value::Array)
}
pub fn list(file: &str) -> Result<Vec<Value>, String> {
    let z = if is_tarball(file) { None } else { seven_for(file) };
    if let Some(z) = z {
        if let Ok(o) = util::std_cmd(&z).args(["l", "-slt", "-ba", file]).output() {
            if o.status.success() {
                let text = String::from_utf8_lossy(&o.stdout).replace("\r\n", "\n");
                let mut items = vec![];
                for block in text.split("\n\n") {
                    let mut kv = std::collections::HashMap::new();
                    for line in block.lines() {
                        if let Some(i) = line.find(" = ") {
                            kv.insert(&line[..i], &line[i + 3..]);
                        }
                    }
                    if let Some(p) = kv.get("Path") {
                        let mtime = kv.get("Modified").map(|m| parse_dt(m)).unwrap_or(0.0);
                        items.push(json!({ "path": p.replace('\\', "/"), "size": kv.get("Size").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0),
                            "isDir": kv.get("Attributes").map(|a| a.contains('D')).unwrap_or(false) || kv.get("Folder") == Some(&"+"), "mtime": mtime }));
                    }
                }
                return Ok(items);
            }
        }
    }
    let o = util::std_cmd(tar_exe()).args(["-tvf", file]).output().map_err(|_| "Could not read archive (install 7-Zip for more formats)".to_string())?;
    if !o.status.success() {
        return Err("Could not read archive (install 7-Zip for more formats)".into());
    }
    let text = String::from_utf8_lossy(&o.stdout);
    let re1 = regex::Regex::new(r"^(\S+)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d+\s+(?:\d\d:\d\d|\d{4}))\s(.*)$").unwrap();
    let re2 = regex::Regex::new(r"^(\S+)\s+\S+\s+(\d+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d)\s(.*)$").unwrap();
    let mut items = vec![];
    for line in text.lines() {
        if line.trim().is_empty() { continue }
        if let Some(m) = re1.captures(line).or_else(|| re2.captures(line)) {
            let name = m[4].replace('\\', "/");
            items.push(json!({ "path": name, "size": m[2].parse::<u64>().unwrap_or(0), "isDir": m[1].starts_with('d') || name.ends_with('/'), "mtime": parse_dt(&m[3]) }));
        } else {
            items.push(json!({ "path": line.trim(), "size": 0, "isDir": line.trim().ends_with('/'), "mtime": 0 }));
        }
    }
    Ok(items)
}
/// "2024-05-01 13:22:05" (local time) -> ms; other formats -> 0
fn parse_dt(s: &str) -> f64 {
    let re = regex::Regex::new(r"(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?").unwrap();
    let Some(c) = re.captures(s) else { return 0.0 };
    let n = |i: usize| c.get(i).and_then(|m| m.as_str().parse::<i64>().ok()).unwrap_or(0);
    let days = days_from_civil(n(1), n(2), n(3));
    let secs = days * 86400 + n(4) * 3600 + n(5) * 60 + n(6);
    ((secs - local_offset_secs()) * 1000) as f64
}
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}
/// the local time zone's offset from UTC, in seconds
pub fn local_offset_secs() -> i64 {
    #[cfg(windows)]
    {
        return crate::win::utc_offset_secs();
    }
    #[cfg(unix)]
    unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        tm.tm_gmtoff
    }
}

/// run a packer, showing its progress ("42%") and the file it's on; stopped when the job is cancelled
fn spawn_tracked(j: &Job, cmd: &Path, args: &[String], cwd: Option<&Path>) -> JR {
    let mut c = util::std_cmd(cmd);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    let mut child = c.spawn().map_err(|e| Err(format!("Couldn't start {}: {e}", cmd.display())))?;
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let errbuf = parking_lot::Mutex::new(String::new());
    let read = |mut s: Box<dyn Read + Send>, is_err: bool| {
        let mut buf = [0u8; 8192];
        let pct = regex::Regex::new(r"(\d+)%").unwrap();
        loop {
            let n = match s.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => n };
            let txt = String::from_utf8_lossy(&buf[..n]).to_string();
            if is_err {
                let mut e = errbuf.lock();
                e.push_str(&txt);
                if e.len() > 8000 { let k = e.len() - 8000; e.drain(..k); }
            }
            let lines = txt.matches('\n').count() as u64;
            {
                let mut d = j.d.lock();
                d.files_done += lines;
                if let Some(m) = pct.captures_iter(&txt).last() {
                    d.indeterminate = false;
                    d.total = 100;
                    d.done = m[1].parse().unwrap_or(0);
                }
            }
            if let Some(last) = txt.trim().lines().last() {
                let l = last.trim();
                let l = l.strip_prefix("a ").or_else(|| l.strip_prefix("x ")).or_else(|| l.strip_prefix("- ")).unwrap_or(l);
                if !l.is_empty() && !l.ends_with('%') { j.set_current(l) }
            }
            crate::ops::emit(j);
        }
    };
    let status = std::thread::scope(|sc| {
        sc.spawn(|| read(Box::new(out), false));
        sc.spawn(|| read(Box::new(err), true));
        loop {
            if j.cancelled.load(Ordering::Relaxed) {
                let _ = child.kill();
            }
            match child.try_wait() {
                Ok(Some(s)) => break Ok(s),
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(150)),
                Err(e) => break Err(e.to_string()),
            }
        }
    });
    let status = status.map_err(Err)?;
    if j.cancelled.load(Ordering::Relaxed) {
        return Err(Ok(Cancelled));
    }
    if status.success() {
        Ok(())
    } else {
        let e = errbuf.lock().clone();
        let tail: Vec<&str> = e.trim().lines().filter(|l| !l.trim().is_empty()).collect();
        let msg = tail.iter().rev().take(2).rev().cloned().collect::<Vec<_>>().join(" ");
        Err(Err(if msg.is_empty() { format!("Exited with code {:?}", status.code()) } else { msg }))
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
fn password(j: &Job, key: &str) -> Vec<String> {
    j.opts[key].as_str().filter(|p| !p.is_empty()).map(|p| vec![format!("-p{p}")]).unwrap_or_default()
}
fn rel_names(sources: &[String], parent: &Path) -> Vec<String> {
    sources.iter().map(|x| Path::new(x).strip_prefix(parent).map(|r| r.to_string_lossy().into_owned()).unwrap_or_else(|_| basename(x))).collect()
}

pub fn extract(j: &Arc<Job>) -> JR {
    j.d.lock().indeterminate = true;
    let jdest = j.dest.clone().unwrap_or_default();
    let mut created = vec![];
    let strip = regex::Regex::new(r"(?i)\.(tar\.(gz|bz2|xz|zst)|tgz|zip|7z|rar|tar|gz|bz2|xz|cab|iso|zst)$").unwrap();
    for file in &j.sources {
        j.checkpoint().map_err(|_| Ok(Cancelled))?;
        let mut dest = jdest.clone();
        if j.opts["smart"].as_bool() != Some(false) {
            // one folder at the top of the archive: straight into dest; otherwise a folder named after the archive
            let mut roots = std::collections::HashSet::new();
            if let Ok(items) = list(file) {
                for it in items {
                    if let Some(p) = it["path"].as_str() { roots.insert(p.split('/').next().unwrap_or("").to_string()); }
                }
            }
            let base = strip.replace(&basename(file), "").to_string();
            if roots.len() != 1 || j.opts["toFolder"].as_bool().unwrap_or(false) {
                dest = util::unique_name(&jdest, &base, "number");
            } else if let Some(only) = roots.iter().next() {
                if util::exists(&Path::new(&jdest).join(only)) { dest = util::unique_name(&jdest, &base, "number"); }
            }
        }
        std::fs::create_dir_all(&dest).map_err(|e| Err(e.to_string()))?;
        j.set_current(&basename(file));
        let member: Vec<String> = j.opts["entry"].as_str().map(|e| vec![e.to_string()]).unwrap_or_default();
        match if is_tarball(file) { None } else { seven_for(file) } {
            Some(z) => {
                let mut a = vec!["x".into(), "-y".into(), "-bsp1".into(), format!("-o{dest}"), file.clone()];
                a.extend(member);
                a.extend(password(j, "password"));
                spawn_tracked(j, &z, &a, None)?;
            }
            None => {
                let mut a = vec!["-xvf".into(), file.clone(), "-C".into(), dest.clone()];
                a.extend(member);
                spawn_tracked(j, &tar_exe(), &a, None)?;
            }
        }
        created.push(dest);
    }
    j.d.lock().undo = json!({ "type": "created", "paths": created.into_iter().filter(|d| !same_path(d, &jdest)).collect::<Vec<_>>() });
    Ok(())
}

pub fn compress(j: &Arc<Job>) -> JR {
    j.d.lock().indeterminate = true;
    let out = j.opts["output"].as_str().unwrap_or("").to_string();
    let fmt = j.opts["format"].as_str().map(String::from).unwrap_or_else(|| util::ext(&out)).to_lowercase();
    let fmt = if fmt.is_empty() { "zip".into() } else { fmt };
    let parent = PathBuf::from(util::dirname(&j.sources[0]));
    let names = rel_names(&j.sources, &parent);
    let _ = std::fs::remove_file(&out);
    match find_7z() {
        Some(z) if fmt != "tar.gz" && fmt != "tgz" => {
            let t = match fmt.as_str() { "7z" => "7z", "tar" => "tar", "gz" => "gzip", "xz" => "xz", "wim" => "wim", _ => "zip" };
            let mut a = vec!["a".into(), "-bsp1".into(), format!("-t{t}")];
            if let Some(l) = j.opts["level"].as_u64() { a.push(format!("-mx={l}")) }
            if let Some(p) = j.opts["password"].as_str().filter(|p| !p.is_empty()) {
                a.push(format!("-p{p}"));
                if t == "7z" { a.push("-mhe=on".into()) }
            }
            a.push(out.clone());
            a.extend(names);
            spawn_tracked(j, &z, &a, Some(&parent))?;
        }
        _ => {
            let mut a: Vec<String> = match fmt.as_str() {
                "zip" => vec!["-a".into(), "-cvf".into(), out.clone()],
                "7z" => vec!["--format".into(), "7zip".into(), "-cvf".into(), out.clone()],
                "tar" => vec!["-cvf".into(), out.clone()],
                "tar.gz" | "tgz" => vec!["-czvf".into(), out.clone()],
                _ => vec!["-a".into(), "-cvf".into(), out.clone()],
            };
            a.extend(names);
            spawn_tracked(j, &tar_exe(), &a, Some(&parent))?;
        }
    }
    j.d.lock().undo = json!({ "type": "created", "paths": [out] });
    Ok(())
}

fn needs_7z(file: &str) -> Result<PathBuf, Result<Cancelled, String>> {
    if is_tarball(file) {
        return Err(Err("Compressed tarballs (.tar.gz etc.) can’t be changed in place. Convert to zip or 7z first.".into()));
    }
    seven_for(file).ok_or_else(|| Err("This archive type can be read but not changed. Install 7-Zip for more formats, or convert it to zip first.".into()))
}
pub fn add(j: &Arc<Job>) -> JR {
    j.d.lock().indeterminate = true;
    let arc = j.dest.clone().unwrap_or_default();
    let inner = j.opts["inner"].as_str().unwrap_or("").trim_matches('/').to_string();
    let z = needs_7z(&arc)?;
    if inner.is_empty() {
        let parent = util::dirname(&j.sources[0]);
        if j.sources.iter().all(|x| util::dirname(x) == parent) {
            let mut a = vec!["a".into(), "-bsp1".into(), "-y".into(), arc.clone()];
            a.extend(rel_names(&j.sources, Path::new(&parent)));
            return spawn_tracked(j, &z, &a, Some(Path::new(&parent)));
        }
    }
    // stage the files in the folders they should have inside the archive
    let tmp = util::temp_dir("add").map_err(|e| Err(e.to_string()))?;
    let r = (|| {
        let base = if inner.is_empty() { tmp.clone() } else { inner.split('/').fold(tmp.clone(), |p, x| p.join(x)) };
        std::fs::create_dir_all(&base).map_err(|e| Err(e.to_string()))?;
        for src in &j.sources {
            j.checkpoint().map_err(|_| Ok(Cancelled))?;
            j.set_current(&basename(src));
            util::copy_tree(Path::new(src), &base.join(basename(src))).map_err(|e| Err(e.to_string()))?;
        }
        let top: Vec<String> = if inner.is_empty() { std::fs::read_dir(&tmp).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default() } else { vec![inner.split('/').next().unwrap_or("").to_string()] };
        let mut a = vec!["a".into(), "-bsp1".into(), "-y".into(), arc.clone()];
        a.extend(top);
        spawn_tracked(j, &z, &a, Some(&tmp))
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    r
}
pub fn delete(j: &Arc<Job>) -> JR {
    j.d.lock().indeterminate = true;
    let arc = j.dest.clone().unwrap_or_default();
    let z = needs_7z(&arc)?;
    let mut a = vec!["d".into(), "-bsp1".into(), "-y".into(), arc];
    a.extend(crate::args::strs(&j.opts["entries"]));
    spawn_tracked(j, &z, &a, None)
}
pub fn rename(j: &Arc<Job>) -> JR {
    let arc = j.dest.clone().unwrap_or_default();
    let z = needs_7z(&arc)?;
    let a = vec!["rn".into(), "-y".into(), arc, j.opts["from"].as_str().unwrap_or("").into(), j.opts["to"].as_str().unwrap_or("").into()];
    spawn_tracked(j, &z, &a, None)
}
pub fn convert(j: &Arc<Job>) -> JR {
    j.d.lock().indeterminate = true;
    let src = j.sources[0].clone();
    let fmt = j.opts["format"].as_str().unwrap_or("zip").to_string();
    let out = j.opts["output"].as_str().unwrap_or("").to_string();
    let tmp = util::temp_dir("conv").map_err(|e| Err(e.to_string()))?;
    let r = (|| {
        j.set_current(&format!("Unpacking {}", basename(&src)));
        match if is_tarball(&src) { None } else { seven_for(&src) } {
            Some(z) => {
                let mut a = vec!["x".into(), "-y".into(), "-bsp1".into(), format!("-o{}", s(&tmp)), src.clone()];
                a.extend(password(j, "password"));
                spawn_tracked(j, &z, &a, None)?;
            }
            None => spawn_tracked(j, &tar_exe(), &["-xf".into(), src.clone(), "-C".into(), s(&tmp)], None)?,
        }
        let names: Vec<String> = std::fs::read_dir(&tmp).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        if names.is_empty() {
            return Err(Err("The archive is empty".into()));
        }
        let _ = std::fs::remove_file(&out);
        j.set_current(&format!("Packing {}", basename(&out)));
        if fmt == "rar" {
            let rar = find_rar().ok_or_else(|| Err("Creating RAR files needs WinRAR (RAR is a closed format). Choose 7z or zip instead.".to_string()))?;
            let mut a = vec!["a".into(), "-r".into(), "-ep1".into(), "-idq".into(), out.clone()];
            a.extend(names.iter().map(|n| s(&tmp.join(n))));
            spawn_tracked(j, &rar, &a, None)?;
        } else if matches!(fmt.as_str(), "tar.gz" | "tgz" | "tar.xz" | "tar.bz2") {
            if let Some(z7) = find_7z() {
                let tar_dir = util::temp_dir("tar").map_err(|e| Err(e.to_string()))?;
                let tname = regex::Regex::new(r"(?i)\.(gz|xz|bz2)$").unwrap().replace(&regex::Regex::new(r"(?i)\.tgz$").unwrap().replace(&basename(&out), ".tar"), "").to_string();
                let tar_tmp = tar_dir.join(tname);
                let mut a = vec!["a".into(), "-bsp1".into(), "-ttar".into(), s(&tar_tmp)];
                a.extend(names.clone());
                spawn_tracked(j, &z7, &a, Some(&tmp))?;
                let t = match fmt.as_str() { "tar.xz" => "xz", "tar.bz2" => "bzip2", _ => "gzip" };
                spawn_tracked(j, &z7, &["a".into(), "-bsp1".into(), format!("-t{t}"), out.clone(), s(&tar_tmp)], None)?;
                let _ = std::fs::remove_dir_all(&tar_dir);
            } else {
                let flag = match fmt.as_str() { "tar.xz" => "-cJf", "tar.bz2" => "-cjf", _ => "-czf" };
                let mut a = vec![flag.into(), out.clone()];
                a.extend(names.clone());
                spawn_tracked(j, &tar_exe(), &a, Some(&tmp))?;
            }
        } else {
            let t = match fmt.as_str() { "7z" => "7z", "tar" => "tar", "wim" => "wim", _ => "zip" };
            match find_7z() {
                Some(z7) => {
                    let mut a = vec!["a".into(), "-bsp1".into(), format!("-t{t}")];
                    if let Some(l) = j.opts["level"].as_u64() { a.push(format!("-mx={l}")) }
                    if let Some(p) = j.opts["newPassword"].as_str().filter(|p| !p.is_empty()) {
                        a.push(format!("-p{p}"));
                        if t == "7z" { a.push("-mhe=on".into()) }
                    }
                    a.push(out.clone());
                    a.extend(names.clone());
                    spawn_tracked(j, &z7, &a, Some(&tmp))?;
                }
                None => {
                    let mut a = vec![if t == "zip" { "-acf".to_string() } else { "-cf".to_string() }, out.clone()];
                    a.extend(names.clone());
                    spawn_tracked(j, &tar_exe(), &a, Some(&tmp))?;
                }
            }
        }
        if j.opts["deleteOriginal"].as_bool().unwrap_or(false) {
            let _ = trash::delete(&src);
        }
        j.d.lock().undo = json!({ "type": "created", "paths": [out] });
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    r
}

pub async fn test(a: &Args) -> R {
    let file = a.s(0)?;
    let (cmd, args): (PathBuf, Vec<String>) = match seven_for(&file) {
        Some(z) => (z, vec!["t".into(), file.clone()]),
        None => (tar_exe(), vec!["-tf".into(), file.clone()]),
    };
    let o = util::run(&cmd, &args, None, 0).await.map_err(|e| e.to_string())?;
    let all = format!("{}{}", o.out(), o.err());
    let ok = o.ok && !o.err().contains("ERROR") && !o.err().contains("Error");
    let message = if !o.ok {
        let l: Vec<&str> = all.trim().lines().collect();
        l.iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" ")
    } else {
        let re = regex::Regex::new(r"Files: \d+|Everything is Ok").unwrap();
        let m: Vec<&str> = re.find_iter(&all).map(|m| m.as_str()).collect();
        if m.is_empty() { "OK".into() } else { m.join(" · ") }
    };
    Ok(json!({ "ok": ok, "message": message }))
}
pub fn caps() -> R {
    Ok(json!({ "full": find_full_7z().is_some(), "bundled": find_bundled_7z().is_some(), "rar": find_rar().is_some() }))
}

/// one file out of a zip (Office documents are zips)
pub fn zip_entry(file: &str, entry: &str, max: u64) -> Option<Vec<u8>> {
    let f = std::fs::File::open(file).ok()?;
    let mut z = zip::ZipArchive::new(f).ok()?;
    let e = z.by_name(entry).ok()?;
    let mut buf = Vec::new();
    e.take(max).read_to_end(&mut buf).ok()?;
    Some(buf)
}
pub fn zip_names(file: &str) -> Vec<String> {
    let Ok(f) = std::fs::File::open(file) else { return vec![] };
    let Ok(z) = zip::ZipArchive::new(f) else { return vec![] };
    z.file_names().map(String::from).collect()
}
