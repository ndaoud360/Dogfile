// Demo mode: Dogfile shows a made-up computer instead of yours, so every feature can be shown (in a video, a
// screenshot, a presentation) without showing a single real file. The demo files live in Dogfile's data folder
// and are empty (0 bytes; photos are tiny pictures so thumbnails show), but each one reports a believable size,
// and copying them takes the time that size would take, so progress bars, speeds and totals look real.
//
// While it's on: the drives and the known folders (Desktop, Documents…) are the demo ones; settings, recent
// files, tags, notes, file history, reminders, phones and the rest are kept apart (store keys get "@demo"); the
// search index, Everything and the Recycle Bin only show demo items; the document scanner rests.
use crate::args::{Args, R};
use crate::{events, st, util};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static ON: AtomicBool = AtomicBool::new(false);
const VERSION: u32 = 1;

pub fn active() -> bool {
    ON.load(Ordering::Relaxed)
}
/// read once at start (before the settings), from the data folder
pub fn init(data_dir: &Path) {
    let on = std::fs::read(data_dir.join("demo.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).map(|v| v["on"].as_bool().unwrap_or(false)).unwrap_or(false);
    ON.store(on, Ordering::Relaxed);
}
/// store files that are personal: kept apart in demo mode
pub fn store_key(name: &str) -> String {
    const PERSONAL: [&str; 17] = ["settings", "session", "editor-session", "editor-recent", "cliphistory", "player-session", "player-resume", "history", "filenotes", "tags", "library", "phonelink", "reminders", "watched", "mediameta", "links", "timeline"];
    if active() && PERSONAL.contains(&name) { format!("{name}@demo") } else { name.to_string() }
}
pub fn root() -> PathBuf {
    st().data_dir.join("Demo")
}
pub fn inside(p: &Path) -> bool {
    p.starts_with(root())
}
fn home() -> PathBuf {
    root().join("Local Disk (C)").join("Users").join("Alex")
}

// ---------------------------------------------------------------------------------------------------------------
// sizes

fn manifest() -> &'static parking_lot::RwLock<HashMap<String, u64>> {
    static M: OnceLock<parking_lot::RwLock<HashMap<String, u64>>> = OnceLock::new();
    M.get_or_init(|| {
        let m = std::fs::read(root().join(".sizes.json")).ok().and_then(|b| serde_json::from_slice::<HashMap<String, u64>>(&b).ok()).unwrap_or_default();
        parking_lot::RwLock::new(m)
    })
}
fn rel_key(p: &Path) -> Option<String> {
    p.strip_prefix(root()).ok().map(|r| r.to_string_lossy().replace('\\', "/").to_lowercase())
}
fn fnv(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}
/// a believable size for a file of this name: the same name always gets the same size
pub fn size_for_name(name: &str) -> u64 {
    let ext = util::ext(name);
    let (lo, hi): (u64, u64) = match ext.as_str() {
        "jpg" | "jpeg" | "heic" | "png" | "webp" => (1_400_000, 7_800_000),
        "raw" | "cr2" | "nef" | "dng" | "arw" => (22_000_000, 48_000_000),
        "psd" => (40_000_000, 380_000_000),
        "mp4" | "mov" | "mkv" | "avi" => (60_000_000, 2_400_000_000),
        "mp3" | "m4a" | "aac" => (3_000_000, 11_000_000),
        "flac" | "wav" => (20_000_000, 70_000_000),
        "pdf" => (90_000, 9_000_000),
        "docx" | "doc" | "odt" | "pages" => (25_000, 2_600_000),
        "xlsx" | "xls" | "csv" | "numbers" => (12_000, 4_000_000),
        "pptx" | "key" => (1_500_000, 60_000_000),
        "txt" | "md" | "json" | "log" | "ini" | "cfg" | "yml" => (300, 60_000),
        "js" | "ts" | "css" | "html" | "py" | "rs" | "cs" | "java" | "go" => (800, 90_000),
        "zip" | "7z" | "rar" => (4_000_000, 900_000_000),
        "iso" | "img" => (1_800_000_000, 6_200_000_000),
        "exe" | "msi" => (900_000, 140_000_000),
        "dll" => (60_000, 9_000_000),
        "fbx" | "obj" | "glb" | "blend" | "stl" | "step" => (2_000_000, 160_000_000),
        "ttf" | "otf" => (60_000, 900_000),
        "svg" | "ico" => (2_000, 90_000),
        "db" | "sqlite" | "bak" => (5_000_000, 800_000_000),
        _ => (40_000, 30_000_000),
    };
    // more small files than big ones, like real folders
    let r = (fnv(&name.to_lowercase()) % 10_000) as f64 / 10_000.0;
    lo + ((hi - lo) as f64 * r * r) as u64
}
/// the size to show for a file: its pretend size when it's a demo file
pub fn size(p: &Path, real: u64) -> u64 {
    if !active() {
        return real;
    }
    let Some(k) = rel_key(p) else { return real };
    if let Some(s) = manifest().read().get(&k) {
        return *s;
    }
    // copies and new files in the demo: empty ones (and the tiny demo pictures) get a size from their name
    let small_pic = real < 65_536 && matches!(util::ext(&k).as_str(), "jpg" | "jpeg" | "png");
    if real == 0 || small_pic {
        let name = k.rsplit('/').next().unwrap_or(&k);
        return size_for_name(name);
    }
    real
}

// ---------------------------------------------------------------------------------------------------------------
// the demo computer

pub fn known_folders() -> Value {
    let h = home();
    let p = |x: &str| h.join(x).to_string_lossy().into_owned();
    json!({
        "home": h.to_string_lossy(), "desktop": p("Desktop"), "documents": p("Documents"), "downloads": p("Downloads"),
        "pictures": p("Pictures"), "videos": p("Videos"), "music": p("Music"), "appData": p("AppData"),
        "temp": std::env::temp_dir().to_string_lossy(), "onedrive": Value::Null, "recentWin": Value::Null,
    })
}
pub fn drives() -> Vec<Value> {
    let r = root();
    let d = |dir: &str, letter: &str, label: &str, ty: &str, total: u64, free: u64| {
        json!({ "path": r.join(dir).to_string_lossy(), "letter": letter, "label": label, "type": ty, "total": total, "free": free, "fs": "NTFS", "provider": "", "name": format!("{label} ({letter})"), "demo": true })
    };
    vec![
        d("Local Disk (C)", "C:", "Local Disk", "fixed", 511_101_108_224, 187_352_240_128),
        d("Data (D)", "D:", "Data", "fixed", 2_000_381_014_016, 1_214_660_272_128),
        d("USB Drive (E)", "E:", "USB Drive", "removable", 61_872_766_976, 40_101_928_960),
    ]
}

/// (folder relative to the demo root, file names)
fn tree() -> Vec<(&'static str, Vec<&'static str>)> {
    vec![
        ("Local Disk (C)/Users/Alex/Desktop", vec!["Quarterly review.pptx", "Invoice 2026-031.pdf", "Screenshot 2026-10-14 091522.png", "todo.txt", "Budget 2026.xlsx", "Setup notes.md"]),
        ("Local Disk (C)/Users/Alex/Documents", vec!["Resume - Alex Morgan.docx", "Cover letter.docx", "Lease agreement.pdf", "Car insurance card.pdf", "Passport scan.pdf", "Tax return 2025.pdf", "Recipes.docx", "Reading list.txt"]),
        ("Local Disk (C)/Users/Alex/Documents/Work", vec!["Client contract - Northwind.pdf", "Project plan.docx", "Meeting notes 2026-10-02.docx", "Pricing model.xlsx", "Pitch deck v7.pptx", "Pitch deck v7 FINAL.pptx", "Pitch deck v7 FINAL (2).pptx"]),
        ("Local Disk (C)/Users/Alex/Documents/Work/Reports", vec!["Q1 report.pdf", "Q2 report.pdf", "Q3 report.pdf", "Q3 report draft.docx", "Sales by region.xlsx", "Customer survey.csv"]),
        ("Local Disk (C)/Users/Alex/Documents/Personal", vec!["Wedding guest list.xlsx", "Warranty - Dishwasher.pdf", "Vaccination record.pdf", "Gym membership.pdf"]),
        ("Local Disk (C)/Users/Alex/Downloads", vec!["setup-photoeditor-4.2.exe", "VLC-3.0.21-win64.exe", "holiday-photos.zip", "statement-2026-09.pdf", "statement-2026-09 (1).pdf", "boarding-pass.pdf", "ubuntu-26.04-desktop-amd64.iso", "font-pack.zip", "presentation-template.pptx", "IMG_4412.jpg", "invoice_88231.pdf", "drivers-printer.msi"]),
        ("Local Disk (C)/Users/Alex/Pictures", vec!["Profile picture.jpg", "Wallpaper - Mountains.jpg", "Wallpaper - Ocean.jpg"]),
        ("Local Disk (C)/Users/Alex/Pictures/2026/Lisbon trip", vec!["IMG_3301.jpg", "IMG_3302.jpg", "IMG_3303.jpg", "IMG_3305.jpg", "IMG_3306.jpg", "IMG_3310.jpg", "IMG_3311.jpg", "IMG_3312.jpg", "IMG_3318.jpg", "IMG_3320.mov", "IMG_3321.jpg", "IMG_3322.jpg"]),
        ("Local Disk (C)/Users/Alex/Pictures/2026/Birthday", vec!["DSC_0012.jpg", "DSC_0013.jpg", "DSC_0014.jpg", "DSC_0015.jpg", "DSC_0016.jpg", "DSC_0019.jpg", "Cake.mp4"]),
        ("Local Disk (C)/Users/Alex/Pictures/2025/Garden", vec!["Roses.jpg", "Tomatoes.jpg", "Before.jpg", "After.jpg", "Timelapse.mp4"]),
        ("Local Disk (C)/Users/Alex/Pictures/Screenshots", vec!["Screenshot 2026-09-30 101010.png", "Screenshot 2026-10-01 143211.png", "Screenshot 2026-10-09 080102.png"]),
        ("Local Disk (C)/Users/Alex/Music/Midnight Static - Neon Coast", vec!["01 - Arrival.mp3", "02 - Neon Coast.mp3", "03 - Low Tide.mp3", "04 - Signal.mp3", "05 - Afterglow.mp3", "cover.jpg"]),
        ("Local Disk (C)/Users/Alex/Music/The Paper Lanterns - Field Notes", vec!["01 - Morning Train.flac", "02 - Field Notes.flac", "03 - Lanterns.flac", "04 - Home Again.flac", "folder.jpg"]),
        ("Local Disk (C)/Users/Alex/Music/Podcasts", vec!["Episode 112 - Building habits.mp3", "Episode 113 - Deep work.mp3"]),
        ("Local Disk (C)/Users/Alex/Videos", vec!["Lisbon highlights.mp4", "Screen recording 2026-10-03.mp4", "Tutorial - Pivot tables.mkv"]),
        ("Local Disk (C)/Users/Alex/Videos/Family", vec!["Beach day.mov", "First steps.mp4", "Holidays 2025.mp4"]),
        ("Local Disk (C)/Program Files/PhotoEditor", vec!["PhotoEditor.exe", "core.dll", "filters.dll", "license.txt"]),
        ("Local Disk (C)/Program Files/Notes App", vec!["Notes.exe", "updater.exe", "resources.pak"]),
        ("Data (D)/Projects/Website redesign", vec!["Brief.docx", "Sitemap.pdf", "Homepage mockup.psd", "Style guide.pdf", "Copy deck.docx"]),
        ("Data (D)/Projects/Website redesign/assets", vec!["hero.jpg", "team-photo.jpg", "logo.svg", "icons.zip", "Inter.ttf"]),
        ("Data (D)/Projects/Website redesign/src", vec!["index.html", "styles.css", "app.js", "README.md", "package.json"]),
        ("Data (D)/Projects/Mobile app", vec!["Requirements.docx", "Wireframes.pdf", "Release notes.md", "app-release.apk", "Test plan.xlsx"]),
        ("Data (D)/Projects/3D models", vec!["Chair.fbx", "Lamp.obj", "Bracket.step", "Phone stand.stl", "Scene.glb"]),
        ("Data (D)/Photos/Archive 2019-2024", vec!["2019 Summer.zip", "2020 Lockdown.zip", "2021 Road trip.zip", "2022 Japan.zip", "2023 Family.zip", "2024 Misc.zip"]),
        ("Data (D)/Backups", vec!["Laptop backup 2026-09-01.zip", "Phone backup 2026-08.zip", "Contacts.csv", "Passwords export (delete me).csv"]),
        ("Data (D)/Games/Indie collection", vec!["StarDrift.exe", "StarDrift.dat", "Save game 1.sav", "Save game 2.sav"]),
        ("Data (D)/Installers", vec!["office-setup.exe", "drivers-gpu-582.11.exe", "windows-11-25h2.iso", "7z2600-x64.exe"]),
        ("USB Drive (E)", vec!["Portfolio.pdf", "Photos for print.zip", "Presentation.pptx", "Movie night.mkv"]),
        ("USB Drive (E)/Transfer", vec!["Scans.pdf", "Old documents.zip", "Readme.txt"]),
    ]
}
// a few files with something to read in them
fn text_of(name: &str) -> Option<&'static str> {
    Some(match name {
        "todo.txt" => "- Send invoice to Northwind\n- Book dentist\n- Back up the laptop\n- Renew car insurance (expires 2026-12-01)\n",
        "Setup notes.md" => "# New laptop setup\n\n1. Install Dogfile\n2. Sign in to cloud storage\n3. Copy Documents from the old PC\n",
        "Reading list.txt" => "The Pragmatic Programmer\nDeep Work\nThe Design of Everyday Things\n",
        "README.md" => "# Website redesign\n\nRun `npm start` and open http://localhost:3000.\n",
        "Release notes.md" => "## 2.4.0\n- Dark mode\n- Faster sync\n- Bug fixes\n",
        "Readme.txt" => "Files to move to the new PC.\n",
        "license.txt" => "Demo license text.\n",
        _ => return None,
    })
}

