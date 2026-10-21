// Saved server connections: SFTP and FTP/FTPS browsed as folders (atlas:remote|<id>|/path), plus Windows shares
// (SMB) and WebDAV connected with saved credentials. Passwords are encrypted for this Windows user and never
// leave this PC. Connections stay open a few minutes after last use.
use crate::args::{Args, R};
use crate::util::{self, basename};
use crate::{events, secrets, setting};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex as AMutex;

fn conn(id: &str) -> Option<Value> {
    if let Some(c) = test_conns().lock().get(id) {
        return Some(c.clone());
    }
    setting("connections").as_array().and_then(|a| a.iter().find(|c| c["id"].as_str() == Some(id)).cloned())
}
fn test_conns() -> &'static parking_lot::Mutex<HashMap<String, Value>> {
    static T: OnceLock<parking_lot::Mutex<HashMap<String, Value>>> = OnceLock::new();
    T.get_or_init(|| parking_lot::Mutex::new(HashMap::new()))
}
fn password(id: &str) -> String {
    secrets::get_in("connection-secrets", id)
}
fn rp(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = regex::Regex::new("/+").unwrap().replace_all(&s, "/").to_string();
    if s.is_empty() { "/".into() } else { s }
}
fn rjoin(a: &str, b: &str) -> String {
    if a.ends_with('/') { format!("{a}{b}") } else { format!("{a}/{b}") }
}
fn url(id: &str, p: &str) -> String {
    format!("atlas:remote|{id}|{}", rp(p))
}
fn friendly(e: &str, c: &Value) -> String {
    let host = c["host"].as_str().unwrap_or("");
    let l = e.to_lowercase();
    if l.contains("not known") || l.contains("no such host") || l.contains("failed to lookup") || l.contains("dns") {
        return format!("Can’t find the server “{host}”. Check the address.");
    }
    if l.contains("refused") {
        let port = c["port"].as_str().map(String::from).or_else(|| c["port"].as_u64().map(|p| p.to_string())).unwrap_or_else(|| if c["type"] == "sftp" { "22".into() } else { "21".into() });
        return format!("{host} refused the connection on port {port}. Is the server running?");
    }
    if l.contains("timed out") || l.contains("timeout") {
        return format!("No answer from {host}. Check the address, the network or a firewall.");
    }
    if l.contains("auth") || l.contains("530") || l.contains("login") || l.contains("password") {
        return "The user name or password was not accepted.".into();
    }
    if l.contains("certificate") || l.contains("self signed") || l.contains("unknownissuer") {
        return "The server’s certificate isn’t trusted. Turn on “Allow self-signed certificates” if you trust this server.".into();
    }
    e.to_string()
}
fn port_of(c: &Value, d: u16) -> u16 {
    c["port"].as_u64().map(|p| p as u16).or_else(|| c["port"].as_str().and_then(|s| s.parse().ok())).unwrap_or(d)
}

struct Ent {
    name: String,
    is_dir: bool,
    size: u64,
    mtime: f64,
}

// ---------------- SFTP ----------------
struct Ssh;
impl russh::client::Handler for Ssh {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _k: &russh::keys::ssh_key::PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }
}
struct SftpConn {
    _ssh: russh::client::Handle<Ssh>,
    sftp: russh_sftp::client::SftpSession,
}

