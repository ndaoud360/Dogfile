// Document reminders: Dogfile watches folders you choose (Downloads and Documents to start) for new photos, scans and
// PDFs, reads their text on this PC (PDF text, or Windows' own offline text recognition for photos and scanned
// pages), works out what kind of document it is (passport, driver's licence, insurance, warranty, lease…) and the
// date it expires or is due, and reminds you with a Windows notification a chosen number of days before.
// Nothing leaves the PC. The list is kept encrypted for this Windows user (reminders.json).
use crate::args::{Args, R};
use crate::{events, setting, st, store};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------------------------------------------
// dates without a date library: days since 1970-01-01 (proleptic Gregorian)
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}
fn days_in_month(y: i64, m: i64) -> i64 {
    days_from_civil(if m == 12 { y + 1 } else { y }, if m == 12 { 1 } else { m + 1 }, 1) - days_from_civil(y, m, 1)
}
pub fn iso(day: i64) -> String {
    let (y, m, d) = civil_from_days(day);
    format!("{y:04}-{m:02}-{d:02}")
}
pub fn parse_iso(s: &str) -> Option<i64> {
    let mut it = s.trim().splitn(3, '-').map(|x| x.parse::<i64>().ok());
    let (y, m, d) = (it.next()??, it.next()??, it.next()??);
    valid(y, m, d).then(|| days_from_civil(y, m, d))
}
fn valid(y: i64, m: i64, d: i64) -> bool {
    (1900..=2200).contains(&y) && (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m)
}
/// today in local time (the offset Windows uses now)
pub fn today() -> i64 {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    (secs + local_offset_secs()).div_euclid(86400)
}
fn local_offset_secs() -> i64 {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
        let mut tz = TIME_ZONE_INFORMATION::default();
        let r = GetTimeZoneInformation(&mut tz);
        let bias = tz.Bias + if r == 2 { tz.DaylightBias } else { tz.StandardBias };
        return -(bias as i64) * 60;
    }
    #[allow(unreachable_code)]
    0
}

// ---------------------------------------------------------------------------------------------------------------
// what kind of document, and which date matters

/// (id, label, words that give it away). The first match wins, so the specific ones come first.
const KINDS: &[(&str, &str, &[&str])] = &[
    ("passport", "Passport", &["passport", "passeport", "pasaporte", "reisepass", "passaporto", "p<"]),
    ("license", "Driver's licence", &["driver license", "driver's license", "drivers license", "driver licence", "driving licence", "driving license", "operator license", "permis de conduire", "licencia de conducir", "führerschein"]),
    ("visa", "Visa", &["visa type", "visa no", "entry visa", "visa number", "type of visa", "visa category"]),
    ("id", "ID card", &["identity card", "identification card", "national id", "id card", "residence permit", "permanent resident", "resident card", "green card", "carte d'identité", "documento nacional"]),
    ("card", "Bank card", &["valid thru", "valid through", "good thru", "debit", "credit card", "mastercard", "visa debit", "cardholder"]),
    ("insurance", "Insurance", &["insurance", "policy number", "policy no", "policy period", "insured", "coverage", "premium", "assurance", "seguro"]),
    ("registration", "Vehicle registration", &["vehicle registration", "registration card", "registration certificate", "license plate", "plate number", " vin ", "vin:", "motor vehicle"]),
    ("warranty", "Warranty", &["warranty", "guarantee", "garantie", "garantía"]),
    ("lease", "Lease / contract", &["lease", "rental agreement", "tenancy", "landlord", "tenant", "contract term", "agreement term", "contract"]),
    ("subscription", "Subscription / membership", &["subscription", "membership", "member since", "renews on", "auto-renew", "your plan", "annual plan"]),
    ("certificate", "Certificate", &["certificate", "certification", "certified", "accreditation", "professional license", "license number"]),
    ("prescription", "Prescription", &["prescription", "rx#", "rx #", "refills", "pharmacy"]),
    ("bill", "Bill / invoice", &["invoice", "amount due", "balance due", "payment due", "statement date", "bill date", "total due", "pay by"]),
    ("ticket", "Ticket / booking", &["boarding pass", "booking reference", "reservation", "e-ticket", "itinerary", "check-in"]),
];
/// words right before a date that say "this is when it runs out / is due"
const EXPIRY_WORDS: &[&str] = &[
    "expires", "expire", "expiry", "expiration", "exp date", "exp.", "exp:", "exp ", "valid until", "valid thru", "valid through", "valid to", "good thru", "good through", "good until",
    "renewal date", "renew by", "renews on", "renews", "end date", "ends on", "date of expiry", "date d'expiration", "fecha de vencimiento", "vence", "vencimiento", "gültig bis", "scadenza", "best before",
    "coverage ends", "policy period", "to:", "until", "term ends", "lease ends", "expiring",
];
const DUE_WORDS: &[&str] = &["due date", "payment due", "due on", "due by", "pay by", "amount due by", "please pay by", "due:"];
/// words before a date that say it's not the one that matters
const NOT_WORDS: &[&str] = &["issue", "issued", "date of birth", "birth", "born", "dob", "d.o.b", "signed", "statement date", "invoice date", "order date", "purchase date", "member since", "since", "printed", "from:", "effective", "start date", "starts", "délivrance", "expedición", "nacimiento"];

