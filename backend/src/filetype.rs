// "What is this?": tells what a file really is from what is inside it (its first and last bytes, the names inside a zip, the
// streams inside an old Office file, the start of a text), for files with no extension or a wrong one. The answer carries
// the extension to add and how sure it is: a magic number is "sure"; a guess from the look of a text is not.
use crate::args::{Args, R};
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom};

#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub ext: &'static str,
    pub label: &'static str,
    pub group: &'static str,
    pub sure: bool,
    pub note: Option<String>,
}
fn f(ext: &'static str, label: &'static str, group: &'static str) -> Option<Found> {
    Some(Found { ext, label, group, sure: true, note: None })
}
fn maybe(ext: &'static str, label: &'static str, group: &'static str, note: &str) -> Option<Found> {
    Some(Found { ext, label, group, sure: false, note: Some(note.to_string()) })
}

fn at(d: &[u8], o: usize, sig: &[u8]) -> bool {
    d.len() >= o + sig.len() && &d[o..o + sig.len()] == sig
}
fn find(d: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && d.windows(needle.len()).any(|w| w == needle)
}
fn utf16(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(|c| c.to_le_bytes()).collect()
}

/// a TIFF-style header's first directory: the Make text and whether it has the DNG tag
fn tiff_info(d: &[u8]) -> (String, bool) {
    let le = match d.get(0..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return (String::new(), false),
    };
    let u16at = |o: usize| d.get(o..o + 2).map(|b| if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) });
    let u32at = |o: usize| d.get(o..o + 4).map(|b| if le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) });
    let Some(ifd) = u32at(4) else { return (String::new(), false) };
    let ifd = ifd as usize;
    let Some(n) = u16at(ifd) else { return (String::new(), false) };
    let (mut make, mut dng) = (String::new(), false);
    for k in 0..(n as usize).min(200) {
        let e = ifd + 2 + k * 12;
        match u16at(e) {
            Some(0xC612) => dng = true,
            Some(0x010F) => {
                let cnt = u32at(e + 4).unwrap_or(0) as usize;
                let off = if cnt <= 4 { e + 8 } else { u32at(e + 8).unwrap_or(0) as usize };
                if let Some(b) = d.get(off..off + cnt.min(64)) {
                    make = String::from_utf8_lossy(b).trim_matches(char::from(0)).trim().to_string();
                }
            }
            _ => {}
        }
    }
    (make, dng)
}

fn zip_kind(path: &str) -> Option<Found> {
    let file = std::fs::File::open(path).ok()?;
    let mut z = zip::ZipArchive::new(file).ok()?;
    let names: Vec<String> = z.file_names().take(4000).filter_map(|n| n.ok().map(|c| c.to_string())).collect();
    let has = |p: &str| names.iter().any(|n| n == p || n.starts_with(p));
    // OpenDocument and EPUB keep their type in a "mimetype" file
    let mime = z.by_name("mimetype").ok().and_then(|mut e| { let mut s = String::new(); e.read_to_string(&mut s).ok()?; Some(s) }).unwrap_or_default();
    let mime = mime.trim();
    if let Some(m) = mime.strip_prefix("application/vnd.oasis.opendocument.") {
        return match m {
            "text" => f("odt", "OpenDocument text document", "Documents"),
            "text-template" => f("ott", "OpenDocument text template", "Documents"),
            "spreadsheet" => f("ods", "OpenDocument spreadsheet", "Documents"),
            "spreadsheet-template" => f("ots", "OpenDocument spreadsheet template", "Documents"),
            "presentation" => f("odp", "OpenDocument presentation", "Documents"),
            "graphics" => f("odg", "OpenDocument drawing", "Documents"),
            _ => f("zip", "OpenDocument file", "Archives"),
        };
    }
    if mime == "application/epub+zip" {
        return f("epub", "EPUB e-book", "Documents");
    }
    if has("word/") {
        let ct = z.by_name("[Content_Types].xml").ok().and_then(|mut e| { let mut s = String::new(); e.read_to_string(&mut s).ok()?; Some(s) }).unwrap_or_default();
        let macros = has("word/vbaProject.bin");
        return if ct.contains("template.macroEnabled") { f("dotm", "Word macro-enabled template", "Documents") } else if ct.contains("document.template") || ct.contains("wordprocessingml.template") { f("dotx", "Word template", "Documents") } else if macros { f("docm", "Word macro-enabled document", "Documents") } else { f("docx", "Word document", "Documents") };
    }
    if has("xl/") {
        let ct = z.by_name("[Content_Types].xml").ok().and_then(|mut e| { let mut s = String::new(); e.read_to_string(&mut s).ok()?; Some(s) }).unwrap_or_default();
        return if has("xl/vbaProject.bin") { f("xlsm", "Excel macro-enabled workbook", "Documents") } else if ct.contains("spreadsheetml.template") { f("xltx", "Excel template", "Documents") } else { f("xlsx", "Excel workbook", "Documents") };
    }
    if has("ppt/") {
        let ct = z.by_name("[Content_Types].xml").ok().and_then(|mut e| { let mut s = String::new(); e.read_to_string(&mut s).ok()?; Some(s) }).unwrap_or_default();
        return if ct.contains("slideshow") { f("ppsx", "PowerPoint slide show", "Documents") } else if ct.contains("presentationml.template") { f("potx", "PowerPoint template", "Documents") } else if has("ppt/vbaProject.bin") { f("pptm", "PowerPoint macro-enabled presentation", "Documents") } else { f("pptx", "PowerPoint presentation", "Documents") };
    }
    if has("visio/") {
        return f("vsdx", "Visio drawing", "Documents");
    }
    if has("3D/3dmodel.model") {
        return f("3mf", "3D Manufacturing Format model", "3D models");
    }
    if has("AndroidManifest.xml") {
        return f("apk", "Android app package", "Archives");
    }
    if has("META-INF/MANIFEST.MF") {
        return f("jar", "Java archive", "Archives");
    }
    if has("mergedimage.png") && has("stack.xml") {
        return f("ora", "OpenRaster image", "Pictures");
    }
    if has("[Content_Types].xml") && has("_rels/") {
        return maybe("zip", "Zip archive holding an Open Packaging document", "Archives", "It looks like a zip of an Office-style package, but not Word, Excel or PowerPoint.");
    }
    f("zip", "Zip archive", "Archives")
}

