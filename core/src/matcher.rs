// What a search looks for. Built from Dogfile's search options (the same fields the old Node worker took) and,
// for the instant index, from a typed query with a few operators:
//   words (all must appear)   -word (must not)   "exact phrase"   *.jpg / report?.doc (wildcards)
//   ext:jpg;png   size:>10mb  size:1mb..50mb   dm:today|yesterday|week|month|year|2024|>2024-01-31
//   folder: / file:   path:projects\atlas (matches the full path)   regex:^IMG_\d+
use regex::Regex;
use serde_json::Value;

#[derive(Default, Clone)]
pub struct Spec {
    pub case_sensitive: bool,
    pub words: Vec<String>,
    pub not_words: Vec<String>,
    pub path_words: Vec<String>,
    pub any_words: Vec<String>,
    pub re: Option<Regex>,
    pub kind_file: bool,
    pub kind_dir: bool,
    pub ext: Vec<String>,
    pub not_ext: Vec<String>,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    pub after: Option<f64>,
    pub before: Option<f64>,
    pub created_after: Option<f64>,
    pub created_before: Option<f64>,
    pub accessed_before: Option<f64>,
    pub include_hidden: bool,
    pub content: Option<regex::bytes::Regex>,
    pub max_content: u64,
}

fn wildcard_re(w: &str, cs: bool) -> Option<Regex> {
    let parts: Vec<String> = w
        .split([';', '|'])
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|p| {
            let r = regex::escape(p).replace("\\*", ".*").replace("\\?", ".");
            if p.contains('*') || p.contains('?') { format!("^{r}$") } else { r }
        })
        .collect();
    let body = if parts.is_empty() { ".*".to_string() } else { parts.join("|") };
    Regex::new(&format!("{}{}", if cs { "" } else { "(?i)" }, body)).ok()
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64()
}
fn strs(v: &Value) -> Vec<String> {
    match v {
        Value::String(s) => s.split([',', ';', ' ']).filter(|x| !x.is_empty()).map(|e| e.trim_start_matches('*').trim_start_matches('.').to_ascii_lowercase()).collect(),
        Value::Array(a) => a.iter().filter_map(|x| x.as_str()).map(|e| e.trim_start_matches('*').trim_start_matches('.').to_ascii_lowercase()).collect(),
        _ => vec![],
    }
}

impl Spec {
    /// From the options Dogfile's search sends (same names as the old worker).
    pub fn from_job(j: &Value) -> Result<Spec, String> {
        let cs = j["caseSensitive"].as_bool().unwrap_or(false);
        let mut s = Spec { case_sensitive: cs, include_hidden: j["includeHidden"].as_bool().unwrap_or(false), ..Default::default() };
        let q = j["query"].as_str().unwrap_or("").trim();
        if !q.is_empty() {
            if j["regex"].as_bool().unwrap_or(false) {
                s.re = Some(Regex::new(&format!("{}{}", if cs { "" } else { "(?i)" }, q)).map_err(|e| format!("Bad pattern: {e}"))?);
            } else {
                s.add_query(q, false);
            }
        }
        match j["kind"].as_str() {
            Some("file") => s.kind_file = true,
            Some("dir") => s.kind_dir = true,
            _ => {}
        }
        s.ext = strs(&j["extensions"]);
        s.not_ext = strs(&j["excludeExtensions"]);
        s.any_words = j["anyWords"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(|w| w.to_lowercase()).collect()).unwrap_or_default();
        s.min_size = num(&j["minSize"]).map(|x| x as u64);
        s.max_size = num(&j["maxSize"]).map(|x| x as u64);
        s.after = num(&j["after"]);
        s.before = num(&j["before"]);
        s.created_after = num(&j["createdAfter"]);
        s.created_before = num(&j["createdBefore"]);
        s.accessed_before = num(&j["accessedBefore"]);
        s.max_content = num(&j["maxContentBytes"]).map(|x| x as u64).unwrap_or(50 * 1024 * 1024);
        if let Some(c) = j["content"].as_str().filter(|c| !c.is_empty()) {
            let pat = if j["contentRegex"].as_bool().unwrap_or(false) { c.to_string() } else { regex::escape(c) };
            let pat = format!("{}{}", if cs { "(?m)" } else { "(?im)" }, pat);
            s.content = Some(regex::bytes::Regex::new(&pat).map_err(|e| format!("Bad content pattern: {e}"))?);
        }
        Ok(s)
    }

    /// The typed query, with operators.
    pub fn from_query(q: &str) -> Spec {
        let mut s = Spec::default();
        s.add_query(q, true);
        s
    }

