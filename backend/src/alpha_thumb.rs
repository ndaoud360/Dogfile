// Thumbnails of pictures with see-through parts (PNG, WebP, GIF). Windows hands back such a thumbnail without its
// transparency for some of them (the see-through parts come out black), so Dogfile makes these itself.
use std::path::Path;

/// Pictures this many pixels or bigger are never opened whole (a 40 megapixel picture is 160 MB once opened)
const MAX_WHOLE_PIXELS: u64 = 12_000_000;

/// (bytes, is_png) for a thumbnail no bigger than `size`, or None when the picture has no transparency (the system's
/// own thumbnail is fine and smaller then), isn't one of these formats, or can't be read
pub fn make(p: &str, size: u32) -> Option<(Vec<u8>, bool)> {
    let ext = Path::new(p).extension()?.to_string_lossy().to_lowercase();
    if !["png", "webp", "gif"].contains(&ext.as_str()) {
        return None;
    }
    let size = size.clamp(16, 2560);
    if ext == "png" {
        match png_streamed(p, size) {
            Streamed::Done(v) => return Some((v, true)),
            Streamed::Opaque => return None,
            Streamed::Other => {}
        }
    }
    whole(p, size)
}

enum Streamed {
    Done(Vec<u8>),
    Opaque,
    Other,
}

/// A PNG shrunk while it is read, a row at a time: a huge picture costs a few rows of memory, not the whole picture.
fn png_streamed(p: &str, size: u32) -> Streamed {
    use png::{BitDepth, ColorType, Decoder, Transformations};
    let Ok(f) = std::fs::File::open(p) else { return Streamed::Other };
    let mut d = Decoder::new(std::io::BufReader::new(f));
    d.set_transformations(Transformations::EXPAND | Transformations::STRIP_16);
    let Ok(mut r) = d.read_info() else { return Streamed::Other };
    let (w, h, interlaced) = { let i = r.info(); (i.width, i.height, i.interlaced) };
    let (ct, bd) = r.output_color_type();
    let ch = match ct {
        ColorType::Rgba => 4usize,
        ColorType::GrayscaleAlpha => 2,
        ColorType::Rgb | ColorType::Grayscale => return Streamed::Opaque,
        _ => return Streamed::Other,
    };
    if interlaced || bd != BitDepth::Eight || w == 0 || h == 0 {
        return Streamed::Other;
    }
    let long = w.max(h);
    let (ow, oh) = if long <= size { (w, h) } else { (((w as u64 * size as u64) / long as u64).max(1) as u32, ((h as u64 * size as u64) / long as u64).max(1) as u32) };
    let xmap: Vec<usize> = (0..w as u64).map(|x| (x * ow as u64 / w as u64) as usize).collect();
    // per output pixel: colour weighted by opacity, opacity, how many pixels went in
    let mut acc = vec![[0u64; 5]; ow as usize];
    let mut out = Vec::with_capacity(ow as usize * oh as usize * 4);
    let flush = |acc: &mut Vec<[u64; 5]>, out: &mut Vec<u8>| {
        for a in acc.iter_mut() {
            if a[3] == 0 {
                out.extend_from_slice(&[0, 0, 0, 0]);
            } else {
                out.extend_from_slice(&[((a[0] + a[3] / 2) / a[3]) as u8, ((a[1] + a[3] / 2) / a[3]) as u8, ((a[2] + a[3] / 2) / a[3]) as u8, ((a[3] + a[4] / 2) / a[4]) as u8]);
            }
            *a = [0; 5];
        }
    };
    let mut cur = 0u32;
    for y in 0..h {
        let Ok(Some(row)) = r.next_row() else { return Streamed::Other };
        let row = row.data();
        let oy = (y as u64 * oh as u64 / h as u64) as u32;
        if oy != cur {
            flush(&mut acc, &mut out);
            cur = oy;
        }
        for x in 0..w as usize {
            let px = &row[x * ch..x * ch + ch];
            let (rgb, a) = if ch == 4 { ([px[0] as u64, px[1] as u64, px[2] as u64], px[3] as u64) } else { ([px[0] as u64; 3], px[1] as u64) };
            let t = &mut acc[xmap[x]];
            t[0] += rgb[0] * a;
            t[1] += rgb[1] * a;
            t[2] += rgb[2] * a;
            t[3] += a;
            t[4] += 1;
        }
    }
    flush(&mut acc, &mut out);
    if out.len() != ow as usize * oh as usize * 4 {
        return Streamed::Other;
    }
    match encode_png(&out, ow, oh) {
        Some(v) => Streamed::Done(v),
        None => Streamed::Other,
    }
}

