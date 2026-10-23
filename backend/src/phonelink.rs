// Phone transfer: files both ways between this PC and any phone on the same Wi-Fi, with no app on the phone.
// Dogfile opens a small web page on the local network; the phone pairs once by scanning a QR code (a one-time
// code shown only on this screen) and keeps a key in a cookie, so later it just opens the page (or the icon it
// added to its home screen) and is connected. iPhones and Android phones alike: iOS lets no PC program reach the
// phone's files on its own, and the browser is what every phone has.
//
// What the phone can do: send photos, videos and files (they land in the inbox folder), send text or a link,
// get what this PC sent it, and browse folders shared from here (read only, opt in). Nothing else is reachable
// on this server: not the interface, not Dogfile's calls, and only from addresses on the local network.
use crate::args::{Args, R};
use crate::{events, st, util};
use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

const PORTS: std::ops::RangeInclusive<u16> = 47777..=47790;

#[derive(Default)]
struct S {
    loaded: bool,
    devices: Vec<Value>,
    outbox: Vec<Value>,
    running: Option<(u16, tokio::sync::oneshot::Sender<()>)>,
    pair: Option<(String, Instant)>,
    fails: HashMap<IpAddr, (u32, Instant)>,
    seen: HashMap<String, Instant>,
}
fn s() -> &'static Mutex<S> {
    static X: OnceLock<Mutex<S>> = OnceLock::new();
    X.get_or_init(|| Mutex::new(S::default()))
}
fn load(g: &mut S) {
    if g.loaded {
        return;
    }
    let v = crate::store::get_or("phonelink", json!({}));
    g.devices = v["devices"].as_array().cloned().unwrap_or_default();
    g.outbox = v["outbox"].as_array().cloned().unwrap_or_default();
    g.loaded = true;
}
fn save(g: &S) {
    let _ = crate::store::set("phonelink", &json!({ "devices": g.devices, "outbox": g.outbox }));
}
fn hash(k: &str) -> String {
    Sha256::digest(k.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}
fn now() -> f64 {
    util::now_ms()
}

pub fn inbox() -> PathBuf {
    let s = crate::setting("phoneInbox");
    match s.as_str().filter(|x| !x.trim().is_empty()) {
        Some(p) => PathBuf::from(p),
        None => crate::sys::known_folders()["downloads"].as_str().map(PathBuf::from).or_else(dirs::home_dir).unwrap_or_else(std::env::temp_dir).join("From phone"),
    }
}
fn shared() -> Vec<String> {
    crate::setting("phoneShared").as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
}
fn pc_name() -> String {
    let n = if crate::demo::active() { "ALEX-PC".to_string() } else { crate::sys::hostname() };
    if n.is_empty() { "this PC".into() } else { n }
}
/// this PC's address on the local network (the one the default route uses)
fn lan_ip() -> Option<IpAddr> {
    let u = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    u.connect("10.255.255.255:1").or_else(|_| u.connect("192.168.255.255:1")).ok()?;
    let ip = u.local_addr().ok()?.ip();
    if ip.is_unspecified() || ip.is_loopback() { None } else { Some(ip) }
}
fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_loopback() || v.is_link_local(),
        IpAddr::V6(v) => {
            if let Some(m) = v.to_ipv4_mapped() {
                return m.is_private() || m.is_loopback() || m.is_link_local();
            }
            v.is_loopback() || (v.segments()[0] & 0xfe00) == 0xfc00 || (v.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

/// demo mode switched: phones and the outbox are read again from the other side
pub fn reset() {
    let mut g = s().lock();
    g.loaded = false;
    g.devices.clear();
    g.outbox.clear();
    g.seen.clear();
}

// ---------------------------------------------------------------------------------------------------------------
// calls from the interface

/// phone:status: {running, port, url, ip, pc, inbox, devices, outbox, shared}
pub fn status(_a: &Args) -> R {
    let mut g = s().lock();
    load(&mut g);
    let port = g.running.as_ref().map(|r| r.0);
    let ip = lan_ip();
    let online = |id: &str| g.seen.get(id).map(|t| t.elapsed() < Duration::from_secs(12)).unwrap_or(false);
    let devices: Vec<Value> = g.devices.iter().map(|d| json!({ "id": d["id"], "name": d["name"], "added": d["added"], "lastSeen": d["lastSeen"], "online": online(d["id"].as_str().unwrap_or("")) })).collect();
    Ok(json!({
        "running": port.is_some(), "port": port, "ip": ip.map(|i| i.to_string()),
        "url": match (port, ip) { (Some(p), Some(i)) => json!(format!("http://{i}:{p}/")), _ => Value::Null },
        "pc": pc_name(), "inbox": inbox().to_string_lossy(), "devices": devices, "outbox": g.outbox, "shared": shared(),
    }))
}
/// phone:start: open the page on the local network (the same port every time when it's free)
pub async fn start(_a: &Args) -> R {
    if s().lock().running.is_some() {
        return status(&Args(vec![]));
    }
    let mut listener = None;
    for p in PORTS {
        if let Ok(l) = tokio::net::TcpListener::bind(("0.0.0.0", p)).await {
            listener = Some(l);
            break;
        }
    }
    let l = match listener {
        Some(l) => l,
        None => tokio::net::TcpListener::bind(("0.0.0.0", 0)).await.map_err(|e| format!("Couldn’t open the phone page: {e}"))?,
    };
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let app = Router::new().fallback(any(|ConnectInfo(addr): ConnectInfo<SocketAddr>, req: Request| async move { handle(addr, req).await }));
    st().rt.spawn(async move {
        let _ = axum::serve(l, app.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(async { let _ = rx.await; }).await;
    });
    s().lock().running = Some((port, tx));
    events::broadcast("phone:changed", json!({}));
    status(&Args(vec![]))
}
/// phone:stop
pub fn stop(_a: &Args) -> R {
    if let Some((_, tx)) = s().lock().running.take() {
        let _ = tx.send(());
    }
    events::broadcast("phone:changed", json!({}));
    Ok(json!(true))
}
/// started with Dogfile when the person keeps it on
pub fn autostart() {
    if crate::setting_bool("phoneAlwaysOn", false) {
        st().rt.spawn(async {
            let _ = start(&Args(vec![])).await;
        });
    }
}
/// phone:pair(fresh?): the one-time code (10 minutes) and its QR code as SVG
pub async fn pair(a: &Args) -> R {
    if s().lock().running.is_none() {
        start(a).await?;
    }
    let (port, ip) = { let g = s().lock(); (g.running.as_ref().map(|r| r.0), lan_ip()) };
    let (Some(port), Some(ip)) = (port, ip) else { return Err("This PC isn’t on a network right now".into()) };
    // the code on screen stays good (several windows, a refresh) unless a new one is asked for
    let fresh = a.0.first().and_then(|v| v.as_bool()).unwrap_or(false);
    let code = {
        let mut g = s().lock();
        match &g.pair {
            Some((c, t)) if !fresh && t.elapsed() < Duration::from_secs(480) => c.clone(),
            _ => {
                let c = util::uuid()[..10].to_string();
                g.pair = Some((c.clone(), Instant::now()));
                c
            }
        }
    };
    let left = s().lock().pair.as_ref().map(|(_, t)| 600u64.saturating_sub(t.elapsed().as_secs())).unwrap_or(600);
    let url = format!("http://{ip}:{port}/p/{code}");
    let qr = qrcode::QrCode::new(url.as_bytes()).map_err(|e| e.to_string())?;
    let svg = qr.render::<qrcode::render::svg::Color>().min_dimensions(220, 220).quiet_zone(true).dark_color(qrcode::render::svg::Color("#000000")).light_color(qrcode::render::svg::Color("#ffffff")).build();
    Ok(json!({ "url": url, "svg": svg, "expires": left }))
}
/// phone:forget(id)
pub fn forget(a: &Args) -> R {
    let id = a.s(0)?;
    let mut g = s().lock();
    load(&mut g);
    g.devices.retain(|d| d["id"].as_str() != Some(id.as_str()));
    save(&g);
    drop(g);
    events::broadcast("phone:changed", json!({}));
    Ok(json!(true))
}
/// phone:rename(id, name)
pub fn rename(a: &Args) -> R {
    let (id, name) = (a.s(0)?, a.s(1)?);
    let mut g = s().lock();
    load(&mut g);
    for d in g.devices.iter_mut() {
        if d["id"].as_str() == Some(id.as_str()) {
            d["name"] = json!(name.trim().chars().take(60).collect::<String>());
        }
    }
    save(&g);
    Ok(json!(true))
}
/// phone:send(paths[]): files (and the files in folders) waiting for the phone
pub fn send(a: &Args) -> R {
    let mut files = Vec::new();
    for p in a.strs(0) {
        let pb = PathBuf::from(&p);
        if pb.is_dir() {
            walk(&pb, 0, &mut files);
        } else if pb.is_file() {
            files.push(pb);
        }
    }
    let mut g = s().lock();
    load(&mut g);
    let n = files.len();
    for f in files {
        let size = std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
        g.outbox.retain(|x| x["path"].as_str() != Some(&*f.to_string_lossy()));
        g.outbox.push(json!({ "id": util::uuid()[..12], "kind": "file", "path": f.to_string_lossy(), "name": util::basename(&f.to_string_lossy()), "size": size, "added": now() }));
    }
    let extra = g.outbox.len().saturating_sub(2000);
    g.outbox.drain(..extra);
    save(&g);
    drop(g);
    events::broadcast("phone:changed", json!({}));
    Ok(json!(n))
}
fn walk(d: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 6 || out.len() >= 1000 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(d) else { return };
    let mut es: Vec<_> = rd.flatten().collect();
    es.sort_by_key(|e| e.file_name());
    for e in es {
        let Ok(t) = e.file_type() else { continue };
        if t.is_dir() {
            walk(&e.path(), depth + 1, out);
        } else if t.is_file() && out.len() < 1000 {
            out.push(e.path());
        }
    }
}
/// phone:sendText(text)
pub fn send_text(a: &Args) -> R {
    let t = a.s(0)?;
    let mut g = s().lock();
    load(&mut g);
    g.outbox.push(json!({ "id": util::uuid()[..12], "kind": "text", "text": t.chars().take(100_000).collect::<String>(), "added": now() }));
    save(&g);
    drop(g);
    events::broadcast("phone:changed", json!({}));
    Ok(json!(true))
}
/// phone:unsend(id) / phone:unsend() for all
pub fn unsend(a: &Args) -> R {
    let id = a.os(0);
    let mut g = s().lock();
    load(&mut g);
    match id {
        Some(id) => g.outbox.retain(|x| x["id"].as_str() != Some(id.as_str())),
        None => g.outbox.clear(),
    }
    save(&g);
    drop(g);
    events::broadcast("phone:changed", json!({}));
    Ok(json!(true))
}

// ---------------------------------------------------------------------------------------------------------------
// the page on the local network

fn resp(status: u16, ctype: &str, body: impl Into<Body>) -> Response {
    Response::builder()
        .status(status)
        .header("Content-Type", ctype)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .body(body.into())
        .unwrap()
}
fn jresp(v: Value) -> Response {
    resp(200, "application/json", serde_json::to_vec(&v).unwrap_or_default())
}
fn text(status: u16, t: &str) -> Response {
    resp(status, "text/plain; charset=utf-8", t.to_string())
}
fn ui(rel: &str) -> Option<Vec<u8>> {
    crate::http::ui_bytes(rel)
}
fn device_name(ua: &str) -> String {
    if ua.contains("iPhone") {
        return "iPhone".into();
    }
    if ua.contains("iPad") || (ua.contains("Macintosh") && ua.contains("Mobile")) {
        return "iPad".into();
    }
    if let Some(i) = ua.find("Android") {
        // "Android 14; Pixel 8 Build/…" → Pixel 8
        let rest = &ua[i..];
        if let Some(model) = rest.split(';').nth(1) {
            let m = model.split(" Build").next().unwrap_or("").trim().trim_end_matches(')');
            if !m.is_empty() && m != "K" && m.len() < 40 {
                return m.to_string();
            }
        }
        return "Android phone".into();
    }
    "Phone".into()
}
fn cookie_of(req: &Request) -> Option<(String, String)> {
    let c = req.headers().get("cookie")?.to_str().ok()?;
    let v = c.split(';').map(|x| x.trim()).find_map(|x| x.strip_prefix("dgk="))?;
    let (id, key) = v.split_once('.')?;
    Some((id.to_string(), key.to_string()))
}
/// the paired phone that sent this request
fn who(req: &Request) -> Option<Value> {
    let (id, key) = cookie_of(req)?;
    let h = hash(&key);
    let mut g = s().lock();
    load(&mut g);
    let d = g.devices.iter_mut().find(|d| d["id"].as_str() == Some(id.as_str()))?;
    // the same work whatever the key, so its contents can't be guessed from timing
    let stored = d["hash"].as_str().unwrap_or("").as_bytes().to_vec();
    let ok = stored.len() == h.len() && stored.iter().zip(h.as_bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0;
    if !ok {
        return None;
    }
    d["lastSeen"] = json!(now());
    let dv = d.clone();
    let was = g.seen.get(&id).map(|t| t.elapsed() < Duration::from_secs(12)).unwrap_or(false);
    g.seen.insert(id, Instant::now());
    if !was {
        save(&g);
        drop(g);
        events::broadcast("phone:changed", json!({ "online": dv["name"] }));
    }
    Some(dv)
}
fn too_many(ip: IpAddr) -> bool {
    let g = s().lock();
    g.fails.get(&ip).map(|(n, t)| *n >= 8 && t.elapsed() < Duration::from_secs(300)).unwrap_or(false)
}
fn failed(ip: IpAddr) {
    let mut g = s().lock();
    let e = g.fails.entry(ip).or_insert((0, Instant::now()));
    if e.1.elapsed() > Duration::from_secs(300) {
        *e = (0, Instant::now());
    }
    e.0 += 1;
}

async fn handle(addr: SocketAddr, req: Request) -> Response {
    if !private(addr.ip()) {
        return text(403, "Only phones on the same network can connect");
    }
    let path = req.uri().path().to_string();
    let method = req.method().as_str().to_string();
    // pages and pictures for the page
    let page = |rel: &str, ctype: &str| ui(rel).map(|b| resp(200, ctype, b)).unwrap_or_else(|| text(404, "Not found"));
    match path.as_str() {
        "/" | "/index.html" => {
            let html = ui("phone/index.html").map(|b| String::from_utf8_lossy(&b).replace("{{PC}}", &html_esc(&pc_name()))).unwrap_or_default();
            return Response::builder()
                .status(200)
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Cache-Control", "no-store")
                .header("Referrer-Policy", "no-referrer")
                .header("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'")
                .body(Body::from(html))
                .unwrap();
        }
        "/phone.js" => return page("phone/phone.js", "text/javascript; charset=utf-8"),
        "/phone.css" => return page("phone/phone.css", "text/css; charset=utf-8"),
        "/icon.png" => return page("assets/icon.png", "image/png"),
        "/manifest.webmanifest" => {
            return resp(200, "application/manifest+json", serde_json::to_vec(&json!({ "name": format!("Dogfile · {}", pc_name()), "short_name": "Dogfile", "start_url": "/", "display": "standalone", "background_color": "#121316", "theme_color": "#121316", "icons": [{ "src": "/icon.png", "sizes": "256x256", "type": "image/png" }] })).unwrap_or_default());
        }
        _ => {}
    }
    // pairing: /p/<one-time code>
    if let Some(code) = path.strip_prefix("/p/") {
        if too_many(addr.ip()) {
            return text(429, "Too many tries. Wait a few minutes.");
        }
        let ok = {
            let mut g = s().lock();
            let valid = matches!(&g.pair, Some((c, t)) if c == code && t.elapsed() < Duration::from_secs(600));
            if valid {
                g.pair = None;
            }
            valid
        };
        if !ok {
            failed(addr.ip());
            return Response::builder().status(303).header("Location", "/?expired=1").body(Body::empty()).unwrap();
        }
        let ua = req.headers().get("user-agent").and_then(|v| v.to_str().ok()).unwrap_or("");
        let (id, key) = (util::uuid()[..16].to_string(), util::uuid());
        let name = device_name(ua);
        {
            let mut g = s().lock();
            load(&mut g);
            g.devices.push(json!({ "id": id, "name": name, "hash": hash(&key), "added": now(), "lastSeen": now() }));
            g.seen.insert(id.clone(), Instant::now());
            save(&g);
        }
        events::broadcast("phone:changed", json!({ "paired": name }));
        return Response::builder()
            .status(303)
            .header("Location", "/")
            .header("Set-Cookie", format!("dgk={id}.{key}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict"))
            .body(Body::empty())
            .unwrap();
    }
    if !path.starts_with("/api/") {
        return text(404, "Not found");
    }
    let Some(dev) = who(&req) else {
        failed(addr.ip());
        return text(401, "Not paired");
    };
    // changes need a header a page from elsewhere can't send without asking first
    if method != "GET" && req.headers().get("x-dog").is_none() {
        return text(403, "Forbidden");
    }
    let q = crate::http::parse_query(req.uri().query().unwrap_or(""));
    match (method.as_str(), path.as_str()) {
        ("GET", "/api/me") => {
            let g = s().lock();
            let out: Vec<Value> = g.outbox.iter().map(|x| json!({ "id": x["id"], "kind": x["kind"], "name": x["name"], "size": x["size"], "text": x["text"], "added": x["added"] })).collect();
            let sh: Vec<Value> = shared().iter().enumerate().map(|(i, p)| json!({ "i": i, "name": util::basename(p) })).collect();
            jresp(json!({ "pc": pc_name(), "device": dev["name"], "inbox": util::basename(&inbox().to_string_lossy()), "outbox": out, "shared": sh }))
        }
        ("PUT", "/api/upload") => upload(&dev, &q, req).await,
        ("POST", "/api/text") => {
            let b = axum::body::to_bytes(req.into_body(), 1 << 20).await.map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            if b.trim().is_empty() {
                return text(400, "Empty");
            }
            events::broadcast("phone:text", json!({ "text": b, "from": dev["name"] }));
            jresp(json!({ "ok": true }))
        }
        ("POST", "/api/dismiss") => {
            let id = q.get("id").cloned().unwrap_or_default();
            let mut g = s().lock();
            g.outbox.retain(|x| x["id"].as_str() != Some(id.as_str()));
            save(&g);
            drop(g);
            events::broadcast("phone:changed", json!({}));
            jresp(json!({ "ok": true }))
        }
        ("GET", p) if p.starts_with("/api/file/") => {
            let id = &p["/api/file/".len()..];
            let item = s().lock().outbox.iter().find(|x| x["id"].as_str() == Some(id)).cloned();
            match item.and_then(|x| x["path"].as_str().map(PathBuf::from)) {
                Some(f) => stream_file(&f, req.headers().get("range").and_then(|v| v.to_str().ok()), q.contains_key("dl")).await,
                None => text(404, "Not there any more"),
            }
        }
        ("GET", "/api/browse") => browse(&q).map(jresp).unwrap_or_else(|e| text(404, &e)),
        ("GET", "/api/shared") => match shared_path(&q) {
            Ok(f) if f.is_file() => stream_file(&f, req.headers().get("range").and_then(|v| v.to_str().ok()), q.contains_key("dl")).await,
            Ok(_) => text(404, "Not a file"),
            Err(e) => text(404, &e),
        },
        _ => text(404, "Not found"),
    }
}
fn html_esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}
fn clean_name(n: &str) -> String {
    let n: String = n.chars().map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    let n = n.trim().trim_matches('.').to_string();
    if n.is_empty() { "file".into() } else { n.chars().take(200).collect() }
}
async fn upload(dev: &Value, q: &HashMap<String, String>, req: Request) -> Response {
    let dir = inbox();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return text(500, &format!("Couldn’t make the inbox folder: {e}"));
    }
    let name = clean_name(q.get("name").map(|s| s.as_str()).unwrap_or("file"));
    let tmp = dir.join(format!(".{}.dogpart", &util::uuid()[..12]));
    let mut f = match tokio::fs::File::create(&tmp).await {
        Ok(f) => f,
        Err(e) => return text(500, &e.to_string()),
    };
    let mut body = req.into_body().into_data_stream();
    let mut n: u64 = 0;
    while let Some(c) = body.next().await {
        let c = match c {
            Ok(c) => c,
            Err(_) => {
                drop(f);
                let _ = tokio::fs::remove_file(&tmp).await;
                return text(400, "The upload stopped");
            }
        };
        n += c.len() as u64;
        if let Err(e) = f.write_all(&c).await {
            drop(f);
            let _ = tokio::fs::remove_file(&tmp).await;
            return text(507, &format!("Couldn’t save: {e}"));
        }
    }
    let _ = f.flush().await;
    drop(f);
    let fin = util::unique_name(&dir.to_string_lossy(), &name, "number");
    if let Err(e) = std::fs::rename(&tmp, &fin) {
        let _ = std::fs::remove_file(&tmp);
        return text(500, &e.to_string());
    }
    // the photo's own date, so the folder sorts like the phone's gallery
    if let Some(ms) = q.get("modified").and_then(|v| v.parse::<i64>().ok()).filter(|v| *v > 0) {
        let _ = filetime::set_file_mtime(&fin, filetime::FileTime::from_unix_time(ms / 1000, ((ms % 1000) * 1_000_000) as u32));
    }
    events::broadcast("phone:received", json!({ "path": fin, "name": util::basename(&fin), "size": n, "from": dev["name"], "batch": q.get("batch") }));
    jresp(json!({ "ok": true, "name": util::basename(&fin) }))
}
async fn stream_file(f: &Path, range: Option<&str>, download: bool) -> Response {
    let Ok(mut file) = tokio::fs::File::open(f).await else { return text(404, "Not found") };
    let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let ctype = crate::http::mime(&util::ext(&f.to_string_lossy()));
    let name = util::basename(&f.to_string_lossy());
    let disp = format!("{}; filename*=UTF-8''{}", if download { "attachment" } else { "inline" }, urlencoding::encode(&name));
    let (mut start, mut end) = (0u64, size.saturating_sub(1));
    let mut partial = false;
    if let Some(r) = range.and_then(|r| r.strip_prefix("bytes=")) {
        if let Some((a, b)) = r.split(',').next().unwrap_or("").split_once('-') {
            if a.is_empty() {
                let n: u64 = b.parse().unwrap_or(0);
                start = size.saturating_sub(n);
            } else {
                start = a.parse().unwrap_or(0);
                if !b.is_empty() {
                    end = b.parse::<u64>().unwrap_or(end).min(end);
                }
            }
            partial = start <= end && start < size;
        }
    }
    if !partial {
        start = 0;
        end = size.saturating_sub(1);
    }
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return text(416, "Range");
    }
    let len = if size == 0 { 0 } else { end - start + 1 };
    let stream = tokio_util::io::ReaderStream::with_capacity(tokio::io::AsyncReadExt::take(file, len), 256 * 1024);
    let mut b = Response::builder()
        .status(if partial { 206 } else { 200 })
        .header("Content-Type", ctype)
        .header("Content-Length", len.to_string())
        .header("Accept-Ranges", "bytes")
        .header("Content-Disposition", disp)
        .header("Cache-Control", "no-store");
    if partial {
        b = b.header("Content-Range", format!("bytes {start}-{end}/{size}"));
    }
    b.body(Body::from_stream(stream)).unwrap()
}
/// a path inside one of the shared folders (never outside it)
fn shared_path(q: &HashMap<String, String>) -> Result<PathBuf, String> {
    let roots = shared();
    let i: usize = q.get("root").and_then(|v| v.parse().ok()).ok_or("Which folder?")?;
    let root = roots.get(i).ok_or("That folder isn’t shared any more")?;
    let root = std::fs::canonicalize(root).map_err(|_| "That folder isn’t there any more".to_string())?;
    let rel = q.get("p").cloned().unwrap_or_default();
    if rel.split(['/', '\\']).any(|s| s == "..") {
        return Err("No".into());
    }
    let p = rel.split('/').filter(|s| !s.is_empty()).fold(root.clone(), |acc, s| acc.join(s));
    let real = std::fs::canonicalize(&p).map_err(|_| "Not found".to_string())?;
    if !real.starts_with(&root) {
        return Err("No".into());
    }
    Ok(real)
}
fn browse(q: &HashMap<String, String>) -> Result<Value, String> {
    let dir = shared_path(q)?;
    let mut items: Vec<Value> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some(json!({ "name": e.file_name().to_string_lossy(), "dir": m.is_dir(), "size": m.len(), "modified": util::ms(m.modified()) }))
        })
        .collect();
    items.sort_by(|a, b| b["dir"].as_bool().cmp(&a["dir"].as_bool()).then_with(|| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase())));
    Ok(json!({ "items": items }))
}
