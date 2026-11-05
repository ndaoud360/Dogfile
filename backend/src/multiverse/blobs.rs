// New content written in a what-if copy (a text edit, a new file) is kept as a blob named by the SHA-256 of what is in it.
// Two things with the same content are one blob, a blob can't be half written (it is made beside and renamed into place),
// and what is read back is always checked against its name, so a damaged blob is never written into anyone's folder.
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// the biggest new content one change can hold
pub const MAX_BLOB: u64 = 32 << 20;
/// the most new content one what-if copy can hold
pub const MAX_TOTAL: u64 = 256 << 20;

pub fn dir(data: &Path) -> PathBuf {
    super::reality::dir(data).join("blobs")
}
/// where the blobs are, from the journals folder (so a journal can be finished without anything else being known)
pub fn dir_of_jdir(jdir: &Path) -> PathBuf {
    jdir.parent().map(|p| p.join("blobs")).unwrap_or_else(|| jdir.join("blobs"))
}
pub fn valid(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn path_in(blobs: &Path, id: &str) -> PathBuf {
    blobs.join(id)
}
fn hex(d: &[u8]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn hash_bytes(b: &[u8]) -> String {
    hex(&Sha256::digest(b))
}
/// the hash and size of a file on disk, read in pieces
pub fn hash_file(p: &Path) -> std::io::Result<(String, u64)> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut n = 0u64;
    loop {
        let k = f.read(&mut buf)?;
        if k == 0 {
            break;
        }
        h.update(&buf[..k]);
        n += k as u64;
    }
    Ok((hex(&h.finalize()), n))
}

/// Keep some new content. Returns its name and size.
pub fn store(data: &Path, bytes: &[u8]) -> Result<(String, u64), String> {
    if bytes.len() as u64 > MAX_BLOB {
        return Err("That is too much new content for one file".into());
    }
    let id = hash_bytes(bytes);
    let d = dir(data);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let final_p = path_in(&d, &id);
    // already kept, and whole (checked by reading it; touched, so that it isn't taken for old and removed before its change is added)
    if matches!(hash_file(&final_p), Ok((h, n)) if h == id && n == bytes.len() as u64) {
        let _ = filetime::set_file_mtime(&final_p, filetime::FileTime::now());
        return Ok((id, bytes.len() as u64));
    }
    let tmp = d.join(format!("{id}.tmp-{}", super::reality::new_id()));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    if let Err(e) = std::fs::rename(&tmp, &final_p) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok((id, bytes.len() as u64))
}

/// Is this blob there, whole, and exactly what its name says?
pub fn verify(blobs: &Path, id: &str, size: u64) -> bool {
    valid(id) && matches!(hash_file(&path_in(blobs, id)), Ok((h, n)) if h == id && n == size)
}
/// is it there with this size (a quick look, used when a change is added)
pub fn has(data: &Path, id: &str, size: u64) -> bool {
    valid(id) && std::fs::metadata(path_in(&dir(data), id)).map(|m| m.is_file() && m.len() == size).unwrap_or(false)
}
pub fn read(data: &Path, id: &str) -> Result<Vec<u8>, String> {
    if !valid(id) {
        return Err("bad blob".into());
    }
    let b = std::fs::read(path_in(&dir(data), id)).map_err(|_| "The new content isn’t there any more".to_string())?;
    if hash_bytes(&b) != id {
        return Err("The new content is damaged".into());
    }
    Ok(b)
}

/// Remove the blobs no what-if copy uses any more.
pub fn gc(data: &Path, keep: &std::collections::HashSet<String>, min_age: u64) {
    let Ok(rd) = std::fs::read_dir(dir(data)) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        // a half-made one left by a stop; only old ones, so one being made right now is left alone
        if name.contains(".tmp-") {
            let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() > 3600).unwrap_or(false);
            if old {
                let _ = std::fs::remove_file(e.path());
            }
            continue;
        }
        if valid(&name) && !keep.contains(&name) {
            let young = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() < min_age).unwrap_or(false);
            if !young {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}
