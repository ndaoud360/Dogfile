// Cloud storage without the sync apps: Amazon S3 (and S3-compatible: Cloudflare R2, Backblaze B2, MinIO,
// Wasabi…), Google Drive, Dropbox and OneDrive, browsed as folders (atlas:remote|<id>|/path) like SFTP and FTP.
// Google, Dropbox and Microsoft sign in through the browser (OAuth with PKCE); the refresh token is kept
// encrypted for this Windows user. S3 uses an access key and secret.
use crate::util;
use base64::Engine;
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct Ent {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: f64,
}

pub enum Api {
    S3(S3),
    Drive(OAuth),
    Dropbox(OAuth),
    OneDrive(OAuth),
}
pub fn is_cloud(kind: &str) -> bool {
    matches!(kind, "s3" | "gdrive" | "dropbox" | "onedrive")
}

// ---------------------------------------------------------------- OAuth (Google, Dropbox, Microsoft)
pub struct Provider {
    pub auth: &'static str,
    pub token: &'static str,
    pub scope: &'static str,
    pub extra: &'static str,
}
pub fn provider(kind: &str) -> Option<Provider> {
    Some(match kind {
        "gdrive" => Provider { auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/drive", extra: "&access_type=offline&prompt=consent" },
        "dropbox" => Provider { auth: "https://www.dropbox.com/oauth2/authorize", token: "https://api.dropboxapi.com/oauth2/token", scope: "", extra: "&token_access_type=offline" },
        "onedrive" => Provider { auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", token: "https://login.microsoftonline.com/common/oauth2/v2.0/token", scope: "Files.ReadWrite.All offline_access User.Read", extra: "&prompt=select_account" },
        _ => return None,
    })
}
/// the app registration Dogfile signs in with: from Settings (cloudApps) or built in at compile time
pub fn client_of(kind: &str) -> (String, String) {
    let apps = crate::setting("cloudApps");
    let id = apps[kind]["clientId"].as_str().filter(|s| !s.is_empty()).map(String::from).or_else(|| match kind {
        "gdrive" => option_env!("DOGFILE_GDRIVE_CLIENT_ID").map(String::from),
        "dropbox" => option_env!("DOGFILE_DROPBOX_CLIENT_ID").map(String::from),
        "onedrive" => option_env!("DOGFILE_ONEDRIVE_CLIENT_ID").map(String::from),
        _ => None,
    });
    let secret = apps[kind]["clientSecret"].as_str().filter(|s| !s.is_empty()).map(String::from).or_else(|| if kind == "gdrive" { option_env!("DOGFILE_GDRIVE_CLIENT_SECRET").map(String::from) } else { None });
    (id.unwrap_or_default(), secret.unwrap_or_default())
}
fn test_base(kind: &str) -> Option<String> {
    // tests point the providers at a local stand-in
    std::env::var(format!("DOGFILE_TEST_{}", kind.to_uppercase())).ok()
}

pub struct OAuth {
    pub kind: String,
    pub id: String,
    token: Mutex<(String, Instant)>,
    /// Google Drive: path → file id
    ids: Mutex<HashMap<String, (String, bool)>>,
}
impl OAuth {
    pub fn new(kind: &str, id: &str) -> Self {
        OAuth { kind: kind.into(), id: id.into(), token: Mutex::new((String::new(), Instant::now())), ids: Mutex::new(HashMap::new()) }
    }
    async fn access(&self) -> Result<String, String> {
        {
            let t = self.token.lock();
            if !t.0.is_empty() && t.1 > Instant::now() {
                return Ok(t.0.clone());
            }
        }
        let refresh = crate::secrets::get_in("connection-secrets", &self.id);
        if refresh.is_empty() {
            return Err("Sign in again: this account isn’t connected".into());
        }
        if test_base(&self.kind).is_some() {
            *self.token.lock() = (refresh.clone(), Instant::now() + Duration::from_secs(3000));
            return Ok(refresh);
        }
        let p = provider(&self.kind).ok_or("Unknown cloud")?;
        let (cid, secret) = client_of(&self.kind);
        let mut form = vec![("grant_type", "refresh_token".to_string()), ("refresh_token", refresh), ("client_id", cid)];
        if !secret.is_empty() {
            form.push(("client_secret", secret));
        }
        let r: Value = util::http().post(p.token).form(&form).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
        let tok = r["access_token"].as_str().ok_or_else(|| format!("Sign in again ({})", r["error_description"].as_str().or(r["error"].as_str()).unwrap_or("the sign-in expired")))?.to_string();
        if let Some(nr) = r["refresh_token"].as_str() {
            crate::secrets::set_in("connection-secrets", &self.id, nr);
        }
        let ttl = r["expires_in"].as_u64().unwrap_or(3600).saturating_sub(120);
        *self.token.lock() = (tok.clone(), Instant::now() + Duration::from_secs(ttl));
        Ok(tok)
    }
}

/// Sign in through the browser: a one-time local web page receives the answer (PKCE, no password seen by Dogfile).
/// Returns the refresh token and the account's name.
pub async fn sign_in(kind: &str) -> Result<(String, String), String> {
    let p = provider(kind).ok_or("Unknown cloud")?;
    let (cid, secret) = client_of(kind);
    if cid.is_empty() {
        return Err(format!("NO_CLIENT_ID:{kind}"));
    }
    // Dropbox needs the exact address registered (a fixed port); Microsoft wants "localhost" (any port)
    let fixed = if kind == "dropbox" { 53682 } else { 0 };
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", fixed)).await.map_err(|e| format!("Couldn’t start the sign-in page ({e})"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = if kind == "onedrive" { format!("http://localhost:{port}/") } else { format!("http://127.0.0.1:{port}/") };
    let verifier: String = {
        use rand::Rng;
        let mut r = rand::rng();
        (0..64).map(|_| { let c = r.random_range(0..62u8); (match c { 0..=9 => b'0' + c, 10..=35 => b'a' + c - 10, _ => b'A' + c - 36 }) as char }).collect()
    };
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state: String = verifier.chars().rev().take(16).collect();
    let url = format!("{}?client_id={}&response_type=code&redirect_uri={}&code_challenge={challenge}&code_challenge_method=S256&state={state}{}{}",
        p.auth, urlencoding::encode(&cid), urlencoding::encode(&redirect), if p.scope.is_empty() { String::new() } else { format!("&scope={}", urlencoding::encode(p.scope)) }, p.extra);
    crate::shell::open_url(&url)?;
    // wait for the browser to come back (5 minutes)
    let code = tokio::time::timeout(Duration::from_secs(300), async {
        loop {
            let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.map_err(|e| e.to_string())?;
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let line = req.lines().next().unwrap_or("").to_string();
            let q = line.split_whitespace().nth(1).unwrap_or("").split_once('?').map(|x| x.1.to_string()).unwrap_or_default();
            let params: HashMap<String, String> = q.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default())).collect();
            if params.is_empty() {
                let _ = sock.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n").await;
                continue;
            }
            let ok = params.contains_key("code") && params.get("state").map(|s| s == &state).unwrap_or(false);
            let body = if ok { "<h2 style='font-family:system-ui'>Signed in. You can close this tab and go back to Dogfile.</h2>" } else { "<h2 style='font-family:system-ui'>Sign-in was cancelled.</h2>" };
            let _ = sock.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
            return if ok { Ok(params["code"].clone()) } else { Err(params.get("error_description").or(params.get("error")).cloned().unwrap_or_else(|| "Sign-in was cancelled".into())) };
        }
    }).await.map_err(|_| "Sign-in timed out".to_string())??;
    let mut form = vec![("grant_type", "authorization_code".to_string()), ("code", code), ("client_id", cid), ("redirect_uri", redirect), ("code_verifier", verifier)];
    if !secret.is_empty() {
        form.push(("client_secret", secret));
    }
    let r: Value = util::http().post(p.token).form(&form).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let refresh = r["refresh_token"].as_str().ok_or_else(|| format!("Sign-in failed: {}", r["error_description"].as_str().or(r["error"].as_str()).unwrap_or("no token")))?.to_string();
    let access = r["access_token"].as_str().unwrap_or("").to_string();
    // who signed in (shown as the connection's name)
    let who = match kind {
        "gdrive" => get_json("https://www.googleapis.com/drive/v3/about?fields=user", &access).await.ok().and_then(|v| v["user"]["emailAddress"].as_str().map(String::from)),
        "dropbox" => match util::http().post("https://api.dropboxapi.com/2/users/get_current_account").bearer_auth(&access).send().await { Ok(r) => r.json::<Value>().await.ok().and_then(|v| v["email"].as_str().map(String::from)), Err(_) => None },
        "onedrive" => get_json("https://graph.microsoft.com/v1.0/me", &access).await.ok().and_then(|v| v["userPrincipalName"].as_str().or(v["mail"].as_str()).map(String::from)),
        _ => None,
    };
    Ok((refresh, who.unwrap_or_default()))
}
async fn get_json(url: &str, tok: &str) -> Result<Value, String> {
    let r = util::http().get(url).bearer_auth(tok).send().await.map_err(|e| e.to_string())?;
    let st = r.status();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if !st.is_success() {
        return Err(api_err(st.as_u16(), &v));
    }
    Ok(v)
}
fn api_err(code: u16, v: &Value) -> String {
    let msg = v["error"]["message"].as_str().or(v["error_summary"].as_str()).or(v["error_description"].as_str()).or(v["error"].as_str()).unwrap_or("");
    match code {
        401 => "Sign in again: the cloud account’s sign-in expired".into(),
        403 => format!("Not allowed{}", if msg.is_empty() { String::new() } else { format!(": {msg}") }),
        404 => "Not found".into(),
        409 if msg.contains("not_found") => "Not found".into(),
        429 => "The cloud service asked to slow down; try again in a minute".into(),
        _ => if msg.is_empty() { format!("The cloud service answered {code}") } else { msg.to_string() },
    }
}
fn iso_ms(s: &str) -> f64 {
    // 2024-05-01T12:34:56Z / .123Z / +00:00
    let re = regex::Regex::new(r"^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)").unwrap();
    let Some(c) = re.captures(s) else { return 0.0 };
    let n = |i: usize| c[i].parse::<i64>().unwrap_or(0);
    let (y, m, d) = (n(1), n(2), n(3));
    let a = (14 - m) / 12;
    let (yy, mm) = (y + 4800 - a, m + 12 * a - 3);
    let jdn = d + (153 * mm + 2) / 5 + 365 * yy + yy / 4 - yy / 100 + yy / 400 - 32045;
    let days = jdn - 2440588;
    ((days * 86400 + n(4) * 3600 + n(5) * 60 + n(6)) * 1000) as f64
}
fn parent_name(p: &str) -> (String, String) {
    let p = p.trim_end_matches('/');
    match p.rfind('/') {
        Some(i) => (if i == 0 { "/".into() } else { p[..i].to_string() }, p[i + 1..].to_string()),
        None => ("/".into(), p.to_string()),
    }
}
async fn save_stream(resp: reqwest::Response, local: &Path, prog: &mut (dyn FnMut(u64) + Send)) -> Result<(), String> {
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        return Err(api_err(code, &v));
    }
    let mut w = tokio::fs::File::create(local).await.map_err(|e| e.to_string())?;
    let mut s = resp.bytes_stream();
    let mut n = 0u64;
    while let Some(ch) = s.next().await {
        let ch = ch.map_err(|e| e.to_string())?;
        w.write_all(&ch).await.map_err(|e| e.to_string())?;
        n += ch.len() as u64;
        prog(n);
    }
    w.flush().await.map_err(|e| e.to_string())
}
async fn file_body(local: &Path) -> Result<(reqwest::Body, u64), String> {
    let f = tokio::fs::File::open(local).await.map_err(|e| e.to_string())?;
    let len = f.metadata().await.map_err(|e| e.to_string())?.len();
    Ok((reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(f)), len))
}

