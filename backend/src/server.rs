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

/// the whole interface over plain HTTP (development and automated tests)
pub async fn serve_dev(host: Arc<DevHost>, addr: &str) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| e.to_string())?;
    let h2 = host.clone();
    let app = Router::new()
        .route(
            "/events",
            get(move |Query(q): Query<HashMap<String, String>>| {
                let h = h2.clone();
                async move {
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
            let r = from_axum(req, "main-1").await;
            to_axum(http::handle(r).await)
        }));
    axum::serve(listener, app).await.map_err(|e| e.to_string())
}
fn tokio_stream_unbounded(mut rx: tokio::sync::mpsc::UnboundedReceiver<String>) -> impl futures_util::Stream<Item = String> {
    futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx))
}
