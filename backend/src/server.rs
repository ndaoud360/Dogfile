// A small local web server. In the app it only streams live video conversions (a custom scheme can't stream);
// for development it serves the whole interface, calls and events, so the interface can run in any browser.
use crate::host::{DialogOpts, Host};
use crate::http::{self, Body as RBody, Req, Resp};
use axum::body::Body;
use axum::extract::{Query, Request};
use axum::response::Response;
use axum::routing::{any, get};
use axum::Router;
use bytes::Bytes;
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

pub fn to_axum(r: Resp) -> Response {
    let mut b = Response::builder().status(r.status);
    for (k, v) in &r.headers {
        b = b.header(k.as_str(), v.as_str());
    }
    let body = match r.body {
        RBody::Bytes(v) => Body::from(v),
        RBody::Stream(rx) => {
            let s = tokio_stream_from(rx);
            Body::from_stream(s)
        }
    };
    b.body(body).unwrap_or_else(|_| Response::new(Body::empty()))
}
fn tokio_stream_from(mut rx: tokio::sync::mpsc::Receiver<Bytes>) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx).map(|o| o.map(Ok)))
}
pub async fn from_axum(req: Request, win_default: &str) -> Req {
    let method = req.method().to_string();
    let uri = req.uri().clone();
    let headers: HashMap<String, String> = req.headers().iter().map(|(k, v)| (k.as_str().to_lowercase(), v.to_str().unwrap_or("").to_string())).collect();
    let body = axum::body::to_bytes(req.into_body(), 512 * 1024 * 1024).await.map(|b| b.to_vec()).unwrap_or_default();
    let raw_query = uri.query().unwrap_or("").to_string();
    Req {
        method,
        path: urlencoding::decode(uri.path()).map(|c| c.into_owned()).unwrap_or_else(|_| uri.path().to_string()),
        query: http::parse_query(&raw_query),
        raw_query,
        win: headers.get("x-dog-win").cloned().unwrap_or_else(|| win_default.to_string()),
        headers,
        body,
    }
}

/// the app's media server: http://127.0.0.1:<port>/<secret>/media/stream?...
pub async fn start_stream_server() -> Result<String, String> {
    let token = crate::util::uuid();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let t2 = token.clone();
    let app = Router::new().fallback(any(move |req: Request| {
        let t = t2.clone();
        async move {
            let mut r = from_axum(req, "").await;
            let Some(rest) = r.path.strip_prefix(&format!("/{t}")) else { return to_axum(Resp::text(403, "Forbidden")) };
            if !rest.starts_with("/media/") {
                return to_axum(Resp::text(404, "Not found"));
            }
            r.path = rest.to_string();
            to_axum(http::handle(r).await)
        }
    }));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(format!("http://127.0.0.1:{port}/{token}/"))
}

// ---------------- development host: windows are browser tabs, events go out as server-sent events ----------------
type Sink = tokio::sync::mpsc::UnboundedSender<String>;
pub struct DevHost {
    sinks: Mutex<HashMap<String, Vec<Sink>>>,
    pending: Mutex<HashMap<String, Value>>,
}
impl DevHost {
    pub fn new() -> Arc<DevHost> {
        Arc::new(DevHost { sinks: Mutex::new(HashMap::new()), pending: Mutex::new(HashMap::new()) })
    }
    fn send(&self, win: &str, channel: &str, data: &Value) {
        let msg = serde_json::to_string(&json!({ "c": channel, "d": data })).unwrap_or_default();
        if let Some(v) = self.sinks.lock().get_mut(win) {
            v.retain(|s| s.send(msg.clone()).is_ok());
        }
    }
}
impl Host for DevHost {
    fn emit(&self, win: &str, channel: &str, data: Value) {
        self.send(win, channel, &data);
    }
    fn broadcast(&self, channel: &str, data: Value) {
        let wins: Vec<String> = self.sinks.lock().keys().cloned().collect();
        for w in wins {
            self.send(&w, channel, &data);
        }
    }
    fn windows(&self) -> Vec<String> {
        let mut w: Vec<String> = self.sinks.lock().keys().cloned().collect();
        w.sort();
        w
    }
    fn win_control(&self, _win: &str, action: &str) -> Value {
        json!(action == "isFullscreen" && false)
    }
    fn new_window(&self, _launch: Value) {}
    fn open_tool(&self, kind: &str, files: Vec<String>, opts: Value) {
        let mut o = if opts.is_object() { opts } else { json!({}) };
        o["files"] = json!(files);
        self.pending.lock().insert(kind.to_string(), o);
    }
    fn tool_pending(&self, win: &str) -> Value {
        let kind = win.split('-').next().unwrap_or("");
        self.pending.lock().remove(kind).unwrap_or(Value::Null)
    }
    fn launch_of(&self, _win: &str) -> Value {
        json!({})
    }
    fn set_zoom(&self, _win: &str, _f: f64) {}
    fn start_drag(&self, _win: &str, _paths: Vec<String>) {}
    fn start_window_drag(&self, _win: &str) {}
    fn set_corners(&self, _pref: &str) {}
    fn pick_folder(&self, _win: &str, _t: Option<String>) -> Option<String> {
        None
    }
    fn open_files(&self, _win: &str, _o: DialogOpts) -> Vec<String> {
        vec![]
    }
    fn save_file(&self, _win: &str, _o: DialogOpts) -> Option<String> {
        None
    }
    fn message_box(&self, _win: &str, _t: &str, _m: &str, _d: &str, _b: Vec<String>, _c: usize) -> usize {
        0
    }
    fn quit(&self) {
        std::process::exit(0);
    }
}

