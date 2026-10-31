//! Dogfile Pro: the 14-day trial and licences.
//!
//! The licence server (supabase/functions/license) signs short tokens with a private key only it has; this file
//! checks them with the public key compiled in (backend/license.json), so a token can't be made up or edited. Every
//! token names the PC it was issued to (a hash of the motherboard's ID), so copying one to another PC does nothing.
//! The trial's start date lives on the server (one trial per PC, ever), and the app never lets time run backwards
//! (it remembers the latest time it has seen), so reinstalling, deleting files or turning the clock back don't
//! give a new trial. Pro calls are refused here, in the program, not only hidden in the interface.
use crate::args::{Args, R};
use crate::*;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

const CONFIG: &str = include_str!("../license.json");
const ALPHA: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KIND_TRIAL: u8 = 1;
const KIND_LICENSE: u8 = 2;
/// re-check a licence with the server this often (when online), so refunds and moves take effect
const REVALIDATE_SECS: u64 = 3 * 86400;

#[derive(Default, Serialize, Deserialize, Clone)]
struct Saved {
    trial: Option<String>,
    license: Option<String>,
    serial: Option<String>,
    email: Option<String>,
    /// the latest time seen (local clock or server): time never runs backwards for the trial
    last_seen: u64,
    /// last successful check with the server
    last_check: u64,
    /// the trial ended on this PC (kept even if the trial token is lost)
    trial_over: bool,
}

struct Claims {
    kind: u8,
    machine: [u8; 10],
    issued: u64,
    a: u64,
    b: u64,
}

static SAVED: Mutex<Option<Saved>> = Mutex::new(None);
/// why the last attempt to write the saved state failed (None: it worked); without it nothing survives a restart
static SAVE_ERROR: Mutex<Option<String>> = Mutex::new(None);

// ---------- configuration ----------
/// the license server's address (also takes the "Report a bug" messages)
pub fn api_base() -> String {
    config().0
}
fn config() -> (String, Option<ed25519_dalek::VerifyingKey>) {
    let c: Value = serde_json::from_str(CONFIG).unwrap_or(json!({}));
    let mut api = c["api"].as_str().unwrap_or("").trim_end_matches('/').to_string();
    let mut pubkey = c["pubkey"].as_str().unwrap_or("").to_string();
    // development builds can point at a test server; release builds can't be redirected
    if cfg!(debug_assertions) {
        if let Ok(v) = std::env::var("DOGFILE_LICENSE_API") {
            api = v.trim_end_matches('/').to_string();
        }
        if let Ok(v) = std::env::var("DOGFILE_LICENSE_PUBKEY") {
            pubkey = v;
        }
    }
    use base64::Engine;
    let key = base64::engine::general_purpose::STANDARD
        .decode(pubkey.trim())
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
        .and_then(|b| ed25519_dalek::VerifyingKey::from_bytes(&b).ok());
    (api, key)
}
/// licensing is set up in this build (a release build always is: publishing refuses otherwise)
pub fn configured() -> bool {
    let (api, key) = config();
    !api.is_empty() && key.is_some()
}