impl Api {
    pub async fn list(&self, dir: &str) -> Result<Vec<Ent>, String> {
        match self {
            Api::S3(s) => s.list(dir).await,
            Api::Dropbox(o) => dropbox::list(o, dir).await,
            Api::OneDrive(o) => onedrive::list(o, dir).await,
            Api::Drive(o) => gdrive::list(o, dir).await,
        }
    }
    pub async fn stat(&self, p: &str) -> Option<(bool, u64)> {
        if p == "/" || p.is_empty() {
            return Some((true, 0));
        }
        match self {
            Api::S3(s) => s.stat(p).await,
            Api::Dropbox(o) => dropbox::stat(o, p).await,
            Api::OneDrive(o) => onedrive::stat(o, p).await,
            Api::Drive(o) => gdrive::find(o, p).await.ok().map(|(_, d, size)| (d, size)),
        }
    }
    pub async fn download(&self, p: &str, local: &Path, prog: &mut (dyn FnMut(u64) + Send)) -> Result<(), String> {
        match self {
            Api::S3(s) => save_stream(s.send("GET", &s.key(p), "", vec![]).await?, local, prog).await,
            Api::Dropbox(o) => save_stream(util::http().post(dropbox::content("download")).bearer_auth(o.access().await?).header("Dropbox-API-Arg", json!({ "path": dropbox::dp(p) }).to_string()).send().await.map_err(|e| e.to_string())?, local, prog).await,
            Api::OneDrive(o) => save_stream(util::http().get(format!("{}:/content", onedrive::item(p))).bearer_auth(o.access().await?).send().await.map_err(|e| e.to_string())?, local, prog).await,
            Api::Drive(o) => gdrive::download(o, p, local, prog).await,
        }
    }
    pub async fn upload(&self, local: &Path, p: &str) -> Result<(), String> {
        match self {
            Api::S3(s) => {
                let (body, len) = file_body(local).await?;
                let r = s.send_body("PUT", &s.key(p), "", vec![("content-length".into(), len.to_string())], body).await?;
                S3::check(r).await.map(|_| ())
            }
            Api::Dropbox(o) => dropbox::upload(o, local, p).await,
            Api::OneDrive(o) => onedrive::upload(o, local, p).await,
            Api::Drive(o) => gdrive::upload(o, local, p).await,
        }
    }
    pub async fn mkdir(&self, p: &str) -> Result<(), String> {
        match self {
            Api::S3(s) => S3::check(s.send("PUT", &format!("{}/", s.key(p)), "", vec![("content-length".into(), "0".into())]).await?).await.map(|_| ()),
            Api::Dropbox(o) => dropbox::rpc(o, "create_folder_v2", json!({ "path": dropbox::dp(p), "autorename": false })).await.map(|_| ()),
            Api::OneDrive(o) => onedrive::mkdir(o, p).await,
            Api::Drive(o) => gdrive::mkdir(o, p).await.map(|_| ()),
        }
    }
    /// deletes a file, or a folder with everything in it
    pub async fn remove(&self, p: &str) -> Result<(), String> {
        match self {
            Api::S3(s) => s.remove(p).await,
            Api::Dropbox(o) => dropbox::rpc(o, "delete_v2", json!({ "path": dropbox::dp(p) })).await.map(|_| ()),
            Api::OneDrive(o) => {
                let r = util::http().delete(onedrive::item(p)).bearer_auth(o.access().await?).send().await.map_err(|e| e.to_string())?;
                if r.status().is_success() || r.status().as_u16() == 404 { Ok(()) } else { let c = r.status().as_u16(); Err(api_err(c, &r.json().await.unwrap_or(Value::Null))) }
            }
            Api::Drive(o) => gdrive::trash(o, p).await,
        }
    }
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        match self {
            Api::S3(s) => s.rename(from, to).await,
            Api::Dropbox(o) => dropbox::rpc(o, "move_v2", json!({ "from_path": dropbox::dp(from), "to_path": dropbox::dp(to) })).await.map(|_| ()),
            Api::OneDrive(o) => onedrive::rename(o, from, to).await,
            Api::Drive(o) => gdrive::rename(o, from, to).await,
        }
    }
}

