// Thumbnails of pictures with see-through parts (PNG, WebP, GIF). Windows hands back such a thumbnail without its
// transparency for some of them (the see-through parts come out black), so Dogfile makes these itself.
use std::path::Path;

/// (bytes, is_png) for a thumbnail no bigger than `size`, or None when the picture has no transparency (the system's
/// own thumbnail is fine and smaller then), isn't one of these formats, is too big to read quickly, or can't be read
pub fn make(p: &str, size: u32) -> Option<(Vec<u8>, bool)> {
    use image::{ImageDecoder, ImageEncoder, ImageReader};
    let ext = Path::new(p).extension()?.to_string_lossy().to_lowercase();
    if !["png", "webp", "gif"].contains(&ext.as_str()) || std::fs::metadata(p).ok()?.len() > 40 * 1048576 {
        return None;
    }
    let reader = ImageReader::open(p).ok()?.with_guessed_format().ok()?;
    let decoder = reader.into_decoder().ok()?;
    if !decoder.color_type().has_alpha() {
        return None;
    }
    let img = image::DynamicImage::from_decoder(decoder).ok()?;
    let size = size.clamp(16, 2560);
    let img = if img.width() > size || img.height() > size { img.thumbnail(size, size) } else { img };
    let rgba = img.to_rgba8();
    // a picture whose alpha is all opaque doesn't need to be a PNG, but its source said it has alpha: keep it exact
    let mut out = vec![];
    image::codecs::png::PngEncoder::new(&mut out).write_image(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8).ok()?;
    Some((out, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_see_through_png_stays_see_through_and_an_opaque_one_is_left_to_the_system() {
        let d = std::env::temp_dir().join(format!("dogfile-alpha-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let a = d.join("a.png");
        let mut im = image::RgbaImage::new(400, 200);
        im.put_pixel(10, 10, image::Rgba([255, 0, 0, 255]));
        im.save(&a).unwrap();
        let (bytes, png) = make(a.to_str().unwrap(), 100).unwrap();
        assert!(png);
        let t = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!((t.width(), t.height()), (100, 50));
        assert_eq!(t.get_pixel(99, 49)[3], 0, "the empty corner is still transparent");
        let o = d.join("o.png");
        image::RgbImage::new(10, 10).save(&o).unwrap();
        assert!(make(o.to_str().unwrap(), 100).is_none());
        assert!(make(d.join("x.txt").to_str().unwrap(), 100).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }
}