    fn add_query(&mut self, q: &str, operators: bool) {
        // the old behaviour: a pattern with wildcards or ; | is one wildcard expression
        if !operators && (q.contains(['*', '?', ';', '|'])) {
            self.re = wildcard_re(q, self.case_sensitive);
            return;
        }
        for tok in tokens(q) {
            let (neg, t) = match tok.strip_prefix('-') { Some(r) if !r.is_empty() && !tok.starts_with("--") => (true, r.to_string()), _ => (false, tok.clone()) };
            if operators {
                let low = t.to_ascii_lowercase();
                if let Some(v) = low.strip_prefix("ext:") {
                    let list: Vec<String> = v.split([';', ',', '|']).filter(|x| !x.is_empty()).map(|x| x.trim_start_matches('.').to_string()).collect();
                    if neg { self.not_ext.extend(list) } else { self.ext.extend(list) }
                    continue;
                }
                if let Some(v) = low.strip_prefix("size:") {
                    self.size_op(v);
                    continue;
                }
                if let Some(v) = low.strip_prefix("dm:").or_else(|| low.strip_prefix("modified:")) {
                    self.date_op(v);
                    continue;
                }
                if low == "folder:" || low == "folders:" {
                    self.kind_dir = true;
                    continue;
                }
                if low == "file:" || low == "files:" {
                    self.kind_file = true;
                    continue;
                }
                if low == "hidden:" {
                    self.include_hidden = true;
                    continue;
                }
                if low.starts_with("regex:") {
                    self.re = Regex::new(&format!("(?i){}", &t[6..])).ok();
                    continue;
                }
                if low.starts_with("path:") {
                    self.path_words.push(normalize_sep(&t[5..].to_lowercase()));
                    continue;
                }
                if t.contains('*') || t.contains('?') {
                    if let Some(r) = wildcard_re(&t, false) {
                        if neg { self.not_words.push(t.to_lowercase()) } else { self.re = Some(r) }
                    }
                    continue;
                }
                if t.contains('\\') || t.contains('/') {
                    self.path_words.push(normalize_sep(&t.to_lowercase()));
                    continue;
                }
            }
            let w = if self.case_sensitive { t } else { t.to_lowercase() };
            if neg { self.not_words.push(w) } else { self.words.push(w) }
        }
    }

    fn size_op(&mut self, v: &str) {
        let parse = |x: &str| -> Option<u64> {
            let x = x.trim();
            let (n, mul) = if let Some(n) = x.strip_suffix("gb") { (n, 1u64 << 30) } else if let Some(n) = x.strip_suffix("mb") { (n, 1 << 20) } else if let Some(n) = x.strip_suffix("kb") { (n, 1 << 10) } else if let Some(n) = x.strip_suffix('b') { (n, 1) } else { (x, 1) };
            n.trim().parse::<f64>().ok().map(|f| (f * mul as f64) as u64)
        };
        if let Some((a, b)) = v.split_once("..") {
            self.min_size = parse(a);
            self.max_size = parse(b);
        } else if let Some(x) = v.strip_prefix(">=").or_else(|| v.strip_prefix('>')) {
            self.min_size = parse(x);
        } else if let Some(x) = v.strip_prefix("<=").or_else(|| v.strip_prefix('<')) {
            self.max_size = parse(x);
        } else {
            match v {
                "empty" => { self.max_size = Some(0); self.kind_file = true; }
                "tiny" => self.max_size = Some(10 << 10),
                "small" => { self.min_size = Some(10 << 10); self.max_size = Some(100 << 10) }
                "medium" => { self.min_size = Some(100 << 10); self.max_size = Some(1 << 20) }
                "large" => { self.min_size = Some(1 << 20); self.max_size = Some(16 << 20) }
                "huge" => { self.min_size = Some(16 << 20); self.max_size = Some(128 << 20) }
                "gigantic" => self.min_size = Some(128 << 20),
                _ => { if let Some(n) = parse(v) { self.min_size = Some(n); self.max_size = Some(n) } }
            }
        }
    }

    fn date_op(&mut self, v: &str) {
        let now = crate::util::now_ms();
        const DAY: f64 = 86_400_000.0;
        let today = now - (now.rem_euclid(DAY)); // UTC midnight; close enough for "today"
        let range = match v {
            "today" => Some((today, f64::MAX)),
            "yesterday" => Some((today - DAY, today)),
            "week" | "thisweek" | "7d" => Some((now - 7.0 * DAY, f64::MAX)),
            "month" | "thismonth" | "30d" => Some((now - 30.0 * DAY, f64::MAX)),
            "year" | "thisyear" | "365d" => Some((now - 365.0 * DAY, f64::MAX)),
            _ => None,
        };
        if let Some((a, b)) = range {
            self.after = Some(a);
            if b != f64::MAX { self.before = Some(b) }
            return;
        }
        let (op, d) = if let Some(x) = v.strip_prefix('>') { ('>', x) } else if let Some(x) = v.strip_prefix('<') { ('<', x) } else { ('=', v) };
        if let Some((start, end)) = parse_date(d) {
            match op {
                '>' => self.after = Some(end),
                '<' => self.before = Some(start),
                _ => { self.after = Some(start); self.before = Some(end) }
            }
        }
    }

    pub fn needs_stat(&self) -> bool {
        true
    }
    /// Does the index have everything this search needs? (content and created/accessed dates are not indexed)
    pub fn index_can(&self) -> bool {
        self.content.is_none() && self.created_after.is_none() && self.created_before.is_none() && self.accessed_before.is_none()
    }
    pub fn has_path_words(&self) -> bool {
        !self.path_words.is_empty()
    }

