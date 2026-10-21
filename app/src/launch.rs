// What Dogfile was started with: a folder or file, Explorer-style switches (/select, /e, ::{CLSID}, shell:…),
// or --edit / --play / --view with files (used by the Windows right-click entries).
use std::path::{Path, PathBuf};

#[derive(Default, Debug)]
pub struct Launch {
    pub path: Option<String>,
    pub select: Option<String>,
    pub edit: Vec<String>,
    pub play: Vec<String>,
    pub view: Vec<String>,
}

fn unq(s: &str) -> String {
    s.trim_matches('"').to_string()
}

pub fn parse(argv: &[String], cwd: Option<&str>) -> Launch {
    let mut out = Launch::default();
    let mut rest: Vec<String> = Vec::new();
    let mut mode: Option<&str> = None;
    for a in argv {
        match a.as_str() {
            "--edit" | "--play" | "--view" => {
                mode = Some(match a.as_str() { "--edit" => "edit", "--play" => "play", _ => "view" });
                continue;
            }
            _ => {}
        }
        if a.starts_with("--") {
            mode = None;
            continue;
        }
        match mode {
            Some("edit") => out.edit.push(abs(&unq(a), cwd)),
            Some("play") => out.play.push(abs(&unq(a), cwd)),
            Some("view") => out.view.push(abs(&unq(a), cwd)),
            _ => rest.push(a.clone()),
        }
    }
    for a in rest {
        let mut a = unq(&a);
        if a.to_lowercase().starts_with("/select,") {
            let s = abs(&unq(&a[8..]), cwd);
            out.path = Path::new(&s).parent().map(|p| p.to_string_lossy().into_owned());
            out.select = Some(s);
            continue;
        }
        let low = a.to_lowercase();
        if let Some(sw) = ["/e,", "/n,", "/root,", "/separate,"].iter().find(|s| low.starts_with(**s)) {
            a = unq(&a[sw.len()..]);
        } else if ["/e", "/n", "/root", "/separate"].contains(&low.as_str()) {
            continue;
        }
        let low = a.to_lowercase();
        if a.starts_with("::") || low.starts_with("shell:") {
            let d = |f: Option<PathBuf>| f.map(|p| p.to_string_lossy().into_owned());
            out.path = if low.contains("20d04fe0") || low.contains("mycomputer") {
                Some("atlas:thispc".into())
            } else if low.contains("645ff040") || low.contains("recyclebin") {
                Some("atlas:recycle".into())
            } else if low.contains("downloads") || low.contains("374de290") {
                d(dirs::download_dir())
            } else if low.contains("desktop") {
                d(dirs::desktop_dir())
            } else if low.contains("documents") || low.contains("personal") {
                d(dirs::document_dir())
            } else {
                Some("atlas:home".into())
            };
            continue;
        }
        let p = abs(&a, cwd);
        match std::fs::metadata(&p) {
            Ok(m) if m.is_dir() => out.path = Some(p),
            Ok(_) => {
                out.path = Path::new(&p).parent().map(|x| x.to_string_lossy().into_owned());
                out.select = Some(p);
            }
            Err(_) => {}
        }
    }
    out
}

fn abs(p: &str, cwd: Option<&str>) -> String {
    let pb = PathBuf::from(p);
    if pb.is_absolute() {
        return p.to_string();
    }
    match cwd {
        Some(c) if !c.is_empty() => Path::new(c).join(pb).to_string_lossy().into_owned(),
        _ => std::env::current_dir().map(|d| d.join(&pb).to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string()),
    }
}
