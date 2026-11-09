// More cloud drives through rclone (https://rclone.org): Box, MEGA, pCloud, Proton Drive, Yandex Disk, Google Photos,
// Backblaze B2, Azure and dozens more. rclone is a downloadable part (components.rs), like ffmpeg. Dogfile keeps its own
// rclone settings file, so it never touches one you made yourself. A drive added here is browsed like the built-in ones
// (cloudapi.rs / remote.rs): list, open, copy in and out, new folder, rename, delete.
use crate::args::{Args, R};
use crate::cloudapi::Ent;
use crate::{components, st, util};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn data_file(name: &str) -> PathBuf {
    std::env::var("DOGFILE_RCLONE_DIR").map(|d| PathBuf::from(d).join(name)).unwrap_or_else(|_| st().data_dir.join(name))
}
fn conf() -> PathBuf {
    data_file("rclone.conf")
}

/// the rclone program: DOGFILE_RCLONE (development), the downloaded part, one next to Dogfile, or one already on this PC
fn exe() -> Option<(PathBuf, &'static str)> {
    if let Ok(p) = std::env::var("DOGFILE_RCLONE") {
        let p = PathBuf::from(p);
        return p.is_file().then_some((p, "development copy"));
    }
    let part = components::rclone_dir().join("rclone.exe");
    if components::ready("rclone") && part.is_file() {
        return Some((part, "downloaded part"));
    }
    if let Some(p) = bundled() {
        return Some((p, "bundled"));
    }
    util::which("rclone").map(|p| (p, "found on this PC"))
}
pub fn bundled() -> Option<PathBuf> {
    let me = std::env::current_exe().ok()?;
    let dir = me.parent()?;
    [dir.join("rclone").join("rclone.exe"), dir.join("rclone.exe")].into_iter().find(|p| p.is_file())
}

async fn rc(args: &[&str], timeout: u64) -> Result<util::Output, String> {
    let (program, _) = exe().ok_or("NEED_RCLONE")?;
    let mut all: Vec<String> = vec!["--config".into(), conf().to_string_lossy().to_string()];
    all.extend(args.iter().map(|s| s.to_string()));
    util::run(&program, &all, None, timeout).await.map_err(|e| format!("Couldn’t run rclone: {e}"))
}
fn problem(o: &util::Output) -> String {
    let e = o.err();
    // rclone prints "ERROR : …" lines; the last one says what went wrong
    let line = e.lines().rev().find(|l| l.contains("ERROR") || l.contains("Failed") || l.contains("CRITICAL")).or_else(|| e.lines().rev().find(|l| !l.trim().is_empty())).unwrap_or("rclone failed");
    let line = line.split(" : ").last().unwrap_or(line);
    line.trim().chars().take(400).collect()
}
async fn ok(args: &[&str], timeout: u64) -> Result<util::Output, String> {
    let o = rc(args, timeout).await?;
    if o.ok { Ok(o) } else { Err(problem(&o)) }
}

/// a remote's name: letters, digits, dot, dash, underscore
fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 60 && !n.starts_with('-') && n.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}
/// "/folder/file" on remote "box1" → "box1:folder/file"
fn target(remote: &str, path: &str) -> String {
    format!("{remote}:{}", path.trim_start_matches('/'))
}

/// "2026-11-01T10:00:00.5+01:00" → seconds since 1970
pub fn parse_time(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let mut idx = 19;
    let mut frac = 0.0;
    if b.get(idx) == Some(&b'.') {
        let start = idx;
        idx += 1;
        while idx < b.len() && b[idx].is_ascii_digit() {
            idx += 1;
        }
        frac = s[start..idx].parse::<f64>().unwrap_or(0.0);
    }
    let mut offset = 0i64;
    if let Some(&c) = b.get(idx) {
        if c == b'+' || c == b'-' {
            let oh = s.get(idx + 1..idx + 3)?.parse::<i64>().ok()?;
            let om = s.get(idx + 4..idx + 6).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
            offset = (oh * 3600 + om * 60) * if c == b'+' { 1 } else { -1 };
        }
    }
    // days since 1970 (civil calendar)
    let (y2, m2) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days * 86_400 + h * 3600 + mi * 60 + se - offset) as f64 + frac)
}