// ---------------- FTP ----------------
enum Ftp {
    Plain(suppaftp::FtpStream),
    Tls(suppaftp::RustlsFtpStream),
}
macro_rules! ftp_do {
    ($f:expr, $s:ident => $body:expr) => {
        match $f {
            Ftp::Plain($s) => $body,
            Ftp::Tls($s) => $body,
        }
    };
}
#[derive(Debug)]
struct AcceptAny;
impl rustls::client::danger::ServerCertVerifier for AcceptAny {
    fn verify_server_cert(&self, _: &rustls::pki_types::CertificateDer<'_>, _: &[rustls::pki_types::CertificateDer<'_>], _: &rustls::pki_types::ServerName<'_>, _: &[u8], _: rustls::pki_types::UnixTime) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, _: &[u8], _: &rustls::pki_types::CertificateDer<'_>, _: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(&self, _: &[u8], _: &rustls::pki_types::CertificateDer<'_>, _: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider().signature_verification_algorithms.supported_schemes()
    }
}
fn tls_config(allow_self_signed: bool) -> Result<Arc<rustls::ClientConfig>, String> {
    let b = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider())).with_safe_default_protocol_versions().map_err(|e| e.to_string())?;
    let cfg = if allow_self_signed {
        b.dangerous().with_custom_certificate_verifier(Arc::new(AcceptAny)).with_no_client_auth()
    } else {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        b.with_root_certificates(roots).with_no_client_auth()
    };
    Ok(Arc::new(cfg))
}
fn ftp_connect(c: &Value, pw: &str) -> Result<Ftp, String> {
    let host = c["host"].as_str().unwrap_or("").to_string();
    let addr = format!("{host}:{}", port_of(c, 21));
    let user = c["user"].as_str().filter(|u| !u.is_empty()).unwrap_or("anonymous").to_string();
    let pass = if !pw.is_empty() { pw.to_string() } else if c["user"].as_str().map(|u| !u.is_empty()).unwrap_or(false) { String::new() } else { "guest".into() };
    let mut f = if c["type"] == "ftps" {
        let s = suppaftp::RustlsFtpStream::connect(&addr).map_err(|e| e.to_string())?;
        let cfg = tls_config(c["allowSelfSigned"].as_bool().unwrap_or(false))?;
        Ftp::Tls(s.into_secure(suppaftp::RustlsConnector::from(cfg), &host).map_err(|e| e.to_string())?)
    } else {
        Ftp::Plain(suppaftp::FtpStream::connect(&addr).map_err(|e| e.to_string())?)
    };
    ftp_do!(&mut f, s => {
        let _ = s.get_ref().set_read_timeout(Some(Duration::from_secs(30)));
        s.login(user.as_str(), pass.as_str()).map_err(|e| e.to_string())?;
        s.transfer_type(suppaftp::types::FileType::Binary).map_err(|e| e.to_string())?;
    });
    Ok(f)
}
fn ftp_list(f: &mut Ftp, dir: &str) -> Result<Vec<Ent>, String> {
    let lines = ftp_do!(f, s => s.list(Some(dir)).map_err(|e| e.to_string())?);
    Ok(lines
        .iter()
        .filter_map(|l| l.parse::<suppaftp::list::File>().ok())
        .filter(|e| e.name() != "." && e.name() != "..")
        .map(|e| Ent { name: e.name().to_string(), is_dir: e.is_directory(), size: e.size() as u64, mtime: util::ms(Ok(e.modified())) })
        .collect())
}