fn ole_kind(d: &[u8]) -> Option<Found> {
    let has = |s: &str| find(d, &utf16(s));
    if has("WordDocument") {
        return f("doc", "Word 97–2003 document", "Documents");
    }
    if has("Workbook") || has("Book") && has("SummaryInformation") && !has("PowerPoint Document") {
        return f("xls", "Excel 97–2003 workbook", "Documents");
    }
    if has("PowerPoint Document") {
        return f("ppt", "PowerPoint 97–2003 presentation", "Documents");
    }
    if has("__properties_version1.0") || has("__substg1.0_") {
        return f("msg", "Outlook message", "Email");
    }
    if has("VisioDocument") {
        return f("vsd", "Visio drawing", "Documents");
    }
    if has("MSProject") || find(d, b"Microsoft Project") || has("Microsoft Project") {
        return f("mpp", "Microsoft Project file", "Documents");
    }
    if has("WksSSWorkBook") || has("CONTENTS") && has("WksSS") {
        return f("wps", "Microsoft Works document", "Documents");
    }
    if has("Windows Installer") || has("SummaryInformation") && find(d, b"Installer") {
        return maybe("msi", "Windows Installer package", "Programs", "An old Office-style container; the installer wording suggests a Windows installer.");
    }
    maybe("", "Old Microsoft compound file (Word, Excel, PowerPoint, Outlook, Visio, Project or an installer)", "Documents", "Dogfile can't tell which program it belongs to.")
}