#[derive(Debug, Clone)]
struct DateHit {
    day: i64,
    at: usize,
    end: usize,
    month_only: bool,
}

fn month_num(s: &str) -> Option<i64> {
    let s = s.to_lowercase();
    const M: &[(&str, i64)] = &[
        ("juin", 6), ("juil", 7), ("jan", 1), ("ene", 1), ("gen", 1), ("feb", 2), ("fév", 2), ("fev", 2), ("mar", 3), ("mär", 3), ("apr", 4), ("avr", 4), ("abr", 4),
        ("may", 5), ("mai", 5), ("mag", 5), ("jun", 6), ("jul", 7), ("lug", 7), ("aug", 8), ("aoû", 8), ("ago", 8), ("sep", 9), ("set", 9),
        ("oct", 10), ("okt", 10), ("ott", 10), ("nov", 11), ("dec", 12), ("déc", 12), ("dic", 12), ("dez", 12),
    ];
    M.iter().find(|(k, _)| s.starts_with(k)).map(|x| x.1)
}
fn year4(y: i64) -> i64 {
    if y < 100 { 2000 + y } else { y }
}

/// every date in the text. `order` decides 03/04/2027: "mdy" (US) or "dmy".
fn find_dates(text: &str, order: &str) -> Vec<DateHit> {
    static RES: OnceLock<[Regex; 6]> = OnceLock::new();
    let mon = r"(jan|feb|fév|fev|mar|mär|apr|avr|abr|may|mai|jun|juin|jul|juil|aug|aoû|sep|sept|oct|okt|nov|dec|déc|dic|dez|ene|ago|set|gen|mag|lug|ott)[a-zéû]*\.?";
    let res = RES.get_or_init(|| {
        [
            // 2027-03-04, 2027/03/04, 2027.03.04
            Regex::new(r"\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b").unwrap(),
            // 03/04/2027, 3-4-27, 03.04.2027
            Regex::new(r"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b").unwrap(),
            // 4 March 2027, 04 MAR 27, 4-Mar-2027
            Regex::new(&format!(r"(?i)\b(\d{{1,2}})(?:st|nd|rd|th)?[\s\-/.]*{mon}[\s\-/.,]*(\d{{4}}|\d{{2}})\b")).unwrap(),
            // March 4, 2027 / Mar 4th 2027
            Regex::new(&format!(r"(?i)\b{mon}\s*(\d{{1,2}})(?:st|nd|rd|th)?,?\s*(\d{{4}})\b")).unwrap(),
            // March 2027
            Regex::new(&format!(r"(?i)\b{mon}[\s,]*(\d{{4}})\b")).unwrap(),
            // 03/27 or 03/2027 (cards): read only next to an expiry word
            Regex::new(r"\b(0?[1-9]|1[0-2])\s*/\s*(\d{4}|\d{2})\b").unwrap(),
        ]
    });
    let mut out: Vec<DateHit> = vec![];
    let taken = |out: &Vec<DateHit>, a: usize, b: usize| out.iter().any(|h| a < h.end && b > h.at);
    for c in res[0].captures_iter(text) {
        let m = c.get(0).unwrap();
        let (y, mo, d) = (c[1].parse().unwrap_or(0), c[2].parse().unwrap_or(0), c[3].parse().unwrap_or(0));
        if valid(y, mo, d) {
            out.push(DateHit { day: days_from_civil(y, mo, d), at: m.start(), end: m.end(), month_only: false });
        }
    }
    for c in res[1].captures_iter(text) {
        let m = c.get(0).unwrap();
        if taken(&out, m.start(), m.end()) {
            continue;
        }
        let (a, b, y): (i64, i64, i64) = (c[1].parse().unwrap_or(0), c[2].parse().unwrap_or(0), year4(c[3].parse().unwrap_or(0)));
        let (mo, d) = if a > 12 { (b, a) } else if b > 12 { (a, b) } else if order == "dmy" { (b, a) } else { (a, b) };
        if valid(y, mo, d) {
            out.push(DateHit { day: days_from_civil(y, mo, d), at: m.start(), end: m.end(), month_only: false });
        }
    }
    for c in res[2].captures_iter(text) {
        let m = c.get(0).unwrap();
        if taken(&out, m.start(), m.end()) {
            continue;
        }
        let (d, mo, y) = (c[1].parse().unwrap_or(0), month_num(&c[2]).unwrap_or(0), year4(c[3].parse().unwrap_or(0)));
        if valid(y, mo, d) {
            out.push(DateHit { day: days_from_civil(y, mo, d), at: m.start(), end: m.end(), month_only: false });
        }
    }
    for c in res[3].captures_iter(text) {
        let m = c.get(0).unwrap();
        if taken(&out, m.start(), m.end()) {
            continue;
        }
        let (mo, d, y) = (month_num(&c[1]).unwrap_or(0), c[2].parse().unwrap_or(0), c[3].parse().unwrap_or(0));
        if valid(y, mo, d) {
            out.push(DateHit { day: days_from_civil(y, mo, d), at: m.start(), end: m.end(), month_only: false });
        }
    }
    for c in res[4].captures_iter(text) {
        let m = c.get(0).unwrap();
        if taken(&out, m.start(), m.end()) {
            continue;
        }
        let (mo, y) = (month_num(&c[1]).unwrap_or(0), c[2].parse().unwrap_or(0));
        if valid(y, mo, 1) {
            // "until March 2027" means the end of March
            out.push(DateHit { day: days_from_civil(y, mo, days_in_month(y, mo)), at: m.start(), end: m.end(), month_only: true });
        }
    }
    for c in res[5].captures_iter(text) {
        let m = c.get(0).unwrap();
        if taken(&out, m.start(), m.end()) {
            continue;
        }
        let (mo, y) = (c[1].parse().unwrap_or(0), year4(c[2].parse().unwrap_or(0)));
        if valid(y, mo, 1) {
            out.push(DateHit { day: days_from_civil(y, mo, days_in_month(y, mo)), at: m.start(), end: m.end(), month_only: true });
        }
    }
    out.sort_by_key(|h| h.at);
    out
}