enum Kind {
    Sftp(SftpConn),
    Ftp(Arc<parking_lot::Mutex<Ftp>>),
}
struct Session {
    kind: Kind,
    last: Instant,
}
type Shared = Arc<AMutex<Session>>;
fn sessions() -> &'static parking_lot::Mutex<HashMap<String, Shared>> {
    static S: OnceLock<parking_lot::Mutex<HashMap<String, Shared>>> = OnceLock::new();
    S.get_or_init(|| parking_lot::Mutex::new(HashMap::new()))
}
async fn open(id: &str) -> Result<Shared, String> {
    if let Some(s) = sessions().lock().get(id).cloned() {
        return Ok(s);
    }
    let c = conn(id).ok_or("This connection was removed")?;
    let pw = password(id);
    let kind = match c["type"].as_str().unwrap_or("") {
        "sftp" => {
            let cfg = Arc::new(russh::client::Config { keepalive_interval: Some(Duration::from_secs(20)), inactivity_timeout: None, ..Default::default() });
            let host = c["host"].as_str().unwrap_or("").to_string();
            let fut = russh::client::connect(cfg, (host.clone(), port_of(&c, 22)), Ssh);
            let mut h = tokio::time::timeout(Duration::from_secs(20), fut).await.map_err(|_| format!("No answer from {host} (timed out)"))?.map_err(|e| friendly(&e.to_string(), &c))?;
            let user = c["user"].as_str().unwrap_or("").to_string();
            let ok = if let Some(kf) = c["keyFile"].as_str().filter(|k| !k.is_empty()) {
                let key = russh::keys::load_secret_key(kf, if pw.is_empty() { None } else { Some(pw.as_str()) }).map_err(|e| format!("Can’t read the key file: {e}"))?;
                let hash = h.best_supported_rsa_hash().await.ok().flatten().flatten();
                h.authenticate_publickey(user, russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(|e| friendly(&e.to_string(), &c))?.success()
            } else {
                h.authenticate_password(user, pw).await.map_err(|e| friendly(&e.to_string(), &c))?.success()
            };
            if !ok {
                return Err("The user name or password was not accepted.".into());
            }
            let ch = h.channel_open_session().await.map_err(|e| e.to_string())?;
            ch.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;
            let sftp = russh_sftp::client::SftpSession::new(ch.into_stream()).await.map_err(|e| e.to_string())?;
            Kind::Sftp(SftpConn { _ssh: h, sftp })
        }
        "ftp" | "ftps" => {
            let c2 = c.clone();
            let f = tokio::task::spawn_blocking(move || ftp_connect(&c2, &pw)).await.map_err(|e| e.to_string())?.map_err(|e| friendly(&e, &c))?;
            Kind::Ftp(Arc::new(parking_lot::Mutex::new(f)))
        }
        _ => return Err("Unsupported connection type".into()),
    };
    let s: Shared = Arc::new(AMutex::new(Session { kind, last: Instant::now() }));
    sessions().lock().insert(id.to_string(), s.clone());
    // closed after four quiet minutes
    let idc = id.to_string();
    let weak = Arc::downgrade(&s);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let Some(s) = weak.upgrade() else { break };
            let idle = s.lock().await.last.elapsed() > Duration::from_secs(240);
            if idle {
                close(&idc).await;
                break;
            }
        }
    });
    Ok(s)
}
pub async fn close(id: &str) {
    let s = sessions().lock().remove(id);
    if let Some(s) = s {
        let g = s.lock().await;
        match &g.kind {
            Kind::Sftp(c) => {
                let _ = c.sftp.close().await;
            }
            Kind::Ftp(f) => {
                let f = f.clone();
                let _ = tokio::task::spawn_blocking(move || ftp_do!(&mut *f.lock(), s => { let _ = s.quit(); })).await;
            }
        }
    }
}

async fn list_raw(s: &mut Session, dir: &str) -> Result<Vec<Ent>, String> {
    s.last = Instant::now();
    match &s.kind {
        Kind::Sftp(c) => {
            let rd = c.sftp.read_dir(dir).await.map_err(|e| e.to_string())?;
            Ok(rd
                .filter(|e| e.file_name() != "." && e.file_name() != "..")
                .map(|e| {
                    let m = e.metadata();
                    Ent { name: e.file_name(), is_dir: m.is_dir(), size: m.size.unwrap_or(0), mtime: m.mtime.unwrap_or(0) as f64 * 1000.0 }
                })
                .collect())
        }
        Kind::Ftp(f) => {
            let (f, d) = (f.clone(), dir.to_string());
            tokio::task::spawn_blocking(move || ftp_list(&mut f.lock(), &d)).await.map_err(|e| e.to_string())?
        }
    }
}
/// (is folder, size) or None when it's gone
async fn stat_raw(s: &mut Session, p: &str) -> Option<(bool, u64)> {
    match &s.kind {
        Kind::Sftp(c) => c.sftp.metadata(p).await.ok().map(|m| (m.is_dir(), m.size.unwrap_or(0))),
        Kind::Ftp(f) => {
            let (f, p) = (f.clone(), p.to_string());
            tokio::task::spawn_blocking(move || {
                let mut g = f.lock();
                ftp_do!(&mut *g, s => {
                    if let Ok(n) = s.size(&p) { return Some((false, n as u64)) }
                    let cwd = s.pwd().ok()?;
                    if s.cwd(&p).is_ok() { let _ = s.cwd(&cwd); return Some((true, 0)) }
                    None
                })
            })
            .await
            .ok()
            .flatten()
        }
    }
}