/// what is at the start of `d` (up to 64 KB) and, for a few types, at the end (`tail`); `path` lets zips be opened
pub fn sniff(path: &str, d: &[u8], tail: &[u8], size: u64) -> Option<Found> {
    if d.is_empty() {
        return maybe("", "An empty file", "Other", "There is nothing in it.");
    }
    // ---- pictures
    if at(d, 0, &[0xFF, 0xD8, 0xFF]) {
        return f("jpg", "JPEG picture", "Pictures");
    }
    if at(d, 0, b"\x89PNG\r\n\x1a\n") {
        return if find(&d[..d.len().min(4096)], b"acTL") { f("apng", "Animated PNG", "Pictures") } else { f("png", "PNG picture", "Pictures") };
    }
    if at(d, 0, b"GIF87a") || at(d, 0, b"GIF89a") {
        return f("gif", "GIF picture", "Pictures");
    }
    if at(d, 0, b"RIFF") && at(d, 8, b"WEBP") {
        return f("webp", "WebP picture", "Pictures");
    }
    if at(d, 0, b"8BPS") {
        return if at(d, 4, &[0, 2]) { f("psb", "Photoshop large document", "Pictures") } else { f("psd", "Photoshop document", "Pictures") };
    }
    if at(d, 0, b"DDS ") {
        return f("dds", "DirectDraw texture", "Pictures");
    }
    if at(d, 0, &[0x76, 0x2F, 0x31, 0x01]) {
        return f("exr", "OpenEXR picture", "Pictures");
    }
    if at(d, 0, b"#?RADIANCE") || at(d, 0, b"#?RGBE") {
        return f("hdr", "Radiance HDR picture", "Pictures");
    }
    if at(d, 0, b"qoif") {
        return f("qoi", "QOI picture", "Pictures");
    }
    if at(d, 0, b"farbfeld") {
        return f("ff", "Farbfeld picture", "Pictures");
    }
    if at(d, 0, &[0xFF, 0x0A]) || at(d, 0, &[0, 0, 0, 0x0C, b'J', b'X', b'L', b' ']) {
        return f("jxl", "JPEG XL picture", "Pictures");
    }
    if at(d, 0, &[0, 0, 0, 0x0C, b'j', b'P', b' ', b' ']) {
        return f("jp2", "JPEG 2000 picture", "Pictures");
    }
    if at(d, 0, &[0xFF, 0x4F, 0xFF, 0x51]) {
        return f("j2k", "JPEG 2000 codestream", "Pictures");
    }
    if at(d, 0, &[0, 0, 1, 0]) && d.len() > 6 && d[4] > 0 {
        return f("ico", "Windows icon", "Pictures");
    }
    if at(d, 0, &[0, 0, 2, 0]) && d.len() > 6 && d[4] > 0 {
        return f("cur", "Windows cursor", "Pictures");
    }
    if at(d, 0, b"BM") && d.len() > 18 && matches!(u32::from_le_bytes([d[14], d[15], d[16], d[17]]), 12 | 40 | 52 | 56 | 64 | 108 | 124) {
        return f("bmp", "Bitmap picture", "Pictures");
    }
    if d.len() > 3 && d[0] == b'P' && matches!(d[2], b'\n' | b' ' | b'\r' | b'\t') {
        match d[1] {
            b'1' | b'4' => return f("pbm", "Portable bitmap", "Pictures"),
            b'2' | b'5' => return f("pgm", "Portable graymap", "Pictures"),
            b'3' | b'6' => return f("ppm", "Portable pixmap", "Pictures"),
            b'7' => return f("pam", "Portable arbitrary map", "Pictures"),
            _ => {}
        }
    }
    if at(d, 0, &[0x0A, 0x05, 0x01, 0x08]) || at(d, 0, &[0x0A, 0x02, 0x01, 0x08]) || at(d, 0, &[0x0A, 0x00, 0x01, 0x08]) {
        return f("pcx", "PCX picture", "Pictures");
    }
    if at(d, 0, &[0x01, 0xDA]) {
        return f("sgi", "SGI picture", "Pictures");
    }
    if at(d, 0, b"FUJIFILMCCD-RAW") {
        return f("raf", "Fujifilm RAW photo", "Camera RAW");
    }
    if at(d, 0, b"MRM\0") {
        return f("mrw", "Minolta RAW photo", "Camera RAW");
    }
    if at(d, 0, b"FOVb") {
        return f("x3f", "Sigma RAW photo", "Camera RAW");
    }
    if at(d, 0, b"IIRO") || at(d, 0, b"IIRS") || at(d, 0, b"MMOR") {
        return f("orf", "Olympus RAW photo", "Camera RAW");
    }
    if at(d, 0, b"IIU\0") || at(d, 0, b"IIU") {
        return f("rw2", "Panasonic RAW photo", "Camera RAW");
    }
    if at(d, 0, b"II*\0") || at(d, 0, b"MM\0*") {
        if at(d, 8, b"CR") && at(d, 0, b"II*\0") {
            return f("cr2", "Canon RAW photo", "Camera RAW");
        }
        let (make, dng) = tiff_info(d);
        if dng {
            return f("dng", "Digital Negative photo", "Camera RAW");
        }
        let m = make.to_lowercase();
        let raw = |e: &'static str, l: &'static str| maybe(e, l, "Camera RAW", &format!("Made by “{make}”: if this is a RAW photo it is this type; if it is an ordinary TIFF, use tif."));
        if m.contains("nikon") {
            return raw("nef", "Nikon RAW photo");
        }
        if m.contains("sony") {
            return raw("arw", "Sony RAW photo");
        }
        if m.contains("pentax") || m.contains("ricoh imaging") {
            return raw("pef", "Pentax RAW photo");
        }
        if m.contains("samsung") {
            return raw("srw", "Samsung RAW photo");
        }
        if m.contains("canon") {
            return raw("cr2", "Canon RAW photo");
        }
        return f("tif", "TIFF picture", "Pictures");
    }
    if at(d, 128, b"DICM") {
        return f("dcm", "DICOM medical image", "Pictures");
    }
    if at(d, 40, b" EMF") {
        return f("emf", "Enhanced Windows metafile", "Pictures");
    }
    if at(d, 0, &[0xD7, 0xCD, 0xC6, 0x9A]) {
        return f("wmf", "Windows metafile", "Pictures");
    }
    if at(d, 0, b"ARRI") {
        return f("ari", "ARRIRAW picture", "Camera RAW");
    }
    // tga has no header magic, but a footer
    if tail.len() >= 18 && find(&tail[tail.len() - 18..], b"TRUEVISION-XFILE") {
        return f("tga", "Targa picture", "Pictures");
    }
    // ---- documents
    if at(d, 0, b"%PDF-") {
        return f("pdf", "PDF document", "Documents");
    }
    if at(d, 0, b"%!PS") {
        return f("ps", "PostScript document", "Documents");
    }
    if at(d, 0, b"{\\rtf") {
        return f("rtf", "Rich Text document", "Documents");
    }
    if at(d, 0, &[0xFF, b'W', b'P', b'C']) {
        return f("wpd", "WordPerfect document", "Documents");
    }
    if at(d, 0, &[0x78, 0x9F, 0x3E, 0x22]) {
        return f("dat", "Winmail.dat (mail attachments from Outlook)", "Email");
    }
    if at(d, 0, b"AT&TFORM") {
        return f("djvu", "DjVu document", "Documents");
    }
    if at(d, 60, b"BOOKMOBI") {
        return f("mobi", "Kindle e-book", "Documents");
    }
    if at(d, 0, &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        // the directory of an old Office file can be anywhere in it: look in what was read
        return ole_kind(d);
    }
    // ---- audio / video
    if at(d, 0, b"ID3") {
        return f("mp3", "MP3 audio", "Audio");
    }
    if at(d, 0, b"fLaC") {
        return f("flac", "FLAC audio", "Audio");
    }
    if at(d, 0, b"OggS") {
        let head = &d[..d.len().min(128)];
        return if find(head, b"OpusHead") { f("opus", "Opus audio", "Audio") } else if find(head, b"\x01vorbis") { f("ogg", "Ogg Vorbis audio", "Audio") } else if find(head, b"theora") { f("ogv", "Ogg video", "Video") } else if find(head, b"Speex") { f("spx", "Speex audio", "Audio") } else if find(head, b"FLAC") { f("oga", "Ogg FLAC audio", "Audio") } else { f("ogg", "Ogg media", "Audio") };
    }
    if at(d, 0, b"RIFF") && at(d, 8, b"WAVE") {
        return f("wav", "WAVE audio", "Audio");
    }
    if at(d, 0, b"RIFF") && at(d, 8, b"AVI ") {
        return f("avi", "AVI video", "Video");
    }
    if at(d, 0, b"FORM") && at(d, 8, b"AIFF") {
        return f("aiff", "AIFF audio", "Audio");
    }
    if at(d, 0, b"FORM") && at(d, 8, b"AIFC") {
        return f("aifc", "Compressed AIFF audio", "Audio");
    }
    if at(d, 0, b"MThd") {
        return f("mid", "MIDI music", "Audio");
    }
    if at(d, 0, b".snd") {
        return f("au", "Sun/NeXT audio", "Audio");
    }
    if at(d, 0, b"wvpk") {
        return f("wv", "WavPack audio", "Audio");
    }
    if at(d, 0, b"MAC ") {
        return f("ape", "Monkey's Audio", "Audio");
    }
    if at(d, 0, b"TTA1") {
        return f("tta", "True Audio", "Audio");
    }
    if at(d, 0, b"caff") {
        return f("caf", "Core Audio file", "Audio");
    }
    if at(d, 0, b"DSD ") {
        return f("dsf", "DSD audio", "Audio");
    }
    if at(d, 0, b"MPCK") || at(d, 0, b"MP+") {
        return f("mpc", "Musepack audio", "Audio");
    }
    if at(d, 0, b"Creative Voice File") {
        return f("voc", "Creative Voice audio", "Audio");
    }
    if at(d, 0, b"#!AMR") {
        return f("amr", "AMR audio", "Audio");
    }
    if at(d, 0, b".RMF") {
        return f("rm", "RealMedia", "Video");
    }
    if at(d, 0, b".ra\xFD") {
        return f("ra", "RealAudio", "Audio");
    }
    if at(d, 0, &[0x72, 0x69, 0x66, 0x66, 0x2E, 0x91, 0xCF, 0x11]) {
        return f("w64", "Sony Wave64 audio", "Audio");
    }
    if at(d, 0, &[0x0B, 0x77]) {
        return f("ac3", "Dolby Digital audio", "Audio");
    }
    if at(d, 0, &[0x7F, 0xFE, 0x80, 0x01]) {
        return f("dts", "DTS audio", "Audio");
    }
    if at(d, 0, &[0x1A, 0x45, 0xDF, 0xA3]) {
        let head = &d[..d.len().min(64)];
        return if find(head, b"webm") { f("webm", "WebM video", "Video") } else { f("mkv", "Matroska video", "Video") };
    }
    if at(d, 0, b"FLV\x01") {
        return f("flv", "Flash video", "Video");
    }
    if at(d, 0, &[0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11]) {
        let video = find(d, &[0xC0, 0xEF, 0x19, 0xBC, 0x4D, 0x5B, 0xCF, 0x11, 0xA8, 0xFD, 0x00, 0x80, 0x5F, 0x5C, 0x44, 0x2B]);
        let wmv = find(d, &utf16("Windows Media Video")) || find(d, b"WMV");
        return if video || wmv { f("wmv", "Windows Media video", "Video") } else { f("wma", "Windows Media audio", "Audio") };
    }
    if at(d, 0, &[0, 0, 1, 0xBA]) {
        return f("mpg", "MPEG video", "Video");
    }
    if at(d, 0, &[0, 0, 1, 0xB3]) {
        return f("m2v", "MPEG video stream", "Video");
    }
    if at(d, 0, b"BIK") || at(d, 0, b"KB2") {
        return f("bik", "Bink video", "Video");
    }
    if at(d, 0, b"NSVf") {
        return f("nsv", "Nullsoft video", "Video");
    }
    if at(d, 0, &[0x06, 0x0E, 0x2B, 0x34]) {
        return f("mxf", "Material Exchange video", "Video");
    }
    if d.len() >= 564 && d[0] == 0x47 && d[188] == 0x47 && d[376] == 0x47 {
        return f("ts", "MPEG transport stream video", "Video");
    }
    if d.len() >= 580 && d[4] == 0x47 && d[196] == 0x47 && d[388] == 0x47 {
        return f("m2ts", "Blu-ray (BDAV) video", "Video");
    }
    if at(d, 4, b"ftyp") && d.len() >= 12 {
        let brand = &d[8..12];
        return match brand {
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1" => f("heic", "HEIF picture", "Pictures"),
            b"avif" | b"avis" => f("avif", "AVIF picture", "Pictures"),
            b"crx " => f("cr3", "Canon RAW 3 photo", "Camera RAW"),
            b"M4A " | b"M4P " => f("m4a", "MPEG-4 audio", "Audio"),
            b"M4B " => f("m4b", "MPEG-4 audiobook", "Audio"),
            b"qt  " => f("mov", "QuickTime movie", "Video"),
            b"M4V " | b"M4VH" | b"M4VP" => f("m4v", "iTunes video", "Video"),
            b"3g2a" | b"3g2b" | b"3g2c" => f("3g2", "3GPP2 video", "Video"),
            b"3gp4" | b"3gp5" | b"3gp6" | b"3gp7" | b"3ge6" | b"3ge7" | b"3gg6" => f("3gp", "3GPP video", "Video"),
            b"F4V " => f("f4v", "Flash MP4 video", "Video"),
            _ => f("mp4", "MPEG-4 video", "Video"),
        };
    }
    if d.len() > 2 && d[0] == 0xFF && (d[1] & 0xF6) == 0xF0 {
        return f("aac", "AAC audio", "Audio");
    }
    if d.len() > 2 && d[0] == 0xFF && (d[1] & 0xE0) == 0xE0 && (d[1] & 0x06) != 0 && (d[2] >> 4) != 0xF {
        return maybe("mp3", "MP3 (MPEG audio) without an ID3 tag", "Audio", "It begins like MPEG audio frames; MP2 and MP1 look the same.");
    }
    // ---- archives and programs
    if at(d, 0, b"PK\x03\x04") || at(d, 0, b"PK\x05\x06") {
        return zip_kind(path);
    }
    if at(d, 0, b"Rar!\x1A\x07") {
        return f("rar", "RAR archive", "Archives");
    }
    if at(d, 0, &[b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C]) {
        return f("7z", "7-Zip archive", "Archives");
    }
    if at(d, 0, &[0x1F, 0x8B]) {
        return f("gz", "Gzip archive", "Archives");
    }
    if at(d, 0, b"BZh") {
        return f("bz2", "Bzip2 archive", "Archives");
    }
    if at(d, 0, &[0xFD, b'7', b'z', b'X', b'Z', 0]) {
        return f("xz", "XZ archive", "Archives");
    }
    if at(d, 0, &[0x28, 0xB5, 0x2F, 0xFD]) {
        return f("zst", "Zstandard archive", "Archives");
    }
    if at(d, 0, b"MSCF") {
        return f("cab", "Windows cabinet", "Archives");
    }
    if at(d, 257, b"ustar") {
        return f("tar", "TAR archive", "Archives");
    }
    if at(d, 0, b"MSWIM\0\0\0") {
        return f("wim", "Windows imaging file", "Archives");
    }
    if at(d, 0, &[0x1F, 0x9D]) {
        return f("z", "Unix compressed file", "Archives");
    }
    if at(d, 0, &[0x60, 0xEA]) {
        return f("arj", "ARJ archive", "Archives");
    }
    if at(d, 2, b"-lh") || at(d, 2, b"-lz") {
        return f("lzh", "LHA archive", "Archives");
    }
    if at(d, 0, b"!<arch>\n") {
        return if find(&d[..d.len().min(256)], b"debian-binary") { f("deb", "Debian package", "Archives") } else { f("a", "Unix archive (ar)", "Archives") };
    }
    if at(d, 0, b"xar!") {
        return f("xar", "XAR archive", "Archives");
    }
    if at(d, 0, b"ITSF") {
        return f("chm", "Compiled HTML help", "Documents");
    }
    if at(d, 0, &[0xED, 0xAB, 0xEE, 0xDB]) {
        return f("rpm", "RPM package", "Archives");
    }
    if at(d, 0, b"conectix") || tail.len() >= 512 && find(&tail[tail.len() - 512..], b"conectix") {
        return f("vhd", "Virtual hard disk", "Archives");
    }
    if tail.len() >= 512 && find(&tail[tail.len() - 512..], b"koly") {
        return f("dmg", "Apple disk image", "Archives");
    }
    if (size > 0x8006) && at(d, 0x8001, b"CD001") {
        return f("iso", "Disc image", "Archives");
    }
    if at(d, 0, b"MZ") {
        if d.len() > 0x40 {
            let pe = u32::from_le_bytes([d[0x3C], d[0x3D], d[0x3E], d[0x3F]]) as usize;
            if at(d, pe, b"PE\0\0") && d.len() > pe + 24 {
                let ch = u16::from_le_bytes([d[pe + 22], d[pe + 23]]);
                return if ch & 0x2000 != 0 { f("dll", "Windows library", "Programs") } else { f("exe", "Windows program", "Programs") };
            }
        }
        return maybe("exe", "Windows (DOS-style) program", "Programs", "It starts like a program file.");
    }
    if at(d, 0, &[0x7F, b'E', b'L', b'F']) {
        return maybe("", "Linux program or library (ELF)", "Programs", "Usually has no extension.");
    }
    if at(d, 0, &[0xCF, 0xFA, 0xED, 0xFE]) || at(d, 0, &[0xCE, 0xFA, 0xED, 0xFE]) || at(d, 0, &[0xCA, 0xFE, 0xBA, 0xBE]) {
        return maybe("", "macOS program or library (Mach-O)", "Programs", "Usually has no extension.");
    }
    if at(d, 0, &[0x4C, 0, 0, 0, 0x01, 0x14, 0x02, 0]) {
        return f("lnk", "Windows shortcut", "Programs");
    }
    if at(d, 0, b"SQLite format 3\0") {
        return f("sqlite", "SQLite database", "Data");
    }
    if at(d, 0, b"regf") {
        return maybe("", "Windows registry hive", "Data", "Registry hives have no extension.");
    }
    // ---- fonts
    if at(d, 0, b"OTTO") {
        return f("otf", "OpenType font", "Fonts");
    }
    if at(d, 0, &[0, 1, 0, 0, 0]) || at(d, 0, b"true") {
        return f("ttf", "TrueType font", "Fonts");
    }
    if at(d, 0, b"ttcf") {
        return f("ttc", "TrueType font collection", "Fonts");
    }
    if at(d, 0, b"wOFF") {
        return f("woff", "Web font (WOFF)", "Fonts");
    }
    if at(d, 0, b"wOF2") {
        return f("woff2", "Web font (WOFF2)", "Fonts");
    }
    // ---- 3D
    if at(d, 0, b"glTF") {
        return f("glb", "glTF 3D model (binary)", "3D models");
    }
    if at(d, 0, b"Kaydara FBX Binary") {
        return f("fbx", "FBX 3D model", "3D models");
    }
    if at(d, 0, b"ply\n") || at(d, 0, b"ply\r\n") {
        return f("ply", "PLY 3D model", "3D models");
    }
    if at(d, 0, b"AC10") && d.len() > 6 && d[4].is_ascii_digit() {
        return f("dwg", "AutoCAD drawing", "3D models");
    }
    if d.len() >= 84 && !d[..5].eq_ignore_ascii_case(b"solid") {
        let n = u32::from_le_bytes([d[80], d[81], d[82], d[83]]) as u64;
        if n > 0 && 84 + n * 50 == size {
            return maybe("stl", "STL 3D model (binary)", "3D models", "The size matches a list of triangles exactly.");
        }
    }
    text_kind(d)
}

