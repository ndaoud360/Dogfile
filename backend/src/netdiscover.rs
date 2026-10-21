// Devices on the local network the way File Explorer's Network page finds media devices: SSDP / UPnP (TVs,
// speakers, media servers, routers, printers, NAS). Computers come from the Windows shell's Network folder.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

fn tag(xml: &str, name: &str) -> String {
    let re = regex::Regex::new(&format!(r"(?i)<(?:\w+:)?{name}>([^<]*)</(?:\w+:)?{name}>")).unwrap();
    re.captures(xml).map(|c| c[1].trim().replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")).unwrap_or_default()
}
fn kind_of(device_type: &str, server: &str) -> &'static str {
    let t = format!("{device_type} {server}").to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| t.contains(w));
    if has(&["mediarenderer", "dial", "tv", "roku", "chromecast"]) { "Media devices" }
    else if has(&["mediaserver", "dlna", "plex", "nas"]) { "Media servers" }
    else if has(&["internetgateway", "wanconnection", "router"]) { "Network infrastructure" }
    else if t.contains("print") { "Printers" }
    else if has(&["zoneplayer", "sonos", "speaker"]) { "Media devices" }
    else { "Other devices" }
}
pub async fn ssdp_discover() -> Vec<Value> {
    let Ok(sock) = tokio::net::UdpSocket::bind("0.0.0.0:0").await else { return vec![] };
    let q = |st: &str| format!("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {st}\r\n\r\n");
    for st in ["ssdp:all", "upnp:rootdevice", "urn:dial-multiscreen-org:service:dial:1"] {
        let _ = sock.send_to(q(st).as_bytes(), "239.255.255.250:1900").await;
    }
    let mut found: HashMap<String, (String, String)> = HashMap::new();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(2600);
    let mut resent = false;
    let mut buf = vec![0u8; 4096];
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline { break }
        if !resent && deadline - now < Duration::from_millis(1900) {
            resent = true;
            let _ = sock.send_to(q("ssdp:all").as_bytes(), "239.255.255.250:1900").await;
        }
        match tokio::time::timeout(deadline - now, sock.recv_from(&mut buf)).await {
            Ok(Ok((n, addr))) => {
                let s = String::from_utf8_lossy(&buf[..n]);
                let hdr = |k: &str| s.lines().find_map(|l| { let (a, b) = l.split_once(':')?; if a.trim().eq_ignore_ascii_case(k) { Some(b.trim().to_string()) } else { None } }).unwrap_or_default();
                let loc = hdr("location");
                if !loc.is_empty() && !found.contains_key(&loc) {
                    found.insert(loc, (addr.ip().to_string(), hdr("server")));
                }
            }
            _ => break,
        }
    }
    let client = crate::util::http();
    let mut tasks = vec![];
    for (loc, (ip, server)) in found.into_iter().take(40) {
        let client = client.clone();
        tasks.push(tokio::spawn(async move {
            let xml = match client.get(&loc).timeout(Duration::from_secs(2)).send().await { Ok(r) => r.text().await.unwrap_or_default(), Err(_) => String::new() };
            let xml: String = xml.chars().take(256 * 1024).collect();
            let name = { let n = tag(&xml, "friendlyName"); if !n.is_empty() { n } else if !server.is_empty() { server.clone() } else { ip.clone() } };
            let device_type = tag(&xml, "deviceType");
            let mut pres = tag(&xml, "presentationURL");
            if !pres.is_empty() && !pres.to_lowercase().starts_with("http") {
                pres = reqwest::Url::parse(&loc).ok().and_then(|b| b.join(&pres).ok()).map(|u| u.to_string()).unwrap_or_default();
            }
            if !(pres.starts_with("http://") || pres.starts_with("https://")) { pres.clear() }
            let model = [tag(&xml, "manufacturer"), tag(&xml, "modelName")].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" ");
            json!({ "name": name, "type": kind_of(&device_type, &server), "model": model, "ip": ip, "url": pres, "source": "ssdp" })
        }));
    }
    let mut out = vec![];
    let mut seen = std::collections::HashSet::new();
    for t in tasks {
        if let Ok(v) = t.await {
            let k = format!("{}|{}", v["name"], v["ip"]);
            if seen.insert(k) { out.push(v) }
        }
    }
    out
}
