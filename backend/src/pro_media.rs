// Dogfile Pro image utilities. These operations run in the backend so the licence gate is enforced
// on the operation itself, not just by hiding its buttons in the renderer.
use crate::args::{Args, R};
use serde_json::json;
use std::path::Path;

pub async fn process_image(a: &Args) -> R {
    let o = a.v(0);
    let src = o["src"].as_str().ok_or("Choose an image")?.to_string();
    let out = o["out"].as_str().ok_or("Choose where to save the image")?.to_string();
    let max_side = o["maxSide"].as_u64().unwrap_or(0).min(20000) as u32;
    let upscale_only = o["upscaleOnly"].as_bool().unwrap_or(false);
    let quality = o["quality"].as_u64().unwrap_or(88).clamp(1, 100) as u8;
    let format = o["format"].as_str().unwrap_or_else(|| Path::new(&out).extension().and_then(|x| x.to_str()).unwrap_or("jpg")).to_ascii_lowercase();
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        use image::imageops::FilterType;
        let mut image = image::open(&src).map_err(|e| format!("Couldn’t open image: {e}"))?;
        let (w, h) = (image.width(), image.height());
        if max_side > 0 && w.max(h) != max_side && (!upscale_only || max_side > w.max(h)) {
            let scale = max_side as f64 / w.max(h) as f64;
            let nw = ((w as f64 * scale).round() as u32).max(1);
            let nh = ((h as f64 * scale).round() as u32).max(1);
            image = image.resize_exact(nw, nh, FilterType::Lanczos3);
        }
        let mut file = std::fs::File::create(&out).map_err(|e| format!("Couldn’t create output: {e}"))?;
        let wrote: Result<(), String> = (|| {
            match format.as_str() {
                "jpg" | "jpeg" => {
                    let rgb = image.to_rgb8();
                    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, quality)
                        .encode_image(&rgb).map_err(|e| format!("Couldn’t encode JPEG: {e}"))?;
                }
                "png" => image.write_to(&mut file, image::ImageFormat::Png).map_err(|e| e.to_string())?,
                "webp" => image.write_to(&mut file, image::ImageFormat::WebP).map_err(|e| e.to_string())?,
                _ => return Err("Choose JPG, PNG or WebP".into()),
            }
            Ok(())
        })();
        drop(file);
        if let Err(e) = wrote { let _ = std::fs::remove_file(&out); return Err(e); }
        let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        Ok(json!({"path": out, "width": image.width(), "height": image.height(), "bytes": size, "originalWidth": w, "originalHeight": h}))
    }).await.map_err(|e| e.to_string())?
}

pub async fn create_gif(a: &Args) -> R {
    let o = a.v(0);
    let files = o["inputs"].as_array().ok_or("Choose at least two pictures")?.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>();
    if files.len() < 2 { return Err("Choose at least two pictures to make a GIF".into()); }
    if files.len() > 300 { return Err("A GIF can contain up to 300 pictures".into()); }
    let out = o["out"].as_str().ok_or("Choose where to save the GIF")?.to_string();
    let delay = o["delayMs"].as_u64().unwrap_or(120).clamp(20, 5000) as u32;
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        use image::{codecs::gif::{GifEncoder, Repeat}, Delay, Frame};
        let mut decoded = Vec::with_capacity(files.len());
        let mut size = None;
        for p in &files {
            let im = image::open(p).map_err(|e| format!("Couldn’t open {}: {e}", Path::new(p).file_name().unwrap_or_default().to_string_lossy()))?;
            let target = *size.get_or_insert((im.width(), im.height()));
            let rgba = if (im.width(), im.height()) == target { im.into_rgba8() } else { im.resize_exact(target.0, target.1, image::imageops::FilterType::Lanczos3).into_rgba8() };
            decoded.push(Frame::from_parts(rgba, 0, 0, Delay::from_numer_denom_ms(delay, 1)));
        }
        let file = std::fs::File::create(&out).map_err(|e| format!("Couldn’t create GIF: {e}"))?;
        let wrote: Result<(), String> = (move || {
            let mut enc = GifEncoder::new(file);
            enc.set_repeat(Repeat::Infinite).map_err(|e| e.to_string())?;
            enc.encode_frames(decoded).map_err(|e| format!("Couldn’t encode GIF: {e}"))?;
            Ok(())
        })();
        if let Err(e) = wrote { let _ = std::fs::remove_file(&out); return Err(e); }
        let bytes = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        Ok(json!({"path": out, "frames": files.len(), "bytes": bytes}))
    }).await.map_err(|e| e.to_string())?
}