fn before(text: &str, at: usize, n: usize) -> String {
    let mut s = at.saturating_sub(n);
    while s > 0 && !text.is_char_boundary(s) {
        s -= 1;
    }
    text[s..at].to_lowercase()
}
/// the line around a position, tidied, for showing where a date was found
fn snippet(text: &str, at: usize, end: usize) -> String {
    let ls = text[..at].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let le = text[end..].find('\n').map(|i| end + i).unwrap_or(text.len());
    let mut s = text[ls..le].split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > 120 {
        s = s.chars().take(117).collect::<String>() + "…";
    }
    s
}

/// What a document is and the date that matters, from its text. `today` lets tests pin the date.
pub fn analyze(text: &str, order: &str, today: i64) -> Value {
    let low = format!(" {} ", text.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" "));
    // the kind whose telltale word comes first (titles are at the top); ties go to the more specific kind
    let kind = KINDS.iter().filter_map(|k| k.2.iter().filter_map(|w| low.find(w)).min().map(|at| (at, k))).min_by_key(|x| x.0).map(|x| x.1);
    let (kind_id, kind_label) = kind.map(|k| (k.0, k.1)).unwrap_or(("document", "Document"));
    let dates = find_dates(text, order);
    let near = |h: &DateHit, words: &[&str]| -> Option<usize> {
        let b = before(text, h.at, 48);
        // the closest word wins: "issued 2020 … expires 2030" on one line
        words.iter().filter_map(|w| b.rfind(w).map(|i| b.len() - i)).min()
    };
    // (score, hit, kind)
    let mut best: Option<(i32, DateHit, &str)> = None;
    for h in &dates {
        // card dates (03/27) only count next to an expiry word
        let exp = near(h, EXPIRY_WORDS);
        let due = near(h, DUE_WORDS);
        let not = near(h, NOT_WORDS);
        if h.month_only && exp.is_none() && due.is_none() {
            continue;
        }
        // too far back to matter, or not a real expiry
        if h.day < today - 400 || h.day > today + 365 * 30 {
            continue;
        }
        let mut score = 0;
        let mut what = "expires";
        if let Some(d) = exp {
            score += 100 - d as i32;
        }
        if let Some(d) = due {
            if exp.map(|e| d <= e).unwrap_or(true) {
                score = score.max(100 - d as i32);
                what = "due";
            }
        }
        if let Some(d) = not {
            // a "not" word closer than the expiry word
            if exp.map(|e| d < e).unwrap_or(true) && due.map(|e| d < e).unwrap_or(true) {
                score -= 200;
            }
        }
        if score <= 0 {
            // no clue next to it: only for identity documents, where the latest future date is the expiry
            if score < 0 || !matches!(kind_id, "passport" | "license" | "id" | "visa" | "card" | "registration" | "insurance") || h.day <= today {
                continue;
            }
            score = 1 + (h.day - today).min(365 * 20) as i32 / 365;
        }
        if best.as_ref().map(|b| score > b.0 || score == b.0 && h.day > b.1.day).unwrap_or(true) {
            best = Some((score, h.clone(), what));
        }
    }
    match best {
        Some((score, h, what)) => json!({
            "kind": kind_id, "kindLabel": kind_label, "date": iso(h.day), "what": what,
            "sure": score >= 40, "evidence": snippet(text, h.at, h.end),
        }),
        None => json!({ "kind": kind_id, "kindLabel": kind_label, "date": null }),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// reading the text of a file

const IMAGE_EXT: &[&str] = &["jpg", "jpeg", "png", "heic", "heif", "webp", "tif", "tiff", "bmp", "gif"];
const DOC_EXT: &[&str] = &["pdf", "docx", "odt", "txt", "rtf"];
fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}
fn wanted(p: &Path) -> bool {
    let e = ext_of(p);
    IMAGE_EXT.contains(&e.as_str()) || DOC_EXT.contains(&e.as_str())
}

/// the text in a file: PDF text first, then (Windows) text recognition on photos and scanned pages
pub fn read_text(path: &str) -> Result<String, String> {
    if let Some(t) = test_ocr(path) {
        return Ok(t);
    }
    let p = Path::new(path);
    let e = ext_of(p);
    if DOC_EXT.contains(&e.as_str()) {
        let t = crate::doc::text(path, 200_000).unwrap_or_default();
        // a scan saved as PDF has no text layer: read the pages
        if e == "pdf" && t.split_whitespace().count() < 8 {
            #[cfg(windows)]
            return ocr::pdf(path);
        }
        return Ok(t);
    }
    if IMAGE_EXT.contains(&e.as_str()) {
        #[cfg(windows)]
        return ocr::image(path);
        #[allow(unreachable_code)]
        return Err("Reading text from pictures needs Windows".into());
    }
    Err("not a document".into())
}
/// development builds: DOGFILE_TEST_OCR=<file.json> ({"name.jpg": "text"}) stands in for text recognition
fn test_ocr(path: &str) -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let f = std::env::var("DOGFILE_TEST_OCR").ok()?;
    let m: Value = serde_json::from_str(&std::fs::read_to_string(f).ok()?).ok()?;
    let name = Path::new(path).file_name()?.to_string_lossy().to_string();
    m.get(&name).and_then(|v| v.as_str()).map(String::from)
}

