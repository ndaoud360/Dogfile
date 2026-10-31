// Summarize (the button in Dogfile Office for Word, Excel, PowerPoint and PDF files): a short summary of a document
// as a Dogfile Notepad note. Free, and everything happens on this PC: the assistant's model writes it when it's
// downloaded; otherwise (or if the model fails) the most telling sentences are picked from the document itself.
use crate::args::{Args, R};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

fn re(s: &str) -> Regex {
    Regex::new(s).expect("regex")
}
fn rx(cell: &'static OnceLock<Regex>, s: &str) -> &'static Regex {
    cell.get_or_init(|| re(s))
}

const STOP: &[&str] = &[
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was", "one", "our", "out", "has", "have", "his", "how", "its", "may", "new", "now", "old", "see", "two", "way", "who", "did", "get", "got", "let", "say", "she", "too", "use", "that", "with", "this", "from", "they", "will", "would", "there", "their", "what", "about", "which", "when", "make", "like", "time", "just", "him", "know", "take", "into", "year", "your", "some", "could", "them", "than", "then", "look", "only", "come", "over", "think", "also", "back", "after", "work", "first", "well", "even", "want", "because", "these", "give", "most", "were", "been", "being", "more", "such", "here", "each", "other", "should", "very", "upon", "must", "does", "per", "page", "shall", "those", "where", "while", "within", "without", "between", "under", "above", "below", "again", "once", "both", "same", "own", "off", "yes", "via", "etc",
];

/// sentences of running text: wrapped lines (PDFs break every line) are joined, short lines without an ending are
/// headings and kept apart
fn sentences(text: &str) -> Vec<String> {
    static SPLIT: OnceLock<Regex> = OnceLock::new();
    let split = rx(&SPLIT, r#"([.!?]["”’)]?)\s+([A-Z0-9“"(])"#);
    let mut paras: Vec<String> = vec![];
    let mut cur = String::new();
    for line in text.lines() {
        let l = line.trim().trim_start_matches(['•', '·', '-', '*', '–']).trim();
        if l.is_empty() {
            if !cur.is_empty() {
                paras.push(std::mem::take(&mut cur));
            }
            continue;
        }
        // a heading: short, no ending, and Title Case or CAPITALS (a wrapped line of a sentence is mostly lower case)
        let ws: Vec<&str> = l.split_whitespace().collect();
        let caps = ws.iter().filter(|w| w.chars().next().is_some_and(|c| c.is_uppercase() || c.is_ascii_digit())).count();
        let heading = l.len() < 70 && !l.ends_with(['.', ',', ';', ':', '!', '?']) && ws.len() <= 8 && caps * 3 >= ws.len() * 2;
        if heading {
            if !cur.is_empty() {
                paras.push(std::mem::take(&mut cur));
            }
            continue;
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(l);
        if l.ends_with(['.', '!', '?']) && l.len() < 60 {
            paras.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        paras.push(cur);
    }
    let mut out = vec![];
    for p in paras {
        let marked = split.replace_all(&p, "$1\u{1}$2");
        for s in marked.split('\u{1}') {
            let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
            if !s.is_empty() {
                out.push(s);
            }
        }
    }
    out
}

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric() && c != '\'')
        .map(|w| w.trim_matches('\'').to_lowercase())
        .filter(|w| w.chars().count() > 2 && !STOP.contains(&w.as_str()) && !w.chars().all(|c| c.is_ascii_digit()))
        .collect()
}

/// the `n` most telling sentences, in the order they appear: sentences full of the document's frequent words, early
/// ones a little ahead, near-repeats dropped
pub fn extract(text: &str, n: usize) -> Vec<String> {
    let sents = sentences(text);
    let mut freq: HashMap<String, f64> = HashMap::new();
    for s in &sents {
        for w in words(s) {
            *freq.entry(w).or_default() += 1.0;
        }
    }
    let top = freq.values().cloned().fold(1.0, f64::max);
    let total = sents.len().max(1) as f64;
    let mut scored: Vec<(usize, f64, HashSet<String>)> = sents
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            let n_words = s.split_whitespace().count();
            if !(6..=60).contains(&n_words) {
                return None;
            }
            let ws = words(s);
            if ws.len() < 3 {
                return None;
            }
            let set: HashSet<String> = ws.iter().cloned().collect();
            let score = set.iter().map(|w| freq[w] / top).sum::<f64>() / (ws.len() as f64).sqrt();
            let early = 1.0 + 0.25 * (1.0 - (i as f64 / total)).powi(3);
            // dates and amounts are usually what the reader came for (a due date, a price)
            let (d, m) = facts(s);
            let concrete = 1.0 + 0.3 * (d.len() + m.len()).min(2) as f64;
            Some((i, score * early * concrete, set))
        })
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut picked: Vec<(usize, HashSet<String>)> = vec![];
    for (i, _, set) in scored {
        if picked.len() >= n {
            break;
        }
        let dup = picked.iter().any(|(_, p)| set.intersection(p).count() as f64 / set.union(p).count().max(1) as f64 > 0.5);
        if !dup {
            picked.push((i, set));
        }
    }
    picked.sort_by_key(|p| p.0);
    picked.into_iter().map(|(i, _)| sents[i].clone()).collect()
}