fn encode_png(rgba: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    use image::ImageEncoder;
    let mut out = vec![];
    image::codecs::png::PngEncoder::new(&mut out).write_image(rgba, w, h, image::ExtendedColorType::Rgba8).ok()?;
    Some(out)
}

/// The formats that can't be read a row at a time (WebP, GIF, interlaced PNG): opened whole, one at a time, and only when small
fn whole(p: &str, size: u32) -> Option<(Vec<u8>, bool)> {
    use image::{ImageDecoder, ImageReader};
    static ONE_AT_A_TIME: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
    let reader = ImageReader::open(p).ok()?.with_guessed_format().ok()?;
    let decoder = reader.into_decoder().ok()?;
    let (w, h) = decoder.dimensions();
    if !decoder.color_type().has_alpha() || w as u64 * h as u64 > MAX_WHOLE_PIXELS {
        return None;
    }
    let _one = ONE_AT_A_TIME.lock();
    let img = image::DynamicImage::from_decoder(decoder).ok()?;
    let img = if img.width() > size || img.height() > size { img.thumbnail(size, size) } else { img };
    let rgba = img.to_rgba8();
    Some((encode_png(&rgba, rgba.width(), rgba.height())?, true))
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

    #[test]
    fn a_big_see_through_png_is_shrunk_without_opening_it_whole() {
        let d = std::env::temp_dir().join(format!("dogfile-alpha-big-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        // 3000 x 2000, a red square in the middle, everything else empty
        let f = d.join("big.png");
        let mut enc = png::Encoder::new(std::io::BufWriter::new(std::fs::File::create(&f).unwrap()), 3000, 2000);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().unwrap().into_stream_writer().unwrap();
        use std::io::Write;
        for y in 0..2000u32 {
            let mut row = vec![0u8; 3000 * 4];
            if (500..1500).contains(&y) {
                for x in 1000..2000usize {
                    row[x * 4..x * 4 + 4].copy_from_slice(&[255, 0, 0, 255]);
                }
            }
            wr.write_all(&row).unwrap();
        }
        wr.finish().unwrap();
        let (bytes, is_png) = make(f.to_str().unwrap(), 150).unwrap();
        assert!(is_png);
        let t = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!((t.width(), t.height()), (150, 100));
        assert_eq!(t.get_pixel(2, 2)[3], 0, "the empty corner stays see-through");
        let c = t.get_pixel(75, 50);
        assert_eq!((c[0], c[1], c[2], c[3]), (255, 0, 0, 255), "the middle keeps its colour");
        // grey with see-through, and a palette picture with a see-through colour
        let g = d.join("g.png");
        let mut enc = png::Encoder::new(std::fs::File::create(&g).unwrap(), 4, 4);
        enc.set_color(png::ColorType::GrayscaleAlpha);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().unwrap().write_image_data(&[200, 0].repeat(16)).unwrap();
        let (b, _) = make(g.to_str().unwrap(), 100).unwrap();
        assert_eq!(image::load_from_memory(&b).unwrap().to_rgba8().get_pixel(1, 1)[3], 0);
        let i = d.join("i.png");
        let mut enc = png::Encoder::new(std::fs::File::create(&i).unwrap(), 2, 2);
        enc.set_color(png::ColorType::Indexed);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_palette(vec![0, 0, 255, 0, 255, 0]);
        enc.set_trns(vec![0, 255]);
        enc.write_header().unwrap().write_image_data(&[0, 1, 1, 0]).unwrap();
        let (b, _) = make(i.to_str().unwrap(), 100).unwrap();
        let t = image::load_from_memory(&b).unwrap().to_rgba8();
        assert_eq!((t.get_pixel(0, 0)[3], t.get_pixel(1, 0)[3]), (0, 255));
        assert_eq!(t.get_pixel(1, 0)[1], 255, "the opaque palette colour (green) is kept");
        let _ = std::fs::remove_dir_all(&d);
    }
}
