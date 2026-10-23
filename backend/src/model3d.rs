// Dogfile 3D helpers. The viewer itself runs in the interface (three.js); the backend fetches the CAD reader
// once (OpenCascade compiled to WebAssembly, occt-import-js, LGPL: kept as its own files so it can be swapped),
// and turns AutoCAD drawings (.dwg) into .dxf with the free ODA File Converter when it's installed: DWG is a
// closed format and every free reader for it is either GPL or unreliable.
use crate::args::{Args, R};
use crate::{st, util};
use parking_lot::Mutex;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const OCCT_VER: &str = "0.0.23";
// the exact files Dogfile was tested with; anything else is refused
const OCCT_FILES: [(&str, &str); 2] = [
    ("occt-import-js.js", "3fb44ce11d00611f9b3f3c5775d520ebab48930c1f08279b7b1316f05f0d3379"),
    ("occt-import-js.wasm", "33391fc9d94ea5c869a6718488bf0a9a464222bac9bdc764dfe1690cef281952"),
];

fn occt_dir() -> PathBuf {
    st().data_dir.join("tools").join(format!("occt-{OCCT_VER}"))
}
fn occt_ready() -> bool {
    OCCT_FILES.iter().all(|(n, _)| occt_dir().join(n).is_file())
}

#[derive(Default, Clone)]
struct Fetch {
    running: bool,
    received: u64,
    total: u64,
    error: Option<String>,
}
fn fetch() -> &'static Mutex<Fetch> {
    static F: OnceLock<Mutex<Fetch>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(Fetch::default()))
}

/// m3d:cadStatus: {ready, dir, downloading, received, total, error}
pub fn cad_status(_a: &Args) -> R {
    let f = fetch().lock().clone();
    Ok(json!({ "ready": occt_ready(), "dir": occt_dir().to_string_lossy(), "downloading": f.running, "received": f.received, "total": f.total, "error": f.error }))
}
/// m3d:cadInstall: fetch the CAD reader (about 8 MB) in the background; poll m3d:cadStatus
pub fn cad_install(_a: &Args) -> R {
    if occt_ready() {
        return Ok(json!({ "ready": true }));
    }
    {
        let mut f = fetch().lock();
        if f.running {
            return Ok(json!({ "downloading": true }));
        }
        *f = Fetch { running: true, total: 7_700_000, ..Default::default() };
    }
    st().rt.spawn(async {
        let r = get_occt().await;
        let mut f = fetch().lock();
        f.running = false;
        f.error = r.err();
    });
    Ok(json!({ "downloading": true }))
}
async fn get_occt() -> Result<(), String> {
    let dir = occt_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // the npm package itself (one compressed download, about 4 MB), else the files from a CDN
    let mut files: Vec<(&str, Vec<u8>)> = Vec::new();
    let mut last = String::new();
    fetch().lock().total = 4_400_000;
    match download(&format!("https://registry.npmjs.org/occt-import-js/-/occt-import-js-{OCCT_VER}.tgz")).await.and_then(|b| untgz(&b)) {
        Ok(found) => {
            for (name, _) in OCCT_FILES {
                if let Some((_, b)) = found.iter().find(|(n, _)| n == &format!("package/dist/{name}")) {
                    files.push((name, b.clone()));
                }
            }
        }
        Err(e) => last = e,
    }
    if files.len() < OCCT_FILES.len() {
        files.clear();
        {
            let mut f = fetch().lock();
            f.received = 0;
            f.total = 7_700_000;
        }
        for (name, sum) in OCCT_FILES {
            for base in ["https://cdn.jsdelivr.net/npm", "https://unpkg.com"] {
                match download(&format!("{base}/occt-import-js@{OCCT_VER}/dist/{name}")).await {
                    Ok(b) if hex(&Sha256::digest(&b)) == sum => {
                        files.push((name, b));
                        break;
                    }
                    Ok(_) => last = "The download didn’t match the expected file".into(),
                    Err(e) => last = e,
                }
            }
        }
    }
    for (name, sum) in OCCT_FILES {
        let b = files.iter().find(|(n, _)| *n == name).map(|(_, b)| b).ok_or_else(|| format!("Couldn’t download the CAD reader: {last}"))?;
        if hex(&Sha256::digest(b)) != sum {
            return Err("The CAD reader that was downloaded isn’t the expected one".into());
        }
        let tmp = dir.join(format!("{name}.part"));
        std::fs::write(&tmp, b).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, dir.join(name)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
/// the files in a .tgz (ustar): [(name, bytes)]
fn untgz(gz: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    use std::io::Read;
    let mut tar = Vec::new();
    flate2::read::GzDecoder::new(gz).read_to_end(&mut tar).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut at = 0;
    while at + 512 <= tar.len() {
        let h = &tar[at..at + 512];
        if h.iter().all(|&b| b == 0) {
            break;
        }
        let field = |a: usize, b: usize| String::from_utf8_lossy(&h[a..b]).trim_end_matches('\0').trim().to_string();
        let size = usize::from_str_radix(&field(124, 136), 8).map_err(|_| "Broken package".to_string())?;
        let prefix = field(345, 500);
        let name = if prefix.is_empty() { field(0, 100) } else { format!("{prefix}/{}", field(0, 100)) };
        let body = at + 512;
        if body + size > tar.len() {
            return Err("Broken package".into());
        }
        if h[156] == b'0' || h[156] == 0 {
            out.push((name, tar[body..body + size].to_vec()));
        }
        at = body + size.div_ceil(512) * 512;
    }
    Ok(out)
}
async fn download(url: &str) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
    let r = util::http().get(url).timeout(std::time::Duration::from_secs(600)).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("HTTP {}", r.status().as_u16()));
    }
    let mut out = Vec::new();
    let mut s = r.bytes_stream();
    while let Some(c) = s.next().await {
        let c = c.map_err(|e| e.to_string())?;
        fetch().lock().received += c.len() as u64;
        out.extend_from_slice(&c);
    }
    Ok(out)
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------------------------------------------------------------------------------------------------------------
// DWG → DXF with the ODA File Converter

