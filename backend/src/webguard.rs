// What the web pane may open. Every address goes through `check` before the web view is told to load it, both
// when a person types it and when a page tries to take the view somewhere else.
//
// - Only http and https. Never file:, dogfile:, javascript:, data:, blob:, ms-… and so on, so a page can't reach
//   the person's files, Dogfile's own pages or a program.
// - Not this computer or the home network (localhost, 127.x, 10.x, 192.168.x, link-local, ::1, fc00::/7…) unless
//   the person turned that on, so a page can't poke at the services on their machine or router.
// - No "user@host" tricks: https://bank.com@evil.example opens nothing.
use std::net::{Ipv4Addr, Ipv6Addr};

/// the address to load (trimmed, with the scheme in lower case) or the reason it isn't allowed
pub fn check(url: &str, allow_local: bool) -> Result<String, &'static str> {
    let u = url.trim();
    if u.is_empty() || u.len() > 8192 || u.chars().any(|c| c.is_control() || c.is_whitespace() || c == '\\') {
        return Err("That isn’t a web address");
    }
    let (scheme, rest) = u.split_once("://").ok_or("Only web addresses (http and https) can be opened here")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("Only web addresses (http and https) can be opened here");
    }
    let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
    if auth.is_empty() || auth.contains('@') {
        return Err("That address looks like a trick: it has a name and an @ before the site");
    }
    let host = host_of(auth).ok_or("That isn’t a web address")?;
    if !allow_local && is_local(&host) {
        return Err("Addresses on this computer or your home network are turned off in the web pane");
    }
    Ok(format!("{scheme}://{rest}"))
}

fn host_of(auth: &str) -> Option<String> {
    if let Some(r) = auth.strip_prefix('[') {
        let (h, tail) = r.split_once(']')?;
        if !(tail.is_empty() || (tail.starts_with(':') && tail[1..].chars().all(|c| c.is_ascii_digit()))) {
            return None;
        }
        return Some(format!("[{}]", h.to_ascii_lowercase()));
    }
    let h = match auth.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => h,
        Some(_) => return None,
        None => auth,
    };
    let h = h.trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() { None } else { Some(h) }
}

fn is_local(host: &str) -> bool {
    if let Some(v6) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return match v6.parse::<Ipv6Addr>() {
            Ok(a) => {
                let s = a.segments();
                a.is_loopback() || a.is_unspecified() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80 || a.to_ipv4_mapped().map(|v| is_local_v4(v)).unwrap_or(false)
            }
            Err(_) => true, // can't read it: closed
        };
    }
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") || host.ends_with(".lan") || host.ends_with(".home.arpa") || !host.contains('.') && !host.chars().all(|c| c.is_ascii_digit()) {
        return true; // "printer", "nas": a name with no dot is a machine on the home network
    }
    match number_form(host) {
        Some(v) => is_local_v4(Ipv4Addr::from(v)),
        None => false,
    }
}

/// 127.0.0.1 written as 2130706433, 0x7f000001, 0177.0.0.1 or 127.1 is still 127.0.0.1: read every way a browser does
fn number_form(host: &str) -> Option<u32> {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    let mut nums: Vec<u64> = vec![];
    for p in &parts {
        let n = if let Some(h) = p.strip_prefix("0x").or_else(|| p.strip_prefix("0X")) {
            u64::from_str_radix(if h.is_empty() { "0" } else { h }, 16).ok()?
        } else if p.len() > 1 && p.starts_with('0') && p.chars().all(|c| c.is_digit(8)) {
            u64::from_str_radix(p, 8).ok()?
        } else if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) {
            p.parse::<u64>().ok()?
        } else {
            return None;
        };
        nums.push(n);
    }
    let last = *nums.last()?;
    let lead = &nums[..nums.len() - 1];
    if lead.iter().any(|&n| n > 255) || last >= 256u64.pow((5 - nums.len()) as u32) {
        return None;
    }
    let mut v: u64 = last;
    for (i, &n) in lead.iter().enumerate() {
        v += n << (8 * (3 - i));
    }
    u32::try_from(v).ok()
}

