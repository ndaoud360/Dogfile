// Pictures the web view can't show itself: Photoshop (its flattened composite), TGA, DDS, OpenEXR and Radiance
// HDR (tone-mapped), 16- and 32-bit TIFF, QOI, PNM/PFM, Farbfeld… decoded here into a PNG for the photo viewer,
// the preview pane and thumbnails. 3D model textures are mostly these.
use std::path::Path;

/// types decoded here (the rest go to the web view, Windows or ffmpeg)
pub const EXTS: &[&str] = &["psd", "psb", "tga", "dds", "exr", "hdr", "pic", "tif", "tiff", "qoi", "pbm", "pgm", "ppm", "pnm", "pam", "pfm", "ff", "icb", "vda", "vst", "targa"];
/// camera RAW files: every one carries a full-size JPEG preview, which is what's shown (the sensor data is not developed)
pub const RAW: &[&str] = &["3fr", "ari", "arw", "bay", "cr2", "cr3", "crw", "dcr", "dng", "erf", "fff", "iiq", "kc2", "kdc", "mdc", "mef", "mos", "mrw", "nef", "nrw", "orf", "pef", "raf", "raw", "rw2", "rwl", "sr2", "srf", "srw", "x3f"];
fn ext_of(p: &str) -> String {
    Path::new(p).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}
pub fn handles(p: &str) -> bool {
    let e = ext_of(p);
    EXTS.contains(&e.as_str()) || RAW.contains(&e.as_str())
}
/// the biggest JPEG inside a camera RAW file, rotated the way the camera was held
fn raw_preview(p: &str) -> Result<image::RgbaImage, String> {
    let data = std::fs::read(p).map_err(|e| e.to_string())?;
    let mut best: Option<(usize, u64)> = None;
    let mut i = 0usize;
    let mut tried = 0;
    while i + 3 < data.len() && tried < 64 {
        if data[i] == 0xFF && data[i + 1] == 0xD8 && data[i + 2] == 0xFF {
            tried += 1;
            if let Ok(r) = image::ImageReader::new(std::io::Cursor::new(&data[i..])).with_guessed_format() {
                if let Ok((w, h)) = r.into_dimensions() {
                    let area = w as u64 * h as u64;
                    if area >= 160 * 120 && best.map(|b| area > b.1).unwrap_or(true) {
                        best = Some((i, area));
                    }
                }
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    let (off, _) = best.ok_or("This RAW file has no picture inside it that Dogfile can read")?;
    let mut img = image::ImageReader::new(std::io::Cursor::new(&data[off..])).with_guessed_format().map_err(|e| e.to_string())?;
    img.no_limits();
    let img = img.decode().map_err(|e| format!("Couldn’t read the picture inside this RAW file: {e}"))?.into_rgba8();
    Ok(match tiff_orientation(&data) {
        3 => image::imageops::rotate180(&img),
        6 => image::imageops::rotate90(&img),
        8 => image::imageops::rotate270(&img),
        _ => img,
    })
}
/// EXIF orientation (1 to 8) from the first directory of a TIFF-style file (most RAW files), 1 when absent
pub fn tiff_orientation(d: &[u8]) -> u16 {
    if d.len() < 16 {
        return 1;
    }
    let le = match &d[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return 1,
    };
    let u16at = |o: usize| -> Option<u16> { d.get(o..o + 2).map(|b| if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) }) };
    let u32at = |o: usize| -> Option<u32> { d.get(o..o + 4).map(|b| if le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) }) };
    let Some(ifd) = u32at(4) else { return 1 };
    let ifd = ifd as usize;
    let Some(n) = u16at(ifd) else { return 1 };
    for k in 0..(n as usize).min(200) {
        let e = ifd + 2 + k * 12;
        if u16at(e) == Some(0x0112) {
            return u16at(e + 8).filter(|v| (1..=8).contains(v)).unwrap_or(1);
        }
    }
    1
}

/// a high dynamic range picture made viewable: exposure, a filmic curve (ACES approximation), sRGB
fn tonemap(img: image::Rgba32FImage) -> image::RgbaImage {
    let (w, h) = img.dimensions();
    // expose so the average brightness sits mid-grey (most EXR/HDR files are scene-linear)
    let mut sum = 0f64;
    let mut n = 0u64;
    for p in img.pixels().step_by(((w as usize * h as usize) / 40_000).max(1)) {
        let l = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
        if l.is_finite() && l > 0.0 {
            sum += (l as f64 + 1e-4).ln();
            n += 1;
        }
    }
    let avg = if n > 0 { (sum / n as f64).exp() as f32 } else { 0.18 };
    let exposure = (0.18 / avg.max(1e-4)).clamp(0.01, 64.0);
    let aces = |x: f32| ((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)).clamp(0.0, 1.0);
    let srgb = |x: f32| if x <= 0.003_130_8 { x * 12.92 } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 };
    image::RgbaImage::from_fn(w, h, |x, y| {
        let p = img.get_pixel(x, y);
        let c = |v: f32| (srgb(aces((if v.is_finite() { v } else { 0.0 }).max(0.0) * exposure)) * 255.0 + 0.5) as u8;
        image::Rgba([c(p[0]), c(p[1]), c(p[2]), (p[3].clamp(0.0, 1.0) * 255.0) as u8])
    })
}