// ---------- the PC's ID ----------
fn b32(bytes: &[u8]) -> String {
    let (mut bits, mut val, mut out) = (0u32, 0u32, String::new());
    for &b in bytes {
        val = (val << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            out.push(ALPHA[((val >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        val &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(ALPHA[((val << (5 - bits)) & 31) as usize] as char);
    }
    out
}
fn unb32(s: &str) -> Option<Vec<u8>> {
    let (mut bits, mut val, mut out) = (0u32, 0u32, Vec::new());
    for c in s.chars().filter(|c| !c.is_whitespace() && *c != '-') {
        let c = match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        };
        let v = ALPHA.iter().position(|&a| a as char == c)? as u32;
        val = (val << 5) | v;
        bits += 5;
        if bits >= 8 {
            out.push(((val >> (bits - 8)) & 255) as u8);
            bits -= 8;
        }
        val &= (1 << bits) - 1;
    }
    Some(out)
}

/// placeholder IDs some motherboards ship with (shared by many PCs): then Windows' own ID is mixed in
fn usable_board_id(u: &[u8]) -> bool {
    let hex: String = u.iter().map(|b| format!("{b:02x}")).collect();
    !(u.iter().all(|&b| b == 0) || u.iter().all(|&b| b == 0xff) || hex == "03000200040005000006000700080009" || hex == "00020003000400050006000700080009")
}
#[cfg(windows)]
fn board_uuid() -> Option<Vec<u8>> {
    use windows::Win32::System::SystemInformation::{GetSystemFirmwareTable, FIRMWARE_TABLE_PROVIDER};
    let rsmb = FIRMWARE_TABLE_PROVIDER(u32::from_be_bytes(*b"RSMB"));
    let n = unsafe { GetSystemFirmwareTable(rsmb, 0, None) } as usize;
    if n < 8 || n > 1 << 22 {
        return None;
    }
    let mut buf = vec![0u8; n];
    let got = unsafe { GetSystemFirmwareTable(rsmb, 0, Some(&mut buf)) } as usize;
    if got < 8 {
        return None;
    }
    // RawSMBIOSData: 8-byte header (with the table length), then the structures
    let len = u32::from_le_bytes(buf[4..8].try_into().ok()?) as usize;
    let table = buf.get(8..8 + len.min(got - 8))?;
    let mut i = 0;
    while i + 4 <= table.len() {
        let (kind, slen) = (table[i], table[i + 1] as usize);
        if slen < 4 {
            break;
        }
        // type 1 "System Information": the UUID at offset 8
        if kind == 1 && slen >= 0x19 {
            return table.get(i + 8..i + 24).map(|s| s.to_vec());
        }
        if kind == 127 {
            break;
        }
        // skip the formatted part, then the strings (ending with two zero bytes)
        let mut j = i + slen;
        while j + 1 < table.len() && !(table[j] == 0 && table[j + 1] == 0) {
            j += 1;
        }
        i = j + 2;
    }
    None
}
#[cfg(not(windows))]
fn board_uuid() -> Option<Vec<u8>> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("ioreg").args(["-rd1", "-c", "IOPlatformExpertDevice"]).output().ok()?;
        let s = String::from_utf8_lossy(&out.stdout);
        let l = s.lines().find(|l| l.contains("IOPlatformUUID"))?;
        let hex: String = l.split('"').nth(3)?.chars().filter(|c| c.is_ascii_hexdigit()).collect();
        return (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()).collect();
    }
    #[allow(unreachable_code)]
    None
}
fn os_id() -> String {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        if let Ok(k) = winreg::RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags("SOFTWARE\\Microsoft\\Cryptography", KEY_READ | KEY_WOW64_64KEY) {
            if let Ok(g) = k.get_value::<String, _>("MachineGuid") {
                return g;
            }
        }
    }
    std::fs::read_to_string("/etc/machine-id").or_else(|_| std::fs::read_to_string("/var/lib/dbus/machine-id")).unwrap_or_default().trim().to_string()
}
/// this PC's ID: 10 bytes of a hash of the motherboard's ID (survives reinstalling Windows), or of Windows' own ID
pub fn machine() -> [u8; 10] {
    static M: std::sync::OnceLock<[u8; 10]> = std::sync::OnceLock::new();
    *M.get_or_init(|| {
        if cfg!(debug_assertions) {
            if let Some(b) = std::env::var("DOGFILE_TEST_MACHINE").ok().and_then(|s| unb32(&s)).filter(|b| b.len() == 10) {
                return b.try_into().unwrap_or([0; 10]);
            }
        }
        let mut h = Sha256::new();
        h.update(b"dogfile-machine-v1|");
        match board_uuid() {
            Some(u) if usable_board_id(&u) => h.update(&u),
            other => {
                h.update(other.unwrap_or_default());
                h.update(b"|");
                h.update(os_id().as_bytes());
            }
        }
        let d = h.finalize();
        let mut out = [0u8; 10];
        out.copy_from_slice(&d[..10]);
        out
    })
}
pub fn machine_text() -> String {
    b32(&machine())
}

// ---------- tokens ----------
fn check(token: &str) -> Option<Claims> {
    let (_, key) = config();
    let key = key?;
    let t = unb32(token)?;
    if t.len() != 88 || t[0] != 1 {
        return None;
    }
    let sig = ed25519_dalek::Signature::from_slice(&t[24..]).ok()?;
    key.verify_strict(&t[..24], &sig).ok()?;
    let u = |i: usize| u32::from_be_bytes(t[i..i + 4].try_into().unwrap_or([0; 4])) as u64;
    let c = Claims { kind: t[1], machine: t[2..12].try_into().ok()?, issued: u(12), a: u(16), b: u(20) };
    // a token for another PC is no use here
    (c.machine == machine()).then_some(c)
}

// ---------- the saved state, sealed to this PC ----------
fn state_key() -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"dogfile-state-v1|");
    h.update(machine());
    h.update(b"|7c1e94b2d5f0");
    h.finalize().into()
}
fn hmac(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    k[..key.len().min(64)].copy_from_slice(&key[..key.len().min(64)]);
    let mut inner = Sha256::new();
    inner.update(k.map(|b| b ^ 0x36));
    inner.update(msg);
    let mut outer = Sha256::new();
    outer.update(k.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}
fn keystream_xor(key: &[u8; 32], nonce: &[u8], data: &mut [u8]) {
    for (i, chunk) in data.chunks_mut(32).enumerate() {
        let mut h = Sha256::new();
        h.update(key);
        h.update(nonce);
        h.update((i as u64).to_le_bytes());
        let block = h.finalize();
        for (b, k) in chunk.iter_mut().zip(block.iter()) {
            *b ^= k;
        }
    }
}
fn state_file() -> std::path::PathBuf {
    st().data_dir.join("license.dat")
}
fn load() -> Saved {
    load_from(&state_file())
}
fn load_from(file: &std::path::Path) -> Saved {
    let Ok(raw) = std::fs::read(file) else { return Saved::default() };
    if raw.len() < 48 {
        return Saved::default();
    }
    let key = state_key();
    let (nonce, rest) = raw.split_at(16);
    let (body, tag) = rest.split_at(rest.len() - 32);
    let mut signed = nonce.to_vec();
    signed.extend_from_slice(body);
    if hmac(&key, &signed)[..] != tag[..] {
        // edited, or copied from another PC
        return Saved::default();
    }
    let mut plain = body.to_vec();
    keystream_xor(&key, nonce, &mut plain);
    serde_json::from_slice(&plain).unwrap_or_default()
}
fn save(s: &Saved) -> Result<(), String> {
    save_to(&state_file(), s)
}
fn save_to(file: &std::path::Path, s: &Saved) -> Result<(), String> {
    let key = state_key();
    let nonce: [u8; 16] = rand::random();
    let mut body = serde_json::to_vec(s).unwrap_or_default();
    keystream_xor(&key, &nonce, &mut body);
    let mut out = nonce.to_vec();
    out.extend_from_slice(&body);
    let tag = hmac(&key, &out);
    out.extend_from_slice(&tag);
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}
fn with<T>(f: impl FnOnce(&mut Saved) -> T) -> T {
    let mut g = SAVED.lock();
    if g.is_none() {
        *g = Some(load());
    }
    let s = g.as_mut().unwrap();
    let before = serde_json::to_string(s).unwrap_or_default();
    let r = f(s);
    if serde_json::to_string(s).unwrap_or_default() != before {
        *SAVE_ERROR.lock() = save(s).err();
    }
    r
}
fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
/// the time for the trial: never earlier than a time already seen
fn trusted_now(s: &mut Saved) -> u64 {
    let n = now_secs().max(s.last_seen);
    s.last_seen = n;
    n
}

// ---------- status ----------
#[derive(PartialEq, Clone, Copy)]
enum Mode {
    Unconfigured,
    Licensed,
    Trial,
    Expired,
    None,
}
fn mode_of(s: &mut Saved) -> (Mode, u64) {
    if !configured() {
        return (Mode::Unconfigured, 0);
    }
    if s.license.as_deref().and_then(check).is_some_and(|c| c.kind == KIND_LICENSE) {
        return (Mode::Licensed, 0);
    }
    if let Some(c) = s.trial.as_deref().and_then(check).filter(|c| c.kind == KIND_TRIAL) {
        let now = trusted_now(s).max(c.issued);
        if now < c.a && !s.trial_over {
            return (Mode::Trial, c.a);
        }
        s.trial_over = true;
        return (Mode::Expired, c.a);
    }
    (if s.trial_over { Mode::Expired } else { Mode::None }, 0)
}
/// Pro features are allowed: a licence, the trial, or a build without licensing
pub fn pro() -> bool {
    matches!(with(|s| mode_of(s).0), Mode::Licensed | Mode::Trial | Mode::Unconfigured)
}
fn status_json() -> Value {
    with(|s| {
        let (mode, end) = mode_of(s);
        let now = trusted_now(s);
        let m = machine_text();
        json!({
            "mode": match mode { Mode::Unconfigured => "unconfigured", Mode::Licensed => "licensed", Mode::Trial => "trial", Mode::Expired => "expired", Mode::None => "none" },
            "pro": matches!(mode, Mode::Licensed | Mode::Trial | Mode::Unconfigured),
            "trialEnd": end,
            "daysLeft": if mode == Mode::Trial { (end.saturating_sub(now) + 86399) / 86400 } else { 0 },
            "serial": if mode == Mode::Licensed { s.serial.as_deref().map(mask_serial) } else { None },
            "email": if mode == Mode::Licensed { s.email.clone() } else { None },
            "machine": format!("{}-{}-{}-{}", &m[..4], &m[4..8], &m[8..12], &m[12..]),
            "pcName": crate::sys::hostname(),
            "price": "$19.99",
            "lastCheck": s.last_check,
        })
    })
}
fn mask_serial(s: &str) -> String {
    // DOGF-XXXXX-XXXXX-XXXXX-ABCDE → DOGF-•••••-•••••-•••••-ABCDE
    let parts: Vec<&str> = s.split('-').collect();
    parts.iter().enumerate().map(|(i, p)| if i == 0 || i == parts.len() - 1 { p.to_string() } else { "•••••".into() }).collect::<Vec<_>>().join("-")
}
fn changed() {
    events::broadcast("license", status_json());
}

// ---------- talking to the licence server ----------
async fn call(method: &str, route: &str, body: Option<Value>) -> Result<Value, String> {
    let (api, _) = config();
    if api.is_empty() {
        return Err("Licensing isn't set up in this copy of Dogfile".into());
    }
    let url = format!("{api}{route}");
    let req = if method == "GET" { util::http().get(&url) } else { util::http().post(&url).json(&body.unwrap_or(json!({}))) };
    let r = req.timeout(Duration::from_secs(25)).send().await.map_err(|_| "Couldn't reach the Dogfile license server. Check your internet connection and try again.".to_string())?;
    let status = r.status();
    let v: Value = r.json().await.unwrap_or(json!({}));
    if !status.is_success() {
        return Err(v["error"].as_str().unwrap_or("The license server couldn't do that. Try again in a minute.").to_string());
    }
    Ok(v)
}
fn pc_name() -> String {
    crate::sys::hostname()
}

/// license:startTrial: ask the server for this PC's trial (the same dates if it was started before)
pub async fn start_trial(_a: &Args) -> R {
    let v = call("POST", "/trial", Some(json!({ "machine": machine_text(), "version": env!("CARGO_PKG_VERSION") }))).await?;
    let token = v["token"].as_str().ok_or("The license server sent something unexpected")?.to_string();
    check(&token).filter(|c| c.kind == KIND_TRIAL).ok_or("The license server sent a trial for another PC")?;
    let server_now = v["now"].as_u64().unwrap_or(0);
    with(|s| {
        s.trial = Some(token);
        s.last_seen = s.last_seen.max(server_now);
    });
    changed();
    Ok(status_json())
}

fn store_license(token: &str, serial: Option<String>, email: Option<String>) -> Result<(), String> {
    check(token).filter(|c| c.kind == KIND_LICENSE).ok_or("That activation code isn't for this PC. Make sure you used this PC's ID.")?;
    with(|s| {
        s.license = Some(token.to_string());
        if serial.is_some() {
            s.serial = serial;
        }
        if email.is_some() {
            s.email = email;
        }
        s.last_check = now_secs();
    });
    changed();
    // accepted, but not written down: it would vanish when Dogfile closes, so don't say it worked
    if let Some(e) = SAVE_ERROR.lock().clone() {
        return Err(format!("The license was accepted but couldn't be saved on this PC ({e}), so it wouldn't last after you close Dogfile. Check that Dogfile's data folder isn't read-only or locked by another program, then try again."));
    }
    Ok(())
}
/// license:activate {serial}: online activation
pub async fn activate(a: &Args) -> R {
    let serial = a.s(0)?;
    let v = call("POST", "/activate", Some(json!({ "serial": serial, "machine": machine_text(), "name": pc_name() }))).await?;
    let token = v["token"].as_str().ok_or("The license server sent something unexpected")?;
    store_license(token, v["serial"].as_str().map(String::from), v["email"].as_str().map(String::from))?;
    Ok(status_json())
}
/// license:offlineRequest {serial}: what to open on another device
pub fn offline_request(a: &Args) -> R {
    let serial = a.s(0)?;
    let (api, _) = config();
    let clean: String = serial.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_uppercase();
    if clean.len() != 24 && clean.len() != 20 {
        return Err("That doesn't look like a Dogfile serial number (DOGF-XXXXX-XXXXX-XXXXX-XXXXX).".into());
    }
    let name: String = urlencoding::encode(&pc_name()).into_owned();
    Ok(json!({ "url": format!("{api}/offline?k={clean}&m={}&n={name}", machine_text()), "machine": machine_text() }))
}
/// license:offlineApply {code}: the activation code typed in (or the contents of the file)
pub fn offline_apply(a: &Args) -> R {
    let code = a.s(0)?;
    // a pasted file or page may have other text around the code: take the longest run of code characters
    let best = code
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == ' '))
        .map(|p| p.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>())
        .max_by_key(|p| p.len())
        .unwrap_or_default();
    if check(&best).filter(|c| c.kind == KIND_LICENSE).is_none() {
        return Err("That activation code doesn't work on this PC. Check it was made with this PC's ID and typed exactly.".into());
    }
    store_license(&best, None, None)?;
    Ok(status_json())
}
/// license:deactivate: free this PC's place so the licence can be used on another
pub async fn deactivate(_a: &Args) -> R {
    let token = with(|s| s.license.clone()).ok_or("This PC isn't activated")?;
    call("POST", "/deactivate", Some(json!({ "token": token }))).await?;
    with(|s| {
        s.license = None;
        s.serial = None;
        s.email = None;
    });
    changed();
    Ok(status_json())
}
/// license:checkout: the payment page (the app polls license:claim with the session)
pub async fn checkout(_a: &Args) -> R {
    call("POST", "/checkout", Some(json!({ "machine": machine_text() }))).await
}
/// license:claim {session}: once paid, the serial number, activated on this PC straight away
pub async fn claim(a: &Args) -> R {
    let session = a.s(0)?;
    let v = call("GET", &format!("/claim?session={}", urlencoding::encode(&session)), None).await?;
    let Some(serial) = v["serial"].as_str() else { return Ok(json!({ "pending": v["pending"].as_bool().unwrap_or(true), "error": v["error"] })) };
    let st = activate(&Args(vec![json!(serial)])).await?;
    Ok(json!({ "serial": serial, "status": st }))
}
/// a quiet check with the server: refunded or moved licences stop, the trial's clock is corrected
pub async fn refresh(force: bool) -> R {
    let (licence, trial, last) = with(|s| (s.license.clone(), s.trial.clone(), s.last_check));
    if !configured() {
        return Ok(status_json());
    }
    let before = with(|s| mode_of(s).0);
    let r = refresh_inner(force, licence, trial, last).await;
    // the server's answer can end the trial or a licence: tell every window
    if with(|s| mode_of(s).0) != before {
        changed();
    }
    r
}
async fn refresh_inner(force: bool, licence: Option<String>, trial: Option<String>, last: u64) -> R {
    if let Some(token) = licence {
        if force || now_secs().saturating_sub(last) > REVALIDATE_SECS {
            if let Ok(v) = call("POST", "/validate", Some(json!({ "token": token }))).await {
                if v["ok"].as_bool() == Some(true) {
                    let n = v["now"].as_u64().unwrap_or(0);
                    with(|s| {
                        s.last_check = now_secs();
                        s.last_seen = s.last_seen.max(n);
                    });
                } else if matches!(v["reason"].as_str(), Some("revoked" | "deactivated" | "unknown")) {
                    with(|s| {
                        s.license = None;
                        s.serial = None;
                        s.email = None;
                    });
                    changed();
                }
            }
        }
    } else if trial.is_some() {
        // the server's dates and time win
        if let Ok(v) = call("POST", "/trial", Some(json!({ "machine": machine_text(), "version": env!("CARGO_PKG_VERSION") }))).await {
            if let Some(t) = v["token"].as_str().filter(|t| check(t).is_some()) {
                let n = v["now"].as_u64().unwrap_or(0);
                with(|s| {
                    s.trial = Some(t.to_string());
                    s.last_seen = s.last_seen.max(n);
                    s.last_check = now_secs();
                });
            }
        }
    }
    Ok(status_json())
}
pub fn status(_a: &Args) -> R {
    Ok(status_json())
}

