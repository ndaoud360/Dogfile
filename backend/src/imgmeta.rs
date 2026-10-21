// Picture details straight from the file header (no decoding): size, date taken, camera, orientation.
use crate::args::{Args, R};
use serde_json::{json, Map, Value};
use std::io::Read;

fn head(p: &str, n: usize) -> Option<Vec<u8>> {
    let mut f = std::fs::File::open(p).ok()?;
    let mut b = vec![0u8; n];
    let mut k = 0;
    while k < n {
        match f.read(&mut b[k..]) {
            Ok(0) | Err(_) => break,
            Ok(m) => k += m,
        }
    }
    b.truncate(k);
    Some(b)
}
fn find(b: &[u8], pat: &[u8]) -> Option<usize> {
    b.windows(pat.len()).position(|w| w == pat)
}

fn tiff(b: &[u8], t: usize, out: &mut Map<String, Value>) {
    if t + 8 > b.len() {
        return;
    }
    let le = b[t] == 0x49;
    let u16_ = |i: usize| -> u32 { if t + i + 2 <= b.len() { let x = [b[t + i], b[t + i + 1]]; (if le { u16::from_le_bytes(x) } else { u16::from_be_bytes(x) }) as u32 } else { 0 } };
    let u32_ = |i: usize| -> u32 { if t + i + 4 <= b.len() { let x = [b[t + i], b[t + i + 1], b[t + i + 2], b[t + i + 3]]; if le { u32::from_le_bytes(x) } else { u32::from_be_bytes(x) } } else { 0 } };
    let ifd = |off: usize, want: &[u32]| -> Map<String, Value> {
        let mut res = Map::new();
        if off == 0 || t + off + 2 > b.len() { return res }
        let n = u16_(off).min(400) as usize;
        for k in 0..n {
            let e = off + 2 + k * 12;
            if t + e + 12 > b.len() { break }
            let (tag, ty, count) = (u16_(e), u16_(e + 2), u32_(e + 4) as usize);
            if !want.contains(&tag) { continue }
            let size = match ty { 3 => 2, 4 | 9 => 4, _ => 1 } * count;
            let vo = if size > 4 { u32_(e + 8) as usize } else { e + 8 };
            let key = tag.to_string();
            match ty {
                2 => {
                    let s = t + vo;
                    let end = (t + vo + count).min(b.len());
                    if s < end {
                        let txt: String = b[s..end].iter().map(|&c| c as char).collect::<String>().trim_end_matches('\0').trim().to_string();
                        res.insert(key, json!(txt));
                    }
                }
                3 => { res.insert(key, json!(u16_(vo))); }
                4 => { res.insert(key, json!(u32_(vo))); }
                _ => {}
            }
        }
        res
    };
    let i0 = ifd(u32_(4) as usize, &[0x010f, 0x0110, 0x0112, 0x0132, 0x8769, 0x0131]);
    let g = |m: &Map<String, Value>, k: u32| m.get(&k.to_string()).cloned();
    let ex = g(&i0, 0x8769).and_then(|v| v.as_u64()).map(|o| ifd(o as usize, &[0x9003, 0x9004, 0xa002, 0xa003])).unwrap_or_default();
    let make = g(&i0, 0x010f).and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    let model = g(&i0, 0x0110).and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    if !make.is_empty() || !model.is_empty() {
        let first = make.to_lowercase().split(' ').next().unwrap_or("").to_string();
        let cam = if !first.is_empty() && model.to_lowercase().starts_with(&first) { model.clone() } else { [make.clone(), model.clone()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" ") };
        out.insert("camera".into(), json!(cam));
    }
    if let Some(o) = g(&i0, 0x0112) { out.insert("orient".into(), o); }
    if let Some(s) = g(&i0, 0x0131) { out.insert("software".into(), s); }
    let d = g(&ex, 0x9003).or(g(&ex, 0x9004)).or(g(&i0, 0x0132)).and_then(|v| v.as_str().map(String::from));
    if let Some(d) = d {
        let nums: Vec<i64> = d.split(|c: char| !c.is_ascii_digit()).filter(|x| !x.is_empty()).filter_map(|x| x.parse().ok()).collect();
        if nums.len() >= 5 && nums[0] > 1900 {
            let days = crate::archive::days_from_civil(nums[0], nums[1], nums[2]);
            let secs = days * 86400 + nums[3] * 3600 + nums[4] * 60 + nums.get(5).copied().unwrap_or(0) - crate::archive::local_offset_secs();
            if secs > 0 { out.insert("taken".into(), json!(secs * 1000)); }
        }
    }
    if !out.contains_key("w") {
        if let Some(w) = g(&ex, 0xa002) {
            out.insert("w".into(), w);
            out.insert("h".into(), g(&ex, 0xa003).unwrap_or(json!(0)));
        }
    }
}