pub async fn list(a: &Args) -> R {
    let id = a.s(0)?;
    let dir = rp(&a.s_or(1, "/"));
    let s = open(&id).await?;
    let mut g = s.lock().await;
    let ents = list_raw(&mut g, &dir).await.map_err(|e| friendly(&e, &conn(&id).unwrap_or(Value::Null)))?;
    Ok(json!(ents.iter().map(|e| { let p = rjoin(&dir, &e.name); json!({ "name": e.name, "path": url(&id, &p), "isDir": e.is_dir, "size": if e.is_dir { 0 } else { e.size }, "mtime": e.mtime, "ctime": e.mtime, "hidden": e.name.starts_with('.'), "remote": { "id": id, "path": p } }) }).collect::<Vec<_>>()))
}

struct Progress {
    win: String,
    token: Value,
    done: u64,
    last: Instant,
}
impl Progress {
    fn tick(&mut self, current: &str, extra: u64, force: bool) {
        if force || self.last.elapsed() > Duration::from_millis(200) {
            self.last = Instant::now();
            events::emit(&self.win, "remote:progress", json!({ "token": self.token, "current": current, "done": self.done + extra }));
        }
    }
}

/// download remote files / folders into a local folder
async fn get_into(id: &str, paths: &[String], local_dir: &Path, prog: &mut Progress) -> Result<Vec<String>, String> {
    let s = open(id).await?;
    let mut out = vec![];
    for p0 in paths {
        let p = rp(p0);
        let local = local_dir.join(basename(&p));
        let mut stack = vec![(p.clone(), local.clone())];
        while let Some((r, l)) = stack.pop() {
            let mut g = s.lock().await;
            g.last = Instant::now();
            let (is_dir, size) = stat_raw(&mut g, &r).await.ok_or_else(|| format!("{r} is gone"))?;
            if is_dir {
                std::fs::create_dir_all(&l).map_err(|e| e.to_string())?;
                for e in list_raw(&mut g, &r).await? {
                    stack.push((rjoin(&r, &e.name), l.join(&e.name)));
                }
                continue;
            }
            let name = basename(&r);
            prog.tick(&name, 0, true);
            match &g.kind {
                Kind::Sftp(c) => {
                    let mut f = c.sftp.open(&r).await.map_err(|e| e.to_string())?;
                    let mut w = tokio::fs::File::create(&l).await.map_err(|e| e.to_string())?;
                    let mut buf = vec![0u8; 256 * 1024];
                    let mut n_all = 0u64;
                    loop {
                        let n = f.read(&mut buf).await.map_err(|e| e.to_string())?;
                        if n == 0 { break }
                        w.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                        n_all += n as u64;
                        prog.tick(&name, n_all, false);
                    }
                    w.flush().await.map_err(|e| e.to_string())?;
                }
                Kind::Ftp(f) => {
                    let (f, r2, l2) = (f.clone(), r.clone(), l.clone());
                    tokio::task::spawn_blocking(move || -> Result<(), String> {
                        let mut g = f.lock();
                        ftp_do!(&mut *g, s => s.retr(&r2, |rd| {
                            let mut w = std::fs::File::create(&l2).map_err(suppaftp::FtpError::ConnectionError)?;
                            std::io::copy(rd, &mut w).map_err(suppaftp::FtpError::ConnectionError)?;
                            Ok(())
                        }).map_err(|e| e.to_string()))
                    })
                    .await
                    .map_err(|e| e.to_string())??;
                }
            }
            prog.done += size;
        }
        out.push(local.to_string_lossy().into_owned());
    }
    prog.tick("", 0, true);
    Ok(out)
}
pub async fn get(win: &str, a: &Args) -> R {
    let id = a.s(0)?;
    let paths = a.strs(1);
    let dir = PathBuf::from(a.s(2)?);
    let mut prog = Progress { win: win.into(), token: a.v(3), done: 0, last: Instant::now() };
    Ok(json!(get_into(&id, &paths, &dir, &mut prog).await?))
}
pub async fn put(win: &str, a: &Args) -> R {
    let id = a.s(0)?;
    let paths = a.strs(1);
    let rdir = rp(&a.s_or(2, "/"));
    let mut prog = Progress { win: win.into(), token: a.v(3), done: 0, last: Instant::now() };
    let s = open(&id).await?;
    for lp in &paths {
        let mut stack = vec![(PathBuf::from(lp), rjoin(&rdir, &basename(lp)))];
        while let Some((l, r)) = stack.pop() {
            let mut g = s.lock().await;
            g.last = Instant::now();
            let md = std::fs::metadata(&l).map_err(|e| e.to_string())?;
            if md.is_dir() {
                match &g.kind {
                    Kind::Sftp(c) => { let _ = c.sftp.create_dir(&r).await; }
                    Kind::Ftp(f) => {
                        let (f, r2) = (f.clone(), r.clone());
                        let _ = tokio::task::spawn_blocking(move || ftp_do!(&mut *f.lock(), s => { let _ = s.mkdir(&r2); })).await;
                    }
                }
                for e in std::fs::read_dir(&l).map_err(|e| e.to_string())?.flatten() {
                    stack.push((e.path(), rjoin(&r, &e.file_name().to_string_lossy())));
                }
                continue;
            }
            let name = basename(&r);
            prog.tick(&name, 0, true);
            match &g.kind {
                Kind::Sftp(c) => {
                    let mut f = c.sftp.create(&r).await.map_err(|e| e.to_string())?;
                    let mut rd = tokio::fs::File::open(&l).await.map_err(|e| e.to_string())?;
                    let mut buf = vec![0u8; 256 * 1024];
                    let mut n_all = 0u64;
                    loop {
                        let n = rd.read(&mut buf).await.map_err(|e| e.to_string())?;
                        if n == 0 { break }
                        f.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                        n_all += n as u64;
                        prog.tick(&name, n_all, false);
                    }
                    f.shutdown().await.map_err(|e| e.to_string())?;
                }
                Kind::Ftp(f) => {
                    let (f, r2, l2) = (f.clone(), r.clone(), l.clone());
                    tokio::task::spawn_blocking(move || -> Result<(), String> {
                        let mut rd = std::fs::File::open(&l2).map_err(|e| e.to_string())?;
                        ftp_do!(&mut *f.lock(), s => s.put_file(&r2, &mut rd).map(|_| ()).map_err(|e| e.to_string()))
                    })
                    .await
                    .map_err(|e| e.to_string())??;
                }
            }
            prog.done += md.len();
        }
    }
    prog.tick("", 0, true);
    Ok(json!(true))
}
pub async fn remove(a: &Args) -> R {
    let id = a.s(0)?;
    let s = open(&id).await?;
    for p0 in a.strs(1) {
        let p = rp(&p0);
        let mut g = s.lock().await;
        g.last = Instant::now();
        let Some((is_dir, _)) = stat_raw(&mut g, &p).await else { continue };
        // depth first: files, then the folders (deepest first)
        let mut files = vec![];
        let mut dirs = vec![];
        if is_dir {
            let mut stack = vec![p.clone()];
            while let Some(d) = stack.pop() {
                dirs.push(d.clone());
                for e in list_raw(&mut g, &d).await? {
                    let c = rjoin(&d, &e.name);
                    if e.is_dir { stack.push(c) } else { files.push(c) }
                }
            }
        } else {
            files.push(p.clone());
        }
        dirs.reverse();
        match &g.kind {
            Kind::Sftp(c) => {
                for f in &files { c.sftp.remove_file(f.as_str()).await.map_err(|e| e.to_string())?; }
                for d in &dirs { c.sftp.remove_dir(d.as_str()).await.map_err(|e| e.to_string())?; }
            }
            Kind::Ftp(f) => {
                let f = f.clone();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let mut g = f.lock();
                    ftp_do!(&mut *g, s => {
                        for x in &files { s.rm(x).map_err(|e| e.to_string())?; }
                        for d in &dirs { s.rmdir(d).map_err(|e| e.to_string())?; }
                    });
                    Ok(())
                })
                .await
                .map_err(|e| e.to_string())??;
            }
        }
    }
    Ok(json!(true))
}
pub async fn rename(a: &Args) -> R {
    let id = a.s(0)?;
    let (from, to) = (rp(&a.s(1)?), rp(&a.s(2)?));
    let s = open(&id).await?;
    let g = s.lock().await;
    match &g.kind {
        Kind::Sftp(c) => c.sftp.rename(from, to).await.map_err(|e| e.to_string())?,
        Kind::Ftp(f) => {
            let f = f.clone();
            tokio::task::spawn_blocking(move || ftp_do!(&mut *f.lock(), s => s.rename(from.as_str(), to.as_str()).map_err(|e| e.to_string()))).await.map_err(|e| e.to_string())??
        }
    }
    Ok(json!(true))
}
pub async fn mkdir(a: &Args) -> R {
    let id = a.s(0)?;
    let p = rp(&a.s(1)?);
    let s = open(&id).await?;
    let g = s.lock().await;
    match &g.kind {
        Kind::Sftp(c) => c.sftp.create_dir(p).await.map_err(|e| e.to_string())?,
        Kind::Ftp(f) => {
            let f = f.clone();
            tokio::task::spawn_blocking(move || {
                ftp_do!(&mut *f.lock(), s => {
                    let mut cur = String::new();
                    for seg in p.split('/').filter(|x| !x.is_empty()) {
                        cur = format!("{cur}/{seg}");
                        let _ = s.mkdir(&cur);
                    }
                })
            })
            .await
            .map_err(|e| e.to_string())?
        }
    }
    Ok(json!(true))
}
pub async fn open_local(a: &Args) -> R {
    let id = a.s(0)?;
    let p = a.s(1)?;
    let dir = util::temp_dir("remote").map_err(|e| e.to_string())?;
    let mut prog = Progress { win: String::new(), token: Value::Null, done: 0, last: Instant::now() };
    let out = get_into(&id, &[p], &dir, &mut prog).await?;
    Ok(json!(out.first()))
}
pub async fn test(a: &Args) -> R {
    let mut c = a.v(0);
    let pw = a.s_or(1, "");
    let id = format!("__test_{}", util::now_ms() as u64);
    c["id"] = json!(id);
    test_conns().lock().insert(id.clone(), c.clone());
    secrets::set_in("connection-secrets", &id, &pw);
    let path = c["path"].as_str().unwrap_or("/").to_string();
    let r = list(&Args(vec![json!(id), json!(path)])).await;
    close(&id).await;
    secrets::set_in("connection-secrets", &id, "");
    test_conns().lock().remove(&id);
    Ok(match r {
        Ok(items) => json!({ "ok": true, "count": items.as_array().map(|a| a.len()).unwrap_or(0) }),
        Err(e) => json!({ "ok": false, "error": e }),
    })
}