/// makes the demo folder (once per version): returns its root
fn build() -> Result<(), String> {
    let r = root();
    let mark = r.join(".version");
    if std::fs::read_to_string(&mark).ok().and_then(|s| s.trim().parse::<u32>().ok()) == Some(VERSION) {
        return Ok(());
    }
    let _ = std::fs::remove_dir_all(&r);
    let mut sizes: HashMap<String, u64> = HashMap::new();
    // dates spread over the last two years, newest in Downloads and on the Desktop
    let now = util::now_ms() as i64 / 1000;
    for (i, (dir, files)) in tree().into_iter().enumerate() {
        let d = r.join(dir);
        std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        for (j, name) in files.iter().enumerate() {
            let p = d.join(name);
            let ext = util::ext(name);
            if let Some(t) = text_of(name) {
                std::fs::write(&p, t).map_err(|e| e.to_string())?;
            } else if matches!(ext.as_str(), "jpg" | "jpeg" | "png") {
                picture(&p, fnv(name)).map_err(|e| e.to_string())?;
                sizes.insert(rel_key(&p).unwrap_or_default(), size_for_name(name));
            } else {
                std::fs::write(&p, b"").map_err(|e| e.to_string())?;
                sizes.insert(rel_key(&p).unwrap_or_default(), size_for_name(name));
            }
            let fresh = dir.contains("Downloads") || dir.contains("Desktop");
            let age_days = if fresh { (fnv(name) % 30) as i64 } else { 20 + (fnv(name) % 700) as i64 + (i as i64) };
            let t = now - age_days * 86_400 - (j as i64) * 3_600;
            let _ = filetime::set_file_mtime(&p, filetime::FileTime::from_unix_time(t, 0));
        }
    }
    for x in ["AppData", "Saved Games", "Contacts"] {
        let _ = std::fs::create_dir_all(home().join(x));
    }
    std::fs::write(r.join(".sizes.json"), serde_json::to_vec(&sizes).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    *manifest().write() = sizes;
    std::fs::write(&mark, VERSION.to_string()).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        // hidden like system files, so they don't show in the demo
        for n in [".version", ".sizes.json"] {
            let _ = std::process::Command::new("attrib").arg("+h").arg(r.join(n)).status();
        }
    }
    Ok(())
}
/// a small, pleasant picture (a soft two-color gradient) so photo thumbnails show
fn picture(p: &Path, seed: u64) -> image::ImageResult<()> {
    let hue = |k: u64| -> [f32; 3] {
        let h = (k % 360) as f32 / 60.0;
        let x = 1.0 - (h % 2.0 - 1.0).abs();
        let (r, g, b) = match h as u32 { 0 => (1.0, x, 0.0), 1 => (x, 1.0, 0.0), 2 => (0.0, 1.0, x), 3 => (0.0, x, 1.0), 4 => (x, 0.0, 1.0), _ => (1.0, 0.0, x) };
        [r, g, b]
    };
    let (a, b) = (hue(seed), hue(seed / 7 + 140));
    let (w, h) = (192u32, 128u32);
    let img = image::RgbImage::from_fn(w, h, |x, y| {
        let t = (x as f32 / w as f32) * 0.6 + (y as f32 / h as f32) * 0.4;
        let c = |i: usize| ((a[i] * (1.0 - t) + b[i] * t) * 0.75 * 255.0 + 30.0).min(255.0) as u8;
        // a horizon line, so it reads as a photo
        let k = if (y as f32) > h as f32 * (0.55 + 0.1 * ((x as f32 / 30.0 + seed as f32).sin())) { 0.7 } else { 1.0 };
        image::Rgb([(c(0) as f32 * k) as u8, (c(1) as f32 * k) as u8, (c(2) as f32 * k) as u8])
    });
    if util::ext(&p.to_string_lossy()) == "png" { img.save_with_format(p, image::ImageFormat::Png) } else { img.save_with_format(p, image::ImageFormat::Jpeg) }
}

