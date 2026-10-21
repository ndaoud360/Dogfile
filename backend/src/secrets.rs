// Secrets (feature-browser token, server passwords): encrypted with Windows' data protection for this user.
use crate::store;
use serde_json::{json, Value};

pub fn protect(plain: &str) -> String {
    #[cfg(windows)]
    if let Some(b) = crate::win::dpapi_protect(plain.as_bytes()) {
        return format!("d:{}", crate::util::b64(&b));
    }
    format!("p:{}", crate::util::b64(plain.as_bytes()))
}
pub fn unprotect(v: &str) -> String {
    let (k, rest) = v.split_at(v.find(':').map(|i| i + 1).unwrap_or(0));
    let Ok(b) = crate::util::unb64(rest) else { return String::new() };
    match k {
        "p:" => String::from_utf8_lossy(&b).into_owned(),
        #[cfg(windows)]
        "d:" => crate::win::dpapi_unprotect(&b).map(|x| String::from_utf8_lossy(&x).into_owned()).unwrap_or_default(),
        // "e:" values were encrypted by the old Electron version (Chromium's key): ask again
        _ => String::new(),
    }
}
pub fn set_in(file: &str, name: &str, value: &str) {
    let mut all = store::get_or(file, json!({}));
    if !all.is_object() { all = json!({}) }
    if value.is_empty() {
        all.as_object_mut().unwrap().remove(name);
    } else {
        all[name] = json!(protect(value));
    }
    let _ = store::set(file, &all);
}
pub fn get_in(file: &str, name: &str) -> String {
    store::get(file).and_then(|a| a.get(name).and_then(|v| v.as_str().map(String::from))).map(|v| unprotect(&v)).unwrap_or_default()
}
pub fn set(name: &str, value: &str) -> Value {
    set_in("secrets", name, value);
    json!(true)
}
pub fn has(name: &str) -> Value {
    json!(!get_in("secrets", name).is_empty())
}