/// dates and amounts of money the document mentions (a bill's due date, a contract's price…)
pub fn facts(text: &str) -> (Vec<String>, Vec<String>) {
    static DATE: OnceLock<Regex> = OnceLock::new();
    static MONEY: OnceLock<Regex> = OnceLock::new();
    let date = rx(&DATE, r"(?i)\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{4})\b");
    let money = rx(&MONEY, r"(?:[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|CAD|AUD|dollars|euros)\b)");
    let uniq = |it: Vec<String>, max: usize| {
        let mut seen = HashSet::new();
        it.into_iter().filter(|x| seen.insert(x.to_lowercase())).take(max).collect::<Vec<_>>()
    };
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (uniq(date.find_iter(&flat).map(|m| m.as_str().to_string()).collect(), 6), uniq(money.find_iter(&flat).map(|m| m.as_str().to_string()).collect(), 6))
}

/// a spreadsheet: each sheet's size, its column headings and the totals of number columns
fn sheet_summary(d: &Value) -> Vec<String> {
    let mut out = vec![];
    for sh in d["sheets"].as_array().into_iter().flatten().take(8) {
        let rows: Vec<Vec<String>> = sh["rows"].as_array().into_iter().flatten().map(|r| r.as_array().into_iter().flatten().map(|c| c.as_str().map(String::from).unwrap_or_else(|| if c.is_null() { String::new() } else { c.to_string() })).collect()).filter(|r: &Vec<String>| r.iter().any(|c| !c.trim().is_empty())).collect();
        let name = sh["name"].as_str().unwrap_or("Sheet");
        if rows.is_empty() {
            out.push(format!("**{name}** is empty."));
            continue;
        }
        let head = &rows[0];
        let cols: Vec<&str> = head.iter().map(|c| c.trim()).filter(|c| !c.is_empty()).collect();
        let mut line = format!("**{name}**: {} row{}", rows.len() - 1, if rows.len() == 2 { "" } else { "s" });
        if !cols.is_empty() {
            line.push_str(&format!(", columns {}", cols.iter().take(10).map(|c| format!("“{c}”")).collect::<Vec<_>>().join(", ")));
        }
        line.push('.');
        let num = |s: &str| s.replace([',', '$', '€', '£', ' '], "").parse::<f64>().ok();
        let mut totals = vec![];
        for (ci, h) in head.iter().enumerate() {
            let vals: Vec<f64> = rows[1..].iter().filter_map(|r| r.get(ci).and_then(|c| num(c))).collect();
            if !h.trim().is_empty() && vals.len() >= 2 && vals.len() * 2 >= rows.len() - 1 {
                let t: f64 = vals.iter().sum();
                let fmt = if t.fract().abs() < 1e-9 { format!("{t:.0}") } else { format!("{t:.2}") };
                totals.push(format!("{} totals {}", h.trim(), fmt));
            }
        }
        if !totals.is_empty() {
            line.push_str(&format!(" {}.", totals.into_iter().take(5).collect::<Vec<_>>().join("; ")));
        }
        out.push(line);
    }
    out
}

