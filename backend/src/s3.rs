// Object storage over the S3 API (signature version 4): Amazon S3 and the services that speak it: Backblaze B2,
// Google Cloud Storage (interoperability HMAC keys), Cloudflare R2, Wasabi, DigitalOcean Spaces, MinIO…
// Browsed as folders (atlas:remote|<id>|/path). A connection can be one bucket, or all of the account's buckets
// (then the first folder is the bucket). Big files go up in parallel parts that are retried one by one; busy
// services ("slow down", 429, 5xx) get retried with growing pauses; an optional speed limit keeps uploads polite.
use crate::util;
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

pub use crate::cloudapi::Ent;

/// files bigger than this go up in parts
const MULTIPART_AT: u64 = 32 * 1024 * 1024;
/// parts in flight at once
const PARALLEL: usize = 4;
/// the most a single copy request takes (S3's limit); bigger objects are copied in parts
const COPY_MAX: u64 = 5 * 1024 * 1024 * 1024;

pub struct S3 {
    endpoint: String,
    region: String,
    /// empty: all the account's buckets ("/bucket/key")
    bucket: String,
    key_id: String,
    secret: String,
    path_style: bool,
    aws: bool,
    /// uploads no faster than this (bytes a second; 0 = no limit)
    max_bps: u64,
    /// each bucket's region (Amazon answers a request in the wrong region with the right one)
    regions: Mutex<HashMap<String, String>>,
    /// at most this many requests at once to this service
    gate: Arc<tokio::sync::Semaphore>,
}