// ---------------------------------------------------------------- Dropbox
mod dropbox {
    use super::*;
    pub fn api(f: &str) -> String {
        format!("{}/2/files/{f}", test_base("dropbox").unwrap_or_else(|| "https://api.dropboxapi.com".into()))
    }
    pub fn content(f: &str) -> String {
        format!("{}/2/files/{f}", test_base("dropbox").unwrap_or_else(|| "https://content.dropboxapi.com".into()))
    }
    /// Dropbox's root is "", everything else "/a/b"
    pub fn dp(p: &str) -> String {
        let p = p.trim_end_matches('/');
        if p.is_empty() || p == "/" { String::new() } else { p.to_string() }
    }
    pub async fn rpc(o: &OAuth, f: &str, body: Value) -> Result<Value, String> {
        let r = util::http().post(api(f)).bearer_auth(o.access().await?).json(&body).send().await.map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if st >= 300 { return Err(api_err(st, &v)) }
        Ok(v)
    }
    fn ent(e: &Value) -> Ent {
        Ent { name: e["name"].as_str().unwrap_or("").into(), is_dir: e[".tag"] == "folder", size: e["size"].as_u64().unwrap_or(0), mtime: iso_ms(e["server_modified"].as_str().unwrap_or("")) }
    }
    pub async fn list(o: &OAuth, dir: &str) -> Result<Vec<Ent>, String> {
        let mut v = rpc(o, "list_folder", json!({ "path": dp(dir), "limit": 2000 })).await?;
        let mut out: Vec<Ent> = v["entries"].as_array().map(|a| a.iter().map(ent).collect()).unwrap_or_default();
        while v["has_more"].as_bool().unwrap_or(false) {
            v = rpc(o, "list_folder/continue", json!({ "cursor": v["cursor"] })).await?;
            out.extend(v["entries"].as_array().map(|a| a.iter().map(ent).collect::<Vec<_>>()).unwrap_or_default());
        }
        Ok(out)
    }
    pub async fn stat(o: &OAuth, p: &str) -> Option<(bool, u64)> {
        rpc(o, "get_metadata", json!({ "path": dp(p) })).await.ok().map(|v| (v[".tag"] == "folder", v["size"].as_u64().unwrap_or(0)))
    }
    pub async fn upload(o: &OAuth, local: &Path, p: &str) -> Result<(), String> {
        let tok = o.access().await?;
        let len = std::fs::metadata(local).map_err(|e| e.to_string())?.len();
        let arg = json!({ "path": dp(p), "mode": "overwrite", "mute": true });
        if len <= 140 * 1024 * 1024 {
            let (body, _) = file_body(local).await?;
            let r = util::http().post(content("upload")).bearer_auth(&tok).header("Dropbox-API-Arg", arg.to_string()).header("Content-Type", "application/octet-stream").body(body).send().await.map_err(|e| e.to_string())?;
            let st = r.status().as_u16();
            if st >= 300 { return Err(api_err(st, &r.json().await.unwrap_or(Value::Null))) }
            return Ok(());
        }
        // big files go up in 64 MB pieces
        let mut f = tokio::fs::File::open(local).await.map_err(|e| e.to_string())?;
        let chunk = 64 * 1024 * 1024usize;
        let mut buf = vec![0u8; chunk];
        let mut off = 0u64;
        let mut session = String::new();
        loop {
            let mut n = 0;
            while n < chunk { let k = f.read(&mut buf[n..]).await.map_err(|e| e.to_string())?; if k == 0 { break } n += k; }
            let last = off + n as u64 >= len;
            let (url, a) = if session.is_empty() { (content("upload_session/start"), json!({ "close": false })) }
                else if last { (content("upload_session/finish"), json!({ "cursor": { "session_id": session, "offset": off }, "commit": arg })) }
                else { (content("upload_session/append_v2"), json!({ "cursor": { "session_id": session, "offset": off }, "close": false })) };
            let r = util::http().post(url).bearer_auth(&tok).header("Dropbox-API-Arg", a.to_string()).header("Content-Type", "application/octet-stream").body(buf[..n].to_vec()).send().await.map_err(|e| e.to_string())?;
            let st = r.status().as_u16();
            let v: Value = r.json().await.unwrap_or(Value::Null);
            if st >= 300 { return Err(api_err(st, &v)) }
            if session.is_empty() { session = v["session_id"].as_str().unwrap_or("").to_string(); }
            off += n as u64;
            if last && !session.is_empty() && off >= len && a.get("commit").is_some() { break }
            if n == 0 { break }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- OneDrive (Microsoft Graph)
mod onedrive {
    use super::*;
    fn base() -> String {
        test_base("onedrive").unwrap_or_else(|| "https://graph.microsoft.com/v1.0".into())
    }
    fn enc(p: &str) -> String {
        p.split('/').map(|s| urlencoding::encode(s).into_owned()).collect::<Vec<_>>().join("/")
    }
    /// the item at a path ("/me/drive/root:/a/b")
    pub fn item(p: &str) -> String {
        let p = p.trim_end_matches('/');
        if p.is_empty() || p == "/" { format!("{}/me/drive/root", base()) } else { format!("{}/me/drive/root:{}", base(), enc(p)) }
    }
    fn ent(e: &Value) -> Ent {
        Ent { name: e["name"].as_str().unwrap_or("").into(), is_dir: e.get("folder").is_some() || e.get("package").is_some(), size: e["size"].as_u64().unwrap_or(0), mtime: iso_ms(e["lastModifiedDateTime"].as_str().unwrap_or("")) }
    }
    pub async fn list(o: &OAuth, dir: &str) -> Result<Vec<Ent>, String> {
        let tok = o.access().await?;
        let p = dir.trim_end_matches('/');
        let mut url = if p.is_empty() || p == "/" { format!("{}/me/drive/root/children?$top=999", base()) } else { format!("{}:/children?$top=999", item(p)) };
        let mut out = vec![];
        loop {
            let v = get_json(&url, &tok).await?;
            out.extend(v["value"].as_array().map(|a| a.iter().map(ent).collect::<Vec<_>>()).unwrap_or_default());
            match v["@odata.nextLink"].as_str() { Some(n) => url = n.to_string(), None => break }
        }
        Ok(out)
    }
    pub async fn stat(o: &OAuth, p: &str) -> Option<(bool, u64)> {
        let v = get_json(&item(p), &o.access().await.ok()?).await.ok()?;
        let e = ent(&v);
        Some((e.is_dir, e.size))
    }
    pub async fn upload(o: &OAuth, local: &Path, p: &str) -> Result<(), String> {
        let tok = o.access().await?;
        let len = std::fs::metadata(local).map_err(|e| e.to_string())?.len();
        if len <= 4 * 1024 * 1024 {
            let body = tokio::fs::read(local).await.map_err(|e| e.to_string())?;
            let r = util::http().put(format!("{}:/content", item(p))).bearer_auth(&tok).body(body).send().await.map_err(|e| e.to_string())?;
            let st = r.status().as_u16();
            if st >= 300 { return Err(api_err(st, &r.json().await.unwrap_or(Value::Null))) }
            return Ok(());
        }
        // an upload session, 10 MB at a time (a multiple of 320 KB, as Graph asks)
        let r = util::http().post(format!("{}:/createUploadSession", item(p))).bearer_auth(&tok).json(&json!({ "item": { "@microsoft.graph.conflictBehavior": "replace" } })).send().await.map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if st >= 300 { return Err(api_err(st, &v)) }
        let up = v["uploadUrl"].as_str().ok_or("No upload address")?.to_string();
        let mut f = tokio::fs::File::open(local).await.map_err(|e| e.to_string())?;
        let chunk = 32 * 327_680usize;
        let mut buf = vec![0u8; chunk];
        let mut off = 0u64;
        while off < len {
            let mut n = 0;
            while n < chunk { let k = f.read(&mut buf[n..]).await.map_err(|e| e.to_string())?; if k == 0 { break } n += k; }
            let r = util::http().put(&up).header("Content-Range", format!("bytes {}-{}/{}", off, off + n as u64 - 1, len)).body(buf[..n].to_vec()).send().await.map_err(|e| e.to_string())?;
            let st = r.status().as_u16();
            if st >= 300 { return Err(api_err(st, &r.json().await.unwrap_or(Value::Null))) }
            off += n as u64;
        }
        Ok(())
    }
    pub async fn mkdir(o: &OAuth, p: &str) -> Result<(), String> {
        let (parent, name) = parent_name(p);
        let url = if parent == "/" { format!("{}/me/drive/root/children", base()) } else { format!("{}:/children", item(&parent)) };
        let r = util::http().post(url).bearer_auth(o.access().await?).json(&json!({ "name": name, "folder": {}, "@microsoft.graph.conflictBehavior": "fail" })).send().await.map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        if st >= 300 && st != 409 { return Err(api_err(st, &r.json().await.unwrap_or(Value::Null))) }
        Ok(())
    }
    pub async fn rename(o: &OAuth, from: &str, to: &str) -> Result<(), String> {
        let (fp, _) = parent_name(from);
        let (tp, tn) = parent_name(to);
        let mut body = json!({ "name": tn });
        if fp != tp { body["parentReference"] = json!({ "path": if tp == "/" { "/drive/root:".to_string() } else { format!("/drive/root:{tp}") } }); }
        let r = util::http().patch(item(from)).bearer_auth(o.access().await?).json(&body).send().await.map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        if st >= 300 { return Err(api_err(st, &r.json().await.unwrap_or(Value::Null))) }
        Ok(())
    }
}

// ---------------------------------------------------------------- Google Drive
mod gdrive {
    use super::*;
    const FOLDER: &str = "application/vnd.google-apps.folder";
    fn base() -> String {
        test_base("gdrive").unwrap_or_else(|| "https://www.googleapis.com".into())
    }
    fn q(s: &str) -> String {
        s.replace('\\', "\\\\").replace('\'', "\\'")
    }
    async fn children(o: &OAuth, id: &str) -> Result<Vec<Value>, String> {
        let tok = o.access().await?;
        let mut out = vec![];
        let mut page = String::new();
        loop {
            let url = format!("{}/drive/v3/files?q={}&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&pageSize=1000{}", base(), urlencoding::encode(&format!("'{}' in parents and trashed=false", q(id))), if page.is_empty() { String::new() } else { format!("&pageToken={page}") });
            let v = get_json(&url, &tok).await?;
            out.extend(v["files"].as_array().cloned().unwrap_or_default());
            match v["nextPageToken"].as_str() { Some(n) => page = n.to_string(), None => break }
        }
        Ok(out)
    }
    /// (id, is folder, size) of a path, walking from the root (remembered after the first time)
    pub async fn find(o: &OAuth, p: &str) -> Result<(String, bool, u64), String> {
        let p = p.trim_end_matches('/');
        if p.is_empty() { return Ok(("root".into(), true, 0)) }
        if let Some((id, d)) = o.ids.lock().get(p).cloned() { return Ok((id, d, 0)) }
        let (parent, name) = parent_name(p);
        let (pid, _, _) = Box::pin(find(o, &parent)).await?;
        for f in children(o, &pid).await? {
            let n = f["name"].as_str().unwrap_or("");
            let is_dir = f["mimeType"] == FOLDER;
            let child = if parent == "/" { format!("/{n}") } else { format!("{parent}/{n}") };
            o.ids.lock().insert(child, (f["id"].as_str().unwrap_or("").to_string(), is_dir));
            if n == name { return Ok((f["id"].as_str().unwrap_or("").to_string(), is_dir, f["size"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0))) }
        }
        Err("Not found".into())
    }
    pub async fn list(o: &OAuth, dir: &str) -> Result<Vec<Ent>, String> {
        let (id, _, _) = find(o, dir).await?;
        let base = dir.trim_end_matches('/');
        let mut out = vec![];
        for f in children(o, &id).await? {
            let name = f["name"].as_str().unwrap_or("").to_string();
            let is_dir = f["mimeType"] == FOLDER;
            o.ids.lock().insert(format!("{base}/{name}"), (f["id"].as_str().unwrap_or("").to_string(), is_dir));
            // Google Docs, Sheets and Slides have no file behind them: they download as Word, Excel and PowerPoint
            let mime = f["mimeType"].as_str().unwrap_or("");
            let name = match mime { "application/vnd.google-apps.document" => format!("{name}.docx"), "application/vnd.google-apps.spreadsheet" => format!("{name}.xlsx"), "application/vnd.google-apps.presentation" => format!("{name}.pptx"), _ => name };
            if mime != FOLDER && mime.starts_with("application/vnd.google-apps.") && !name.contains('.') { continue }
            out.push(Ent { name, is_dir, size: f["size"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0), mtime: iso_ms(f["modifiedTime"].as_str().unwrap_or("")) });
        }
        Ok(out)
    }
    async fn find_doc(o: &OAuth, p: &str) -> Result<(String, Option<&'static str>), String> {
        if let Ok((id, _, _)) = find(o, p).await { return Ok((id, None)) }
        for (ext, mime) in [(".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), (".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), (".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")] {
            if let Some(stem) = p.strip_suffix(ext) {
                if let Ok((id, _, _)) = find(o, stem).await { return Ok((id, Some(mime))) }
            }
        }
        Err("Not found".into())
    }
    pub async fn download(o: &OAuth, p: &str, local: &Path, prog: &mut (dyn FnMut(u64) + Send)) -> Result<(), String> {
        let (id, export) = find_doc(o, p).await?;
        let url = match export { Some(m) => format!("{}/drive/v3/files/{id}/export?mimeType={}", base(), urlencoding::encode(m)), None => format!("{}/drive/v3/files/{id}?alt=media", base()) };
        save_stream(util::http().get(url).bearer_auth(o.access().await?).send().await.map_err(|e| e.to_string())?, local, prog).await
    }
    pub async fn upload(o: &OAuth, local: &Path, p: &str) -> Result<(), String> {
        let tok = o.access().await?;
        let (parent, name) = parent_name(p);
        let (pid, _, _) = find(o, &parent).await?;
        let existing = find(o, p).await.ok().map(|x| x.0);
        let (url, method, meta) = match &existing {
            Some(id) => (format!("{}/upload/drive/v3/files/{id}?uploadType=resumable", base()), reqwest::Method::PATCH, json!({})),
            None => (format!("{}/upload/drive/v3/files?uploadType=resumable", base()), reqwest::Method::POST, json!({ "name": name, "parents": [pid] })),
        };
        let r = util::http().request(method, url).bearer_auth(&tok).json(&meta).send().await.map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        if st >= 300 { return Err(api_err(st, &r.json().await.unwrap_or(Value::Null))) }
        let loc = r.headers().get("location").and_then(|v| v.to_str().ok()).ok_or("No upload address")?.to_string();
        let (body, len) = file_body(local).await?;
        let r = util::http().put(loc).header("content-length", len.to_string()).body(body).send().await.map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if st >= 300 { return Err(api_err(st, &v)) }
        if let Some(id) = v["id"].as_str() { o.ids.lock().insert(p.trim_end_matches('/').to_string(), (id.to_string(), false)); }
        Ok(())
    }
    pub async fn mkdir(o: &OAuth, p: &str) -> Result<String, String> {
        if let Ok((id, true, _)) = find(o, p).await { return Ok(id) }
        let (parent, name) = parent_name(p);
        let pid: String = Box::pin(mkdir(o, &parent)).await?;
        let r = util::http().post(format!("{}/drive/v3/files", base())).bearer_auth(o.access().await?).json(&json!({ "name": name, "mimeType": FOLDER, "parents": [pid] })).send().await.map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if st >= 300 { return Err(api_err(st, &v)) }
        let id = v["id"].as_str().unwrap_or("").to_string();
        o.ids.lock().insert(p.trim_end_matches('/').to_string(), (id.clone(), true));
        Ok(id)
    }
    /// to Google Drive's trash (recoverable for 30 days)
    pub async fn trash(o: &OAuth, p: &str) -> Result<(), String> {
        let (id, _) = find_doc(o, p).await?;
        let r = util::http().patch(format!("{}/drive/v3/files/{id}", base())).bearer_auth(o.access().await?).json(&json!({ "trashed": true })).send().await.map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        if st >= 300 { return Err(api_err(st, &r.json().await.unwrap_or(Value::Null))) }
        let pre = p.trim_end_matches('/').to_string();
        o.ids.lock().retain(|k, _| k != &pre && !k.starts_with(&format!("{pre}/")));
        Ok(())
    }
    pub async fn rename(o: &OAuth, from: &str, to: &str) -> Result<(), String> {
        let (id, _) = find_doc(o, from).await?;
        let (fp, _) = parent_name(from);
        let (tp, tn) = parent_name(to);
        let mut url = format!("{}/drive/v3/files/{id}", base());
        if fp != tp {
            let (old, _, _) = find(o, &fp).await?;
            let (new, _, _) = find(o, &tp).await?;
            url = format!("{url}?addParents={new}&removeParents={old}");
        }
        let r = util::http().patch(url).bearer_auth(o.access().await?).json(&json!({ "name": tn })).send().await.map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        if st >= 300 { return Err(api_err(st, &r.json().await.unwrap_or(Value::Null))) }
        let pre = from.trim_end_matches('/').to_string();
        o.ids.lock().retain(|k, _| k != &pre && !k.starts_with(&format!("{pre}/")));
        Ok(())
    }
}

// ---------------------------------------------------------------- S3 (signature version 4)
pub struct S3 {
    endpoint: String,
    region: String,
    bucket: String,
    key_id: String,
    secret: String,
    path_style: bool,
}
fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut k = if key.len() > 64 { Sha256::digest(key).to_vec() } else { key.to_vec() };
    k.resize(64, 0);
    let ipad: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
    let opad: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();
    let inner = Sha256::new().chain_update(&ipad).chain_update(data).finalize();
    Sha256::new().chain_update(&opad).chain_update(inner).finalize().to_vec()
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn uri_enc(s: &str, slash: bool) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => o.push(b as char),
            b'/' if !slash => o.push('/'),
            _ => o.push_str(&format!("%{b:02X}")),
        }
    }
    o
}
fn amz_date() -> (String, String) {
    let ms = util::now_ms() as i64 / 1000;
    let (days, secs) = (ms.div_euclid(86400), ms.rem_euclid(86400));
    // civil from days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let date = format!("{y:04}{m:02}{d:02}");
    (format!("{date}T{:02}{:02}{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60), date)
}
impl S3 {
    pub fn from(c: &Value, secret: &str) -> Result<S3, String> {
        let region = c["region"].as_str().filter(|s| !s.is_empty()).unwrap_or("us-east-1").to_string();
        let bucket = c["bucket"].as_str().filter(|s| !s.is_empty()).ok_or("Which bucket?")?.to_string();
        let endpoint = c["host"].as_str().filter(|s| !s.is_empty()).map(|h| if h.starts_with("http") { h.trim_end_matches('/').to_string() } else { format!("https://{}", h.trim_end_matches('/')) }).unwrap_or_else(|| format!("https://s3.{region}.amazonaws.com"));
        let path_style = c["pathStyle"].as_bool().unwrap_or(!endpoint.contains("amazonaws.com"));
        Ok(S3 { endpoint, region, bucket, key_id: c["user"].as_str().unwrap_or("").to_string(), secret: secret.to_string(), path_style })
    }
    /// "/a/b.txt" → "a/b.txt"
    pub fn key(&self, p: &str) -> String {
        p.trim_start_matches('/').trim_end_matches('/').to_string()
    }
    fn url_and_host(&self, key: &str) -> (String, String, String) {
        let u = reqwest::Url::parse(&self.endpoint).unwrap_or_else(|_| reqwest::Url::parse("https://s3.amazonaws.com").unwrap());
        let host = match u.port() { Some(p) => format!("{}:{p}", u.host_str().unwrap_or("")), None => u.host_str().unwrap_or("").to_string() };
        if self.path_style {
            let path = format!("/{}/{}", self.bucket, uri_enc(key, false));
            (format!("{}://{host}{path}", u.scheme()), host, path)
        } else {
            let h = format!("{}.{host}", self.bucket);
            let path = format!("/{}", uri_enc(key, false));
            (format!("{}://{h}{path}", u.scheme()), h, path)
        }
    }
    fn signed(&self, method: &str, key: &str, query: &str, mut headers: Vec<(String, String)>) -> (String, Vec<(String, String)>) {
        let (url, host, path) = self.url_and_host(key);
        let (amz, date) = amz_date();
        headers.push(("host".into(), host));
        headers.push(("x-amz-date".into(), amz.clone()));
        headers.push(("x-amz-content-sha256".into(), "UNSIGNED-PAYLOAD".into()));
        headers.sort_by(|a, b| a.0.cmp(&b.0));
        let mut qs: Vec<(String, String)> = query.split('&').filter(|x| !x.is_empty()).map(|kv| { let (k, v) = kv.split_once('=').unwrap_or((kv, "")); (uri_enc(k, true), uri_enc(v, true)) }).collect();
        qs.sort();
        let cq = qs.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
        let ch: String = headers.iter().map(|(k, v)| format!("{}:{}\n", k.to_lowercase(), v.trim())).collect();
        let sh = headers.iter().map(|(k, _)| k.to_lowercase()).collect::<Vec<_>>().join(";");
        let creq = format!("{method}\n{path}\n{cq}\n{ch}\n{sh}\nUNSIGNED-PAYLOAD");
        let scope = format!("{date}/{}/s3/aws4_request", self.region);
        let sts = format!("AWS4-HMAC-SHA256\n{amz}\n{scope}\n{}", hex(&Sha256::digest(creq.as_bytes())));
        let k = hmac(&hmac(&hmac(&hmac(format!("AWS4{}", self.secret).as_bytes(), date.as_bytes()), self.region.as_bytes()), b"s3"), b"aws4_request");
        let sig = hex(&hmac(&k, sts.as_bytes()));
        headers.push(("authorization".into(), format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={sh}, Signature={sig}", self.key_id)));
        headers.retain(|(k, _)| k != "host");
        (if cq.is_empty() { url } else { format!("{url}?{cq}") }, headers)
    }
    pub async fn send(&self, method: &str, key: &str, query: &str, headers: Vec<(String, String)>) -> Result<reqwest::Response, String> {
        self.send_body(method, key, query, headers, reqwest::Body::from(Vec::new())).await
    }
    pub async fn send_body(&self, method: &str, key: &str, query: &str, headers: Vec<(String, String)>, body: reqwest::Body) -> Result<reqwest::Response, String> {
        let (url, hs) = self.signed(method, key, query, headers);
        let mut rq = util::http().request(reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?, url);
        for (k, v) in hs {
            rq = rq.header(k, v);
        }
        rq.body(body).send().await.map_err(|e| e.to_string())
    }
    pub async fn check(r: reqwest::Response) -> Result<String, String> {
        let st = r.status().as_u16();
        let t = r.text().await.unwrap_or_default();
        if st >= 300 {
            let code = regex::Regex::new(r"<Code>([^<]+)</Code>").unwrap().captures(&t).map(|c| c[1].to_string()).unwrap_or_default();
            let msg = regex::Regex::new(r"<Message>([^<]+)</Message>").unwrap().captures(&t).map(|c| c[1].to_string()).unwrap_or_default();
            return Err(match code.as_str() {
                "InvalidAccessKeyId" | "SignatureDoesNotMatch" => "The access key or secret was not accepted.".into(),
                "NoSuchBucket" => "That bucket doesn’t exist (check the name and region).".into(),
                "AccessDenied" => "Access denied for this key.".into(),
                "NoSuchKey" => "Not found".into(),
                _ => if msg.is_empty() { format!("The storage service answered {st}") } else { msg },
            });
        }
        Ok(t)
    }
    async fn list_all(&self, prefix: &str, delim: bool) -> Result<(Vec<(String, u64, f64)>, Vec<String>), String> {
        let mut files = vec![];
        let mut dirs = vec![];
        let mut token = String::new();
        let key_re = regex::Regex::new(r"(?s)<Contents>.*?<Key>([^<]*)</Key>.*?<LastModified>([^<]*)</LastModified>.*?<Size>(\d+)</Size>.*?</Contents>").unwrap();
        let pre_re = regex::Regex::new(r"(?s)<CommonPrefixes>\s*<Prefix>([^<]*)</Prefix>").unwrap();
        loop {
            let mut q = format!("list-type=2&max-keys=1000&prefix={}", prefix);
            if delim { q.push_str("&delimiter=/") }
            if !token.is_empty() { q.push_str(&format!("&continuation-token={token}")) }
            // the query is signed with its values already decoded
            let body = S3::check(self.send("GET", "", &q, vec![]).await?).await?;
            let un = |s: &str| s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'");
            for c in key_re.captures_iter(&body) { files.push((un(&c[1]), c[3].parse().unwrap_or(0), iso_ms(&c[2]))); }
            for c in pre_re.captures_iter(&body) { dirs.push(un(&c[1])); }
            match regex::Regex::new(r"<NextContinuationToken>([^<]+)</NextContinuationToken>").unwrap().captures(&body) { Some(c) => token = un(&c[1]), None => break }
        }
        Ok((files, dirs))
    }
    pub async fn list(&self, dir: &str) -> Result<Vec<Ent>, String> {
        let k = self.key(dir);
        let prefix = if k.is_empty() { String::new() } else { format!("{k}/") };
        let (files, dirs) = self.list_all(&prefix, true).await?;
        let mut out: Vec<Ent> = dirs.iter().map(|d| Ent { name: d[prefix.len()..].trim_end_matches('/').to_string(), is_dir: true, size: 0, mtime: 0.0 }).filter(|e| !e.name.is_empty()).collect();
        out.extend(files.into_iter().filter(|(f, _, _)| f.len() > prefix.len()).map(|(f, s, m)| Ent { name: f[prefix.len()..].to_string(), is_dir: false, size: s, mtime: m }));
        Ok(out)
    }
    pub async fn stat(&self, p: &str) -> Option<(bool, u64)> {
        let k = self.key(p);
        if let Ok(r) = self.send("HEAD", &k, "", vec![]).await {
            if r.status().is_success() {
                return Some((false, r.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).unwrap_or(0)));
            }
        }
        let (f, d) = self.list_all(&format!("{k}/"), true).await.ok()?;
        if !f.is_empty() || !d.is_empty() { Some((true, 0)) } else { None }
    }
    pub async fn remove(&self, p: &str) -> Result<(), String> {
        let k = self.key(p);
        let (files, _) = self.list_all(&format!("{k}/"), false).await?;
        for (f, _, _) in files {
            S3::check(self.send("DELETE", &f, "", vec![]).await?).await?;
        }
        let _ = self.send("DELETE", &format!("{k}/"), "", vec![]).await;
        let r = self.send("DELETE", &k, "", vec![]).await?;
        if r.status().is_success() || r.status().as_u16() == 404 { Ok(()) } else { S3::check(r).await.map(|_| ()) }
    }
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        let (fk, tk) = (self.key(from), self.key(to));
        let mut moves = vec![];
        if self.send("HEAD", &fk, "", vec![]).await.map(|r| r.status().is_success()).unwrap_or(false) {
            moves.push((fk.clone(), tk.clone()));
        } else {
            let (files, _) = self.list_all(&format!("{fk}/"), false).await?;
            for (f, _, _) in files { moves.push((f.clone(), format!("{tk}{}", &f[fk.len()..]))); }
        }
        for (a, b) in moves {
            let src = format!("/{}/{}", self.bucket, uri_enc(&a, false));
            S3::check(self.send("PUT", &b, "", vec![("x-amz-copy-source".into(), src)]).await?).await?;
            S3::check(self.send("DELETE", &a, "", vec![]).await?).await?;
        }
        Ok(())
    }
}