/// Is this this PC's own name: "127.0.0.1:47800", "localhost", "[::1]:47800" (a Host header, or an Origin without its scheme)?
fn is_loopback_host(h: &str) -> bool {
    let name = match h.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => h.split(':').next().unwrap_or(""),
    };
    matches!(name.to_ascii_lowercase().as_str(), "127.0.0.1" | "localhost" | "::1")
}
/// Is the address the dev server is asked to listen on reachable from this PC only?
fn is_loopback_bind(addr: &str) -> bool {
    match addr.parse::<std::net::SocketAddr>() {
        Ok(a) => a.ip().is_loopback(),
        Err(_) => is_loopback_host(addr),
    }
}
/// The dev server's calls include files and commands, so only this PC's own pages may use it. A page on another site
/// (which can send a request here without being able to read the answer) and a name that points here only after a DNS
/// trick both fail: the Host must be this PC's and, when the browser says where the page came from, so must the Origin.
fn dev_request_allowed(host: Option<&str>, origin: Option<&str>) -> bool {
    let Some(host) = host else { return false };
    if !is_loopback_host(host) {
        return false;
    }
    match origin {
        None => true,
        Some(o) => o.strip_prefix("http://").or_else(|| o.strip_prefix("https://")).is_some_and(is_loopback_host),
    }
}
fn dev_headers_allowed(h: &axum::http::HeaderMap) -> bool {
    let get = |n: &str| h.get(n).and_then(|v| v.to_str().ok());
    dev_request_allowed(get("host"), get("origin"))
}

/// the whole interface over plain HTTP (development and automated tests)
pub async fn serve_dev(host: Arc<DevHost>, addr: &str) -> Result<(), String> {
    if !is_loopback_bind(addr) && std::env::var("DOGFILE_DEV_ALLOW_REMOTE").is_err() {
        return Err(format!("{addr} can be reached from other computers, and the dev server can open files and run commands on this PC. Use 127.0.0.1, or set DOGFILE_DEV_ALLOW_REMOTE=1 if you really mean it."));
    }
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| e.to_string())?;
    let h2 = host.clone();
    let app = Router::new()
        .route(
            "/events",
            get(move |headers: axum::http::HeaderMap, Query(q): Query<HashMap<String, String>>| {
                let h = h2.clone();
                async move {
                    if !dev_headers_allowed(&headers) {
                        return Response::builder().status(403).body(Body::from("Forbidden")).unwrap();
                    }
                    let win = q.get("w").cloned().unwrap_or("main-1".into());
                    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
                    h.sinks.lock().entry(win).or_default().push(tx);
                    let stream = tokio_stream_unbounded(rx).map(|m| Ok::<Bytes, std::io::Error>(Bytes::from(format!("data: {m}\n\n"))));
                    let first = futures_util::stream::once(async { Ok::<Bytes, std::io::Error>(Bytes::from(": hi\n\n")) });
                    Response::builder().header("Content-Type", "text/event-stream").header("Cache-Control", "no-cache").body(Body::from_stream(first.chain(stream))).unwrap()
                }
            }),
        )
        .fallback(any(|req: Request| async move {
            if !dev_headers_allowed(req.headers()) {
                return to_axum(Resp::text(403, "Forbidden"));
            }
            let r = from_axum(req, "main-1").await;
            to_axum(http::handle(r).await)
        }));
    axum::serve(listener, app).await.map_err(|e| e.to_string())
}
fn tokio_stream_unbounded(mut rx: tokio::sync::mpsc::UnboundedReceiver<String>) -> impl futures_util::Stream<Item = String> {
    futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_this_pcs_own_names_count_as_this_pc() {
        for ok in ["127.0.0.1:47800", "localhost", "LOCALHOST:47800", "[::1]:47800", "127.0.0.1"] {
            assert!(is_loopback_host(ok), "{ok}");
        }
        for bad in ["", "evil.com", "127.0.0.1.evil.com", "localhost.evil.com:47800", "192.168.1.5:47800", "127.0.0.1@evil.com", "0.0.0.0:47800", "[::]:1"] {
            assert!(!is_loopback_host(bad), "{bad:?}");
        }
    }
    #[test]
    fn a_page_from_another_site_or_a_rebound_name_is_refused() {
        // the browser's own page, and tools that send no Origin
        assert!(dev_request_allowed(Some("127.0.0.1:47800"), Some("http://127.0.0.1:47800")));
        assert!(dev_request_allowed(Some("localhost:47800"), Some("http://localhost:47800")));
        assert!(dev_request_allowed(Some("127.0.0.1:47800"), None));
        // a website posting to this PC (the Host is right, the Origin is not)
        assert!(!dev_request_allowed(Some("127.0.0.1:47800"), Some("https://evil.com")));
        assert!(!dev_request_allowed(Some("127.0.0.1:47800"), Some("null")));
        // DNS rebinding: the page's own name points here, so the Host is not this PC's
        assert!(!dev_request_allowed(Some("attacker.example:47800"), Some("http://attacker.example:47800")));
        assert!(!dev_request_allowed(Some("attacker.example:47800"), None));
        assert!(!dev_request_allowed(None, None));
    }
    #[test]
    fn the_dev_server_only_listens_on_this_pc_unless_told_otherwise() {
        for ok in ["127.0.0.1:47800", "[::1]:47800", "localhost:47800"] {
            assert!(is_loopback_bind(ok), "{ok}");
        }
        for bad in ["0.0.0.0:47800", "192.168.1.5:47800", "[::]:47800", "example.com:47800"] {
            assert!(!is_loopback_bind(bad), "{bad}");
        }
    }
}
