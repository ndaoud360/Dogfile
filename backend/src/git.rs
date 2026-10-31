// git for the status bar: branch, changed files (badges), switching branches, recent history, pull.
use crate::args::{Args, R};
use crate::util;
use serde_json::{json, Map, Value};
use std::path::Path;

async fn git(dir: &str, args: &[&str], timeout: u64) -> Result<String, String> {
    let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let o = util::run("git", &a, Some(Path::new(dir)), timeout).await.map_err(|e| e.to_string())?;
    if o.ok {
        Ok(o.out())
    } else {
        let e = o.err();
        let lines: Vec<&str> = e.trim().lines().collect();
        Err(lines.iter().rev().take(2).rev().cloned().collect::<Vec<_>>().join(" "))
    }
}
pub async fn branches(a: &Args) -> R {
    let out = git(&a.s(0)?, &["branch", "--format=%(HEAD)|%(refname:short)|%(committerdate:relative)", "--sort=-committerdate"], 15000).await?;
    Ok(json!(out.lines().filter(|l| !l.is_empty()).map(|l| { let p: Vec<&str> = l.splitn(3, '|').collect(); json!({ "name": p.get(1).unwrap_or(&""), "current": p.first() == Some(&"*"), "when": p.get(2).unwrap_or(&"") }) }).collect::<Vec<_>>()))
}
pub async fn checkout(a: &Args) -> R {
    let (dir, br) = (a.s(0)?, a.s(1)?);
    if a.b(2) { git(&dir, &["checkout", "-b", &br], 30000).await?; } else { git(&dir, &["checkout", &br], 30000).await?; }
    Ok(json!(true))
}
pub async fn log(a: &Args) -> R {
    let n = format!("-{}", a.u(1, 25));
    let out = git(&a.s(0)?, &["log", &n, "--date=relative", "--pretty=format:%h\x1f%s\x1f%an\x1f%ad"], 15000).await?;
    Ok(json!(out.lines().filter(|l| !l.is_empty()).map(|l| { let p: Vec<&str> = l.split('\x1f').collect(); json!({ "hash": p.first(), "subject": p.get(1), "author": p.get(2), "date": p.get(3) }) }).collect::<Vec<_>>()))
}
pub async fn pull(a: &Args) -> R {
    Ok(json!(git(&a.s(0)?, &["pull", "--ff-only"], 60000).await?))
}
pub async fn status(a: &Args) -> R {
    let dir = a.s(0)?;
    let mut d = std::path::PathBuf::from(&dir);
    let mut root = None;
    for _ in 0..40 {
        if d.join(".git").exists() { root = Some(d.clone()); break }
        if !d.pop() { break }
    }
    let Some(root) = root else { return Ok(Value::Null) };
    let branch = std::fs::read_to_string(root.join(".git").join("HEAD")).ok().map(|h| { let h = h.trim(); if let Some(r) = h.strip_prefix("ref:") { r.trim().split('/').skip(2).collect::<Vec<_>>().join("/") } else { h.chars().take(7).collect() } });
    let rs = root.to_string_lossy().into_owned();
    let files = match git(&rs, &["status", "--porcelain=v1", "-z", "--ignored=no", "-unormal"], 8000).await {
        Ok(out) => {
            let mut m = Map::new();
            let parts: Vec<&str> = out.split('\0').collect();
            let mut i = 0;
            while i < parts.len() {
                let s = parts[i];
                i += 1;
                if s.len() < 4 { continue }
                let code = &s[..2];
                let rel = &s[3..];
                if code.starts_with('R') { i += 1 }
                let full = root.join(rel).to_string_lossy().trim_end_matches(['\\', '/']).to_string();
                let c = code.trim();
                m.insert(full, json!(if c.is_empty() { code } else { c }));
            }
            Value::Object(m)
        }
        Err(_) => Value::Null,
    };
    Ok(json!({ "root": rs, "branch": branch, "files": files }))
}
