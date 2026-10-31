// Tags written into the files themselves, so they travel with the file (another PC, a backup, Explorer's "Tags"
// column, Windows Search): System.Keywords through the Windows property system (photos, music, video, Office…);
// Office files and PDFs directly; everywhere else an extended attribute (user.xdg.tags on Linux).
use crate::args::{Args, R};
use serde_json::json;

/// "C:\\a\\\\b" → "C:\\a\\b" (the property system rejects doubled separators); UNC prefixes are kept
fn norm(p: &str) -> String {
    let (pre, rest) = if p.starts_with("\\\\") { ("\\\\", &p[2..]) } else { ("", p) };
    let mut s = rest.to_string();
    while s.contains("\\\\") {
        s = s.replace("\\\\", "\\");
    }
    format!("{pre}{s}")
}
pub async fn read(a: &Args) -> R {
    let p = norm(&a.s(0)?);
    let v = tokio::task::spawn_blocking(move || read_words(&p)).await.map_err(|e| e.to_string())?;
    Ok(json!(v))
}
pub async fn write(a: &Args) -> R {
    let p = norm(&a.s(0)?);
    let words: Vec<String> = crate::args::strs(&a.v(1)).into_iter().map(|w| w.trim().to_string()).filter(|w| !w.is_empty()).collect();
    let r = tokio::task::spawn_blocking(move || write_words(&p, &words)).await.map_err(|e| e.to_string())?;
    match r {
        Ok(how) => Ok(json!({ "ok": true, "how": how })),
        Err(e) => Ok(json!({ "ok": false, "error": e })),
    }
}

fn read_words(p: &str) -> Vec<String> {
    #[cfg(windows)]
    if let Ok(v) = win::read(p) {
        if !v.is_empty() {
            return v;
        }
    }
    let ext = crate::util::ext(p);
    if ["docx", "xlsx", "pptx"].contains(&ext.as_str()) || ext == "pdf" {
        if let Ok(v) = crate::doc::props_of(p) {
            if let Some(k) = v["keywords"].as_str() {
                return split(k);
            }
        }
    }
    #[cfg(unix)]
    if let Some(v) = xattr_get(p) {
        return split(&v);
    }
    vec![]
}
fn split(s: &str) -> Vec<String> {
    s.split([';', ',']).map(|w| w.trim().to_string()).filter(|w| !w.is_empty()).collect()
}

fn write_words(p: &str, words: &[String]) -> Result<&'static str, String> {
    let ext = crate::util::ext(p);
    #[cfg(windows)]
    {
        if ext != "pdf" {
            match win::write(p, words) {
                Ok(()) => return Ok("properties"),
                Err(e) if !["docx", "xlsx", "pptx"].contains(&ext.as_str()) => return Err(e),
                Err(_) => {}
            }
        }
    }
    if ["docx", "xlsx", "pptx"].contains(&ext.as_str()) {
        crate::doc::set_props(p, &json!({ "keywords": words.join("; ") }))?;
        return Ok("office");
    }
    if ext == "pdf" {
        crate::doc::pdf_set_info(p, &json!({ "keywords": words.join("; ") }))?;
        return Ok("pdf");
    }
    #[cfg(unix)]
    {
        xattr_set(p, &words.join(";"))?;
        return Ok("xattr");
    }
    #[allow(unreachable_code)]
    Err("This kind of file can’t hold tags".into())
}

#[cfg(unix)]
fn xattr_get(p: &str) -> Option<String> {
    use std::ffi::CString;
    let path = CString::new(p).ok()?;
    let name = CString::new("user.xdg.tags").ok()?;
    let mut buf = vec![0u8; 4096];
    #[cfg(target_os = "macos")]
    let n = unsafe { libc::getxattr(path.as_ptr(), name.as_ptr(), buf.as_mut_ptr() as *mut _, buf.len(), 0, 0) };
    #[cfg(not(target_os = "macos"))]
    let n = unsafe { libc::getxattr(path.as_ptr(), name.as_ptr(), buf.as_mut_ptr() as *mut _, buf.len()) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    String::from_utf8(buf).ok()
}
#[cfg(unix)]
fn xattr_set(p: &str, v: &str) -> Result<(), String> {
    use std::ffi::CString;
    let path = CString::new(p).map_err(|e| e.to_string())?;
    let name = CString::new("user.xdg.tags").map_err(|e| e.to_string())?;
    let r = if v.is_empty() {
        #[cfg(target_os = "macos")]
        let r = unsafe { libc::removexattr(path.as_ptr(), name.as_ptr(), 0) };
        #[cfg(not(target_os = "macos"))]
        let r = unsafe { libc::removexattr(path.as_ptr(), name.as_ptr()) };
        if r != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENODATA) { 0 } else { r }
    } else {
        #[cfg(target_os = "macos")]
        let r = unsafe { libc::setxattr(path.as_ptr(), name.as_ptr(), v.as_ptr() as *const _, v.len(), 0, 0) };
        #[cfg(not(target_os = "macos"))]
        let r = unsafe { libc::setxattr(path.as_ptr(), name.as_ptr(), v.as_ptr() as *const _, v.len(), 0) };
        r
    };
    if r == 0 { Ok(()) } else { Err(format!("Couldn’t write tags: {}", std::io::Error::last_os_error())) }
}

#[cfg(windows)]
mod win {
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Storage::EnhancedStorage::PKEY_Keywords;
    use windows::Win32::System::Com::StructuredStorage::{InitPropVariantFromStringVector, PropVariantToStringVectorAlloc};
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreFromParsingName, GPS_DEFAULT, GPS_READWRITE};

    pub fn read(p: &str) -> Result<Vec<String>, String> {
        crate::win::com_init();
        unsafe {
            let store: IPropertyStore = SHGetPropertyStoreFromParsingName(&HSTRING::from(p), None, GPS_DEFAULT).map_err(|e| e.message())?;
            let v = store.GetValue(&PKEY_Keywords).map_err(|e| e.message())?;
            let mut arr: *mut PWSTR = std::ptr::null_mut();
            let mut n = 0u32;
            if PropVariantToStringVectorAlloc(&v, &mut arr, &mut n).is_err() || arr.is_null() {
                return Ok(vec![]);
            }
            let mut out = vec![];
            for i in 0..n as usize {
                let s = *arr.add(i);
                if !s.is_null() {
                    out.push(s.to_string().unwrap_or_default());
                    CoTaskMemFree(Some(s.0 as *const _));
                }
            }
            CoTaskMemFree(Some(arr as *const _));
            Ok(out)
        }
    }
    pub fn write(p: &str, words: &[String]) -> Result<(), String> {
        crate::win::com_init();
        unsafe {
            let store: IPropertyStore = SHGetPropertyStoreFromParsingName(&HSTRING::from(p), None, GPS_READWRITE).map_err(|e| format!("This file can’t hold tags ({})", e.message()))?;
            let wide: Vec<HSTRING> = words.iter().map(|w| HSTRING::from(w.as_str())).collect();
            let ptrs: Vec<PCWSTR> = wide.iter().map(|w| PCWSTR(w.as_ptr())).collect();
            let v = InitPropVariantFromStringVector(if ptrs.is_empty() { None } else { Some(&ptrs) }).map_err(|e| e.message())?;
            store.SetValue(&PKEY_Keywords, &v).map_err(|e| format!("This file can’t hold tags ({})", e.message()))?;
            store.Commit().map_err(|e| format!("Couldn’t save the tags into the file ({})", e.message()))?;
            Ok(())
        }
    }
}