fn ent_of(v: &Value) -> Option<Ent> {
    let name = v["Name"].as_str().or_else(|| v["Path"].as_str())?.to_string();
    let is_dir = v["IsDir"].as_bool().unwrap_or(false);
    Some(Ent { name, is_dir, size: v["Size"].as_i64().filter(|s| *s >= 0).unwrap_or(0) as u64, mtime: v["ModTime"].as_str().and_then(parse_time).unwrap_or(0.0) })
}

/// one rclone remote, used like the built-in cloud drives
pub struct Remote {
    pub name: String,
}
impl Remote {
    pub fn new(name: &str) -> Self {
        Remote { name: name.to_string() }
    }
    fn t(&self, p: &str) -> Result<String, String> {
        if valid_name(&self.name) { Ok(target(&self.name, p)) } else { Err("This drive’s name isn’t valid".into()) }
    }
    pub async fn list(&self, dir: &str) -> Result<Vec<Ent>, String> {
        let o = ok(&["lsjson", "--no-mimetype", &self.t(dir)?], 120_000).await?;
        let v: Value = serde_json::from_str(o.out().trim()).map_err(|_| "rclone gave an unreadable list".to_string())?;
        Ok(v.as_array().map(|a| a.iter().filter_map(ent_of).collect()).unwrap_or_default())
    }
    pub async fn stat(&self, p: &str) -> Option<(bool, u64)> {
        let o = rc(&["lsjson", "--stat", "--no-mimetype", &self.t(p).ok()?], 60_000).await.ok()?;
        if !o.ok {
            return None;
        }
        let v: Value = serde_json::from_str(o.out().trim()).ok()?;
        let e = ent_of(&v)?;
        Some((e.is_dir, e.size))
    }
    pub async fn download(&self, p: &str, local: &Path, prog: &mut (dyn FnMut(u64) + Send)) -> Result<(), String> {
        if let Some(d) = local.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        ok(&["copyto", &self.t(p)?, &local.to_string_lossy()], 3_600_000).await?;
        prog(std::fs::metadata(local).map(|m| m.len()).unwrap_or(0));
        Ok(())
    }
    pub async fn upload(&self, local: &Path, p: &str, prog: &mut (dyn FnMut(u64) + Send)) -> Result<(), String> {
        ok(&["copyto", &local.to_string_lossy(), &self.t(p)?], 3_600_000).await?;
        prog(std::fs::metadata(local).map(|m| m.len()).unwrap_or(0));
        Ok(())
    }
    pub async fn copy(&self, from: &str, to: &str) -> Option<Result<(), String>> {
        let (a, b) = (self.t(from).ok()?, self.t(to).ok()?);
        Some(ok(&["copyto", &a, &b], 3_600_000).await.map(|_| ()))
    }
    pub async fn mkdir(&self, p: &str) -> Result<(), String> {
        ok(&["mkdir", &self.t(p)?], 60_000).await.map(|_| ())
    }
    /// a file, or a folder with everything in it
    pub async fn remove(&self, p: &str) -> Result<(), String> {
        let t = self.t(p)?;
        match self.stat(p).await {
            Some((true, _)) => ok(&["purge", &t], 600_000).await.map(|_| ()),
            Some((false, _)) => ok(&["deletefile", &t], 120_000).await.map(|_| ()),
            None => Ok(()),
        }
    }
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        let (a, b) = (self.t(from)?, self.t(to)?);
        // a folder is moved with its contents; a file is moved by name
        match self.stat(from).await {
            Some((true, _)) => ok(&["move", &a, &b], 600_000).await.map(|_| ()),
            _ => ok(&["moveto", &a, &b], 600_000).await.map(|_| ()),
        }
    }
}

// ---------------------------------------------------------------- what the window asks for
/// the services offered when adding a drive (anything else rclone knows can be typed in under "Other")
fn providers() -> Value {
    json!([
        { "type": "box", "label": "Box", "auth": "browser", "fields": [] },
        { "type": "mega", "label": "MEGA", "auth": "password", "fields": [
            { "key": "user", "label": "Email", "secret": false }, { "key": "pass", "label": "Password", "secret": true } ],
          "note": "MEGA encrypts everything on your PC, so listing a big account can take a moment." },
        { "type": "pcloud", "label": "pCloud", "auth": "browser", "fields": [] },
        { "type": "protondrive", "label": "Proton Drive", "auth": "password", "fields": [
            { "key": "username", "label": "Proton username", "secret": false }, { "key": "password", "label": "Password", "secret": true }, { "key": "2fa", "label": "Two-factor code (if you use one)", "secret": false } ],
          "note": "Proton Drive support is still new in rclone." },
        { "type": "yandex", "label": "Yandex Disk", "auth": "browser", "fields": [] },
        { "type": "gphotos", "label": "Google Photos (read only)", "rclone": "google photos", "auth": "browser", "fields": [] },
        { "type": "b2", "label": "Backblaze B2", "auth": "keys", "fields": [
            { "key": "account", "label": "keyID", "secret": false }, { "key": "key", "label": "applicationKey", "secret": true } ] },
        { "type": "azureblob", "label": "Microsoft Azure Blob", "auth": "keys", "fields": [
            { "key": "account", "label": "Storage account name", "secret": false }, { "key": "key", "label": "Account key", "secret": true } ] },
        { "type": "other", "label": "Another service (advanced)…", "auth": "other", "fields": [] },
    ])
}