fn oda() -> Option<PathBuf> {
    if let Some(p) = crate::setting("odaConverter").as_str().filter(|s| !s.is_empty()).map(PathBuf::from) {
        if p.is_file() {
            return Some(p);
        }
    }
    if util::IS_WIN {
        for root in [std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into()), std::env::var("ProgramFiles(x86)").unwrap_or_default()] {
            let base = Path::new(&root).join("ODA");
            let Ok(rd) = std::fs::read_dir(&base) else { continue };
            // the newest version first (folders are named ODAFileConverter 25.12.0 …)
            let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.file_name().map(|n| n.to_string_lossy().starts_with("ODAFileConverter")).unwrap_or(false)).collect();
            dirs.sort();
            for d in dirs.into_iter().rev() {
                let exe = d.join("ODAFileConverter.exe");
                if exe.is_file() {
                    return Some(exe);
                }
            }
        }
        None
    } else {
        util::which("ODAFileConverter").or_else(|| ["/usr/bin/ODAFileConverter", "/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter"].iter().map(PathBuf::from).find(|p| p.is_file()))
    }
}
/// m3d:dwgStatus: {ready, path}
pub fn dwg_status(_a: &Args) -> R {
    let p = oda();
    Ok(json!({ "ready": p.is_some(), "path": p.map(|p| p.to_string_lossy().into_owned()) }))
}
/// m3d:dwgToDxf(path): converts a copy and answers the .dxf path (in the temp folder)
pub async fn dwg_to_dxf(a: &Args) -> R {
    let src = PathBuf::from(a.s(0)?);
    let exe = oda().ok_or("NO_ODA")?;
    let work = util::temp_dir("dwg").map_err(|e| e.to_string())?;
    let (inp, out) = (work.join("in"), work.join("out"));
    std::fs::create_dir_all(&inp).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    std::fs::copy(&src, inp.join("model.dwg")).map_err(|e| format!("Couldn’t read the drawing: {e}"))?;
    let r = util::cmd(&exe)
        .args([inp.as_os_str(), out.as_os_str()])
        .args(["ACAD2018", "DXF", "0", "1", "*.DWG"])
        .output();
    let r = tokio::time::timeout(std::time::Duration::from_secs(180), r).await.map_err(|_| "The DWG converter took too long".to_string())?.map_err(|e| e.to_string())?;
    let dxf = out.join("model.dxf");
    if !dxf.is_file() {
        let msg = String::from_utf8_lossy(&r.stderr).trim().to_string();
        return Err(if msg.is_empty() { "The ODA File Converter couldn’t convert this drawing".into() } else { msg });
    }
    Ok(json!(dxf.to_string_lossy()))
}