fn today() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| (d.as_secs() as i64 + crate::archive::local_offset_secs()).div_euclid(86400)).unwrap_or(0);
    let (y, m, dd) = civil(d);
    const M: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!("{} {dd}, {y}", M[(m - 1) as usize])
}
fn civil(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// what the model reads: the whole text when it's short, else the best sentences up to about 1,500 words
fn model_input(text: &str) -> String {
    const MAX: usize = 7000;
    if text.len() <= MAX {
        return text.to_string();
    }
    let mut s = String::new();
    for x in extract(text, 80) {
        if s.len() + x.len() > MAX {
            break;
        }
        s.push_str(&x);
        s.push('\n');
    }
    if s.len() < 500 {
        s = text.chars().take(MAX).collect();
    }
    s
}
fn clean_bullets(t: &str) -> Vec<String> {
    t.lines()
        .map(|l| l.trim().trim_start_matches(['-', '*', '•']).trim())
        .map(|l| l.trim_start_matches(|c: char| c.is_ascii_digit()).trim_start_matches(['.', ')']).trim())
        .filter(|l| l.len() > 3)
        .map(|l| l.replace("**", ""))
        .take(8)
        .collect()
}

/// a screenplay: its scenes (INT. / EXT. headings), who speaks most and where it happens most
pub struct Script {
    pub scenes: usize,
    pub characters: Vec<(String, usize)>,
    pub places: Vec<(String, usize)>,
}
pub fn screenplay(text: &str) -> Option<Script> {
    static SLUG: OnceLock<Regex> = OnceLock::new();
    static CUE: OnceLock<Regex> = OnceLock::new();
    let slug = rx(&SLUG, r"^\s*(?:\d+[A-Z]?\.?\s+)?(?:INT\.?\s*/\s*EXT|EXT\.?\s*/\s*INT|I\s*/\s*E|INT|EXT)[.\s]\s*(.+?)\s*$");
    let cue = rx(&CUE, r"^\s*([A-Z][A-Z0-9 .'’\-]{1,28}?[A-Z0-9.])\s*(?:\((?:[A-Z.'’ ]{1,12})\)\s*)*(?:\^)?\s*$");
    let mut scenes = 0;
    let mut places: HashMap<String, usize> = HashMap::new();
    let mut who: HashMap<String, usize> = HashMap::new();
    let lines: Vec<&str> = text.lines().collect();
    for (i, l) in lines.iter().enumerate() {
        if let Some(c) = slug.captures(l) {
            scenes += 1;
            // "KITCHEN - NIGHT 12" -> "Kitchen"
            let place = c[1].split(" - ").next().unwrap_or("").split(" -- ").next().unwrap_or("").trim_end_matches(|ch: char| ch.is_ascii_digit() || ch == ' ' || ch == '.').trim().to_string();
            if !place.is_empty() && place.len() < 60 {
                *places.entry(title_case(&place)).or_default() += 1;
            }
            continue;
        }
        let Some(c) = cue.captures(l) else { continue };
        let name = c[1].trim().trim_end_matches('.').to_string();
        let words = name.split_whitespace().count();
        let bad = ["CUT TO", "FADE IN", "FADE OUT", "THE END", "CONTINUED", "DISSOLVE TO", "SMASH CUT", "MORE", "BACK TO", "LATER", "INTERCUT", "TITLE", "SUPER", "MONTAGE", "END OF", "FLASHBACK", "CONT'D", "CONT’D", "OMITTED"];
        if words == 0 || words > 3 || name.chars().any(|c| c.is_ascii_lowercase()) || bad.iter().any(|b| name.starts_with(b)) {
            continue;
        }
        // a speaker's name is followed by what they say
        let next = lines[i + 1..].iter().map(|x| x.trim()).find(|x| !x.is_empty()).unwrap_or("");
        if next.chars().any(|c| c.is_ascii_lowercase()) || next.starts_with('(') {
            *who.entry(name).or_default() += 1;
        }
    }
    if scenes < 5 {
        return None;
    }
    let top = |m: HashMap<String, usize>, n: usize, min: usize| {
        let mut v: Vec<(String, usize)> = m.into_iter().filter(|x| x.1 >= min).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        v.truncate(n);
        v
    };
    let characters = top(who, 8, 3).into_iter().map(|(n, c)| (title_case(&n), c)).collect();
    Some(Script { scenes, characters, places: top(places, 6, 1) })
}
fn title_case(s: &str) -> String {
    s.split_whitespace().map(|w| { let low = w.to_lowercase(); let mut c = low.chars(); match c.next() { Some(f) => f.to_uppercase().collect::<String>() + c.as_str(), None => String::new() } }).collect::<Vec<_>>().join(" ")
}

/// doc:summarize {path, text?, name?}: { markdown, name, engine }
pub async fn summarize_call(a: &Args) -> R {
    let o = a.v(0);
    let path = o["path"].as_str().unwrap_or("").to_string();
    let name = o["name"].as_str().map(String::from).unwrap_or_else(|| crate::util::basename(&path));
    let ext = crate::util::ext(&path);
    let sheet = matches!(ext.as_str(), "xlsx" | "xlsm" | "xltx" | "ods" | "xls" | "csv");
    let p2 = path.clone();
    let fast = o["fast"].as_bool() == Some(true);
    let given = o["text"].as_str().filter(|t| t.trim().len() > 20).map(String::from);
    let (text, sheet_lines, slide_titles) = tokio::task::spawn_blocking(move || -> Result<(String, Vec<String>, Vec<String>), String> {
        let mut lines = vec![];
        let mut titles = vec![];
        if sheet && !p2.is_empty() {
            if let Ok(d) = crate::doc::read(&p2, 400_000) {
                lines = sheet_summary(&d);
            }
        }
        if matches!(crate::util::ext(&p2).as_str(), "pptx" | "pptm" | "potx" | "odp") {
            if let Ok(d) = crate::doc::read(&p2, 400_000) {
                titles = d["slides"].as_array().into_iter().flatten().filter_map(|s| s["title"].as_str()).map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).take(15).collect();
            }
        }
        // the text the app sent (what's on screen); if that's next to nothing, what Dogfile can read from the file
        let from_file = || if p2.is_empty() { String::new() } else { crate::doc::text(&p2, 600_000).unwrap_or_default() };
        let text = match given {
            Some(t) if t.trim().len() >= 200 => t,
            Some(t) => { let f = from_file(); if f.trim().len() > t.trim().len() { f } else { t } }
            None => from_file(),
        };
        Ok((text, lines, titles))
    })
    .await
    .map_err(|e| e.to_string())??;
    if text.trim().len() < 40 && sheet_lines.is_empty() {
        return Err("There isn’t enough text in this document to summarize. (A scanned PDF needs its text recognized first: Tools > Text from images.)".into());
    }
    let words = text.split_whitespace().count();
    let (dates, money) = facts(&text);
    let script = screenplay(&text);

    // the model writes it when it's on this PC; otherwise (or if it fails) the document's own best sentences
    let mut engine = "extract";
    let mut points: Vec<String> = vec![];
    if !sheet && words >= 60 && !fast && crate::llm::model_ready() {
        let prompt = crate::llm::free_prompt(
            "You summarize documents for the person who owns them. Write 3 to 6 short bullet points in plain English, one per line, each starting with \"- \". Use only facts from the document: names, dates, amounts and what the person needs to do. No introduction, no closing line.",
            &format!("{} “{name}”:\n\n{}\n\nSummarize it.", if script.is_some() { "Screenplay" } else { "Document" }, model_input(&text)),
        );
        if let Ok(t) = crate::llm::complete(prompt, 380).await {
            let b = clean_bullets(&t);
            if b.len() >= 2 {
                points = b;
                engine = "model";
            }
        }
    }
    if points.is_empty() && !sheet {
        let n = if words < 300 { 3 } else if words < 1500 { 5 } else { 7 };
        points = extract(&text, n);
    }

    let mut md = format!("# Summary of {name}\n\n");
    if let Some(sc) = &script {
        md.push_str(&format!("**Screenplay**, {} scene{}.  \n", sc.scenes, if sc.scenes == 1 { "" } else { "s" }));
        if !sc.characters.is_empty() {
            md.push_str(&format!("**Main characters:** {}  \n", sc.characters.iter().map(|(n, c)| format!("{n} ({c})")).collect::<Vec<_>>().join(", ")));
        }
        if !sc.places.is_empty() {
            md.push_str(&format!("**Main places:** {}  \n", sc.places.iter().map(|(n, c)| if *c > 1 { format!("{n} ({c})") } else { n.clone() }).collect::<Vec<_>>().join(", ")));
        }
        md.push('\n');
    }
    if !slide_titles.is_empty() {
        md.push_str(&format!("{} slides: {}.\n\n", slide_titles.len(), slide_titles.join(" · ")));
    }
    for l in &sheet_lines {
        md.push_str(&format!("- {l}\n"));
    }
    for p in &points {
        md.push_str(&format!("- {p}\n"));
    }
    if points.is_empty() && sheet_lines.is_empty() {
        md.push_str("- No clear sentences to pick out. The dates and amounts below may still help.\n");
    }
    if !dates.is_empty() || !money.is_empty() {
        md.push('\n');
        if !dates.is_empty() {
            md.push_str(&format!("**Dates:** {}  \n", dates.join(" · ")));
        }
        if !money.is_empty() {
            md.push_str(&format!("**Amounts:** {}  \n", money.join(" · ")));
        }
    }
    let how = if engine == "model" { "Written by the assistant's model on this PC." } else { "Key sentences picked on this PC." };
    md.push_str(&format!("\n---\nFrom “{name}” ({words} words) on {}. {how}\n", today()));
    Ok(json!({ "markdown": md, "name": format!("Summary of {}.md", name.rsplit_once('.').map(|x| x.0).unwrap_or(&name)), "engine": engine, "words": words }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn picks_telling_sentences_in_order() {
        let t = "Car Loan Statement\nRiverside Auto Finance\nThis statement covers your auto loan for the\nmonth of October 2026. Your monthly payment of $412.37 is due on November 15, 2026.\n\nPlease pay by the due date to avoid a late fee of $25.00. Your remaining loan balance is $14,880.12 after this payment.\nThank you for choosing us. We value our customers and their loan payment history very much.";
        let s = extract(t, 3);
        assert_eq!(s.len(), 3);
        // wrapped lines are joined back into their sentence, headings are left out, dates and amounts come first
        assert!(sentences(t).iter().any(|x| x == "This statement covers your auto loan for the month of October 2026."));
        assert!(s.iter().any(|x| x.contains("late fee")), "{s:?}");
        assert!(s.iter().any(|x| x.contains("due on November 15, 2026")), "{s:?}");
        assert!(!s.iter().any(|x| x.contains("Riverside")), "{s:?}");
        let (d, m) = facts(t);
        assert_eq!(d, vec!["November 15, 2026"]);
        assert_eq!(m, vec!["$412.37", "$25.00", "$14,880.12"]);
    }
    #[test]
    fn reads_a_screenplay() {
        let mut t = String::from("FADE IN:\n\n");
        for i in 0..12 {
            t.push_str(&format!("{}. INT. {} - NIGHT\n\nRain hits the window. Maya paces.\n\nMAYA\nWe have to leave tonight.\n\nLEO (V.O.)\n(quietly)\nNot without the money.\n\nEXT. HARBOR - DAY\n\nGulls. LEO walks to the boat.\n\nCUT TO:\n\n", i + 1, if i % 2 == 0 { "KITCHEN" } else { "MAYA'S CAR" }));
        }
        let s = screenplay(&t).expect("a screenplay");
        assert_eq!(s.scenes, 24);
        assert_eq!(s.characters.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), vec!["Leo", "Maya"]);
        assert_eq!(s.places[0], ("Harbor".to_string(), 12));
        assert!(screenplay("Just a letter.\nINT. is a word here once.").is_none());
    }
    #[test]
    fn sheet_totals() {
        let d = json!({ "sheets": [{ "name": "Budget", "rows": [["Item", "Cost"], ["Rent", "1200"], ["Food", "350.50"], ["Car", "412.37"]] }] });
        let l = sheet_summary(&d);
        assert_eq!(l[0], "**Budget**: 3 rows, columns “Item”, “Cost”. Cost totals 1962.87.");
    }
}