pub async fn status(_a: &Args) -> R {
    let Some((_, source)) = exe() else { return Ok(json!({ "ready": false })) };
    match ok(&["version"], 20_000).await {
        Ok(o) => Ok(json!({ "ready": true, "version": o.out().lines().next().unwrap_or("").trim(), "source": source })),
        Err(e) => Ok(json!({ "ready": false, "installed": true, "error": e })),
    }
}
pub fn provider_list(_a: &Args) -> R {
    Ok(providers())
}
pub async fn remotes(_a: &Args) -> R {
    let o = ok(&["listremotes", "--long"], 20_000).await?;
    Ok(json!(o.out().lines().filter_map(|l| { let (n, t) = l.split_once(':')?; Some(json!({ "name": n.trim(), "type": t.trim() })) }).collect::<Vec<_>>()))
}

/// rclone:create({ name, type, params }): sign in (a browser opens for the services that use one) and save the drive
pub async fn create(a: &Args) -> R {
    let spec = a.v(0);
    let (name, kind) = (spec["name"].as_str().unwrap_or("").to_string(), spec["type"].as_str().unwrap_or("").to_string());
    if !valid_name(&name) {
        return Err("Choose a name with only letters, numbers, dots, dashes or underscores".into());
    }
    if kind.is_empty() || !kind.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Choose a service".into());
    }
    if ok(&["listremotes"], 20_000).await?.out().lines().any(|l| l.trim_end_matches(':') == name) {
        return Err(format!("A drive called “{name}” already exists"));
    }
    let mut args: Vec<String> = vec!["config".into(), "create".into(), name.clone(), kind.clone()];
    if let Some(p) = spec["params"].as_object() {
        for (k, v) in p {
            let val = v.as_str().unwrap_or("").trim();
            if !val.is_empty() && !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                args.push(format!("{k}={val}"));
            }
        }
    }
    args.push("--obscure".into());
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    // signing in through the browser can take a few minutes
    ok(&refs, 600_000).await?;
    // prove it works before the drive is kept
    if let Err(e) = ok(&["lsjson", "--max-depth", "1", &format!("{name}:")], 120_000).await {
        let _ = rc(&["config", "delete", &name], 20_000).await;
        return Err(format!("It was set up but couldn’t be opened: {e}"));
    }
    Ok(json!({ "name": name }))
}

pub async fn delete(a: &Args) -> R {
    let name = a.s(0)?;
    if !valid_name(&name) {
        return Err("This drive’s name isn’t valid".into());
    }
    ok(&["config", "delete", &name], 20_000).await?;
    Ok(json!(true))
}