    /// Name-level test (cheap): name is the original, low is its lowercase form.
    pub fn name_ok(&self, name: &str, low: &str, is_dir: bool, hidden: bool) -> bool {
        if !self.include_hidden && hidden {
            return false;
        }
        if self.kind_file && is_dir { return false }
        if self.kind_dir && !is_dir { return false }
        let n = if self.case_sensitive { name } else { low };
        if !self.words.iter().all(|w| n.contains(w.as_str())) { return false }
        if self.not_words.iter().any(|w| if w.contains(['*', '?']) { wildcard_re(w, false).map(|r| r.is_match(low)).unwrap_or(false) } else { n.contains(w.as_str()) }) { return false }
        if let Some(re) = &self.re { if !re.is_match(name) { return false } }
        if !self.any_words.is_empty() && !self.any_words.iter().any(|w| low.contains(w.as_str())) { return false }
        if !self.ext.is_empty() || !self.not_ext.is_empty() {
            let e = crate::util::ext_of(name);
            if !self.ext.is_empty() && (is_dir || !self.ext.iter().any(|x| x == &e)) { return false }
            if self.not_ext.iter().any(|x| x == &e) { return false }
        }
        true
    }
    pub fn meta_ok(&self, is_dir: bool, size: u64, mtime: f64, ctime: f64, atime: f64) -> bool {
        if !is_dir {
            if let Some(m) = self.min_size { if size < m { return false } }
            if let Some(m) = self.max_size { if size > m { return false } }
        }
        if let Some(a) = self.after { if mtime < a { return false } }
        if let Some(b) = self.before { if mtime > b { return false } }
        if let Some(a) = self.created_after { if ctime < a { return false } }
        if let Some(b) = self.created_before { if ctime > b { return false } }
        if let Some(b) = self.accessed_before { if atime.max(mtime) > b { return false } }
        true
    }
    pub fn path_ok(&self, path_low: &str) -> bool {
        let p = normalize_sep(path_low);
        self.path_words.iter().all(|w| p.contains(w.as_str()))
    }
}

fn normalize_sep(s: &str) -> String {
    s.replace('/', "\\")
}

fn tokens(q: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in q.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() { out.push(std::mem::take(&mut cur)) }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() { out.push(cur) }
    out
}

/// "2024", "2024-03", "2024-03-15" → [start, end) in ms (UTC).
fn parse_date(d: &str) -> Option<(f64, f64)> {
    let parts: Vec<i64> = d.split(['-', '/', '.']).map(|x| x.parse().ok()).collect::<Option<Vec<_>>>()?;
    let days = |y: i64, m: i64, dd: i64| -> i64 {
        // days since 1970-01-01 (civil from days, Howard Hinnant)
        let y2 = if m <= 2 { y - 1 } else { y };
        let era = y2.div_euclid(400);
        let yoe = y2 - era * 400;
        let mp = (m + 9) % 12;
        let doy = (153 * mp + 2) / 5 + dd - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146097 + doe - 719468
    };
    const DAY: f64 = 86_400_000.0;
    match parts.as_slice() {
        [y] => Some((days(*y, 1, 1) as f64 * DAY, days(y + 1, 1, 1) as f64 * DAY)),
        [y, m] => {
            let (ny, nm) = if *m == 12 { (y + 1, 1) } else { (*y, m + 1) };
            Some((days(*y, *m, 1) as f64 * DAY, days(ny, nm, 1) as f64 * DAY))
        }
        [y, m, dd] => Some((days(*y, *m, *dd) as f64 * DAY, (days(*y, *m, *dd) + 1) as f64 * DAY)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn words_and_ops() {
        let s = Spec::from_query("report -draft ext:pdf;docx size:>1mb");
        assert!(s.name_ok("Annual Report 2024.pdf", "annual report 2024.pdf", false, false));
        assert!(!s.name_ok("report draft.pdf", "report draft.pdf", false, false));
        assert!(!s.name_ok("report.txt", "report.txt", false, false));
        assert!(s.meta_ok(false, 2 << 20, 0.0, 0.0, 0.0));
        assert!(!s.meta_ok(false, 10, 0.0, 0.0, 0.0));
        let w = Spec::from_query("IMG_*.jpg");
        assert!(w.name_ok("IMG_001.jpg", "img_001.jpg", false, false));
        assert!(!w.name_ok("xIMG_001.jpg", "ximg_001.jpg", false, false));
        let p = Spec::from_query("atlas\\src main");
        assert!(p.path_ok("c:\\code\\atlas\\src\\main.js"));
        assert_eq!(parse_date("1970-01-02"), Some((86_400_000.0, 172_800_000.0)));
    }
    #[test]
    fn job_wildcards() {
        let j = serde_json::json!({"query": "*.png;*.jpg"});
        let s = Spec::from_job(&j).unwrap();
        assert!(s.name_ok("a.PNG", "a.png", false, false));
        assert!(!s.name_ok("a.gif", "a.gif", false, false));
    }
}
