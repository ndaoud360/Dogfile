//! A Windows notification for work that finished while Dogfile wasn't in front (a long copy, a move), so people know
//! it's done without watching. Clicking it opens the folder the files went to.
use crate::args::{Args, R};
use serde_json::json;

/// notify:show {title, body, path?}
pub fn show(a: &Args) -> R {
    let o = a.v(0);
    let title = o["title"].as_str().unwrap_or("Dogfile").to_string();
    let body = o["body"].as_str().unwrap_or("").to_string();
    let path = o["path"].as_str().map(String::from);
    #[cfg(windows)]
    win::show(&title, &body, path);
    #[cfg(not(windows))]
    let _ = (title, body, path);
    Ok(json!(true))
}

#[cfg(windows)]
mod win {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    fn esc(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
    }
    fn alive() -> &'static parking_lot::Mutex<Vec<ToastNotification>> {
        static A: std::sync::OnceLock<parking_lot::Mutex<Vec<ToastNotification>>> = std::sync::OnceLock::new();
        A.get_or_init(|| parking_lot::Mutex::new(vec![]))
    }
    pub fn show(title: &str, body: &str, path: Option<String>) {
        crate::reminders::toast::register();
        let xml = format!("<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>", esc(title), esc(body));
        let r = (|| -> windows::core::Result<()> {
            let doc = XmlDocument::new()?;
            doc.LoadXml(&HSTRING::from(xml))?;
            let t = ToastNotification::CreateToastNotification(&doc)?;
            t.Activated(&TypedEventHandler::new(move |_, _| {
                let p = path.clone();
                crate::st().rt.spawn(async move {
                    let h = &crate::st().host;
                    match p {
                        Some(p) => h.open_path(serde_json::json!({ "path": p })),
                        None => { if let Some(w) = h.main_windows().first() { h.win_control(w, "focus"); } }
                    }
                });
                Ok(())
            }))?;
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from("Dogfile.Dogfile"))?.Show(&t)?;
            let mut a = alive().lock();
            a.push(t);
            if a.len() > 20 { a.remove(0); }
            Ok(())
        })();
        if let Err(e) = r { eprintln!("notification: {e}"); }
    }
}