/// where one request goes
#[derive(Clone)]
struct At {
    bucket: String,
    region: String,
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
    let (y, m, d) = crate::reminders::civil_from_days(days);
    let date = format!("{y:04}{m:02}{d:02}");
    (format!("{date}T{:02}{:02}{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60), date)
}
fn iso_ms(s: &str) -> f64 {
    // 2026-10-23T11:02:03.000Z
    let (d, t) = s.split_once('T').unwrap_or((s, "00:00:00"));
    let day = crate::reminders::parse_iso(d).unwrap_or(0);
    let mut hms = t.trim_end_matches('Z').split(':').map(|x| x.split('.').next().unwrap_or("0").parse::<i64>().unwrap_or(0));
    let secs = hms.next().unwrap_or(0) * 3600 + hms.next().unwrap_or(0) * 60 + hms.next().unwrap_or(0);
    ((day * 86400 + secs) * 1000) as f64
}
fn unxml(s: &str) -> String {
    s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#13;", "\r")
}
fn tag<'a>(body: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let i = body.find(&open)? + open.len();
    let j = body[i..].find(&format!("</{name}>"))? + i;
    Some(&body[i..j])
}

/// endpoint and region for a provider preset when no endpoint is given
fn preset(c: &Value, region: &str) -> Option<(String, String)> {
    let r = region.to_string();
    Some(match c["provider"].as_str().unwrap_or("") {
        "b2" => (format!("https://s3.{region}.backblazeb2.com"), r),
        "gcs" => ("https://storage.googleapis.com".into(), "auto".into()),
        "r2" => (format!("https://{}.r2.cloudflarestorage.com", c["account"].as_str().unwrap_or("").trim()), "auto".into()),
        "wasabi" => (format!("https://s3.{region}.wasabisys.com"), r),
        "spaces" => (format!("https://{region}.digitaloceanspaces.com"), r),
        _ => return None,
    })
}

impl S3 {
    pub fn from(c: &Value, secret: &str) -> Result<S3, String> {
        let mut region = c["region"].as_str().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("").to_string();
        let given = c["host"].as_str().map(str::trim).filter(|s| !s.is_empty());
        let endpoint = match given {
            Some(h) => if h.starts_with("http") { h.trim_end_matches('/').to_string() } else { format!("https://{}", h.trim_end_matches('/')) },
            None => match preset(c, if region.is_empty() { "us-east-1" } else { &region }) {
                Some((e, r)) => {
                    region = r;
                    e
                }
                None => format!("https://s3.{}.amazonaws.com", if region.is_empty() { "us-east-1" } else { &region }),
            },
        };
        if c["provider"] == "r2" && c["account"].as_str().unwrap_or("").trim().is_empty() && given.is_none() {
            return Err("Enter your Cloudflare account ID".into());
        }
        if region.is_empty() {
            // "us-east-1" is what MinIO and most S3-compatible services expect when none is set (R2 and Google
            // Cloud get "auto" from their presets)
            region = "us-east-1".into();
        }
        let aws = endpoint.contains("amazonaws.com");
        let path_style = c["pathStyle"].as_bool().unwrap_or(!aws);
        let max_bps = (c["maxSpeed"].as_f64().or_else(|| c["maxSpeed"].as_str().and_then(|s| s.parse().ok())).unwrap_or(0.0) * 1024.0 * 1024.0) as u64;
        Ok(S3 {
            endpoint,
            region,
            bucket: c["bucket"].as_str().unwrap_or("").trim().trim_matches('/').to_string(),
            key_id: c["user"].as_str().unwrap_or("").trim().to_string(),
            secret: secret.trim().to_string(),
            path_style,
            aws,
            max_bps,
            regions: Mutex::new(HashMap::new()),
            gate: Arc::new(tokio::sync::Semaphore::new(PARALLEL + 2)),
        })
    }
    fn all_buckets(&self) -> bool {
        self.bucket.is_empty()
    }
    /// "/a/b.txt" → (bucket, "a/b.txt"); with all buckets the first folder is the bucket
    fn split(&self, p: &str) -> (String, String) {
        let k = p.trim_start_matches('/').trim_end_matches('/');
        if self.all_buckets() {
            let (b, rest) = k.split_once('/').unwrap_or((k, ""));
            (b.to_string(), rest.to_string())
        } else {
            (self.bucket.clone(), k.to_string())
        }
    }
    async fn at(&self, bucket: &str) -> At {
        if let Some(r) = self.regions.lock().get(bucket) {
            return At { bucket: bucket.into(), region: r.clone() };
        }
        let mut region = self.region.clone();
        // Amazon: ask the bucket where it lives (the answer comes even when access is denied)
        if self.aws && !bucket.is_empty() {
            let probe = At { bucket: bucket.into(), region: region.clone() };
            if let Ok(r) = self.raw(&probe, "HEAD", "", "", vec![], Vec::new()).await {
                if let Some(v) = r.headers().get("x-amz-bucket-region").and_then(|v| v.to_str().ok()) {
                    region = v.to_string();
                }
            }
        }
        self.regions.lock().insert(bucket.into(), region.clone());
        At { bucket: bucket.into(), region }
    }