// ---------------- Windows shares / WebDAV ----------------
pub fn unc_of(c: &Value) -> String {
    let host = c["host"].as_str().unwrap_or("");
    if c["type"] == "webdav" {
        let u = if host.to_lowercase().starts_with("http") { host.to_string() } else { format!("https://{host}") };
        if let Ok(u) = reqwest::Url::parse(&u) {
            let ssl = if u.scheme() == "https" { "@SSL" } else { "" };
            let port = u.port().map(|p| format!("@{p}")).unwrap_or_default();
            let path = urlencoding::decode(u.path()).map(|c| c.into_owned()).unwrap_or_default().replace('/', "\\");
            return format!("\\\\{}{ssl}{port}\\DavWWWRoot{}", u.host_str().unwrap_or(""), path.trim_end_matches('\\'));
        }
    }
    let share = c["share"].as_str().filter(|s| !s.is_empty()).map(|s| format!("\\{}", s.trim_start_matches('\\'))).unwrap_or_default();
    format!("\\\\{}{share}", host.trim_start_matches('\\'))
}
pub async fn connect_share(a: &Args) -> R {
    let id = a.s(0)?;
    let c = conn(&id).ok_or("This connection was removed")?;
    let target = unc_of(&c);
    if !util::IS_WIN {
        return Err("Only on Windows".into());
    }
    let mut args = vec!["use".to_string(), target.clone()];
    let pw = password(&id);
    if !pw.is_empty() {
        args.push(pw);
    }
    if let Some(u) = c["user"].as_str().filter(|u| !u.is_empty()) {
        args.push(format!("/user:{u}"));
    }
    args.push("/persistent:no".into());
    let o = util::run("net.exe", &args, None, 30000).await.map_err(|e| e.to_string())?;
    let e = o.err();
    if o.ok || e.contains("1219") || e.to_lowercase().contains("already") {
        return Ok(json!(target));
    }
    let l = e.to_lowercase();
    Err(if l.contains("86") || l.contains("1326") || l.contains("password") {
        "The user name or password was not accepted.".into()
    } else if l.contains(" 53") || l.contains(" 67") || l.contains("not found") || l.contains("network path") {
        "Can’t find that server or share. Check the address and that you’re on the same network.".into()
    } else {
        util::last_line(&e)
    })
}
/// is a path (share, mapped drive, server) answering? never hangs longer than the timeout
pub async fn reachable(p: &str, ms: u64) -> bool {
    let p = p.to_string();
    let t = tokio::task::spawn_blocking(move || match std::fs::metadata(&p) {
        Ok(_) => true,
        Err(e) => e.kind() == std::io::ErrorKind::PermissionDenied,
    });
    tokio::time::timeout(Duration::from_millis(ms), t).await.ok().and_then(|r| r.ok()).unwrap_or(false)
}
pub async fn status(a: &Args) -> R {
    let id = a.s(0)?;
    let Some(c) = conn(&id) else { return Ok(json!({ "ok": false })) };
    let t = c["type"].as_str().unwrap_or("");
    if t == "smb" || t == "webdav" {
        return Ok(json!({ "ok": reachable(&unc_of(&c), 4000).await }));
    }
    if sessions().lock().contains_key(&id) {
        return Ok(json!({ "ok": true, "connected": true }));
    }
    // a TCP knock, without logging in
    let addr = format!("{}:{}", c["host"].as_str().unwrap_or(""), port_of(&c, if t == "sftp" { 22 } else { 21 }));
    let ok = matches!(tokio::time::timeout(Duration::from_secs(4), tokio::net::TcpStream::connect(addr)).await, Ok(Ok(_)));
    Ok(json!({ "ok": ok }))
}
#[allow(dead_code)]
fn unused(_: &mut dyn Read, _: &mut dyn Write) {}