fn is_local_v4(a: Ipv4Addr) -> bool {
    let o = a.octets();
    a.is_loopback() || a.is_private() || a.is_link_local() || a.is_unspecified() || a.is_broadcast() || o[0] == 0 || (o[0] == 100 && (64..128).contains(&o[1])) || o[0] >= 224
}

/// a name for a downloaded file that can't climb out of the folder or be mistaken for another kind of file
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut s: String = base.chars().map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c }).collect();
    s = s.trim().trim_matches('.').to_string();
    // a right-to-left override would make "photo-gpj.exe" read as "photo-exe.jpg"
    s.retain(|c| !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'));
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if s.is_empty() || ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "LPT1", "LPT2", "LPT3"].contains(&stem.as_str()) {
        return "download".into();
    }
    s.chars().take(150).collect()
}

/// programs and scripts: a download of this kind is flagged so it is never run by accident
pub fn risky_file(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    ["exe", "msi", "bat", "cmd", "com", "scr", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "lnk", "dll", "jar", "reg", "cpl", "msc", "pif", "appx", "msix", "iso", "img", "vhd", "docm", "xlsm", "pptm", "url"].contains(&ext.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_web_is_allowed() {
        assert_eq!(check(" https://Example.com/a?b=1#c ", false).unwrap(), "https://Example.com/a?b=1#c");
        assert!(check("HTTP://example.com", false).is_ok());
        for bad in ["file:///C:/Windows/win.ini", "javascript:alert(1)", "data:text/html,hi", "dogfile://x/y", "ftp://example.com", "blob:https://example.com/1", "about:blank", "example.com", "", "https://", "https://exa mple.com", "https://example.com\\evil"] {
            assert!(check(bad, false).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_name_before_an_at_sign_is_a_trick() {
        assert!(check("https://paypal.com@evil.example/login", false).is_err());
        assert!(check("https://user:pw@example.com", false).is_err());
        assert!(check("https://example.com/path@thing", false).is_ok());
    }

    #[test]
    fn this_computer_and_the_home_network_are_closed_unless_allowed() {
        for local in ["http://localhost:3000", "http://app.localhost", "http://127.0.0.1", "http://127.1", "http://2130706433", "http://0x7f000001", "http://0177.0.0.1", "http://10.0.0.5", "http://192.168.1.1/admin", "http://172.16.0.1", "http://172.31.255.255", "http://169.254.169.254/latest", "http://0.0.0.0", "http://[::1]:8080", "http://[fe80::1]", "http://[fd00::1]", "http://[::ffff:127.0.0.1]", "http://printer", "http://router.local", "http://nas.lan", "http://localhost.", "http://100.64.0.1"] {
            assert!(check(local, false).is_err(), "{local}");
            assert!(check(local, true).is_ok(), "{local} (allowed)");
        }
        for public in ["https://example.com", "http://8.8.8.8", "https://172.32.0.1", "https://[2606:4700::1111]", "https://sub.domain.example.co.uk:8443/x", "http://1.1.1.1"] {
            assert!(check(public, false).is_ok(), "{public}");
        }
    }

    #[test]
    fn download_names_are_made_safe() {
        assert_eq!(safe_file_name("..\\..\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(safe_file_name("a/b/c.txt"), "c.txt");
        assert_eq!(safe_file_name("CON.txt"), "download");
        assert_eq!(safe_file_name("photo\u{202e}gpj.exe"), "photogpj.exe");
        assert_eq!(safe_file_name("  ...  "), "download");
        assert_eq!(safe_file_name("na:me?.pdf"), "na_me_.pdf");
        assert!(risky_file("setup.EXE") && risky_file("x.ps1") && risky_file("macro.docm"));
        assert!(!risky_file("photo.jpg") && !risky_file("notes.txt"));
    }
}