fn text_kind(d: &[u8]) -> Option<Found> {
    // text? (UTF-8, UTF-16 with a mark, or plain 8-bit with no control bytes)
    let (text, utf16) = if at(d, 0, &[0xFF, 0xFE]) || at(d, 0, &[0xFE, 0xFF]) {
        let le = d[0] == 0xFF;
        let units: Vec<u16> = d[2..].chunks_exact(2).map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect();
        (String::from_utf16_lossy(&units), true)
    } else {
        let head = &d[..d.len().min(16384)];
        let controls = head.iter().filter(|&&b| b < 9 || (b > 13 && b < 32 && b != 27)).count();
        if controls > 0 && controls * 100 > head.len() {
            return maybe("", "Binary data", "Other", "Dogfile doesn't recognise this format.");
        }
        if head.contains(&0) {
            return maybe("", "Binary data", "Other", "Dogfile doesn't recognise this format.");
        }
        (String::from_utf8_lossy(head).trim_start_matches('\u{feff}').to_string(), false)
    };
    let _ = utf16;
    let t = text.trim_start();
    let lower: String = t.chars().take(600).collect::<String>().to_lowercase();
    if lower.starts_with("<?xml") || lower.starts_with('<') {
        if lower.contains("<svg") {
            return f("svg", "SVG vector picture", "Pictures");
        }
        if lower.contains("<collada") {
            return f("dae", "COLLADA 3D model", "3D models");
        }
        if lower.contains("<!doctype html") || lower.contains("<html") || lower.contains("<head") || lower.contains("<body") {
            return f("html", "Web page", "Web");
        }
        if lower.starts_with("<?xml") {
            return maybe("xml", "XML document", "Code", "It begins with an XML declaration.");
        }
        return maybe("html", "Web page or markup", "Web", "It starts with a tag.");
    }
    if t.starts_with("#!") {
        let line = t.lines().next().unwrap_or("").to_lowercase();
        return if line.contains("python") { maybe("py", "Python script", "Code", "Its first line names Python.") } else if line.contains("node") { maybe("js", "JavaScript (Node) script", "Code", "Its first line names Node.") } else if line.contains("ruby") { maybe("rb", "Ruby script", "Code", "Its first line names Ruby.") } else if line.contains("perl") { maybe("pl", "Perl script", "Code", "Its first line names Perl.") } else if line.contains("pwsh") || line.contains("powershell") { maybe("ps1", "PowerShell script", "Code", "Its first line names PowerShell.") } else { maybe("sh", "Shell script", "Code", "Its first line is a shell command line.") };
    }
    if t.starts_with("BEGIN:VCARD") {
        return f("vcf", "Contact card (vCard)", "Data");
    }
    if t.starts_with("BEGIN:VCALENDAR") {
        return f("ics", "Calendar (iCalendar)", "Data");
    }
    if t.starts_with("WEBVTT") {
        return f("vtt", "WebVTT subtitles", "Subtitles");
    }
    if t.starts_with("[Script Info]") {
        return f("ass", "Advanced SubStation subtitles", "Subtitles");
    }
    if t.starts_with("-----BEGIN ") {
        return maybe("pem", "PEM certificate or key", "Data", "It starts with a BEGIN line.");
    }
    if t.starts_with("solid ") || t.starts_with("solid\n") {
        return maybe("stl", "STL 3D model (text)", "3D models", "It starts with “solid”.");
    }
    if t.starts_with("ISO-10303-21") {
        return f("step", "STEP 3D model", "3D models");
    }
    if t.starts_with("From ") || t.starts_with("Received:") || (lower.contains("\nsubject:") && (lower.starts_with("from:") || lower.starts_with("to:") || lower.starts_with("date:") || lower.starts_with("message-id:") || lower.starts_with("mime-version:") || lower.starts_with("return-path:"))) {
        return maybe("eml", "E-mail message", "Email", "It begins with mail headers.");
    }
    if t.starts_with('{') || t.starts_with('[') {
        let ok = serde_json::from_str::<Value>(&text).is_ok() || text.trim_end().ends_with('}') || text.trim_end().ends_with(']');
        if ok {
            return maybe("json", "JSON data", "Code", "It is written like JSON.");
        }
    }
    // numbered subtitle blocks: "1", then "00:00:01,000 --> 00:00:02,000"
    {
        let mut lines = t.lines();
        let a = lines.next().unwrap_or("").trim();
        let b = lines.next().unwrap_or("");
        if a.chars().all(|c| c.is_ascii_digit()) && !a.is_empty() && b.contains("-->") {
            return f("srt", "SubRip subtitles", "Subtitles");
        }
    }
    let first: Vec<&str> = t.lines().take(8).collect();
    let commas: Vec<usize> = first.iter().map(|l| l.matches(',').count()).collect();
    if first.len() >= 2 && commas[0] >= 1 && commas.iter().all(|&c| c == commas[0]) {
        return maybe("csv", "Comma-separated table", "Documents", "Every line has the same number of commas.");
    }
    let tabs: Vec<usize> = first.iter().map(|l| l.matches('\t').count()).collect();
    if first.len() >= 2 && tabs[0] >= 1 && tabs.iter().all(|&c| c == tabs[0]) {
        return maybe("tsv", "Tab-separated table", "Documents", "Every line has the same number of tabs.");
    }
    if lower.starts_with("# ") || lower.contains("\n## ") || lower.contains("](http") {
        return maybe("md", "Markdown text", "Documents", "It uses Markdown headings or links.");
    }
    if t.lines().take(40).any(|l| l.starts_with("v ") || l.starts_with("vn ")) && t.lines().take(400).any(|l| l.starts_with("f ")) {
        return maybe("obj", "OBJ 3D model", "3D models", "It lists vertices (v) and faces (f).");
    }
    if lower.contains("function ") && (lower.contains("=>") || lower.contains("const ") || lower.contains("require(")) {
        return maybe("js", "JavaScript", "Code", "It looks like JavaScript.");
    }
    if lower.contains("def ") && lower.contains("import ") && lower.contains(":\n") {
        return maybe("py", "Python", "Code", "It looks like Python.");
    }
    if lower.contains("#include") {
        return maybe("c", "C or C++ source", "Code", "It has #include lines.");
    }
    if lower.contains("[section") || (first.iter().any(|l| l.starts_with('[') && l.trim_end().ends_with(']')) && first.iter().any(|l| l.contains('='))) {
        return maybe("ini", "Settings file (INI)", "Code", "It has [sections] with key=value lines.");
    }
    maybe("txt", "Plain text", "Documents", "It is readable text with no special structure.")
}