#[cfg(windows)]
mod ocr {
    use windows::core::HSTRING;
    use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{IRandomAccessStream, InMemoryRandomAccessStream};
    use windows::Storage::{FileAccessMode, StorageFile};

    fn engine() -> windows::core::Result<OcrEngine> {
        OcrEngine::TryCreateFromUserProfileLanguages()
    }
    fn recognize(stream: &IRandomAccessStream) -> windows::core::Result<String> {
        let dec = BitmapDecoder::CreateAsync(stream)?.get()?;
        let max = OcrEngine::MaxImageDimension()?;
        let bmp = if dec.PixelWidth()? > max || dec.PixelHeight()? > max {
            // shrink very large photos to what the recogniser takes
            let t = windows::Graphics::Imaging::BitmapTransform::new()?;
            let k = max as f64 / dec.PixelWidth()?.max(dec.PixelHeight()?) as f64;
            t.SetScaledWidth((dec.PixelWidth()? as f64 * k) as u32)?;
            t.SetScaledHeight((dec.PixelHeight()? as f64 * k) as u32)?;
            dec.GetSoftwareBitmapTransformedAsync(BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied, &t, windows::Graphics::Imaging::ExifOrientationMode::RespectExifOrientation, windows::Graphics::Imaging::ColorManagementMode::DoNotColorManage)?.get()?
        } else {
            SoftwareBitmap::ConvertWithAlpha(&dec.GetSoftwareBitmapAsync()?.get()?, BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied)?
        };
        let r = engine()?.RecognizeAsync(&bmp)?.get()?;
        // one line per recognised line, so "Expires" and its date stay together
        let mut out = String::new();
        for l in r.Lines()? {
            out.push_str(&l.Text()?.to_string());
            out.push('\n');
        }
        Ok(out)
    }
    pub fn image(path: &str) -> Result<String, String> {
        (|| -> windows::core::Result<String> {
            let f = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))?.get()?;
            let s = f.OpenAsync(FileAccessMode::Read)?.get()?;
            recognize(&s)
        })()
        .map_err(|e| format!("text recognition: {}", e.message()))
    }
    /// the first pages of a scanned PDF, drawn by Windows and read
    pub fn pdf(path: &str) -> Result<String, String> {
        (|| -> windows::core::Result<String> {
            let f = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))?.get()?;
            let doc = PdfDocument::LoadFromFileAsync(&f)?.get()?;
            let mut out = String::new();
            for i in 0..doc.PageCount()?.min(4) {
                let page = doc.GetPage(i)?;
                let size = page.Size()?;
                let opts = PdfPageRenderOptions::new()?;
                // about 200 dpi: small print reads well
                let w = ((size.Width as f64) * 200.0 / 96.0).min(OcrEngine::MaxImageDimension()? as f64) as u32;
                opts.SetDestinationWidth(w)?;
                let s = InMemoryRandomAccessStream::new()?;
                page.RenderWithOptionsToStreamAsync(&s, &opts)?.get()?;
                s.Seek(0)?;
                let rs: IRandomAccessStream = windows::core::Interface::cast(&s)?;
                out.push_str(&recognize(&rs)?);
                out.push('\n');
            }
            Ok(out)
        })()
        .map_err(|e| format!("text recognition: {}", e.message()))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// the list (encrypted on disk) and its settings

fn cfg() -> Value {
    let c = setting("reminders");
    if c.is_object() { c } else { json!({}) }
}
/// on, and Dogfile Pro (or the trial): background reading stops quietly when Pro ends
pub fn enabled() -> bool {
    cfg()["enabled"].as_bool().unwrap_or(false) && crate::license::pro()
}
/// days before the date to remind (the person's choice; 0 = on the day)
fn intervals() -> Vec<i64> {
    let mut v: Vec<i64> = cfg()["intervals"].as_array().map(|a| a.iter().filter_map(|x| x.as_i64()).collect()).unwrap_or_else(|| vec![60, 25, 10, 5]);
    v.retain(|d| (0..=730).contains(d));
    v.sort_unstable_by(|a, b| b.cmp(a));
    v.dedup();
    v
}
fn folders() -> Vec<PathBuf> {
    let k = crate::sys::known_folders();
    match cfg()["folders"].as_array() {
        Some(a) => a.iter().filter_map(|x| x.as_str()).filter(|s| !s.is_empty()).map(PathBuf::from).collect(),
        None => ["downloads", "documents"].iter().filter_map(|n| k[*n].as_str().map(PathBuf::from)).collect(),
    }
}
fn date_order() -> String {
    cfg()["dateOrder"].as_str().unwrap_or("mdy").to_string()
}