/// rclone:check(name): a quick look at the top folder
pub async fn check(a: &Args) -> R {
    let name = a.s(0)?;
    let items = Remote::new(&name).list("/").await?;
    Ok(json!({ "ok": true, "count": items.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_and_names() {
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(parse_time("2026-11-09T12:30:15Z"), Some(1_794_227_415.0));
        assert_eq!(parse_time("2026-11-09T13:30:15+01:00"), Some(1_794_227_415.0));
        assert_eq!(parse_time("2026-11-09T12:30:15.5Z"), Some(1_794_227_415.5));
        assert_eq!(parse_time("2000-02-29T00:00:00Z"), Some(951_782_400.0));
        assert!(parse_time("garbage").is_none());
        assert!(valid_name("box-1.work") && !valid_name("-x") && !valid_name("a b") && !valid_name("a:b") && !valid_name(""));
        assert_eq!(target("box1", "/a/b c.txt"), "box1:a/b c.txt");
        assert_eq!(target("box1", "/"), "box1:");
    }

    #[test]
    fn a_listing_becomes_entries() {
        let v: Value = serde_json::from_str(r#"[{"Path":"a.txt","Name":"a.txt","Size":12,"ModTime":"2026-11-09T12:30:15Z","IsDir":false},{"Path":"d","Name":"d","Size":-1,"ModTime":"2026-11-09T12:30:15Z","IsDir":true}]"#).unwrap();
        let e: Vec<Ent> = v.as_array().unwrap().iter().filter_map(ent_of).collect();
        assert_eq!((e[0].name.as_str(), e[0].size, e[0].is_dir), ("a.txt", 12, false));
        assert_eq!((e[1].name.as_str(), e[1].size, e[1].is_dir), ("d", 0, true));
    }

    // the whole thing against a real rclone, with its "local" drive standing in for a cloud (needs DOGFILE_RCLONE)
    #[tokio::test(flavor = "multi_thread")]
    async fn browsing_copying_and_deleting_through_rclone() {
        let Ok(bin) = std::env::var("DOGFILE_RCLONE") else { return };
        if !Path::new(&bin).is_file() {
            return;
        }
        let work = std::env::temp_dir().join(format!("dogfile-rclone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        let cloud = work.join("cloud");
        std::fs::create_dir_all(cloud.join("docs")).unwrap();
        std::fs::write(cloud.join("docs").join("a.txt"), "hello").unwrap();
        unsafe { std::env::set_var("DOGFILE_RCLONE_DIR", &work) };
        let call = |a: Vec<Value>| Args(a);
        assert_eq!(status(&call(vec![])).await.unwrap()["ready"], true);
        create(&call(vec![json!({ "name": "fake", "type": "alias", "params": { "remote": cloud.to_string_lossy() } })])).await.unwrap();
        assert!(create(&call(vec![json!({ "name": "fake", "type": "alias", "params": { "remote": "x" } })])).await.is_err());
        assert!(create(&call(vec![json!({ "name": "bad name", "type": "alias" })])).await.is_err());
        assert_eq!(remotes(&call(vec![])).await.unwrap().as_array().unwrap().len(), 1);
        let r = Remote::new("fake");
        let top = r.list("/").await.unwrap();
        assert_eq!(top.len(), 1);
        assert!(top[0].is_dir);
        let docs = r.list("/docs").await.unwrap();
        assert_eq!((docs[0].name.as_str(), docs[0].size), ("a.txt", 5));
        assert!(docs[0].mtime > 1_700_000_000.0);
        assert_eq!(r.stat("/docs/a.txt").await, Some((false, 5)));
        assert_eq!(r.stat("/docs").await.map(|s| s.0), Some(true));
        assert_eq!(r.stat("/nope").await, None);
        // down, up, copy inside, rename, new folder, delete
        let local = work.join("got.txt");
        let mut seen = 0u64;
        r.download("/docs/a.txt", &local, &mut |n| seen = n).await.unwrap();
        assert_eq!((std::fs::read_to_string(&local).unwrap(), seen), ("hello".to_string(), 5));
        std::fs::write(&local, "changed!").unwrap();
        r.upload(&local, "/docs/b.txt", &mut |_| {}).await.unwrap();
        assert_eq!(std::fs::read_to_string(cloud.join("docs").join("b.txt")).unwrap(), "changed!");
        r.copy("/docs/b.txt", "/docs/c.txt").await.unwrap().unwrap();
        r.rename("/docs/c.txt", "/docs/d.txt").await.unwrap();
        r.mkdir("/new folder").await.unwrap();
        assert!(cloud.join("new folder").is_dir() && cloud.join("docs").join("d.txt").is_file() && !cloud.join("docs").join("c.txt").exists());
        r.rename("/docs", "/papers").await.unwrap();
        assert!(cloud.join("papers").join("d.txt").is_file());
        r.remove("/papers/d.txt").await.unwrap();
        r.remove("/papers").await.unwrap();
        assert!(!cloud.join("papers").exists());
        assert_eq!(check(&call(vec![json!("fake")])).await.unwrap()["ok"], true);
        delete(&call(vec![json!("fake")])).await.unwrap();
        assert!(remotes(&call(vec![])).await.unwrap().as_array().unwrap().is_empty());
        unsafe { std::env::remove_var("DOGFILE_RCLONE_DIR") };
        let _ = std::fs::remove_dir_all(&work);
    }
}