    fn url_and_host(&self, at: &At, key: &str) -> (String, String, String) {
        let mut ep = self.endpoint.clone();
        // a bucket in another Amazon region is reached through that region's address
        if self.aws && at.region != self.region {
            ep = format!("https://s3.{}.amazonaws.com", at.region);
        }
        let u = reqwest::Url::parse(&ep).unwrap_or_else(|_| reqwest::Url::parse("https://s3.amazonaws.com").unwrap());
        let host = match u.port() {
            Some(p) => format!("{}:{p}", u.host_str().unwrap_or("")),
            None => u.host_str().unwrap_or("").to_string(),
        };
        if at.bucket.is_empty() {
            return (format!("{}://{host}/", u.scheme()), host, "/".into());
        }
        if self.path_style || at.bucket.contains('.') {
            let path = format!("/{}/{}", at.bucket, uri_enc(key, false));
            (format!("{}://{host}{path}", u.scheme()), host, path)
        } else {
            let h = format!("{}.{host}", at.bucket);
            let path = format!("/{}", uri_enc(key, false));
            (format!("{}://{h}{path}", u.scheme()), h, path)
        }
    }
    fn signed(&self, at: &At, method: &str, key: &str, query: &str, mut headers: Vec<(String, String)>) -> (String, Vec<(String, String)>) {
        let (url, host, path) = self.url_and_host(at, key);
        let (amz, date) = amz_date();
        headers.push(("host".into(), host));
        headers.push(("x-amz-date".into(), amz.clone()));
        headers.push(("x-amz-content-sha256".into(), "UNSIGNED-PAYLOAD".into()));
        headers.sort_by(|a, b| a.0.cmp(&b.0));
        let mut qs: Vec<(String, String)> = query
            .split('&')
            .filter(|x| !x.is_empty())
            .map(|kv| {
                let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
                (uri_enc(k, true), uri_enc(v, true))
            })
            .collect();
        qs.sort();
        let cq = qs.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
        let ch: String = headers.iter().map(|(k, v)| format!("{}:{}\n", k.to_lowercase(), v.trim())).collect();
        let sh = headers.iter().map(|(k, _)| k.to_lowercase()).collect::<Vec<_>>().join(";");
        let creq = format!("{method}\n{path}\n{cq}\n{ch}\n{sh}\nUNSIGNED-PAYLOAD");
        let scope = format!("{date}/{}/s3/aws4_request", at.region);
        let sts = format!("AWS4-HMAC-SHA256\n{amz}\n{scope}\n{}", hex(&Sha256::digest(creq.as_bytes())));
        let k = hmac(&hmac(&hmac(&hmac(format!("AWS4{}", self.secret).as_bytes(), date.as_bytes()), at.region.as_bytes()), b"s3"), b"aws4_request");
        let sig = hex(&hmac(&k, sts.as_bytes()));
        headers.push(("authorization".into(), format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={sh}, Signature={sig}", self.key_id)));
        headers.retain(|(k, _)| k != "host");
        (if cq.is_empty() { url } else { format!("{url}?{cq}") }, headers)
    }
    /// one request, no retries
    async fn raw(&self, at: &At, method: &str, key: &str, query: &str, headers: Vec<(String, String)>, body: Vec<u8>) -> Result<reqwest::Response, String> {
        let (url, hs) = self.signed(at, method, key, query, headers);
        let mut rq = util::http().request(reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?, url).timeout(Duration::from_secs(if body.len() > 1 << 20 { 900 } else { 120 }));
        for (k, v) in hs {
            rq = rq.header(k, v);
        }
        rq.body(body).send().await.map_err(|e| e.to_string())
    }
    /// a request that's retried when the service is busy or the network drops: 5 tries, pausing 0.5, 1, 2, 4 s
    /// (or as long as the service asks), with a little randomness so parallel parts don't retry in step
    async fn send(&self, at: &At, method: &str, key: &str, query: &str, headers: Vec<(String, String)>, body: Vec<u8>) -> Result<reqwest::Response, String> {
        let _permit = self.gate.acquire().await.map_err(|e| e.to_string())?;
        let mut wait = 500u64;
        for attempt in 0..5 {
            let r = self.raw(at, method, key, query, headers.clone(), body.clone()).await;
            let retry_after = match &r {
                Ok(resp) => {
                    let st = resp.status().as_u16();
                    if !(st == 429 || st == 500 || st == 502 || st == 503 || st == 504) {
                        return r;
                    }
                    resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<u64>().ok()).map(|s| s * 1000)
                }
                Err(_) => None,
            };
            if attempt == 4 {
                return r;
            }
            let jitter = (util::now_ms() as u64) % 250;
            tokio::time::sleep(Duration::from_millis(retry_after.unwrap_or(wait).min(20_000) + jitter)).await;
            wait *= 2;
        }
        unreachable!()
    }
    pub async fn check(r: reqwest::Response) -> Result<String, String> {
        let st = r.status().as_u16();
        let t = r.text().await.unwrap_or_default();
        if st >= 300 {
            let code = tag(&t, "Code").unwrap_or("").to_string();
            let msg = tag(&t, "Message").map(unxml).unwrap_or_default();
            return Err(match code.as_str() {
                "InvalidAccessKeyId" | "SignatureDoesNotMatch" | "InvalidSecurity" => "The access key or secret was not accepted.".into(),
                "NoSuchBucket" => "That bucket doesn’t exist (check the name, and the region or endpoint).".into(),
                "AccessDenied" | "AllAccessDisabled" => "Access denied for this key.".into(),
                "NoSuchKey" => "Not found".into(),
                "SlowDown" | "TooManyRequests" => "The storage service is busy. Try again in a moment.".into(),
                "EntityTooLarge" => "That file is too big for one upload.".into(),
                "AuthorizationHeaderMalformed" => "The region is wrong for this bucket.".into(),
                "RequestTimeTooSkewed" => "This PC’s clock is off; the storage service refused the request. Set the time and try again.".into(),
                _ if st == 403 && msg.is_empty() => "Access denied for this key.".into(),
                _ => if msg.is_empty() { format!("The storage service answered {st}") } else { msg },
            });
        }
        Ok(t)
    }
    /// a body-less request to a path ("/bucket/key"), retried, checked
    pub async fn call(&self, method: &str, p: &str, query: &str, headers: Vec<(String, String)>) -> Result<String, String> {
        let (b, k) = self.split(p);
        let at = self.at(&b).await;
        S3::check(self.send(&at, method, &k, query, headers, Vec::new()).await?).await
    }

    async fn buckets(&self) -> Result<Vec<Ent>, String> {
        let at = At { bucket: String::new(), region: self.region.clone() };
        let body = S3::check(self.send(&at, "GET", "", "", vec![], Vec::new()).await?).await?;
        let mut out = vec![];
        for part in body.split("<Bucket>").skip(1) {
            if let Some(n) = tag(part, "Name") {
                out.push(Ent { name: unxml(n), is_dir: true, size: 0, mtime: tag(part, "CreationDate").map(iso_ms).unwrap_or(0.0) });
            }
        }
        Ok(out)
    }
    async fn list_all(&self, at: &At, prefix: &str, delim: bool) -> Result<(Vec<(String, u64, f64)>, Vec<String>), String> {
        let mut files = vec![];
        let mut dirs = vec![];
        let mut token = String::new();
        loop {
            let mut q = format!("list-type=2&max-keys=1000&prefix={prefix}");
            if delim {
                q.push_str("&delimiter=/")
            }
            if !token.is_empty() {
                q.push_str(&format!("&continuation-token={token}"))
            }
            // the query is signed with its values decoded
            let body = S3::check(self.send(at, "GET", "", &q, vec![], Vec::new()).await?).await?;
            for c in body.split("<Contents>").skip(1) {
                let c = c.split("</Contents>").next().unwrap_or("");
                if let Some(k) = tag(c, "Key") {
                    files.push((unxml(k), tag(c, "Size").and_then(|s| s.parse().ok()).unwrap_or(0), tag(c, "LastModified").map(iso_ms).unwrap_or(0.0)));
                }
            }
            for c in body.split("<CommonPrefixes>").skip(1) {
                if let Some(p) = tag(c, "Prefix") {
                    dirs.push(unxml(p));
                }
            }
            match tag(&body, "NextContinuationToken") {
                Some(t) if tag(&body, "IsTruncated") == Some("true") => token = unxml(t),
                _ => break,
            }
        }
        Ok((files, dirs))
    }
    pub async fn list(&self, dir: &str) -> Result<Vec<Ent>, String> {
        let (b, k) = self.split(dir);
        if b.is_empty() {
            return self.buckets().await;
        }
        let at = self.at(&b).await;
        let prefix = if k.is_empty() { String::new() } else { format!("{k}/") };
        let (files, dirs) = self.list_all(&at, &prefix, true).await?;
        let mut out: Vec<Ent> = dirs.iter().map(|d| Ent { name: d[prefix.len().min(d.len())..].trim_end_matches('/').to_string(), is_dir: true, size: 0, mtime: 0.0 }).filter(|e| !e.name.is_empty()).collect();
        // "folder/" markers are folders, not empty files
        out.extend(files.into_iter().filter(|(f, _, _)| f.len() > prefix.len() && !f.ends_with('/')).map(|(f, s, m)| Ent { name: f[prefix.len()..].to_string(), is_dir: false, size: s, mtime: m }));
        Ok(out)
    }
    pub async fn stat(&self, p: &str) -> Option<(bool, u64)> {
        let (b, k) = self.split(p);
        if b.is_empty() {
            return Some((true, 0));
        }
        let at = self.at(&b).await;
        if k.is_empty() {
            let r = self.send(&at, "HEAD", "", "", vec![], Vec::new()).await.ok()?;
            return r.status().is_success().then_some((true, 0));
        }
        if let Ok(r) = self.send(&at, "HEAD", &k, "", vec![], Vec::new()).await {
            if r.status().is_success() {
                return Some((false, r.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).unwrap_or(0)));
            }
        }
        let (f, d) = self.list_all(&at, &format!("{k}/"), true).await.ok()?;
        if !f.is_empty() || !d.is_empty() { Some((true, 0)) } else { None }
    }
    pub async fn download(&self, p: &str, local: &Path, prog: &mut (dyn FnMut(u64) + Send)) -> Result<(), String> {
        let (b, k) = self.split(p);
        let at = self.at(&b).await;
        let r = self.send(&at, "GET", &k, "", vec![], Vec::new()).await?;
        if !r.status().is_success() {
            return S3::check(r).await.map(|_| ());
        }
        let mut w = tokio::fs::File::create(local).await.map_err(|e| e.to_string())?;
        let mut s = r.bytes_stream();
        let mut n = 0u64;
        while let Some(ch) = s.next().await {
            let ch = ch.map_err(|e| e.to_string())?;
            w.write_all(&ch).await.map_err(|e| e.to_string())?;
            n += ch.len() as u64;
            prog(n);
        }
        w.flush().await.map_err(|e| e.to_string())
    }
    pub async fn mkdir(&self, p: &str) -> Result<(), String> {
        let (b, k) = self.split(p);
        if k.is_empty() {
            // a new bucket (all-buckets connections)
            let at = At { bucket: b, region: self.region.clone() };
            let body = if self.aws && self.region != "us-east-1" { format!("<CreateBucketConfiguration><LocationConstraint>{}</LocationConstraint></CreateBucketConfiguration>", self.region).into_bytes() } else { vec![] };
            return S3::check(self.send(&at, "PUT", "", "", vec![("content-length".into(), body.len().to_string())], body).await?).await.map(|_| ());
        }
        let at = self.at(&b).await;
        S3::check(self.send(&at, "PUT", &format!("{k}/"), "", vec![("content-length".into(), "0".into())], Vec::new()).await?).await.map(|_| ())
    }