#[derive(Default)]
struct Db {
    /// the reminders: {id, path, name, kind, kindLabel, date, what, sure, evidence, note, added, notified: [days…], dismissed, snoozed, manual}
    items: Vec<Value>,
    /// files already looked at: path -> "mtime:size"
    seen: HashMap<String, String>,
    loaded: bool,
}
fn db() -> &'static Mutex<Db> {
    static D: OnceLock<Mutex<Db>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(Db::default()))
}
fn load(d: &mut Db) {
    if d.loaded {
        return;
    }
    d.loaded = true;
    let Some(v) = store::get("reminders") else { return };
    let plain = crate::secrets::unprotect(v["data"].as_str().unwrap_or(""));
    let Ok(all) = serde_json::from_str::<Value>(&plain) else { return };
    d.items = all["items"].as_array().cloned().unwrap_or_default();
    d.seen = all["seen"].as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect()).unwrap_or_default();
}
fn save(d: &Db) {
    let all = json!({ "items": d.items, "seen": d.seen });
    let _ = store::set("reminders", &json!({ "data": crate::secrets::protect(&all.to_string()) }));
}
fn changed() {
    events::broadcast("reminders:changed", json!(null));
}
fn uid() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("r{:x}", n)
}
fn sig(p: &Path) -> Option<String> {
    let m = std::fs::metadata(p).ok()?;
    let t = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(format!("{t}:{}", m.len()))
}

// ---------------------------------------------------------------------------------------------------------------
// the scanner: a queue of files, read one at a time in the background

struct Scan {
    queue: VecDeque<PathBuf>,
    queued: HashSet<PathBuf>,
    running: bool,
    done: usize,
    found: usize,
    current: Option<String>,
}
fn scan() -> &'static Mutex<Scan> {
    static S: OnceLock<Mutex<Scan>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Scan { queue: VecDeque::new(), queued: HashSet::new(), running: false, done: 0, found: 0, current: None }))
}
fn enqueue(p: PathBuf) {
    if !wanted(&p) {
        return;
    }
    let mut s = scan().lock();
    if s.queued.insert(p.clone()) {
        s.queue.push_back(p);
    }
    if !s.running {
        s.running = true;
        drop(s);
        std::thread::spawn(worker);
    }
}
/// files in the watched folders (a few levels deep; big folders are skipped past a limit)
fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if out.len() > 20_000 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.starts_with('~') || name.eq_ignore_ascii_case("node_modules") || name.eq_ignore_ascii_case("$recycle.bin") {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() && !ft.is_symlink() {
            if depth > 0 {
                walk(&p, depth - 1, out);
            }
        } else if ft.is_file() && wanted(&p) {
            if let Ok(m) = e.metadata() {
                // not tiny icons, not huge files
                if m.len() >= 8 * 1024 && m.len() <= 60 * 1024 * 1024 {
                    out.push(p);
                }
            }
        }
    }
}
fn scan_all() {
    let mut files = vec![];
    for f in folders() {
        walk(&f, 3, &mut files);
    }
    // newest first: they matter most
    files.sort_by_key(|p| std::cmp::Reverse(std::fs::metadata(p).and_then(|m| m.modified()).ok()));
    let seen = {
        let mut d = db().lock();
        load(&mut d);
        d.seen.clone()
    };
    for p in files {
        if seen.get(&p.to_string_lossy().to_string()) != sig(&p).as_ref() {
            enqueue(p);
        }
    }
}
fn worker() {
    lower_priority();
    loop {
        let next = {
            let mut s = scan().lock();
            match s.queue.pop_front() {
                Some(p) => {
                    s.queued.remove(&p);
                    s.current = Some(p.to_string_lossy().to_string());
                    Some(p)
                }
                None => {
                    s.running = false;
                    s.current = None;
                    None
                }
            }
        };
        let Some(p) = next else { break };
        if !enabled() {
            let mut s = scan().lock();
            s.queue.clear();
            s.queued.clear();
            s.running = false;
            break;
        }
        let path = p.to_string_lossy().to_string();
        let Some(sg) = sig(&p) else { continue };
        let text = read_text(&path).unwrap_or_default();
        let a = analyze(&text, &date_order(), today());
        let mut added = false;
        {
            let mut d = db().lock();
            load(&mut d);
            d.seen.insert(path.clone(), sg);
            if a["date"].is_string() && !d.items.iter().any(|x| x["path"].as_str() == Some(&path)) {
                let mut it = a.clone();
                it["id"] = json!(uid());
                it["path"] = json!(path);
                it["name"] = json!(p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
                it["added"] = json!(now_ms());
                it["notified"] = json!([]);
                d.items.push(it);
                added = true;
            }
            save(&d);
        }
        {
            let mut s = scan().lock();
            s.done += 1;
            if added {
                s.found += 1;
            }
        }
        if added {
            changed();
            check();
        }
        // gentle on the PC: a short pause between files
        std::thread::sleep(Duration::from_millis(if cfg!(debug_assertions) { 20 } else { 400 }));
    }
    events::broadcast("reminders:scan", status_json());
}
fn lower_priority() {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN};
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
    }
}
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
fn status_json() -> Value {
    let s = scan().lock();
    json!({ "running": s.running, "queued": s.queue.len(), "done": s.done, "found": s.found, "current": s.current })
}

// ---------------------------------------------------------------------------------------------------------------
// watching the folders for new files

