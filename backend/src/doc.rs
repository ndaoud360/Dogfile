// Text and structure from documents without Office: Word/Writer, Excel/Calc, PowerPoint/Impress (zips of XML),
// PDF (text operators + document info), plain text, Markdown, HTML, RTF. Used by previews, the assistant
// ("rename using contents", "PDFs about taxes") and search. Also writes title / author into Office files and PDFs.
use crate::archive::{zip_entry, zip_names};
use crate::args::{Args, R};
use crate::util;
use regex::Regex;
use serde_json::{json, Value};
use std::io::{Read, Write};

fn re(s: &str) -> Regex {
    Regex::new(s).unwrap()
}
pub fn ents(s: &str) -> String {
    let s = s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'");
    let s = re(r"&#(\d+);").replace_all(&s, |c: &regex::Captures| c[1].parse::<u32>().ok().and_then(char::from_u32).map(String::from).unwrap_or_default()).to_string();
    let s = re(r"(?i)&#x([0-9a-f]+);").replace_all(&s, |c: &regex::Captures| u32::from_str_radix(&c[1], 16).ok().and_then(char::from_u32).map(String::from).unwrap_or_default()).to_string();
    s.replace("&amp;", "&")
}
fn text_of(file: &str, entry: &str) -> Option<String> {
    zip_entry(file, entry, 30 * 1048576).map(|b| String::from_utf8_lossy(&b).into_owned())
}

