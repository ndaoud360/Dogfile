// What is using a file or folder, and when nothing can be found, why it can't be changed.
// Windows' lock list (Restart Manager) only answers for files, so a folder is looked at through the files inside it, and
// through the programs that are working in it (a command prompt "in" a folder keeps it from being renamed or deleted).
// Then the file or folder is tried for real, so the answer is never just "nothing": it is in use (by whom, or by something
// Dogfile isn't allowed to see), or it is a permission problem, or it is free.
use crate::args::{err, Args, R};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// the files looked at under a folder (a folder with more than this is looked at in part)
const MAX_FILES: usize = 4000;

fn flat(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}
/// `p` is `dir` or inside it
pub fn inside(p: &str, dir: &str) -> bool {
    let (p, d) = (flat(p), flat(dir));
    !d.is_empty() && (p == d || p.starts_with(&format!("{d}\\")))
}

struct Holder {
    name: String,
    exe: String,
    service: String,
    /// ("open" | "cwd" | "exe", where)
    how: Vec<(String, String)>,
}
impl Holder {
    fn add(&mut self, kind: &str, detail: &str) {
        if !self.how.iter().any(|(k, d)| k == kind && d == detail) {
            self.how.push((kind.to_string(), detail.to_string()));
        }
    }
}

fn holders_json(h: &BTreeMap<u32, Holder>, me: u32) -> Vec<Value> {
    h.iter()
        .map(|(pid, x)| json!({ "pid": pid, "name": x.name, "exe": x.exe, "service": x.service, "self": *pid == me, "how": x.how.iter().map(|(k, d)| json!({ "kind": k, "where": d })).collect::<Vec<_>>() }))
        .collect()
}

#[cfg(windows)]
fn probe(p: &str) -> Value {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let md = match std::fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(e) => return json!({ "path": p, "state": "missing", "code": e.raw_os_error() }),
    };
    let ro = md.file_attributes() & 1 != 0;
    // opened with no sharing allowed: it fails when anything else has it open (a program, Explorer, a scanner…)
    let res = if md.is_dir() {
        std::fs::OpenOptions::new().access_mode(0x1).share_mode(0).custom_flags(0x0200_0000).open(p)
    } else {
        std::fs::OpenOptions::new().read(true).share_mode(0).open(p)
    };
    match res {
        Ok(_) => json!({ "path": p, "state": "free", "readonly": ro, "isDir": md.is_dir() }),
        Err(e) => {
            let code = e.raw_os_error().unwrap_or(0);
            let state = match code {
                32 | 33 | 1224 => "in_use",
                5 => "denied",
                2 | 3 => "missing",
                _ => "other",
            };
            json!({ "path": p, "state": state, "code": code, "readonly": ro, "isDir": md.is_dir(), "error": e.to_string() })
        }
    }
}

#[cfg(windows)]
pub fn inspect_sync(paths: &[String]) -> Value {
    use crate::win;
    use std::path::PathBuf;
    let (mut files, mut dirs): (Vec<String>, Vec<String>) = (vec![], vec![]);
    for p in paths {
        match std::fs::symlink_metadata(p) {
            Ok(m) if m.is_dir() => dirs.push(p.clone()),
            Ok(_) => files.push(p.clone()),
            Err(_) => {}
        }
    }
    // the files inside the folders
    let mut capped = false;
    let mut stack: Vec<PathBuf> = dirs.iter().map(PathBuf::from).collect();
    'walk: while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(md) = std::fs::symlink_metadata(e.path()) else { continue };
            if md.file_type().is_symlink() {
                continue;
            }
            if md.is_dir() {
                stack.push(e.path());
            } else {
                files.push(e.path().to_string_lossy().to_string());
                if files.len() >= MAX_FILES {
                    capped = true;
                    break 'walk;
                }
            }
        }
    }
    let me = std::process::id();
    let mut holders: BTreeMap<u32, Holder> = BTreeMap::new();
    // 1. programs that have one of the files open
    for chunk in files.chunks(400) {
        for v in win::who_locks(chunk) {
            let pid = v["pid"].as_u64().unwrap_or(0) as u32;
            let h = holders.entry(pid).or_insert_with(|| Holder { name: v["name"].as_str().unwrap_or("").into(), exe: v["exe"].as_str().unwrap_or("").into(), service: v["service"].as_str().unwrap_or("").into(), how: vec![] });
            h.add("open", "");
        }
    }
    // 2. programs working in a folder, or running from it
    let procs = win::process_snapshot();
    let hidden = procs.iter().filter(|p| !p.inspectable).count();
    for pr in &procs {
        for d in &dirs {
            let mut hit = |kind: &str, detail: &str| {
                let h = holders.entry(pr.pid).or_insert_with(|| Holder { name: pr.name.clone(), exe: pr.exe.clone(), service: String::new(), how: vec![] });
                h.add(kind, detail);
            };
            if let Some(c) = &pr.cwd {
                if inside(c, d) {
                    hit("cwd", c);
                }
            }
            if !pr.exe.is_empty() && inside(&pr.exe, d) {
                hit("exe", &pr.exe);
            }
        }
    }
    // 3. try it for real
    let diagnosis: Vec<Value> = paths.iter().take(25).map(|p| probe(p)).collect();
    json!({ "admin": dogfile_core::is_admin(), "holders": holders_json(&holders, me), "diagnosis": diagnosis, "hiddenPrograms": hidden, "looked": { "files": files.len(), "folders": dirs.len(), "programs": procs.len(), "capped": capped } })
}