pub fn parse(b: &[u8]) -> Value {
    let mut out = Map::new();
    if b.len() < 24 {
        return Value::Object(out);
    }
    let be16 = |i: usize| if i + 2 <= b.len() { u16::from_be_bytes([b[i], b[i + 1]]) as u64 } else { 0 };
    let le16 = |i: usize| if i + 2 <= b.len() { u16::from_le_bytes([b[i], b[i + 1]]) as u64 } else { 0 };
    let be32 = |i: usize| if i + 4 <= b.len() { u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as u64 } else { 0 };
    let le32 = |i: usize| if i + 4 <= b.len() { u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as u64 } else { 0 };
    if b[0] == 0xff && b[1] == 0xd8 {
        let mut o = 2;
        while o + 9 < b.len() {
            if b[o] != 0xff { o += 1; continue }
            let m = b[o + 1];
            if m == 0xd8 || m == 0x01 || (0xd0..=0xd7).contains(&m) { o += 2; continue }
            let len = be16(o + 2) as usize;
            if m == 0xe1 && &b[o + 4..o + 8] == b"Exif" { tiff(b, o + 10, &mut out) }
            if (0xc0..=0xcf).contains(&m) && m != 0xc4 && m != 0xc8 && m != 0xcc {
                out.insert("h".into(), json!(be16(o + 5)));
                out.insert("w".into(), json!(be16(o + 7)));
                break;
            }
            if m == 0xda { break }
            o += 2 + len;
        }
    } else if be32(0) == 0x89504e47 {
        out.insert("w".into(), json!(be32(16)));
        out.insert("h".into(), json!(be32(20)));
        if let Some(i) = find(b, b"eXIf") { tiff(b, i + 4, &mut out) }
        if find(&b[..b.len().min(4096)], b"Adobe").is_some() { out.insert("software".into(), json!("Adobe")); }
    } else if &b[0..3] == b"GIF" {
        out.insert("w".into(), json!(le16(6)));
        out.insert("h".into(), json!(le16(8)));
    } else if &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        match &b[12..16] {
            b"VP8 " => { out.insert("w".into(), json!(le16(26) & 0x3fff)); out.insert("h".into(), json!(le16(28) & 0x3fff)); }
            b"VP8L" => { let v = le32(21); out.insert("w".into(), json!((v & 0x3fff) + 1)); out.insert("h".into(), json!(((v >> 14) & 0x3fff) + 1)); }
            b"VP8X" => {
                let r24 = |i: usize| (b[i] as u64) | (b[i + 1] as u64) << 8 | (b[i + 2] as u64) << 16;
                out.insert("w".into(), json!(1 + r24(24)));
                out.insert("h".into(), json!(1 + r24(27)));
                if let Some(i) = find(b, b"EXIF") { tiff(b, i + 8 + if b.get(i + 8..i + 12) == Some(b"Exif") { 6 } else { 0 }, &mut out) }
            }
            _ => {}
        }
    } else if &b[0..2] == b"BM" {
        out.insert("w".into(), json!(le32(18) as i32));
        out.insert("h".into(), json!((le32(22) as i32).unsigned_abs()));
    } else if (b[0] == 0x49 && b[1] == 0x49) || (b[0] == 0x4d && b[1] == 0x4d) {
        tiff(b, 0, &mut out);
    } else if &b[4..8] == b"ftyp" {
        if let Some(i) = find(b, b"ispe") { out.insert("w".into(), json!(be32(i + 8))); out.insert("h".into(), json!(be32(i + 12))); }
        if let Some(e) = find(b, b"Exif\0\0") { tiff(b, e + 6, &mut out) }
    }
    if let Some(o) = out.get("orient").and_then(|v| v.as_u64()) {
        if (5..=8).contains(&o) {
            if let (Some(w), Some(h)) = (out.get("w").cloned(), out.get("h").cloned()) {
                out.insert("w".into(), h);
                out.insert("h".into(), w);
            }
        }
    }
    Value::Object(out)
}
pub async fn meta(a: &Args) -> R {
    let paths = a.strs(0);
    tokio::task::spawn_blocking(move || Ok(json!(paths.iter().map(|p| head(p, 131072).map(|b| parse(&b)).unwrap_or(json!({}))).collect::<Vec<_>>()))).await.map_err(|e| e.to_string())?
}
