// Ready-made reorganisations: they only write changes into the reality, never touch the disk.
use super::tree::*;

fn category(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|x| x.1.to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "heic" | "heif" | "svg" | "tif" | "tiff" | "raw" | "cr2" | "nef" | "arw" | "dng" | "ico" | "psd" | "avif" => "Images",
        "mp4" | "mkv" | "mov" | "avi" | "wmv" | "webm" | "m4v" | "flv" | "mpg" | "mpeg" => "Videos",
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" | "opus" | "aiff" => "Music",
        "pdf" | "doc" | "docx" | "txt" | "md" | "rtf" | "odt" | "ppt" | "pptx" | "xls" | "xlsx" | "csv" | "odp" | "ods" | "epub" | "pages" | "numbers" | "key" => "Documents",
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso" | "cab" | "dflock" => "Archives",
        "exe" | "msi" | "msix" | "appx" | "dmg" | "pkg" | "deb" | "apk" => "Installers",
        "js" | "ts" | "py" | "rs" | "c" | "cpp" | "h" | "java" | "cs" | "go" | "rb" | "php" | "html" | "css" | "json" | "xml" | "yml" | "yaml" | "sh" | "bat" | "ps1" => "Code",
        _ => "Other",
    }
}

/// year and month of a unix time
pub fn year_month(secs: i64) -> (i64, u32) {
    let z = secs.div_euclid(86400) + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = (mp + if mp < 10 { 3 } else { -9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m)
}

/// a name that is free in the folder: "photo (2).jpg"
pub fn unique(t: &Tree, dir: &str, name: &str) -> String {
    if t.get(&join(dir, name)).is_none() {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for n in 2..10_000 {
        let c = format!("{stem} ({n}){ext}");
        if t.get(&join(dir, &c)).is_none() {
            return c;
        }
    }
    name.to_string()
}

/// Group the files directly in `scope` into folders chosen by `pick`. The result is checked against a copy of the folder as
/// it goes, so every change it writes can be made.
fn group(t: &Tree, scope: &str, pick: impl Fn(&Node) -> String) -> Vec<OpKind> {
    let mut sim = t.clone();
    let mut ops: Vec<OpKind> = vec![];
    let mut files: Vec<Node> = t.children(scope).into_iter().filter(|n| n.kind == Kind::File).cloned().collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    for f in files {
        let folder = pick(&f);
        let fp = join(scope, &folder);
        if parent_of(&f.path) == fp {
            continue;
        }
        match sim.get(&fp) {
            Some(n) if n.kind == Kind::Dir => {}
            Some(_) => continue,
            None => {
                let op = OpKind::Mkdir { path: fp.clone() };
                if sim.apply(&op, None).is_ok() {
                    ops.push(op);
                } else {
                    continue;
                }
            }
        }
        let to = join(&fp, &unique(&sim, &fp, name_of(&f.path)));
        let op = OpKind::Move { from: f.path.clone(), to };
        if sim.apply(&op, None).is_ok() {
            ops.push(op);
        }
    }
    ops
}

pub fn by_type(t: &Tree, scope: &str) -> Vec<OpKind> {
    group(t, scope, |n| category(name_of(&n.path)).to_string())
}
pub fn by_month(t: &Tree, scope: &str) -> Vec<OpKind> {
    group(t, scope, |n| {
        let (y, m) = year_month(n.mtime);
        format!("{y}-{m:02}")
    })
}
/// Move every file out of the folders inside `scope` into `scope` itself (names that clash get a number). Nothing is deleted.
pub fn flatten(t: &Tree, scope: &str) -> Vec<OpKind> {
    let mut sim = t.clone();
    let mut ops = vec![];
    let mut files: Vec<Node> = t.below(scope).into_iter().filter(|n| n.kind == Kind::File && parent_of(&n.path) != scope).cloned().collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    for f in files {
        let to = join(scope, &unique(&sim, scope, name_of(&f.path)));
        let op = OpKind::Move { from: f.path.clone(), to };
        if sim.apply(&op, None).is_ok() {
            ops.push(op);
        }
    }
    ops
}