    /// keep uploads under the speed limit: wait until `sent` bytes since `start` fit it
    async fn pace(&self, start: Instant, sent: u64) {
        if self.max_bps == 0 {
            return;
        }
        let should = Duration::from_secs_f64(sent as f64 / self.max_bps as f64);
        let took = start.elapsed();
        if should > took {
            tokio::time::sleep(should - took).await;
        }
    }
    pub async fn upload(&self, local: &Path, p: &str, prog: &mut (dyn FnMut(u64) + Send)) -> Result<(), String> {
        let (b, k) = self.split(p);
        if b.is_empty() || k.is_empty() {
            return Err("Open a bucket first, then copy files into it".into());
        }
        let at = self.at(&b).await;
        let len = tokio::fs::metadata(local).await.map_err(|e| e.to_string())?.len();
        let start = Instant::now();
        if len < MULTIPART_AT {
            let body = tokio::fs::read(local).await.map_err(|e| e.to_string())?;
            self.pace(start, len).await;
            S3::check(self.send(&at, "PUT", &k, "", vec![("content-length".into(), len.to_string())], body).await?).await?;
            prog(len);
            return Ok(());
        }
        self.multipart(&at, &k, local, len, start, prog).await
    }
    /// a big file in parts (at most 10,000; at least 8 MB each), several at once, each retried on its own
    async fn multipart(&self, at: &At, k: &str, local: &Path, len: u64, start: Instant, prog: &mut (dyn FnMut(u64) + Send)) -> Result<(), String> {
        let mib = 1024 * 1024;
        let part = (len.div_ceil(9_000)).max(8 * mib).div_ceil(mib) * mib;
        let count = len.div_ceil(part);
        let body = S3::check(self.send(at, "POST", k, "uploads=", vec![], Vec::new()).await?).await?;
        let upload_id = tag(&body, "UploadId").map(unxml).ok_or("The storage service didn’t start the upload")?;
        let result: Result<Vec<(u64, String)>, String> = async {
            let mut etags: Vec<(u64, String)> = vec![];
            let sent = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let mut jobs = futures_util::stream::iter((1..=count).map(|n| {
                let (at, k, upload_id, local, sent) = (at.clone(), k.to_string(), upload_id.clone(), local.to_path_buf(), sent.clone());
                async move {
                    let off = (n - 1) * part;
                    let size = part.min(len - off);
                    let mut f = tokio::fs::File::open(&local).await.map_err(|e| e.to_string())?;
                    f.seek(std::io::SeekFrom::Start(off)).await.map_err(|e| e.to_string())?;
                    let mut buf = vec![0u8; size as usize];
                    f.read_exact(&mut buf).await.map_err(|e| e.to_string())?;
                    let before = sent.load(std::sync::atomic::Ordering::Relaxed);
                    self.pace(start, before + size).await;
                    let r = self.send(&at, "PUT", &k, &format!("partNumber={n}&uploadId={upload_id}"), vec![("content-length".into(), size.to_string())], buf).await?;
                    let etag = r.headers().get("etag").and_then(|v| v.to_str().ok()).map(String::from);
                    S3::check(r).await?;
                    sent.fetch_add(size, std::sync::atomic::Ordering::Relaxed);
                    Ok::<(u64, String, u64), String>((n, etag.ok_or("The storage service lost a part")?, size))
                }
            }))
            .buffer_unordered(PARALLEL);
            let mut done = 0u64;
            while let Some(r) = jobs.next().await {
                let (n, etag, size) = r?;
                done += size;
                prog(done);
                etags.push((n, etag));
            }
            etags.sort_by_key(|x| x.0);
            Ok(etags)
        }
        .await;
        match result {
            Ok(etags) => {
                let xml = format!(
                    "<CompleteMultipartUpload>{}</CompleteMultipartUpload>",
                    etags.iter().map(|(n, e)| format!("<Part><PartNumber>{n}</PartNumber><ETag>{}</ETag></Part>", e.replace('&', "&amp;"))).collect::<String>()
                );
                let r = self.send(at, "POST", k, &format!("uploadId={upload_id}"), vec![("content-type".into(), "application/xml".into()), ("content-length".into(), xml.len().to_string())], xml.into_bytes()).await?;
                let t = S3::check(r).await?;
                // a 200 can still carry an error
                if t.contains("<Error>") {
                    return Err(tag(&t, "Message").map(unxml).unwrap_or_else(|| "The upload couldn’t be finished".into()));
                }
                Ok(())
            }
            Err(e) => {
                // don't leave paid-for parts behind
                let _ = self.send(at, "DELETE", k, &format!("uploadId={upload_id}"), vec![], Vec::new()).await;
                Err(e)
            }
        }
    }