// ---------- Word / Writer ----------
fn docx_blocks(xml: &str) -> Vec<Value> {
    let tc = re(r"<w:tc[ >][\s\S]*?</w:tc>");
    let tr = re(r"<w:tr[ >][\s\S]*?</w:tr>");
    let wt = re(r"<w:t[^>]*>([^<]*)</w:t>");
    let body = re(r"<w:tbl>[\s\S]*?</w:tbl>").replace_all(xml, |t: &regex::Captures| {
        let rows: Vec<String> = tr.find_iter(&t[0]).map(|r| tc.find_iter(r.as_str()).map(|c| ents(&wt.captures_iter(c.as_str()).map(|x| x[1].to_string()).collect::<String>())).collect::<Vec<_>>().join("\t")).collect();
        format!("<w:p><w:pPr><w:pStyle w:val=\"AtlasTable\"/></w:pPr><w:r><w:t>{}</w:t></w:r></w:p>", rows.join("\n").replace(['<', '&'], " "))
    });
    let para = re(r"<w:p[ >][\s\S]*?</w:p>");
    let style = re(r#"<w:pStyle w:val="([^"]+)""#);
    let runs = re(r"<w:t[^>]*>([^<]*)</w:t>|<w:tab/>|<w:br/>");
    let bold = re(r#"<w:b/>|<w:b w:val="(1|true)""#);
    let h1 = re(r"(?i)heading\s?1|Heading1|berschrift1");
    let h2 = re(r"(?i)heading\s?2|Heading2");
    let h3 = re(r"(?i)heading\s?[3-6]|Heading[3-6]|Subtitle");
    let mut blocks = vec![];
    for m in para.find_iter(&body) {
        let p = m.as_str();
        let st = style.captures(p).map(|c| c[1].to_string()).unwrap_or_default();
        let text = ents(&runs.captures_iter(p).map(|x| if x[0].starts_with("<w:tab") { "\t".to_string() } else if x[0].starts_with("<w:br") { "\n".to_string() } else { x.get(1).map(|g| g.as_str().to_string()).unwrap_or_default() }).collect::<String>());
        let list = p.contains("<w:numPr>");
        let b = bold.is_match(p);
        let kind = if st.eq_ignore_ascii_case("title") || h1.is_match(&st) { "h1" } else if h2.is_match(&st) { "h2" } else if h3.is_match(&st) { "h3" } else if st == "AtlasTable" { "table" } else if list { "li" } else { "p" };
        if !text.trim().is_empty() || kind == "p" {
            blocks.push(json!({ "kind": kind, "text": text, "bold": b }));
        }
    }
    blocks
}
fn odt_blocks(xml: &str) -> Vec<Value> {
    let r = fancy_regex::Regex::new(r"<text:(h|p)([^>]*)>([\s\S]*?)</text:\1>").unwrap();
    let lvl = re(r#"text:outline-level="(\d)""#);
    let sp = re(r#"<text:s(?: text:c="(\d+)")?/>"#);
    let tags = re(r"<[^>]+>");
    let mut out = vec![];
    for c in r.captures_iter(xml).flatten() {
        let inner = c[3].replace("<text:tab/>", "\t").replace("<text:line-break/>", "\n");
        let inner = sp.replace_all(&inner, |m: &regex::Captures| " ".repeat(m.get(1).and_then(|n| n.as_str().parse().ok()).unwrap_or(1))).to_string();
        let text = ents(&tags.replace_all(&inner, ""));
        let l: u32 = lvl.captures(&c[2]).and_then(|m| m[1].parse().ok()).unwrap_or(0);
        let kind = if &c[1] == "h" { if l <= 1 { "h1" } else if l == 2 { "h2" } else { "h3" } } else { "p" };
        out.push(json!({ "kind": kind, "text": text }));
    }
    out
}
// ---------- Excel / Calc ----------
fn xlsx_sheets(file: &str, max_rows: usize) -> Vec<Value> {
    let names = zip_names(file);
    let si = re(r"<si>([\s\S]*?)</si>");
    let t = re(r"<t[^>]*>([^<]*)</t>");
    let shared: Vec<String> = text_of(file, "xl/sharedStrings.xml").map(|ss| si.captures_iter(&ss).map(|m| ents(&t.captures_iter(&m[1]).map(|x| x[1].to_string()).collect::<String>())).collect()).unwrap_or_default();
    let wb = text_of(file, "xl/workbook.xml").unwrap_or_default();
    let titles: Vec<String> = re(r#"<sheet [^>]*name="([^"]+)""#).captures_iter(&wb).map(|m| ents(&m[1])).collect();
    let num = re(r"\d+");
    let mut files: Vec<String> = names.into_iter().filter(|n| re(r"^xl/worksheets/sheet\d+\.xml$").is_match(n)).collect();
    files.sort_by_key(|n| num.find(n).and_then(|m| m.as_str().parse::<u32>().ok()).unwrap_or(0));
    let row = re(r"<row[^>]*>([\s\S]*?)</row>");
    let cell = re(r#"<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>([\s\S]*?)</c>)"#);
    let tt = re(r#"t="(\w+)""#);
    let vv = re(r"<v>([\s\S]*?)</v>");
    let is = re(r"<is>([\s\S]*?)</is>");
    let tags = re(r"<[^>]+>");
    let mut sheets = vec![];
    for (i, f) in files.iter().take(12).enumerate() {
        let x = text_of(file, f).unwrap_or_default();
        let mut rows: Vec<Value> = vec![];
        for r in row.captures_iter(&x) {
            if rows.len() >= max_rows { break }
            let mut cells: Vec<String> = vec![];
            for c in cell.captures_iter(&r[1]) {
                let col = c[1].bytes().fold(0usize, |a, ch| a * 26 + (ch - b'A' + 1) as usize) - 1;
                let ty = tt.captures(&c[2]).map(|m| m[1].to_string()).unwrap_or_default();
                let body = c.get(3).map(|m| m.as_str()).unwrap_or("");
                let v = vv.captures(body).map(|m| m[1].to_string());
                let val = if ty == "s" { v.and_then(|v| v.parse::<usize>().ok()).and_then(|k| shared.get(k).cloned()).unwrap_or_default() } else if ty == "inlineStr" { ents(&tags.replace_all(&is.captures(body).map(|m| m[1].to_string()).unwrap_or_default(), "")) } else { v.map(|v| ents(&v)).unwrap_or_default() };
                if col > 400 { continue }
                while cells.len() < col { cells.push(String::new()) }
                if cells.len() == col { cells.push(val) } else { cells[col] = val }
            }
            cells.truncate(40);
            rows.push(json!(cells));
        }
        sheets.push(json!({ "name": titles.get(i).cloned().unwrap_or(format!("Sheet {}", i + 1)), "rows": rows }));
    }
    sheets
}
fn ods_sheets(xml: &str, max_rows: usize) -> Vec<Value> {
    let table = re(r#"<table:table table:name="([^"]*)"[\s\S]*?</table:table>"#);
    let row = re(r"<table:table-row[^>]*>([\s\S]*?)</table:table-row>");
    let cell = re(r"<table:table-cell([^>]*?)(?:/>|>([\s\S]*?)</table:table-cell>)");
    let rep = re(r#"table:number-columns-repeated="(\d+)""#);
    let tags = re(r"<[^>]+>");
    let mut sheets = vec![];
    for t in table.captures_iter(xml) {
        let mut rows: Vec<Vec<String>> = vec![];
        for r in row.captures_iter(&t[0]) {
            if rows.len() >= max_rows { break }
            let mut cells: Vec<String> = vec![];
            for c in cell.captures_iter(&r[1]) {
                let n: usize = rep.captures(&c[1]).and_then(|m| m[1].parse().ok()).unwrap_or(1).min(40);
                let v = ents(tags.replace_all(&c.get(2).map(|m| m.as_str()).unwrap_or("").replace("</text:p>", "\n"), "").trim());
                for _ in 0..n {
                    if cells.len() < 40 { cells.push(v.clone()) }
                }
            }
            while cells.last().map(|c| c.is_empty()).unwrap_or(false) { cells.pop(); }
            rows.push(cells);
        }
        while rows.last().map(|r| r.is_empty()).unwrap_or(false) { rows.pop(); }
        sheets.push(json!({ "name": ents(&t[1]), "rows": rows }));
    }
    sheets
}
// ---------- PowerPoint / Impress ----------
fn pptx_slides(file: &str) -> Vec<Value> {
    let num = re(r"\d+");
    let mut names: Vec<String> = zip_names(file).into_iter().filter(|n| re(r"^ppt/slides/slide\d+\.xml$").is_match(n)).collect();
    names.sort_by_key(|n| num.find(n).and_then(|m| m.as_str().parse::<u32>().ok()).unwrap_or(0));
    let ap = re(r"<a:p>([\s\S]*?)</a:p>");
    let at = re(r"<a:t>([^<]*)</a:t>");
    let sp = re(r"<p:sp>([\s\S]*?)</p:sp>");
    let tt = re(r#"type="(ctr)?[Tt]itle""#);
    let mut slides = vec![];
    for n in names.iter().take(80) {
        let x = text_of(file, n).unwrap_or_default();
        let paras: Vec<String> = ap.captures_iter(&x).map(|p| ents(&at.captures_iter(&p[1]).map(|t| t[1].to_string()).collect::<String>())).filter(|t| !t.trim().is_empty()).collect();
        let title = sp.captures_iter(&x).find(|s| tt.is_match(&s[1])).map(|s| ents(&at.captures_iter(&s[1]).map(|t| t[1].to_string()).collect::<Vec<_>>().join(" "))).unwrap_or_default();
        let lines: Vec<String> = if !title.is_empty() { paras.iter().filter(|p| **p != title).cloned().collect() } else { paras.iter().skip(1).cloned().collect() };
        slides.push(json!({ "title": if title.is_empty() { paras.first().cloned().unwrap_or_default() } else { title }, "lines": lines }));
    }
    slides
}
fn odp_slides(xml: &str) -> Vec<Value> {
    let page = re(r"<draw:page[^>]*>([\s\S]*?)</draw:page>");
    let t = re(r"<text:(?:p|h|span)[^>]*>([\s\S]*?)</text:(?:p|h|span)>");
    let tags = re(r"<[^>]+>");
    page.captures_iter(xml)
        .map(|p| {
            let paras: Vec<String> = t.captures_iter(&p[1]).map(|x| ents(&tags.replace_all(&x[1], ""))).filter(|s| !s.trim().is_empty()).collect();
            json!({ "title": paras.first().cloned().unwrap_or_default(), "lines": paras.iter().skip(1).collect::<Vec<_>>() })
        })
        .collect()
}
// ---------- PDF ----------
fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}
fn hex_string(h: &str) -> String {
    let h = if h.len() % 2 == 1 { format!("{h}0") } else { h.to_string() };
    let b: Vec<u8> = (0..h.len()).step_by(2).filter_map(|i| u8::from_str_radix(&h[i..i + 2], 16).ok()).collect();
    if b.len() >= 2 && b[0] == 0xfe && b[1] == 0xff {
        let u: Vec<u16> = b[2..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u);
    }
    latin1(&b)
}
fn pdf_string(raw: &str) -> String {
    let r = re(r"\\([nrtbf()\\]|[0-7]{1,3})");
    let s = r.replace_all(raw, |c: &regex::Captures| match &c[1] {
        "n" => "\n".to_string(), "r" => "\r".into(), "t" => "\t".into(), "b" | "f" => String::new(), "(" => "(".into(), ")" => ")".into(), "\\" => "\\".into(),
        o => u32::from_str_radix(o, 8).ok().and_then(char::from_u32).map(String::from).unwrap_or_default(),
    });
    let chars: Vec<u32> = s.chars().map(|c| c as u32).collect();
    if chars.len() >= 2 && chars[0] == 0xfe && chars[1] == 0xff {
        let u: Vec<u16> = chars[2..].chunks_exact(2).map(|c| ((c[0] << 8) | c[1]) as u16).collect();
        return String::from_utf16_lossy(&u);
    }
    s.to_string()
}
fn pdf_info(b: &[u8]) -> Value {
    let s = latin1(b);
    // the last value wins: edits are appended to the end of the file
    let get = |k: &str| -> String {
        let r = re(&format!(r"/{k}\s*\(((?:\\.|[^\\)])*)\)|/{k}\s*<([0-9A-Fa-f]+)>"));
        match r.captures_iter(&s).last() {
            Some(c) => c.get(1).map(|m| pdf_string(m.as_str())).unwrap_or_else(|| hex_string(c.get(2).map(|m| m.as_str()).unwrap_or(""))),
            None => String::new(),
        }
    };
    let pages = re(r"/Type\s*/Page[^s]").find_iter(&s).count();
    json!({ "title": get("Title"), "author": get("Author"), "subject": get("Subject"), "keywords": get("Keywords"), "creator": get("Creator"), "producer": get("Producer"), "pages": pages })
}
fn a85(s: &str) -> Option<Vec<u8>> {
    let s = s.trim_start_matches("<~");
    let s = match s.find("~>") { Some(i) => &s[..i], None => s };
    let s: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    let mut out = vec![];
    let mut i = 0;
    while i < s.len() {
        if s[i] == b'z' { out.extend([0, 0, 0, 0]); i += 1; continue }
        let chunk = &s[i..(i + 5).min(s.len())];
        i += 5;
        let pad = 5 - chunk.len();
        let mut v: u64 = 0;
        for k in 0..5 {
            let ch = *chunk.get(k).unwrap_or(&b'u');
            let c = ch as i64 - 33;
            if !(0..=84).contains(&c) { return None }
            v = v * 85 + c as u64;
        }
        let b = [(v >> 24) as u8, (v >> 16) as u8, (v >> 8) as u8, v as u8];
        out.extend_from_slice(&b[..4 - pad]);
    }
    Some(out)
}
fn inflate(d: &[u8]) -> Option<Vec<u8>> {
    let mut out = vec![];
    if flate2::read::ZlibDecoder::new(d).read_to_end(&mut out).is_ok() && !out.is_empty() {
        return Some(out);
    }
    out.clear();
    if d.len() > 2 && flate2::read::DeflateDecoder::new(&d[2..]).read_to_end(&mut out).is_ok() && !out.is_empty() {
        return Some(out);
    }
    // damaged streams: keep what decoded
    let mut z = flate2::read::ZlibDecoder::new(d);
    let mut buf = [0u8; 65536];
    loop {
        match z.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
        }
    }
    if out.is_empty() { None } else { Some(out) }
}
fn pdf_text(b: &[u8], max: usize) -> String {
    let stream_re = regex::bytes::Regex::new(r"stream\r?\n").unwrap();
    let image = re(r"/Subtype\s*/Image|/Type\s*/XObject[^>]*/Subtype\s*/Image|/FontFile");
    let ops = re(r#"\[((?:\\.|[^\]])*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")|<([0-9A-Fa-f]+)>\s*Tj|(T\*|Td|TD|Tm|ET)"#);
    let inner = re(r"\(((?:\\.|[^\\)])*)\)|(-?\d+(?:\.\d+)?)");
    let mut out = String::new();
    let mut pos = 0usize;
    let mut streams = 0;
    while out.len() < max && streams < 20000 {
        let Some(m) = stream_re.find_at(b, pos) else { break };
        let start = m.end();
        let Some(rel) = memfind(&b[start..], b"endstream") else { break };
        let end = start + rel;
        let dict = latin1(&b[m.start().saturating_sub(300)..m.start()]);
        pos = end + 9;
        if image.is_match(&dict) { continue }
        let mut data: Vec<u8> = b[start..end].to_vec();
        if dict.contains("/ASCII85Decode") || dict.contains("/A85") {
            match a85(&latin1(&data)) { Some(d) => data = d, None => continue }
        }
        if dict.contains("/FlateDecode") || re(r"/Fl\b").is_match(&dict) {
            match inflate(&data) { Some(d) => data = d, None => continue }
        } else if dict.contains("/Filter") && !(dict.contains("/ASCII85Decode") || dict.contains("/A85")) {
            continue;
        }
        streams += 1;
        let t = latin1(&data);
        if !re(r"T[Jj]").is_match(&t) { continue }
        for op in ops.captures_iter(&t) {
            if let Some(m4) = op.get(4) {
                out.push_str(if m4.as_str() == "Td" || m4.as_str() == "TD" { " " } else { "\n" });
                continue;
            }
            if let Some(m3) = op.get(3) {
                out.push_str(&hex_string(m3.as_str()).chars().filter(|c| *c as u32 > 8).collect::<String>());
                continue;
            }
            if let Some(m2) = op.get(2) {
                out.push_str(&pdf_string(m2.as_str()));
                continue;
            }
            if let Some(m1) = op.get(1) {
                for p in inner.captures_iter(m1.as_str()) {
                    if let Some(s) = p.get(1) { out.push_str(&pdf_string(s.as_str())) } else if p.get(2).and_then(|n| n.as_str().parse::<f64>().ok()).unwrap_or(0.0) < -200.0 { out.push(' ') }
                }
            }
        }
        out.push('\n');
    }
    let out: String = out.chars().filter(|c| matches!(*c, '\t' | '\n') || (*c >= ' ' && *c != '\u{7f}' && !(('\u{80}'..'\u{a0}').contains(c)))).collect();
    let out = re(r"[ \t]+").replace_all(&out, " ");
    let out = re(r"\n\s*\n\s*\n+").replace_all(&out, "\n\n");
    out.trim().chars().take(max).collect()
}
fn memfind(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}
fn strip_html(s: &str) -> String {
    let s = re(r"(?is)<(script|style)[\s\S]*?</(script|style)>").replace_all(s, "");
    let s = re(r"(?i)<br\s*/?>|</(p|div|h\d|li|tr)>").replace_all(&s, "\n");
    let s = ents(&re(r"<[^>]+>").replace_all(&s, ""));
    re(r"\n{3,}").replace_all(&s, "\n\n").trim().to_string()
}
fn strip_rtf(s: &str) -> String {
    let s = re(r"\\par[d]?").replace_all(s, "\n");
    let s = re(r"\{\\\*[^}]*\}|\\[a-z]+-?\d* ?|[{}]").replace_all(&s, "");
    re(r"\n{3,}").replace_all(&s, "\n\n").trim().to_string()
}

/// structured document for previews
pub fn read(file: &str, max: usize) -> Result<Value, String> {
    let ext = util::ext(file);
    let md = std::fs::metadata(file).map_err(|e| crate::fsx::friendly(&e))?;
    match ext.as_str() {
        "docx" | "docm" | "dotx" => {
            let x = text_of(file, "word/document.xml").ok_or("Can’t read this document")?;
            let core = text_of(file, "docProps/core.xml").unwrap_or_default();
            let tag = |t: &str| ents(&re(&format!("<{t}[^>]*>([^<]*)</{t}>")).captures(&core).map(|c| c[1].to_string()).unwrap_or_default());
            Ok(json!({ "type": "doc", "blocks": docx_blocks(&x), "props": { "title": tag("dc:title"), "subject": tag("dc:subject"), "author": tag("dc:creator"), "keywords": tag("cp:keywords"), "description": tag("dc:description") } }))
        }
        "odt" | "ott" => {
            let x = text_of(file, "content.xml").ok_or("Can’t read this document")?;
            Ok(json!({ "type": "doc", "blocks": odt_blocks(&x) }))
        }
        "xlsx" | "xlsm" | "xltx" => Ok(json!({ "type": "sheet", "sheets": xlsx_sheets(file, 200) })),
        "ods" => Ok(json!({ "type": "sheet", "sheets": text_of(file, "content.xml").map(|x| ods_sheets(&x, 200)).unwrap_or_default() })),
        "pptx" | "pptm" | "potx" => Ok(json!({ "type": "slides", "slides": pptx_slides(file) })),
        "odp" => Ok(json!({ "type": "slides", "slides": text_of(file, "content.xml").map(|x| odp_slides(&x)).unwrap_or_default() })),
        "pdf" => {
            let buf = std::fs::read(file).map_err(|e| crate::fsx::friendly(&e))?;
            let body = &buf[..buf.len().min(60 * 1048576)];
            let info = if buf.len() > 5 * 1048576 { [&buf[..4 * 1048576], &buf[buf.len() - 1048576..]].concat() } else { buf.clone() };
            Ok(json!({ "type": "text", "text": pdf_text(body, max), "props": pdf_info(&info) }))
        }
        "html" | "htm" | "xhtml" => {
            let s = std::fs::read(file).map_err(|e| e.to_string())?;
            let s = String::from_utf8_lossy(&s[..s.len().min(max * 3)]).into_owned();
            Ok(json!({ "type": "text", "text": strip_html(&s).chars().take(max).collect::<String>() }))
        }
        "rtf" => {
            let s = std::fs::read(file).map_err(|e| e.to_string())?;
            Ok(json!({ "type": "text", "text": strip_rtf(&latin1(&s[..s.len().min(max * 3)])).chars().take(max).collect::<String>() }))
        }
        _ => {
            if md.len() > 50 * 1048576 {
                return Err("Too large".into());
            }
            let mut f = std::fs::File::open(file).map_err(|e| e.to_string())?;
            let mut b = vec![0u8; (md.len() as usize).min(max * 2)];
            let n = f.read(&mut b).unwrap_or(0);
            b.truncate(n);
            let utf16 = b.len() >= 2 && b[0] == 0xff && b[1] == 0xfe;
            if b.contains(&0) && !utf16 {
                return Err("Not a text file".into());
            }
            let text = if utf16 { String::from_utf16_lossy(&b[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>()) } else { String::from_utf8_lossy(&b).into_owned() };
            Ok(json!({ "type": "text", "text": text.chars().take(max).collect::<String>() }))
        }
    }
}
/// plain text of anything above
pub fn text(file: &str, max: usize) -> Result<String, String> {
    let d = read(file, max)?;
    let s = match d["type"].as_str().unwrap_or("") {
        "doc" => d["blocks"].as_array().map(|b| b.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default(),
        "sheet" => d["sheets"].as_array().map(|ss| ss.iter().map(|s| format!("{}\n{}", s["name"].as_str().unwrap_or(""), s["rows"].as_array().map(|r| r.iter().map(|row| row.as_array().map(|c| c.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("\t")).unwrap_or_default()).collect::<Vec<_>>().join("\n")).unwrap_or_default())).collect::<Vec<_>>().join("\n\n")).unwrap_or_default(),
        "slides" => d["slides"].as_array().map(|ss| ss.iter().map(|s| { let mut v = vec![s["title"].as_str().unwrap_or("").to_string()]; v.extend(s["lines"].as_array().map(|l| l.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>()).unwrap_or_default()); v.join("\n") }).collect::<Vec<_>>().join("\n\n")).unwrap_or_default(),
        _ => {
            let t = d["props"]["title"].as_str().filter(|t| !t.is_empty()).map(|t| format!("{t}\n")).unwrap_or_default();
            format!("{t}{}", d["text"].as_str().unwrap_or(""))
        }
    };
    Ok(s.chars().take(max).collect())
}
/// a good title for a file, from what's inside
pub fn title(file: &str) -> String {
    let Ok(d) = read(file, 6000) else { return String::new() };
    let clean = |s: &str| re(r"\s+").replace_all(s, " ").trim().to_string();
    let bad = re(r"(?i)^(untitled|microsoft word|document\d*|slide \d+|page \d+|draft)$");
    let has_letter = re(r"(?i)[a-z]");
    let ok = |s: &str| s.chars().count() >= 3 && s.chars().count() <= 120 && !bad.is_match(s) && has_letter.is_match(s);
    let pt = clean(d["props"]["title"].as_str().unwrap_or(""));
    if ok(&pt) {
        return pt;
    }
    match d["type"].as_str().unwrap_or("") {
        "doc" => {
            let blocks = d["blocks"].as_array().cloned().unwrap_or_default();
            let t = |b: &Value| clean(b["text"].as_str().unwrap_or(""));
            blocks.iter().find(|b| matches!(b["kind"].as_str(), Some("h1") | Some("h2")) && ok(&t(b))).or_else(|| blocks.iter().find(|b| b["bold"].as_bool().unwrap_or(false) && ok(&t(b)))).or_else(|| blocks.iter().find(|b| ok(&t(b)))).map(t).unwrap_or_default()
        }
        "slides" => d["slides"].as_array().and_then(|s| s.iter().map(|x| clean(x["title"].as_str().unwrap_or(""))).find(|t| ok(t))).unwrap_or_default(),
        "sheet" => {
            let s = d["sheets"].get(0).cloned().unwrap_or(Value::Null);
            let name = clean(s["name"].as_str().unwrap_or(""));
            if ok(&name) && !re(r"(?i)^(sheet|tabelle|feuil|hoja|foglio)\s?\d+$").is_match(&name) {
                return name;
            }
            let num = re(r"^[\d.,\-/: ]+$");
            s["rows"].as_array().and_then(|rows| rows.iter().flat_map(|r| r.as_array().cloned().unwrap_or_default()).filter_map(|c| c.as_str().map(clean)).find(|c| ok(c) && !num.is_match(c))).unwrap_or(name)
        }
        _ => {
            let deco = re(r"^#+\s*|^[=*\-_]{3,}$");
            d["text"].as_str().unwrap_or("").lines().map(|l| clean(&deco.replace_all(l, ""))).find(|l| ok(l) && l.split(' ').count() <= 16).unwrap_or_default()
        }
    }
}

pub async fn read_call(a: &Args) -> R {
    let p = a.s(0)?;
    let max = a.r(1)["maxChars"].as_u64().unwrap_or(200000) as usize;
    tokio::task::spawn_blocking(move || read(&p, max)).await.map_err(|e| e.to_string())?
}
pub async fn text_call(a: &Args) -> R {
    let p = a.s(0)?;
    let n = a.u(1, 20000) as usize;
    Ok(json!(tokio::task::spawn_blocking(move || text(&p, n)).await.map_err(|e| e.to_string())??))
}
pub async fn titles_call(a: &Args) -> R {
    let paths = a.strs(0);
    Ok(json!(tokio::task::spawn_blocking(move || paths.iter().take(500).map(|p| title(p)).collect::<Vec<_>>()).await.map_err(|e| e.to_string())?))
}

fn xml_esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}
/// title / subject / author / keywords into an Office document (docProps/core.xml), the rest copied as is
pub fn set_props(file: &str, props: &Value) -> Result<(), String> {
    let mut core = text_of(file, "docProps/core.xml").ok_or("This document has no properties part")?;
    for (tag, key) in [("dc:title", "title"), ("dc:subject", "subject"), ("dc:creator", "author"), ("cp:keywords", "keywords"), ("dc:description", "description")] {
        let Some(v) = props[key].as_str() else { continue };
        let r = re(&format!(r"<{tag}([^>]*)>[^<]*</{tag}>|<{tag}\s*/>"));
        let repl = format!("<{tag}>{}</{tag}>", xml_esc(v));
        if r.is_match(&core) {
            core = r.replace(&core, regex::NoExpand(&repl)).to_string();
        } else {
            core = core.replace("</cp:coreProperties>", &format!("{repl}</cp:coreProperties>"));
        }
    }
    let src = std::fs::File::open(file).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(src).map_err(|e| e.to_string())?;
    let tmp = format!("{file}.dogfile-tmp");
    {
        let out = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut w = zip::ZipWriter::new(out);
        for i in 0..z.len() {
            let e = z.by_index_raw(i).map_err(|e| e.to_string())?;
            if e.name() == "docProps/core.xml" {
                let name = e.name().to_string();
                drop(e);
                w.start_file(name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).map_err(|e| e.to_string())?;
                w.write_all(core.as_bytes()).map_err(|e| e.to_string())?;
            } else {
                w.raw_copy_file(e).map_err(|e| e.to_string())?;
            }
        }
        w.finish().map_err(|e| e.to_string())?;
    }
    crate::util::replace_file(std::path::Path::new(&tmp), std::path::Path::new(file)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        crate::fsx::friendly(&e)
    })
}
/// PDF title / author / subject / keywords as an incremental update appended to the file (the way Acrobat saves)
pub fn pdf_set_info(file: &str, props: &Value) -> Result<(), String> {
    let buf = std::fs::read(file).map_err(|e| e.to_string())?;
    let tail = latin1(&buf[buf.len().saturating_sub(65536)..]);
    let sx = re(r"startxref\s+(\d+)").captures_iter(&tail).last().ok_or("This PDF is damaged or unusual, so its properties can’t be changed here")?;
    let prev: u64 = sx[1].parse().unwrap_or(0);
    let ti = tail.rfind("trailer").ok_or("This PDF is protected or uses a compressed index, so its properties can’t be changed here")?;
    let tr = &tail[ti..];
    if tr.contains("/Encrypt") {
        return Err("This PDF is protected or uses a compressed index, so its properties can’t be changed here".into());
    }
    let size: u64 = re(r"/Size\s+(\d+)").captures(tr).and_then(|c| c[1].parse().ok()).unwrap_or(0);
    let root = re(r"/Root\s+(\d+\s+\d+\s+R)").captures(tr).map(|c| c[1].to_string());
    let (Some(root), true) = (root, size > 0) else { return Err("This PDF’s properties can’t be changed here".into()) };
    let id = re(r"/ID\s*(\[[^\]]*\])").captures(tr).map(|c| c[1].to_string());
    let whole = latin1(&buf);
    let mut keep = String::new();
    if let Some(c) = re(r"/Info\s+(\d+)\s+(\d+)\s+R").captures(tr) {
        let r = re(&format!(r"(?:^|\s){}\s+{}\s+obj\s*<<([\s\S]*?)>>\s*endobj", &c[1], &c[2]));
        if let Some(m) = r.captures_iter(&whole).last() {
            keep = re(r"/(Title|Author|Subject|Keywords|ModDate)\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f]*>)").replace_all(&m[1], "").trim().to_string();
        }
    }
    let enc = |v: &str| {
        let mut h = String::from("<FEFF");
        for u in v.encode_utf16() { h.push_str(&format!("{u:04X}")) }
        h + ">"
    };
    let fields: Vec<String> = [("Title", "title"), ("Author", "author"), ("Subject", "subject"), ("Keywords", "keywords")].iter().filter_map(|(k, key)| props[*key].as_str().filter(|v| !v.is_empty()).map(|v| format!("/{k} {}", enc(v)))).collect();
    let now = crate::fsx::iso_ms(util::now_ms() as i64);
    let d = now.replace(['-', ':', 'T'], "");
    let stamp = &d[..14.min(d.len())];
    let nl = if buf.last() == Some(&b'\n') { "" } else { "\n" };
    let obj_off = buf.len() + nl.len();
    let obj = format!("{size} 0 obj\n<< {keep} {} /ModDate (D:{stamp}Z) >>\nendobj\n", fields.join(" "));
    let xref_off = obj_off + obj.len();
    let xref = format!("xref\n{size} 1\n{:010} 00000 n \ntrailer\n<< /Size {} /Root {root} /Info {size} 0 R /Prev {prev}{} >>\nstartxref\n{xref_off}\n%%EOF\n", obj_off, size + 1, id.map(|i| format!(" /ID {i}")).unwrap_or_default());
    let tmp = format!("{file}.dogfile-tmp");
    let mut out = buf;
    out.extend(format!("{nl}{obj}{xref}").chars().map(|c| c as u8));
    std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
    crate::util::replace_file(std::path::Path::new(&tmp), std::path::Path::new(file)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        crate::fsx::friendly(&e)
    })
}
pub async fn set_props_call(a: &Args) -> R {
    let p = a.s(0)?;
    let props = a.v(1);
    tokio::task::spawn_blocking(move || if util::ext(&p) == "pdf" { pdf_set_info(&p, &props) } else { set_props(&p, &props) }).await.map_err(|e| e.to_string())??;
    Ok(json!(true))
}

/// keywords and title of an Office document or a PDF (for tags kept inside files)
pub fn props_of(file: &str) -> Result<Value, String> {
    if crate::util::ext(file) == "pdf" {
        let b = std::fs::read(file).map_err(|e| e.to_string())?;
        return Ok(pdf_info(&b));
    }
    let core = text_of(file, "docProps/core.xml").ok_or("This document has no properties part")?;
    let tag = |t: &str| re(&format!(r"<{t}[^>]*>([^<]*)</{t}>")).captures(&core).map(|c| c[1].replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"));
    Ok(json!({ "title": tag("dc:title"), "keywords": tag("cp:keywords") }))
}
