// Report a bug (Help > Report a bug): the person's name, email and message go to Dogfile's server (saved, then
// emailed to the developer), or straight through FormSubmit if that server can't be reached. The address is fixed here, so nothing in a window can send a
// report anywhere else.
use crate::args::{Args, R};
use crate::util;
use serde_json::{json, Value};

/// where reports go. FormSubmit asks this address to confirm once (the first message ever sent to it, from the app
/// or the website, triggers a one-time "activate" email); after that every report arrives normally.
pub const TO: &str = "nd640dev@gmail.com";
/// FormSubmit only takes forms sent from a web page, so reports say they come from Dogfile's contact page
const FROM_PAGE: &str = "https://dogfileio.vercel.app/contact.html";

/// "Windows 11 24H2 (build 26100.2605)", from the registry
pub fn windows_version() -> String {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        if let Ok(k) = winreg::RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion") {
            let build: String = k.get_value("CurrentBuild").unwrap_or_default();
            let ubr: u32 = k.get_value("UBR").unwrap_or(0);
            let display: String = k.get_value("DisplayVersion").unwrap_or_default();
            // ProductName still says "Windows 10" on Windows 11; the build number tells them apart
            let name = if build.parse::<u32>().unwrap_or(0) >= 22000 { "Windows 11" } else { "Windows 10" };
            return format!("{name} {display} (build {build}.{ubr})").replace("  ", " ");
        }
        "Windows".into()
    }
    #[cfg(not(windows))]
    {
        std::env::consts::OS.into()
    }
}

pub async fn send(a: &Args) -> R {
    let o = a.v(0);
    let field = |k: &str, max: usize| o[k].as_str().unwrap_or("").trim().chars().take(max).collect::<String>();
    let (name, email, message) = (field("name", 120), field("email", 200), field("message", 8000));
    if name.is_empty() {
        return Err("Please enter your name.".into());
    }
    let at = email.find('@');
    if !matches!(at, Some(i) if i > 0 && email[i + 1..].contains('.') && !email.contains(' ')) {
        return Err("That email address doesn’t look right.".into());
    }
    if message.chars().count() < 5 {
        return Err("Please describe the problem.".into());
    }
    // a few reports an hour at most (a stuck key or a loop can't flood the inbox, or get the form service to block us)
    {
        static SENT: parking_lot::Mutex<Vec<std::time::Instant>> = parking_lot::Mutex::new(Vec::new());
        let mut g = SENT.lock();
        g.retain(|t| t.elapsed() < std::time::Duration::from_secs(3600));
        if g.len() >= 5 {
            return Err("You’ve sent several reports in the last hour. Please wait a bit before sending another (or email nd640dev@gmail.com).".into());
        }
        g.push(std::time::Instant::now());
    }
    let mut body = json!({
        "name": name, "email": email, "message": message,
        "_subject": format!("Dogfile bug report from {name}"), "_replyto": email, "_template": "table", "_captcha": "false",
    });
    // a report about a mod (a feature someone shared): which one, so it can be checked and taken down
    let m = &o["mod"];
    if m.is_object() {
        let s = |k: &str| m[k].as_str().unwrap_or("").trim().chars().take(300).collect::<String>();
        body["_subject"] = json!(format!("Dogfile mod report: {} (from {name})", s("name")));
        body["Mod"] = json!(s("name"));
        body["Mod author"] = json!(s("author"));
        body["Mod source"] = json!(s("source"));
        body["Mod version"] = json!(s("version"));
    }
    if o["includeSystem"].as_bool().unwrap_or(true) {
        body["Dogfile"] = json!(format!("{} ({})", env!("CARGO_PKG_VERSION"), std::env::consts::ARCH));
        body["Windows"] = json!(windows_version());
        // what went wrong recently that the person may not have noticed (file names inside are only their own)
        let errs = crate::recent_errors(15);
        if !errs.is_empty() {
            body["Recent errors"] = json!(errs);
        }
    }
    // to Dogfile's own server first: it saves every report (nothing is lost if email forwarding fails) and forwards it;
    // straight to FormSubmit only when that server can't be reached
    let api = crate::license::api_base();
    if !api.is_empty() {
        let fixed = ["name", "email", "message", "_subject", "_replyto", "_template", "_captcha"];
        let details: serde_json::Map<String, Value> = body.as_object().map(|o| o.iter().filter(|(k, _)| !fixed.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
        let payload = json!({ "kind": "bug", "name": body["name"], "email": body["email"], "message": body["message"], "subject": body["_subject"], "details": details });
        match util::http().post(format!("{api}/contact")).json(&payload).timeout(std::time::Duration::from_secs(30)).send().await {
            Ok(r) => {
                let v: Value = r.json().await.unwrap_or(Value::Null);
                if v["ok"] == json!(true) {
                    return Ok(json!(true));
                }
                if let Some(e) = v["error"].as_str() {
                    return Err(e.to_string());
                }
            }
            Err(e) => crate::errlog(&format!("bug report: the Dogfile server couldn't be reached ({e}); trying FormSubmit")),
        }
    }
    let r = util::http()
        .post(format!("https://formsubmit.co/ajax/{TO}"))
        .header("accept", "application/json")
        .header("content-type", "application/json")
        .header("referer", FROM_PAGE)
        .header("origin", "https://dogfileio.vercel.app")
        .body(body.to_string())
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "Dogfile couldn’t reach the internet. Check your connection and try again.".to_string())?;
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if v["success"] == json!(true) || v["success"] == json!("true") {
        Ok(json!(true))
    } else {
        Err(v["message"].as_str().filter(|m| !m.is_empty()).unwrap_or("The report couldn’t be sent just now. Try again in a minute.").to_string())
    }
}