    /// copy one object inside the service (nothing comes down to this PC); in parts when it's over 5 GB
    async fn copy_object(&self, from: (&At, &str), to: (&At, &str), size: u64) -> Result<(), String> {
        let src = format!("/{}/{}", from.0.bucket, uri_enc(from.1, false));
        if size <= COPY_MAX {
            let t = S3::check(self.send(to.0, "PUT", to.1, "", vec![("x-amz-copy-source".into(), src), ("content-length".into(), "0".into())], Vec::new()).await?).await?;
            if t.contains("<Error>") {
                return Err(tag(&t, "Message").map(unxml).unwrap_or_else(|| "The copy failed".into()));
            }
            return Ok(());
        }
        let part = 512 * 1024 * 1024u64;
        let body = S3::check(self.send(to.0, "POST", to.1, "uploads=", vec![], Vec::new()).await?).await?;
        let upload_id = tag(&body, "UploadId").map(unxml).ok_or("The storage service didn’t start the copy")?;
        let mut xml = String::from("<CompleteMultipartUpload>");
        for (i, off) in (0..size).step_by(part as usize).enumerate() {
            let end = (off + part).min(size) - 1;
            let r = self.send(to.0, "PUT", to.1, &format!("partNumber={}&uploadId={upload_id}", i + 1), vec![("x-amz-copy-source".into(), src.clone()), ("x-amz-copy-source-range".into(), format!("bytes={off}-{end}")), ("content-length".into(), "0".into())], Vec::new()).await?;
            let t = match S3::check(r).await {
                Ok(t) => t,
                Err(e) => {
                    let _ = self.send(to.0, "DELETE", to.1, &format!("uploadId={upload_id}"), vec![], Vec::new()).await;
                    return Err(e);
                }
            };
            xml.push_str(&format!("<Part><PartNumber>{}</PartNumber><ETag>{}</ETag></Part>", i + 1, tag(&t, "ETag").unwrap_or("")));
        }
        xml.push_str("</CompleteMultipartUpload>");
        S3::check(self.send(to.0, "POST", to.1, &format!("uploadId={upload_id}"), vec![("content-length".into(), xml.len().to_string())], xml.into_bytes()).await?).await.map(|_| ())
    }
    /// every object under a path: (key, size); a single object is itself
    async fn objects(&self, at: &At, k: &str) -> Result<(bool, Vec<(String, u64)>), String> {
        if !k.is_empty() {
            if let Ok(r) = self.send(at, "HEAD", k, "", vec![], Vec::new()).await {
                if r.status().is_success() {
                    let n = r.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).unwrap_or(0);
                    return Ok((false, vec![(k.to_string(), n)]));
                }
            }
        }
        let prefix = if k.is_empty() { String::new() } else { format!("{k}/") };
        let (files, _) = self.list_all(at, &prefix, false).await?;
        Ok((true, files.into_iter().map(|(f, s, _)| (f, s)).collect()))
    }
    /// copy a file or folder to another path of this connection, inside the service
    pub async fn copy(&self, from: &str, to: &str) -> Result<(), String> {
        let ((fb, fk), (tb, tk)) = (self.split(from), self.split(to));
        let (fa, ta) = (self.at(&fb).await, self.at(&tb).await);
        let (_, objs) = self.objects(&fa, &fk).await?;
        for (key, size) in objs {
            let dest = if key == fk { tk.clone() } else { format!("{tk}{}", &key[fk.len()..]) };
            self.copy_object((&fa, &key), (&ta, &dest), size).await?;
        }
        Ok(())
    }
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        let (fb, fk) = self.split(from);
        if fk.is_empty() {
            return Err("Buckets can’t be renamed".into());
        }
        let fa = self.at(&fb).await;
        self.copy(from, to).await?;
        let (_, objs) = self.objects(&fa, &fk).await?;
        self.delete_keys(&fa, objs.into_iter().map(|x| x.0).collect()).await?;
        let _ = self.send(&fa, "DELETE", &format!("{fk}/"), "", vec![], Vec::new()).await;
        Ok(())
    }
    /// many deletes in one request (up to 1000 at a time); one by one where that isn't offered
    async fn delete_keys(&self, at: &At, keys: Vec<String>) -> Result<(), String> {
        for chunk in keys.chunks(1000) {
            let xml = format!(
                "<Delete><Quiet>true</Quiet>{}</Delete>",
                chunk.iter().map(|k| format!("<Object><Key>{}</Key></Object>", k.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;"))).collect::<String>()
            );
            let md5 = { use md5::Digest; base64::Engine::encode(&base64::engine::general_purpose::STANDARD, md5::Md5::digest(xml.as_bytes())) };
            let r = self.send(at, "POST", "", "delete=", vec![("content-md5".into(), md5), ("content-type".into(), "application/xml".into()), ("content-length".into(), xml.len().to_string())], xml.into_bytes()).await?;
            let st = r.status().as_u16();
            if st == 501 || st == 400 || st == 405 {
                for k in chunk {
                    let r = self.send(at, "DELETE", k, "", vec![], Vec::new()).await?;
                    if !(r.status().is_success() || r.status().as_u16() == 404) {
                        S3::check(r).await?;
                    }
                }
                continue;
            }
            let t = S3::check(r).await?;
            if let Some(e) = t.split("<Error>").nth(1) {
                return Err(format!("Couldn’t delete {}: {}", tag(e, "Key").map(unxml).unwrap_or_default(), tag(e, "Message").map(unxml).unwrap_or_default()));
            }
        }
        Ok(())
    }
    pub async fn remove(&self, p: &str) -> Result<(), String> {
        let (b, k) = self.split(p);
        let at = self.at(&b).await;
        let (is_dir, objs) = self.objects(&at, &k).await?;
        self.delete_keys(&at, objs.into_iter().map(|x| x.0).collect()).await?;
        if k.is_empty() {
            // the bucket itself (all-buckets connections), once it's empty
            return S3::check(self.send(&at, "DELETE", "", "", vec![], Vec::new()).await?).await.map(|_| ());
        }
        if is_dir {
            let _ = self.send(&at, "DELETE", &format!("{k}/"), "", vec![], Vec::new()).await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signing_matches_aws_example() {
        // the "GET Object" example from Amazon's SigV4 documentation, with UNSIGNED-PAYLOAD replaced by its form
        let k = hmac(&hmac(&hmac(&hmac(b"AWS4wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", b"20130524"), b"us-east-1"), b"s3"), b"aws4_request");
        assert_eq!(hex(&k), "dbb893acc010964918f1fd433add87c70e8b0db6be30c1fbeafefa5ec6ba8378");
    }
    #[test]
    fn paths() {
        let s = S3::from(&serde_json::json!({ "bucket": "", "user": "k" }), "s").unwrap();
        assert_eq!(s.split("/photos/2026/a.jpg"), ("photos".to_string(), "2026/a.jpg".to_string()));
        assert_eq!(s.split("/"), (String::new(), String::new()));
        let s = S3::from(&serde_json::json!({ "bucket": "b", "provider": "b2", "region": "us-west-004" }), "s").unwrap();
        assert_eq!(s.endpoint, "https://s3.us-west-004.backblazeb2.com");
        assert_eq!(s.split("/x/y"), ("b".to_string(), "x/y".to_string()));
        let s = S3::from(&serde_json::json!({ "bucket": "b", "provider": "gcs" }), "s").unwrap();
        assert_eq!((s.endpoint.as_str(), s.region.as_str()), ("https://storage.googleapis.com", "auto"));
        assert!(S3::from(&serde_json::json!({ "provider": "r2" }), "s").is_err());
    }
    #[test]
    fn times() {
        assert_eq!(iso_ms("1970-01-02T00:00:01.000Z"), 86_401_000.0);
    }
}