fn watcher() -> &'static Mutex<Option<notify::RecommendedWatcher>> {
    static W: OnceLock<Mutex<Option<notify::RecommendedWatcher>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(None))
}
fn start_watching() {
    use notify::{RecursiveMode, Watcher};
    let mut w = watcher().lock();
    *w = None;
    if !enabled() {
        return;
    }
    let Ok(mut nw) = notify::recommended_watcher(|r: notify::Result<notify::Event>| {
        let Ok(e) = r else { return };
        if !matches!(e.kind, notify::EventKind::Create(_) | notify::EventKind::Modify(_)) {
            return;
        }
        for p in e.paths {
            // wait for downloads and scanners to finish writing
            let p2 = p.clone();
            st().rt.spawn(async move {
                tokio::time::sleep(Duration::from_secs(4)).await;
                if p2.is_file() && sig(&p2).is_some() {
                    let seen = {
                        let mut d = db().lock();
                        load(&mut d);
                        d.seen.get(&p2.to_string_lossy().to_string()).cloned()
                    };
                    if seen != sig(&p2) {
                        enqueue(p2);
                    }
                }
            });
        }
    }) else {
        return;
    };
    for f in folders() {
        let _ = nw.watch(&f, RecursiveMode::Recursive);
    }
    *w = Some(nw);
}

// ---------------------------------------------------------------------------------------------------------------
// reminding

/// days left until a reminder's date (negative once it has passed)
fn days_left(it: &Value) -> Option<i64> {
    Some(parse_iso(it["date"].as_str()?)? - today())
}
/// send what's due now: each chosen interval once, and once on the day / when it has passed
pub fn check() {
    if !enabled() {
        return;
    }
    let ints = intervals();
    let mut due: Vec<(Value, i64)> = vec![];
    {
        let mut d = db().lock();
        load(&mut d);
        let now = now_ms();
        let mut dirty = false;
        for it in d.items.iter_mut() {
            if it["dismissed"].as_bool() == Some(true) {
                continue;
            }
            if it["snoozed"].as_u64().map(|s| s > now).unwrap_or(false) {
                continue;
            }
            let Some(left) = days_left(it) else { continue };
            let notified: Vec<i64> = it["notified"].as_array().map(|a| a.iter().filter_map(|x| x.as_i64()).collect()).unwrap_or_default();
            // the smallest interval reached that hasn't been sent; "0" is the day itself (or after)
            let mut marks: Vec<i64> = ints.iter().copied().filter(|&i| left <= i).collect();
            if left <= 0 {
                marks.push(0);
            }
            let Some(&mark) = marks.iter().min() else { continue };
            if notified.contains(&mark) {
                continue;
            }
            // don't send one for a date long gone that was only just found
            if left < -30 {
                continue;
            }
            let mut n = notified.clone();
            // everything above this mark counts as sent too (no burst of old reminders)
            n.extend(marks.iter().copied());
            n.sort_unstable();
            n.dedup();
            it["notified"] = json!(n);
            if it["snoozed"].is_u64() {
                it["snoozed"] = Value::Null;
            }
            dirty = true;
            due.push((it.clone(), left));
        }
        if dirty {
            save(&d);
        }
    }
    for (it, left) in due {
        notify_one(&it, left);
    }
    if !cfg!(test) {
        changed();
    }
}
fn when_text(left: i64) -> String {
    match left {
        l if l < -1 => format!("{} days ago", -l),
        -1 => "yesterday".into(),
        0 => "today".into(),
        1 => "tomorrow".into(),
        l => format!("in {l} days"),
    }
}
fn notify_one(it: &Value, left: i64) {
    let label = it["kindLabel"].as_str().unwrap_or("Document");
    let verb = if it["what"].as_str() == Some("due") { "is due" } else if left < 0 { "expired" } else { "expires" };
    let title = format!("{label} {verb} {}", when_text(left));
    let (y, m, d) = civil_from_days(parse_iso(it["date"].as_str().unwrap_or("")).unwrap_or(0));
    let body = format!("{} · {}", it["note"].as_str().filter(|s| !s.is_empty()).or(it["name"].as_str()).unwrap_or(""), format_date(y, m, d));
    let id = it["id"].as_str().unwrap_or("").to_string();
    events::broadcast("reminders:due", json!({ "id": id, "title": title, "body": body }));
    #[cfg(windows)]
    toast::show(&title, &body, &id);
}
fn format_date(y: i64, m: i64, d: i64) -> String {
    const M: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!("{} {d}, {y}", M[(m - 1).clamp(0, 11) as usize])
}

/// clicking a notification: show Dogfile with the reminders open
#[cfg_attr(not(windows), allow(dead_code))]
fn open_reminders(id: &str) {
    let h = &st().host;
    let mains = h.main_windows();
    if let Some(w) = mains.first() {
        h.win_control(w, "focus");
        events::emit(w, "reminders:open", json!({ "id": id }));
    } else {
        h.new_window(json!({ "open": "reminders", "reminder": id }));
    }
}

