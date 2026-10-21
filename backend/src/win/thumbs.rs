// Thumbnails from Windows' own thumbnail cache (photos, videos, PDFs, Office files, anything with a handler):
// made on a few background threads, newest request first, kept briefly in memory and handed to the window as
// short /thumb addresses instead of large inline images.
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::sync::{Condvar, OnceLock};
use windows::core::Interface;
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::Shell::*;

type Done = tokio::sync::oneshot::Sender<Option<(Vec<u8>, bool)>>;
struct Queue {
    jobs: Mutex<VecDeque<(String, u32, Done)>>,
    cv: Condvar,
    cv_m: std::sync::Mutex<()>,
}
fn queue() -> &'static Queue {
    static Q: OnceLock<Queue> = OnceLock::new();
    Q.get_or_init(|| {
        for _ in 0..4 {
            std::thread::spawn(worker);
        }
        Queue { jobs: Mutex::new(VecDeque::new()), cv: Condvar::new(), cv_m: std::sync::Mutex::new(()) }
    })
}
fn worker() {
    super::com_init();
    loop {
        let job = queue().jobs.lock().pop_back(); // newest first: what's on screen now
        match job {
            Some((p, size, tx)) => {
                let r = make(&p, size);
                let _ = tx.send(r);
            }
            None => {
                let g = queue().cv_m.lock().unwrap();
                let _ = queue().cv.wait_timeout(g, std::time::Duration::from_millis(500));
            }
        }
    }
}

/// BGRA pixels of a bitmap as straight RGBA
pub fn hbitmap_rgba(hbm: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
    unsafe {
        let mut bm = BITMAP::default();
        if GetObjectW(hbm, std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _)) == 0 {
            let _ = DeleteObject(hbm);
            return None;
        }
        let (w, h) = (bm.bmWidth.max(1) as u32, bm.bmHeight.unsigned_abs().max(1));
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader = BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w as i32, biHeight: -(h as i32), biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let dc = CreateCompatibleDC(None);
        let lines = GetDIBits(dc, hbm, 0, h, Some(buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
        let _ = DeleteDC(dc);
        let _ = DeleteObject(hbm);
        if lines == 0 {
            return None;
        }
        let any_alpha = buf.chunks_exact(4).any(|p| p[3] != 0);
        for p in buf.chunks_exact_mut(4) {
            p.swap(0, 2);
            if !any_alpha {
                p[3] = 255; // no alpha channel at all: opaque
            } else if p[3] > 0 && p[3] < 255 {
                // premultiplied -> straight
                let a = p[3] as u32;
                for c in 0..3 {
                    p[c] = ((p[c] as u32 * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }
        Some((w, h, buf))
    }
}
/// JPEG for opaque pictures (about a tenth the size), PNG when there's transparency
pub fn encode(w: u32, h: u32, rgba: Vec<u8>, force_png: bool) -> Option<(Vec<u8>, bool)> {
    use image::ImageEncoder;
    let opaque = rgba.chunks_exact(4).all(|p| p[3] == 255);
    let mut out = vec![];
    if opaque && !force_png {
        let rgb: Vec<u8> = rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82).write_image(&rgb, w, h, image::ExtendedColorType::Rgb8).ok()?;
        Some((out, false))
    } else {
        image::codecs::png::PngEncoder::new(&mut out).write_image(&rgba, w, h, image::ExtendedColorType::Rgba8).ok()?;
        Some((out, true))
    }
}
fn make(p: &str, size: u32) -> Option<(Vec<u8>, bool)> {
    let it = super::shellx::item(p).ok()?;
    let f: IShellItemImageFactory = it.cast().ok()?;
    let s = size.clamp(16, 2560) as i32;
    let hbm = unsafe { f.GetImage(SIZE { cx: s, cy: s }, SIIGBF(SIIGBF_THUMBNAILONLY.0 | SIIGBF_BIGGERSIZEOK.0)) }.ok()?;
    let (w, h, rgba) = hbitmap_rgba(hbm)?;
    encode(w, h, rgba, false)
}

// recently made thumbnails, by address
struct Cache {
    map: HashMap<String, (Vec<u8>, bool)>,
    order: VecDeque<String>,
    bytes: usize,
}
fn cache() -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Cache { map: HashMap::new(), order: VecDeque::new(), bytes: 0 }))
}
fn remember(key: String, v: (Vec<u8>, bool)) {
    let mut c = cache().lock();
    c.bytes += v.0.len();
    if let Some(old) = c.map.insert(key.clone(), v) {
        c.bytes -= old.0.len();
    } else {
        c.order.push_back(key);
    }
    while c.bytes > 8 * 1048576 {
        let Some(k) = c.order.pop_front() else { break };
        if let Some(v) = c.map.remove(&k) {
            c.bytes -= v.0.len();
        }
    }
}
async fn generate(p: &str, size: u32) -> Option<(Vec<u8>, bool)> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let q = queue();
        let mut j = q.jobs.lock();
        j.push_back((p.to_string(), size, tx));
        // too far behind: the oldest requests are for things no longer on screen
        while j.len() > 400 {
            if let Some((_, _, t)) = j.pop_front() {
                let _ = t.send(None);
            }
        }
        drop(j);
        q.cv.notify_one();
    }
    rx.await.ok().flatten()
}
fn key(p: &str, size: u32) -> String {
    let m = std::fs::metadata(p).map(|m| crate::util::ms(m.modified()) as u64).unwrap_or(0);
    format!("/thumb?p={}&s={size}&v={m}", urlencoding::encode(p))
}
/// thumb:get — an address for the picture, or nothing when Windows has no thumbnail for this file
pub async fn get(p: String, size: u32) -> Option<String> {
    let k = key(&p, size);
    if cache().lock().map.contains_key(&k) {
        return Some(k);
    }
    let v = generate(&p, size).await?;
    remember(k.clone(), v);
    Some(k)
}
/// the /thumb address itself
pub async fn serve(p: &str, size: u32, v: &str) -> crate::http::Resp {
    let k = format!("/thumb?p={}&s={size}&v={v}", urlencoding::encode(p));
    let hit = cache().lock().map.get(&k).cloned();
    let got = match hit {
        Some(x) => Some(x),
        None => {
            let g = generate(p, size).await;
            if let Some(x) = &g {
                remember(k, x.clone());
            }
            g
        }
    };
    match got {
        Some((b, png)) => crate::http::Resp::bytes(200, if png { "image/png" } else { "image/jpeg" }, b).header("Cache-Control", "max-age=3600"),
        None => crate::http::Resp::text(404, "No thumbnail"),
    }
}
