// Updates: Dogfile does not install updates itself. The Microsoft Store (or, for a copy installed from the website, the
// website) provides new versions. Dogfile only looks at a small file (latest.json) on its public GitHub Releases page to
// learn that a newer version exists, so it can say so and point to the Store, and it carries its own release notes, so
// that after an update it can show what changed. Nothing is downloaded or run.
//
// latest.json: { "version": "2.0.1", "date": "2026-10-22", "notes": "Markdown-ish changelog: \"- \" bullets, \"# \" headings" }
// (the file publish.yml makes has more in it, which is ignored here)
use crate::args::{Args, R};
use crate::{setting, util};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::OnceLock;

pub const DEFAULT_URL: &str = "https://github.com/ndaoud360/dogfile-updates/releases/latest/download/latest.json";
/// the release notes of this version, written in release-notes/<version>.md (the build stops if that file is missing)
const OWN_NOTES: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../release-notes/", env!("CARGO_PKG_VERSION"), ".md"));

fn manifest_url() -> String {
    setting("updateUrl").as_str().filter(|s| s.starts_with("https://")).map(String::from).unwrap_or_else(|| DEFAULT_URL.to_string())
}
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
/// the Microsoft Store copy (store.txt beside the program) is installed and updated by the Store
pub fn from_store() -> bool {
    crate::st().res_dir.join("store.txt").is_file()
}

/// "2.0.10" > "2.0.9"; anything after a dash (2.1.0-beta) sorts before the plain version
pub fn newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> (Vec<u64>, bool) {
        let v = v.trim().trim_start_matches(['v', 'V']);
        let (main, pre) = v.split_once('-').map(|(m, p)| (m, !p.is_empty())).unwrap_or((v, false));
        (main.split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect(), pre)
    };
    let (mut x, xp) = parse(a);
    let (mut y, yp) = parse(b);
    let n = x.len().max(y.len());
    x.resize(n, 0);
    y.resize(n, 0);
    if x != y {
        return x > y;
    }
    !xp && yp
}

struct Last {
    manifest: Option<Value>,
    checked: f64,
    error: Option<String>,
}
fn last() -> &'static Mutex<Last> {
    static L: OnceLock<Mutex<Last>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(Last { manifest: None, checked: 0.0, error: None }))
}

fn status_json() -> Value {
    let l = last().lock();
    let cur = current_version();
    let (available, latest, notes, date) = match &l.manifest {
        Some(m) => {
            let v = m["version"].as_str().unwrap_or("");
            (!v.is_empty() && newer(v, cur), json!(v), m["notes"].clone(), m["date"].clone())
        }
        None => (false, Value::Null, Value::Null, Value::Null),
    };
    json!({ "current": cur, "available": available, "latest": latest, "notes": notes, "date": date,
            "checked": if l.checked > 0.0 { json!(l.checked) } else { Value::Null }, "error": l.error, "store": from_store() })
}

/// update:check: look for a newer version now (only to say so; nothing is downloaded)
pub async fn check(_a: &Args) -> R {
    let url = manifest_url();
    let r = async {
        let resp = util::http().get(&url).header("Cache-Control", "no-cache").timeout(std::time::Duration::from_secs(20)).send().await.map_err(|e| short_err(&e.to_string()))?;
        if !resp.status().is_success() {
            return Err(if resp.status().as_u16() == 404 { "No updates have been published yet".to_string() } else { format!("The update server answered {}", resp.status()) });
        }
        let body = resp.bytes().await.map_err(|e| short_err(&e.to_string()))?;
        let m: Value = serde_json::from_slice(&body).map_err(|_| "The update information couldn't be read".to_string())?;
        if m["version"].as_str().is_none() {
            return Err("The update information couldn't be read".into());
        }
        // only what is shown is kept
        Ok(json!({ "version": m["version"], "date": m["date"], "notes": m["notes"] }))
    }
    .await;
    {
        let mut l = last().lock();
        l.checked = util::now_ms();
        match r {
            Ok(m) => {
                l.manifest = Some(m);
                l.error = None;
            }
            Err(e) => l.error = Some(e),
        }
    }
    Ok(status_json())
}
fn short_err(e: &str) -> String {
    if e.contains("dns") || e.contains("connect") || e.contains("timed out") { "No connection to the update server".into() } else { util::last_line(e) }
}
pub fn status(_a: &Args) -> R {
    Ok(status_json())
}
/// update:notes: what is new in this version (carried inside the program, so it works offline)
pub fn notes(_a: &Args) -> R {
    Ok(json!({ "version": current_version(), "notes": OWN_NOTES, "store": from_store() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn this_version_has_release_notes() {
        assert!(OWN_NOTES.trim().len() > 10, "release-notes/{}.md is empty", current_version());
    }
    #[test]
    fn versions_compare_like_people_expect() {
        assert!(newer("2.0.10", "2.0.9"));
        assert!(!newer("2.0.9", "2.0.10"));
        assert!(!newer("2.0.0", "2.0.0"));
        assert!(newer("v2.1.0", "2.0.0"));
        assert!(newer("2.1.0", "2.1.0-beta"));
        assert!(!newer("2.1.0-beta", "2.1.0"));
        // something unreadable is never "newer", so it can't trigger an update
        assert!(!newer("garbage", "2.0.0"));
    }
}