#[cfg(windows)]
mod toast {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    const AUMID: &str = "Dogfile.Dogfile";
    /// Windows shows notifications from programs it knows: register Dogfile's name and icon once (no installer needed)
    fn register() {
        use winreg::enums::HKEY_CURRENT_USER;
        let Ok((k, _)) = winreg::RegKey::predef(HKEY_CURRENT_USER).create_subkey(format!("Software\\Classes\\AppUserModelId\\{AUMID}")) else { return };
        let _ = k.set_value("DisplayName", &"Dogfile");
        let icon = crate::st().data_dir.join("notify-icon.png");
        if !icon.exists() {
            let _ = std::fs::write(&icon, include_bytes!("../../app/icons/128x128.png"));
        }
        let _ = k.set_value("IconUri", &icon.to_string_lossy().to_string());
        let _ = k.set_value("IconBackgroundColor", &"FFFFFFFF");
    }
    fn esc(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
    }
    // notifications are kept alive so a click can still reach Dogfile
    fn alive() -> &'static parking_lot::Mutex<Vec<ToastNotification>> {
        static A: std::sync::OnceLock<parking_lot::Mutex<Vec<ToastNotification>>> = std::sync::OnceLock::new();
        A.get_or_init(|| parking_lot::Mutex::new(vec![]))
    }
    pub fn show(title: &str, body: &str, id: &str) {
        register();
        let xml = format!(
            "<toast launch=\"reminder:{}\" scenario=\"reminder\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><actions><action content=\"Open\" arguments=\"open\"/><action content=\"Dismiss\" arguments=\"dismiss\" activationType=\"system\"/></actions></toast>",
            esc(id), esc(title), esc(body)
        );
        let r = (|| -> windows::core::Result<()> {
            let doc = XmlDocument::new()?;
            doc.LoadXml(&HSTRING::from(xml))?;
            let t = ToastNotification::CreateToastNotification(&doc)?;
            let id2 = id.to_string();
            t.Activated(&TypedEventHandler::new(move |_, _| {
                let id3 = id2.clone();
                crate::st().rt.spawn(async move { super::open_reminders(&id3) });
                Ok(())
            }))?;
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?.Show(&t)?;
            let mut a = alive().lock();
            a.push(t);
            if a.len() > 30 {
                a.remove(0);
            }
            Ok(())
        })();
        if let Err(e) = r {
            eprintln!("notification: {e}");
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// start, and the calls the interface makes

/// at startup (and when the settings change): watch, look through what's new, check dates every hour
pub fn start() {
    static STARTED: OnceLock<()> = OnceLock::new();
    apply();
    if STARTED.set(()).is_ok() {
        st().rt.spawn(async {
            tokio::time::sleep(Duration::from_secs(20)).await;
            loop {
                check();
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        });
    }
}
fn apply() {
    start_watching();
    if enabled() {
        std::thread::spawn(scan_all);
    }
}

/// reminders:list
pub fn list(_a: &Args) -> R {
    let mut d = db().lock();
    load(&mut d);
    let t = today();
    let mut items: Vec<Value> = d
        .items
        .iter()
        .map(|it| {
            let mut v = it.clone();
            v["daysLeft"] = json!(days_left(it));
            v["exists"] = json!(Path::new(it["path"].as_str().unwrap_or("")).exists());
            v
        })
        .collect();
    items.sort_by_key(|v| v["daysLeft"].as_i64().unwrap_or(i64::MAX));
    Ok(json!({ "items": items, "today": iso(t), "scan": status_json(), "enabled": enabled(), "folders": folders().iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(), "intervals": intervals() }))
}
/// reminders:status
pub fn status(_a: &Args) -> R {
    Ok(status_json())
}
/// reminders:apply: the settings changed (on/off, folders, intervals)
pub fn apply_call(_a: &Args) -> R {
    apply();
    check();
    Ok(json!(true))
}
/// reminders:scanNow: look through everything again (files read before are skipped unless they changed)
pub fn scan_now(a: &Args) -> R {
    if a.b(0) {
        // from scratch: forget which files were read
        let mut d = db().lock();
        load(&mut d);
        d.seen.clear();
        save(&d);
    }
    std::thread::spawn(scan_all);
    Ok(status_json())
}
/// reminders:analyze path: what Dogfile finds in one file (for "Remind me about this…")
pub async fn analyze_call(a: &Args) -> R {
    let p = a.s(0)?;
    let order = date_order();
    tokio::task::spawn_blocking(move || {
        let text = read_text(&p)?;
        let mut v = analyze(&text, &order, today());
        v["chars"] = json!(text.chars().count());
        Ok(v)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// reminders:add {path, date, kind, kindLabel, note, what}
pub fn add(a: &Args) -> R {
    let mut v = a.v(0);
    let path = v["path"].as_str().unwrap_or("").to_string();
    if parse_iso(v["date"].as_str().unwrap_or("")).is_none() {
        return Err("Pick a date".into());
    }
    let mut d = db().lock();
    load(&mut d);
    d.items.retain(|x| path.is_empty() || x["path"].as_str() != Some(&path));
    v["id"] = json!(uid());
    if v["name"].as_str().unwrap_or("").is_empty() {
        v["name"] = json!(Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    }
    if v["kindLabel"].as_str().unwrap_or("").is_empty() {
        v["kindLabel"] = json!("Document");
    }
    v["added"] = json!(now_ms());
    v["notified"] = json!([]);
    v["manual"] = json!(true);
    v["sure"] = json!(true);
    let out = v.clone();
    d.items.push(v);
    save(&d);
    drop(d);
    changed();
    check();
    Ok(out)
}
/// reminders:update id {date?, note?, kind?, kindLabel?, what?, dismissed?}
pub fn update(a: &Args) -> R {
    let id = a.s(0)?;
    let patch = a.v(1);
    let mut d = db().lock();
    load(&mut d);
    let Some(it) = d.items.iter_mut().find(|x| x["id"].as_str() == Some(&id)) else { return Err("That reminder is gone".into()) };
    if let Some(o) = patch.as_object() {
        for (k, v) in o {
            if ["date", "note", "kind", "kindLabel", "what", "dismissed"].contains(&k.as_str()) {
                if k == "date" && parse_iso(v.as_str().unwrap_or("")).is_none() {
                    return Err("That isn't a date".into());
                }
                it[k] = v.clone();
            }
        }
        // a new date starts the reminders again
        if o.contains_key("date") {
            it["notified"] = json!([]);
            it["sure"] = json!(true);
        }
    }
    let out = it.clone();
    save(&d);
    drop(d);
    changed();
    check();
    Ok(out)
}
/// reminders:snooze id days
pub fn snooze(a: &Args) -> R {
    let id = a.s(0)?;
    let days = a.f(1, 1.0).max(0.0);
    let mut d = db().lock();
    load(&mut d);
    let Some(it) = d.items.iter_mut().find(|x| x["id"].as_str() == Some(&id)) else { return Err("That reminder is gone".into()) };
    it["snoozed"] = json!(now_ms() + (days * 86_400_000.0) as u64);
    // the current mark comes again after the snooze
    if let Some(left) = days_left(it) {
        let n: Vec<i64> = it["notified"].as_array().map(|a| a.iter().filter_map(|x| x.as_i64()).filter(|&x| x > left.max(0)).collect()).unwrap_or_default();
        it["notified"] = json!(n);
    }
    save(&d);
    drop(d);
    changed();
    Ok(json!(true))
}
/// reminders:remove id: and don't find this file again
pub fn remove(a: &Args) -> R {
    let id = a.s(0)?;
    let mut d = db().lock();
    load(&mut d);
    d.items.retain(|x| x["id"].as_str() != Some(&id));
    save(&d);
    drop(d);
    changed();
    Ok(json!(true))
}
/// reminders:test: a sample notification, to see how they look
pub fn test(_a: &Args) -> R {
    let it = json!({ "id": "test", "kindLabel": "Passport", "what": "expires", "name": "This is how reminders look", "date": iso(today() + 25) });
    notify_one(&it, 25);
    Ok(json!(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn d(s: &str) -> i64 {
        parse_iso(s).unwrap()
    }
    #[test]
    fn calendar() {
        for day in [-1000, 0, 1, 365, 19000, 20000, 25000] {
            let (y, m, dd) = civil_from_days(day);
            assert_eq!(days_from_civil(y, m, dd), day);
        }
        assert_eq!(iso(days_from_civil(2028, 2, 29)), "2028-02-29");
        assert!(parse_iso("2027-02-29").is_none());
    }
    #[test]
    fn passport() {
        let t = "UNITED STATES OF AMERICA\nPASSPORT\nDate of birth 14 Feb 1985\nDate of issue 03 Mar 2019\nDate of expiration 02 Mar 2029\n";
        let a = analyze(t, "mdy", d("2026-10-23"));
        assert_eq!(a["kind"], "passport");
        assert_eq!(a["date"], "2029-03-02");
        assert_eq!(a["sure"], true);
    }
    #[test]
    fn licence_us_order() {
        let t = "DRIVER LICENSE\nDOB 07/04/1990\nISS 05/01/2022\nEXP 07/04/2030\n";
        let a = analyze(t, "mdy", d("2026-10-23"));
        assert_eq!(a["kind"], "license");
        assert_eq!(a["date"], "2030-07-04");
    }
    #[test]
    fn day_first() {
        let a = analyze("Insurance policy\nValid until 03/04/2027", "dmy", d("2026-10-23"));
        assert_eq!(a["date"], "2027-04-03");
        assert_eq!(a["kind"], "insurance");
    }
    #[test]
    fn card_month_year() {
        let a = analyze("1234 5678 9012 3456\nVALID THRU 08/28\nJOHN DOE", "mdy", d("2026-10-23"));
        assert_eq!(a["kind"], "card");
        assert_eq!(a["date"], "2028-08-31");
    }
    #[test]
    fn bill_due() {
        let a = analyze("Invoice #1234\nInvoice date: October 1, 2026\nAmount due $120.00\nPayment due: November 15, 2026", "mdy", d("2026-10-23"));
        assert_eq!(a["kind"], "bill");
        assert_eq!(a["what"], "due");
        assert_eq!(a["date"], "2026-11-15");
    }
    #[test]
    fn warranty_month() {
        let a = analyze("Warranty card\nPurchased 12 Jan 2025. Coverage ends January 2027.", "mdy", d("2026-10-23"));
        assert_eq!(a["kind"], "warranty");
        assert_eq!(a["date"], "2027-01-31");
    }
    #[test]
    fn nothing() {
        let a = analyze("Meeting notes from 10/02/2026. Lunch was good.", "mdy", d("2026-10-23"));
        assert!(a["date"].is_null());
    }
    #[test]
    fn iso_and_text() {
        let a = analyze("Membership renews on 2027-01-15", "mdy", d("2026-10-23"));
        assert_eq!(a["kind"], "subscription");
        assert_eq!(a["date"], "2027-01-15");
    }
}
