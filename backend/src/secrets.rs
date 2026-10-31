// Secrets (feature-browser token, server passwords, cloud sign-ins): encrypted with Windows' data protection (DPAPI)
// for this Windows user. On Windows nothing is ever saved unencrypted: if Windows can't encrypt it, saving fails and
// the caller says so. Old "p:" values (plain base64, from before this rule) are re-encrypted the next time they're
// read, or removed from disk if Windows still can't encrypt them.
use crate::store;
use serde_json::{json, Value};

const NO_DPAPI: &str = "Windows couldn’t encrypt it for your account, so it wasn’t saved (Dogfile never stores passwords unencrypted). Restart Windows and try again.";

/// encrypt for this Windows user. On Windows: DPAPI or an error. Elsewhere (the Linux and macOS preview builds have
/// no DPAPI) the value is only encoded, and the file holding it is readable by this user alone (see `set_in`).
pub fn protect(plain: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        crate::win::dpapi_protect(plain.as_bytes()).map(|b| format!("d:{}", crate::util::b64(&b))).ok_or_else(|| NO_DPAPI.to_string())
    }
    #[cfg(not(windows))]
    {
        Ok(format!("p:{}", crate::util::b64(plain.as_bytes())))
    }
}
pub fn unprotect(v: &str) -> String {
    let (k, rest) = v.split_at(v.find(':').map(|i| i + 1).unwrap_or(0));
    let Ok(b) = crate::util::unb64(rest) else { return String::new() };
    match k {
        // read so old values can be moved to "d:" (see get_in and reminders::load); never written on Windows now
        "p:" => String::from_utf8_lossy(&b).into_owned(),
        #[cfg(windows)]
        "d:" => crate::win::dpapi_unprotect(&b).map(|x| String::from_utf8_lossy(&x).into_owned()).unwrap_or_default(),
        // "e:" values were encrypted by the old Electron version (Chromium's key): ask again
        _ => String::new(),
    }
}
/// whether a stored value is the old unencrypted kind that has to be moved to DPAPI
pub fn needs_upgrade(v: &str) -> bool {
    cfg!(windows) && v.starts_with("p:")
}

/// save (or with an empty value, remove) one secret; Err when it couldn't be encrypted or written
pub fn set_in(file: &str, name: &str, value: &str) -> Result<(), String> {
    set_at(&crate::st().data_dir, file, name, value)
}
fn set_at(dir: &std::path::Path, file: &str, name: &str, value: &str) -> Result<(), String> {
    let mut all = store::get_in(dir, file).unwrap_or(json!({}));
    if !all.is_object() {
        all = json!({})
    }
    if value.is_empty() {
        all.as_object_mut().unwrap().remove(name);
    } else {
        all[name] = json!(protect(value)?);
    }
    store::set_in(dir, file, &all).map_err(|e| format!("Couldn’t save it: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir.join(format!("{}.json", crate::demo::store_key(file))), std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}
pub fn get_in(file: &str, name: &str) -> String {
    let Some(raw) = store::get(file).and_then(|a| a.get(name).and_then(|v| v.as_str().map(String::from))) else { return String::new() };
    let plain = unprotect(&raw);
    if needs_upgrade(&raw) {
        // an old unencrypted value: encrypt it now, or take it off the disk (then it's asked for again)
        match set_in(file, name, &plain) {
            Ok(()) => {}
            Err(e) => {
                crate::errlog(&format!("secrets: an old unencrypted {name} couldn't be encrypted and was removed: {e}"));
                let _ = remove_raw(file, name);
                return String::new();
            }
        }
    }
    plain
}
fn remove_raw(file: &str, name: &str) -> Result<(), String> {
    let mut all = store::get_or(file, json!({}));
    if let Some(o) = all.as_object_mut() {
        o.remove(name);
    }
    store::set(file, &all)
}
pub fn set(name: &str, value: &str) -> Result<Value, String> {
    set_in("secrets", name, value)?;
    Ok(json!(true))
}
pub fn has(name: &str) -> Value {
    json!(!get_in("secrets", name).is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tmp(label: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("dogfile-secrets-{label}-{}-{}", std::process::id(), crate::util::now_ms() as u64));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    #[test]
    fn a_failed_write_is_an_error_not_a_success() {
        let d = tmp("fail");
        // a folder sits where the file's temporary copy has to go: the write can't succeed, and it must say so
        std::fs::create_dir_all(d.join("blocked.json.tmp")).unwrap();
        assert!(set_at(&d, "blocked", "x", "hunter2").is_err());
        // a data folder that can't exist (it's a file): an error too
        std::fs::write(d.join("file"), b"").unwrap();
        assert!(set_at(&d.join("file"), "secrets", "x", "hunter2").is_err());
        std::fs::remove_dir_all(&d).ok();
    }
    #[test]
    fn a_good_write_round_trips_and_is_never_plain_on_windows() {
        let d = tmp("ok");
        set_at(&d, "secrets", "x", "hunter2").unwrap();
        let raw = store::get_in(&d, "secrets").unwrap()["x"].as_str().unwrap().to_string();
        if cfg!(windows) {
            assert!(raw.starts_with("d:"), "{raw}");
        }
        assert_eq!(unprotect(&raw), "hunter2");
        set_at(&d, "secrets", "x", "").unwrap();
        assert!(store::get_in(&d, "secrets").unwrap().get("x").is_none());
        std::fs::remove_dir_all(&d).ok();
    }
}