// ---------------------------------------------------------------------------------------------------------------
// calls

/// demo:status: {on, root, home}
pub fn status(_a: &Args) -> R {
    Ok(json!({ "on": active(), "root": root().to_string_lossy(), "home": home().to_string_lossy() }))
}
/// demo:set(on): switches, then every window reloads into (or out of) the demo
pub fn set(a: &Args) -> R {
    let on = a.0.first().and_then(|v| v.as_bool()).unwrap_or(false);
    if on {
        build()?;
        // demo settings: yours, without anything that points at your files or servers
        if crate::store::get("settings@demo").is_none() {
            let mut s = crate::store::get("settings").unwrap_or_else(|| json!({}));
            scrub(&mut s);
            if let Some(o) = s.as_object_mut() {
                for k in ["connections", "remotes", "workspaces", "profiles", "collections", "openWithApps", "recentSearches", "searchHistory", "phoneShared", "phoneInbox", "indexRoots", "reminders", "macros", "folderRules", "automations", "lastFolder", "startFolder"] {
                    o.remove(k);
                }
                o.insert("welcomed".into(), json!(true));
            }
            crate::store::set("settings@demo", &s)?;
        }
        // pins and recent items, so the demo looks lived in
        if crate::store::get("library@demo").is_none() {
            let h = home();
            let p = |x: &Path| x.to_string_lossy().into_owned();
            let docs = h.join("Documents");
            let lib = json!({
                "pinned": [p(&docs.join("Work")), p(&root().join("Data (D)").join("Projects"))],
                "recent": [p(&docs.join("Work").join("Reports")), p(&h.join("Pictures").join("2026").join("Lisbon trip")), p(&h.join("Downloads")), p(&root().join("Data (D)").join("Projects").join("Website redesign"))],
                "recentFiles": [p(&docs.join("Work").join("Pitch deck v7 FINAL.pptx")), p(&h.join("Desktop").join("Budget 2026.xlsx")), p(&docs.join("Work").join("Reports").join("Q3 report.pdf")), p(&h.join("Desktop").join("todo.txt"))],
                "workspaces": {}, "folderViews": {},
            });
            crate::store::set("library@demo", &lib)?;
        }
    }
    std::fs::write(st().data_dir.join("demo.json"), json!({ "on": on }).to_string()).map_err(|e| e.to_string())?;
    ON.store(on, Ordering::Relaxed);
    // everything that was read from the other side
    let s = crate::store::get("settings").unwrap_or_else(|| json!({}));
    *st().settings.write() = s;
    crate::ops::configure_from_settings();
    crate::phonelink::reset();
    events::broadcast("demo:changed", json!({ "on": on }));
    Ok(json!({ "on": on }))
}
/// demo:reset: a fresh demo (the files back as they were)
pub fn reset(_a: &Args) -> R {
    let _ = std::fs::remove_file(root().join(".version"));
    build()?;
    events::broadcast("demo:changed", json!({ "on": active() }));
    Ok(json!(true))
}
/// paths that point at real files go: strings that look like paths, and list entries holding one
fn scrub(v: &mut Value) {
    let looks = |s: &str| (s.len() > 2 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_alphabetic()) || s.starts_with("\\\\") || (s.starts_with('/') && s.len() > 1 && !s.starts_with("//"));
    fn has_path(v: &Value, looks: &dyn Fn(&str) -> bool) -> bool {
        match v {
            Value::String(s) => looks(s),
            Value::Array(a) => a.iter().any(|x| has_path(x, looks)),
            Value::Object(o) => o.values().any(|x| has_path(x, looks)),
            _ => false,
        }
    }
    match v {
        Value::Object(o) => {
            o.retain(|_, x| !matches!(x, Value::String(s) if looks(s)));
            for x in o.values_mut() {
                scrub(x);
            }
        }
        Value::Array(a) => a.retain(|x| !has_path(x, &looks)),
        _ => {}
    }
}