pub fn identify(path: &str) -> Result<Value, String> {
    let md = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if md.is_dir() {
        return Err("That is a folder".into());
    }
    let size = md.len();
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut head = vec![0u8; (size as usize).min(if size > 40_000_000 { 262_144 } else { 1_048_576 })];
    let n = file.read(&mut head).map_err(|e| e.to_string())?;
    head.truncate(n);
    let mut tail = vec![];
    if size > 600 {
        let take = 1024.min(size);
        if file.seek(SeekFrom::Start(size - take)).is_ok() {
            tail = vec![0u8; take as usize];
            let m = file.read(&mut tail).unwrap_or(0);
            tail.truncate(m);
        }
    }
    // ISO images keep their marker at 0x8001, beyond the first 32 KB: the head covers it (1 MB read)
    let found = sniff(path, &head, &tail, size);
    let current = std::path::Path::new(path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    Ok(match found {
        Some(f) => json!({
            "ext": f.ext, "label": f.label, "group": f.group, "sure": f.sure, "note": f.note, "current": current,
            // the extension already on the file is right when it names the same type (jpg/jpeg, tif/tiff, htm/html…) or the type's own family
            "matches": same_type(&current, f.ext),
            "size": size,
        }),
        None => json!({ "ext": "", "label": "Unknown", "group": "Other", "sure": false, "note": "Dogfile doesn't recognise this format.", "current": current, "matches": false, "size": size }),
    })
}
fn same_type(current: &str, found: &str) -> bool {
    if current.is_empty() || found.is_empty() {
        return false;
    }
    if current == found {
        return true;
    }
    let groups: &[&[&str]] = &[
        &["jpg", "jpeg", "jfif", "jpe"], &["tif", "tiff"], &["html", "htm", "xhtml"], &["mpg", "mpeg", "vob", "m2v"], &["ogg", "oga", "ogv", "ogm", "opus", "spx"],
        &["mid", "midi"], &["aif", "aiff", "aifc"], &["j2k", "jp2", "jpc", "jpx"], &["gz", "tgz", "taz"], &["bz2", "tbz", "tbz2"], &["xz", "txz"],
        &["mkv", "webm", "mka", "mk3d"], &["mp4", "m4v", "m4a", "m4b", "m4r", "mov", "qt", "3gp", "3g2", "f4v", "mp3"], &["wmv", "wma", "asf"],
        &["zip", "zipx", "jar", "war", "apk", "cbz", "pk3", "pk4", "pkz", "docx", "xlsx", "pptx", "epub", "odt", "ods", "odp", "3mf", "vsdx"],
        &["txt", "log", "md", "markdown", "csv", "tsv", "json", "xml", "ini", "cfg", "conf", "js", "py", "c", "h", "cpp", "sh", "rb", "pl", "ps1", "html", "htm", "css", "yml", "yaml", "toml", "sql", "srt", "vtt", "ass", "eml", "vcf", "ics", "pem", "obj", "stl", "svg", "bat", "cmd", "ts", "tsx", "jsx"],
        &["exe", "dll", "scr", "com", "msi"], &["cr2", "nef", "arw", "dng", "orf", "rw2", "pef", "srw", "raw", "tif", "tiff", "3fr", "fff", "iiq", "erf", "mef", "mos", "nrw", "rwl", "sr2", "srf", "kdc", "dcr", "bay", "crw", "x3f", "cr3", "raf", "mrw", "ari"],
        &["doc", "dot", "xls", "xlt", "ppt", "pps", "pot", "msg", "vsd", "vss", "vst", "mpp", "mpt", "wps", "msi"],
        &["docx", "docm", "dotx", "dotm"], &["xlsx", "xlsm", "xltx", "xltm", "xlsb"], &["pptx", "pptm", "ppsx", "ppsm", "potx", "potm"], &["odt", "ott"], &["ods", "ots", "fods"],
        &["ts", "m2ts", "mts", "trp", "m2t"], &["dat", "ts"], &["ttf", "otf", "ttc"], &["ico", "cur"], &["tar", "tgz", "ova"], &["lzh", "lha"], &["wpd", "wp", "wp5", "wp6", "wpt"],
        &["psd", "psb"], &["ply", "obj"], &["pbm", "pgm", "ppm", "pnm", "pam"],
    ];
    // text types match any text extension (a .cfg that is "plain text" is fine); the others need the same family
    let text_family = groups[15];
    if text_family.contains(&found) && text_family.contains(&current) {
        return true;
    }
    if found == "txt" || found == "html" {
        // a .conf, .rc, .whatever is text: not worth renaming to .txt
        return !matches!(current, "jpg" | "png" | "gif" | "zip" | "pdf" | "exe" | "mp3" | "mp4") && !current.is_empty() && is_probably_text_ext(current);
    }
    groups.iter().any(|g| g.contains(&current) && g.contains(&found))
}
fn is_probably_text_ext(e: &str) -> bool {
    !matches!(e, "jpg" | "jpeg" | "png" | "gif" | "zip" | "pdf" | "exe" | "mp3" | "mp4" | "mkv" | "avi" | "wav" | "flac" | "7z" | "rar" | "docx" | "xlsx" | "pptx" | "bmp" | "ico" | "webp" | "mov")
}

pub async fn identify_call(a: &Args) -> R {
    let p = a.s(0)?;
    tokio::task::spawn_blocking(move || identify(&p)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id(bytes: &[u8]) -> Found {
        sniff("", bytes, &[], bytes.len() as u64).expect("something")
    }
    #[test]
    fn pictures_and_media() {
        assert_eq!(id(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10]).ext, "jpg");
        assert_eq!(id(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").ext, "png");
        assert_eq!(id(b"GIF89a\x01\0").ext, "gif");
        assert_eq!(id(b"RIFF\x24\0\0\0WEBPVP8 ").ext, "webp");
        assert_eq!(id(b"RIFF\x24\0\0\0WAVEfmt ").ext, "wav");
        assert_eq!(id(b"ID3\x04\0\0\0\0\0\0").ext, "mp3");
        assert_eq!(id(b"fLaC\0\0\0\"").ext, "flac");
        assert_eq!(id(b"\0\0\0\x20ftypheic\0\0\0\0").ext, "heic");
        assert_eq!(id(b"\0\0\0\x20ftypisom\0\0\0\0").ext, "mp4");
        assert_eq!(id(b"\0\0\0\x14ftypqt  \0\0\0\0").ext, "mov");
        assert_eq!(id(b"\x1A\x45\xDF\xA3\x01\0\0\0\0\0\0\x1fB\x82\x84webm").ext, "webm");
        assert_eq!(id(b"%PDF-1.7\n").ext, "pdf");
        assert_eq!(id(b"8BPS\0\x01\0\0\0\0\0\0").ext, "psd");
        assert_eq!(id(b"8BPS\0\x02\0\0\0\0\0\0").ext, "psb");
        assert_eq!(id(b"glTF\x02\0\0\0").ext, "glb");
        assert_eq!(id(b"Rar!\x1A\x07\x00\xCF").ext, "rar");
        assert!(id(b"OggS\0\x02\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\x01\x13OpusHead").label.contains("Opus"));
    }
    #[test]
    fn text_by_look() {
        assert_eq!(id(b"#!/usr/bin/env python3\nprint(1)\n").ext, "py");
        assert_eq!(id(b"{\"a\": 1, \"b\": [1,2]}").ext, "json");
        assert_eq!(id(b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").ext, "svg");
        assert_eq!(id(b"<!DOCTYPE html><html><body>hi</body></html>").ext, "html");
        assert_eq!(id(b"1\n00:00:01,000 --> 00:00:02,000\nHello\n").ext, "srt");
        assert_eq!(id(b"WEBVTT\n\n00:00.000 --> 00:01.000\nHi").ext, "vtt");
        assert_eq!(id(b"BEGIN:VCARD\nVERSION:3.0\n").ext, "vcf");
        assert_eq!(id(b"name,age\nAnn,3\nBob,4\n").ext, "csv");
        assert_eq!(id(b"# Title\n\nSome words\n").ext, "md");
        assert_eq!(id(b"just some words here\n").ext, "txt");
        assert!(!id(b"just some words here\n").sure);
        assert_eq!(id(&[0u8; 0].iter().copied().chain(vec![1u8, 2, 3, 0, 5, 6, 7, 0, 9, 10, 0, 12, 13, 0, 0, 0, 1, 2]).collect::<Vec<u8>>()).ext, "");
    }
    #[test]
    fn same_type_rules() {
        assert!(same_type("jpeg", "jpg"));
        assert!(same_type("tif", "tiff"));
        assert!(same_type("cfg", "txt"));
        assert!(same_type("nef", "tif"));
        assert!(!same_type("", "jpg"));
        assert!(!same_type("txt", "jpg"));
        assert!(!same_type("jpg", "png"));
        assert!(same_type("docx", "zip"));
    }
    #[test]
    fn old_office_streams() {
        let mut d = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        d.extend_from_slice(&[0u8; 100]);
        d.extend_from_slice(&utf16("WordDocument"));
        assert_eq!(id(&d).ext, "doc");
        let mut d = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        d.extend_from_slice(&utf16("Workbook"));
        assert_eq!(id(&d).ext, "xls");
        let mut d = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        d.extend_from_slice(&utf16("PowerPoint Document"));
        assert_eq!(id(&d).ext, "ppt");
    }
    #[test]
    fn real_files_with_the_wrong_name() {
        let dir = std::env::temp_dir().join(format!("dogfile-ft-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // a docx made by hand: [Content_Types].xml + word/document.xml
        let p = dir.join("report");
        {
            use std::io::Write;
            let mut z = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("[Content_Types].xml", o).unwrap();
            z.write_all(b"<Types/>").unwrap();
            z.start_file("word/document.xml", o).unwrap();
            z.write_all(b"<w:document/>").unwrap();
            z.finish().unwrap();
        }
        let v = identify(p.to_str().unwrap()).unwrap();
        assert_eq!(v["ext"], "docx");
        assert_eq!(v["sure"], true);
        assert_eq!(v["matches"], false);
        let q = dir.join("odd.dat");
        std::fs::write(&q, b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").unwrap();
        let v = identify(q.to_str().unwrap()).unwrap();
        assert_eq!(v["ext"], "png");
        assert_eq!(v["matches"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