/// the picture as RGBA, at most `max` pixels on its longer side (0 = full size)
pub fn decode(p: &str, max: u32) -> Result<image::RgbaImage, String> {
    let e = Path::new(p).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let img = if RAW.contains(&e.as_str()) {
        raw_preview(p)?
    } else if e == "psd" || e == "psb" {
        // Photoshop keeps a flattened copy of the whole picture: that's what's shown
        let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
        let psd = psd::Psd::from_bytes(&bytes).map_err(|e| format!("Couldn’t read this Photoshop file: {e}"))?;
        image::RgbaImage::from_raw(psd.width(), psd.height(), psd.rgba()).ok_or("Couldn’t read this Photoshop file")?
    } else if e == "dds" {
        // game and 3D textures: BC1–BC7, uncompressed, float; the top mip level of the first layer
        let f = std::fs::File::open(p).map_err(|e| e.to_string())?;
        let dds = image_dds::ddsfile::Dds::read(std::io::BufReader::new(f)).map_err(|e| format!("Couldn’t read this texture: {e}"))?;
        image_dds::image_from_dds(&dds, 0).map_err(|e| format!("Couldn’t read this texture: {e}"))?
    } else {
        let r = image::ImageReader::open(p).map_err(|e| e.to_string())?.with_guessed_format().map_err(|e| e.to_string())?;
        let mut r = r;
        r.no_limits();
        let d = r.decode().map_err(|e| format!("Couldn’t read this picture: {e}"))?;
        match d {
            image::DynamicImage::ImageRgb32F(_) | image::DynamicImage::ImageRgba32F(_) => tonemap(d.into_rgba32f()),
            other => other.into_rgba8(),
        }
    };
    Ok(if max > 0 && (img.width() > max || img.height() > max) {
        let k = max as f64 / img.width().max(img.height()) as f64;
        image::imageops::thumbnail(&img, ((img.width() as f64 * k).round() as u32).max(1), ((img.height() as f64 * k).round() as u32).max(1))
    } else {
        img
    })
}
/// as PNG bytes
pub fn png(p: &str, max: u32) -> Result<Vec<u8>, String> {
    let img = decode(p, max)?;
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 255) as u8, (y % 255) as u8, 120]));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Jpeg).unwrap();
        out.into_inner()
    }
    /// a pretend RAW file: a TIFF header whose first directory says "rotate 90°", a small thumbnail, then the real preview
    fn fake_raw(orient: u16) -> Vec<u8> {
        let mut d = vec![b'I', b'I', 42, 0, 8, 0, 0, 0];
        d.extend_from_slice(&1u16.to_le_bytes()); // one entry
        d.extend_from_slice(&0x0112u16.to_le_bytes());
        d.extend_from_slice(&3u16.to_le_bytes());
        d.extend_from_slice(&1u32.to_le_bytes());
        d.extend_from_slice(&orient.to_le_bytes());
        d.extend_from_slice(&[0, 0]);
        d.extend_from_slice(&0u32.to_le_bytes());
        d.extend_from_slice(&[0u8; 64]); // "sensor data"
        d.extend_from_slice(&jpeg(160, 120)); // thumbnail
        d.extend_from_slice(&[0u8; 32]);
        d.extend_from_slice(&jpeg(640, 400)); // preview
        d
    }
    #[test]
    fn raw_preview_is_the_big_jpeg_and_is_turned() {
        let dir = std::env::temp_dir().join(format!("dogfile-raw-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (orient, w, h) in [(1u16, 640u32, 400u32), (6, 400, 640), (3, 640, 400), (8, 400, 640)] {
            let f = dir.join("shot.cr2");
            std::fs::write(&f, fake_raw(orient)).unwrap();
            let img = decode(f.to_str().unwrap(), 0).unwrap();
            assert_eq!((img.width(), img.height()), (w, h), "orientation {orient}");
        }
        let junk = dir.join("empty.nef");
        std::fs::write(&junk, vec![0u8; 5000]).unwrap();
        assert!(decode(junk.to_str().unwrap(), 0).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