/// Checks in the background: with the server soon after start and every few hours, and whether the trial ran out
pub fn start_background() {
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(20)).await;
        let mut was = pro();
        let mut n = 0u64;
        loop {
            if n % 36 == 0 {
                let _ = refresh(false).await;
            }
            let now = pro();
            if now != was {
                was = now;
                changed();
            }
            n += 1;
            tokio::time::sleep(Duration::from_secs(600)).await;
        }
    });
}

/// Calls only Dogfile Pro may make. Background ones (tracking, folder rules) quietly do nothing instead.
pub fn gate(name: &str, a: &Args) -> Option<R> {
    const PRO: &[&str] = &[
        "versions:save", "versions:list", "versions:restore", "versions:remove", "versions:overview",
        "remote:signIn", "remote:get", "remote:put", "remote:mkdir", "remote:rename", "remote:copy", "remote:open", "remote:test",
        "ext:install", "ai:download", "media:export", "media:contactSheet", "llm:plan", "llm:warm",
        "reminders:analyze", "reminders:add", "reminders:scanNow",
        "meta:write", "meta:stripAll",
    ];
    const QUIET: &[&str] = &["versions:track", "rules:watch"];
    let dupes = name == "work:start" && a.v(0)["type"].as_str() == Some("dupes");
    if !(PRO.contains(&name) || QUIET.contains(&name) || dupes) || pro() {
        return None;
    }
    if QUIET.contains(&name) {
        if name == "rules:watch" {
            // stop any folder rules that were running
            let _ = crate::watch::rules_watch("", &Args(vec![json!([])]));
        }
        return Some(Ok(json!(false)));
    }
    Some(Err("PRO_REQUIRED: This is a Dogfile Pro feature".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tmp(label: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("dogfile-license-{label}-{}-{}", std::process::id(), crate::util::now_ms() as u64));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    #[test]
    fn a_failed_save_is_an_error_not_a_success() {
        let d = tmp("fail");
        // a folder sits where the temporary copy has to go: the write can't succeed, and it must say so
        std::fs::create_dir_all(d.join("license.tmp")).unwrap();
        assert!(save_to(&d.join("license.dat"), &Saved::default()).is_err());
        assert!(!d.join("license.dat").exists());
        std::fs::remove_dir_all(&d).ok();
    }
    #[test]
    fn saved_state_round_trips_and_a_changed_file_is_refused() {
        let d = tmp("ok");
        let f = d.join("license.dat");
        let s = Saved { serial: Some("DOGF-TEST".into()), ..Saved::default() };
        save_to(&f, &s).unwrap();
        assert_eq!(load_from(&f).serial.as_deref(), Some("DOGF-TEST"));
        // one changed byte (or a copy from another PC) and the file is not believed
        let mut raw = std::fs::read(&f).unwrap();
        raw[20] ^= 1;
        std::fs::write(&f, raw).unwrap();
        assert_eq!(load_from(&f).serial, None);
        std::fs::remove_dir_all(&d).ok();
    }
}
