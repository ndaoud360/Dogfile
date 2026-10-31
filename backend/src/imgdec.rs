// Pictures the web view can't show itself: Photoshop (its flattened composite), TGA, DDS, OpenEXR and Radiance
// HDR (tone-mapped), 16- and 32-bit TIFF, QOI, PNM/PFM, Farbfeld… decoded here into a PNG for the photo viewer,
// the preview pane and thumbnails. 3D model textures are mostly these.
use std::path::Path;

/// types decoded here (the rest go to the web view, Windows or ffmpeg)
pub const EXTS: &[&str] = &["psd", "psb", "tga", "dds", "exr", "hdr", "pic", "tif", "tiff", "qoi", "pbm", "pgm", "ppm", "pnm", "pam", "pfm", "ff", "icb", "vda", "vst"];
pub fn handles(p: &str) -> bool {
    let e = Path::new(p).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    EXTS.contains(&e.as_str())
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
    let img = if e == "psd" || e == "psb" {
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