#[cfg(not(windows))]
pub fn inspect_sync(_paths: &[String]) -> Value {
    json!({ "unsupported": true, "holders": [], "diagnosis": [] })
}

pub async fn inspect(a: &Args) -> R {
    let paths = a.strs(0);
    tokio::task::spawn_blocking(move || inspect_sync(&paths)).await.map_err(err)
}

/// the same, run by an elevated copy of this program (Windows asks for permission once), which can see programs and system
/// services that a normal window can't
pub async fn inspect_admin(a: &Args) -> R {
    if !cfg!(windows) {
        return Err("Only on Windows".into());
    }
    let paths = a.strs(0);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let tag = format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let spec = std::env::temp_dir().join(format!("dogfile-locks-{tag}.json"));
    let out = std::env::temp_dir().join(format!("dogfile-locks-{tag}.out.json"));
    std::fs::write(&spec, json!({ "paths": paths }).to_string()).map_err(|e| e.to_string())?;
    let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let script = format!(
        "Start-Process -FilePath {} -ArgumentList {} -Verb RunAs -Wait -WindowStyle Hidden",
        q(&exe.to_string_lossy()),
        q(&format!("--who-locks \"{}\" \"{}\"", spec.to_string_lossy(), out.to_string_lossy()))
    );
    let o = crate::util::run("powershell.exe", &["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), script], None, 120_000).await;
    let _ = std::fs::remove_file(&spec);
    let res = match o {
        Ok(o) if o.ok => std::fs::read(&out).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).ok_or_else(|| "The administrator check gave no answer".to_string()),
        Ok(o) => Err(if o.err().to_lowercase().contains("cancel") { "Administrator permission was not given".to_string() } else { "Couldn’t start the administrator check".to_string() }),
        Err(e) => Err(e.to_string()),
    };
    let _ = std::fs::remove_file(&out);
    let mut v = res?;
    v["elevated"] = json!(true);
    Ok(v)
}

/// `Dogfile.exe --who-locks <request.json> <answer.json>`: what the elevated copy runs
pub fn cli(spec: &str, out: &str) -> i32 {
    let paths: Vec<String> = std::fs::read(spec).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v["paths"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())).unwrap_or_default();
    let v = inspect_sync(&paths);
    if std::fs::write(out, v.to_string()).is_ok() { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inside_means_the_folder_itself_or_something_in_it() {
        assert!(inside("C:\\Users\\me\\Proj", "c:\\users\\ME\\proj"));
        assert!(inside("C:\\Users\\me\\Proj\\src\\a.rs", "C:\\Users\\me\\Proj\\"));
        assert!(inside("C:/Users/me/Proj/x", "C:\\Users\\me\\Proj"));
        assert!(!inside("C:\\Users\\me\\Proj2", "C:\\Users\\me\\Proj"));
        assert!(!inside("C:\\Users\\me", "C:\\Users\\me\\Proj"));
        assert!(!inside("C:\\x", ""));
    }

    #[test]
    fn a_program_is_listed_once_with_every_way_it_is_involved() {
        let mut m: BTreeMap<u32, Holder> = BTreeMap::new();
        let h = m.entry(7).or_insert_with(|| Holder { name: "cmd.exe".into(), exe: "C:\\Windows\\cmd.exe".into(), service: String::new(), how: vec![] });
        h.add("cwd", "C:\\a");
        h.add("cwd", "C:\\a");
        h.add("open", "");
        let j = holders_json(&m, 7);
        assert_eq!(j.len(), 1);
        assert_eq!(j[0]["how"].as_array().unwrap().len(), 2);
        assert_eq!(j[0]["self"], true);
    }
}
