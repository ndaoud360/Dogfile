// Set a picture as a folder's icon, the way Windows does it: a .ico file and a desktop.ini inside the folder, so Explorer
// shows it too. "Reset" takes both away again (only when they are the ones made here).
use crate::args::{err, Args, R};
use serde_json::json;
use std::path::Path;

const ICO: &str = "folder-icon.ico";
const INI: &str = "desktop.ini";

#[cfg(windows)]
fn attrib(args: &[&str], p: &Path) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("attrib").args(args).arg(p).creation_flags(0x0800_0000).status();
}
#[cfg(not(windows))]
fn attrib(_args: &[&str], _p: &Path) {}

fn ours(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join(INI)).map(|s| s.to_lowercase().contains(ICO)).unwrap_or(false)
}

fn set_sync(folder: &str, image: &str) -> R {
    let dir = Path::new(folder);
    if !dir.is_dir() {
        return Err("That folder isn’t on this PC".into());
    }
    let ini = dir.join(INI);
    if ini.exists() && !ours(dir) {
        return Err("This folder already has an icon set by another program, so it was left alone".into());
    }
    let img = image::open(image).map_err(|e| format!("Couldn’t open that picture: {e}"))?;
    // the middle of the picture, as a square icon
    let square = img.resize_to_fill(256, 256, image::imageops::FilterType::Lanczos3).to_rgba8();
    let ico = dir.join(ICO);
    // a hidden system file can't be written over until it is made ordinary again
    for p in [&ico, &ini] {
        attrib(&["-s", "-h", "-r"], p);
    }
    {
        use image::ImageEncoder;
        let f = std::fs::File::create(&ico).map_err(|e| crate::fsx::friendly(&e))?;
        let enc = image::codecs::ico::IcoEncoder::new(std::io::BufWriter::new(f));
        enc.write_image(square.as_raw(), 256, 256, image::ExtendedColorType::Rgba8).map_err(|e| format!("Couldn’t make the icon: {e}"))?;
    }
    let text = format!("[.ShellClassInfo]\r\nIconResource={ICO},0\r\nIconFile={ICO}\r\nIconIndex=0\r\n");
    std::fs::write(&ini, text).map_err(|e| crate::fsx::friendly(&e))?;
    attrib(&["+s", "+h"], &ico);
    attrib(&["+s", "+h"], &ini);
    // Explorer only reads desktop.ini of a folder marked read-only or system
    attrib(&["+r"], dir);
    Ok(json!({ "icon": ico.to_string_lossy() }))
}

fn clear_sync(folder: &str) -> R {
    let dir = Path::new(folder);
    if !ours(dir) {
        return Ok(json!(false));
    }
    for p in [dir.join(ICO), dir.join(INI)] {
        attrib(&["-s", "-h", "-r"], &p);
        let _ = std::fs::remove_file(&p);
    }
    attrib(&["-r"], dir);
    Ok(json!(true))
}

pub async fn set(a: &Args) -> R {
    let (folder, image) = (a.s(0)?, a.s(1)?);
    tokio::task::spawn_blocking(move || set_sync(&folder, &image)).await.map_err(err)?
}

pub async fn clear(a: &Args) -> R {
    let folder = a.s(0)?;
    tokio::task::spawn_blocking(move || clear_sync(&folder)).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picture_becomes_a_folder_icon_and_can_be_taken_away() {
        let d = std::env::temp_dir().join(format!("dogfile-icon-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let img = image::RgbaImage::from_pixel(300, 120, image::Rgba([200, 30, 30, 255]));
        let pic = d.join("cover.png");
        img.save(&pic).unwrap();
        let r = set_sync(&d.to_string_lossy(), &pic.to_string_lossy()).unwrap();
        assert!(Path::new(r["icon"].as_str().unwrap()).exists());
        assert!(ours(&d));
        assert!(clear_sync(&d.to_string_lossy()).unwrap() == json!(true));
        assert!(!d.join(ICO).exists() && !d.join(INI).exists());
        // a desktop.ini that is not ours is never touched
        std::fs::write(d.join(INI), "[.ShellClassInfo]\r\nIconFile=other.ico\r\n").unwrap();
        assert!(set_sync(&d.to_string_lossy(), &pic.to_string_lossy()).is_err());
        assert!(clear_sync(&d.to_string_lossy()).unwrap() == json!(false));
        std::fs::remove_dir_all(&d).ok();
    }
}
