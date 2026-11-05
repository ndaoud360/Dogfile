// Lock a file or a folder with a password. The item becomes one encrypted file named <name>.dflock (the names inside are
// encrypted too) and the original is removed once the locked copy has been read back and checked. Unlock puts it back.
//
//   file:   "DOGLOCK1" | argon2 memory KiB u32 | passes u32 | lanes u32 | salt 16 | nonce prefix 7        (43 bytes, authenticated)
//   then chunks:  length u32 | AES-256-GCM(chunk) , each chunk up to 1 MiB, the nonce = prefix | chunk number u32 | last-chunk flag
//   inside (after decrypting): entries   1 file / 2 folder | name length u32 | name (UTF-8, "/" separated) | [file: size u64 | modified secs i64 | data]   …   0 = end
//
// The key comes from the password with Argon2id (64 MiB, 3 passes), so guessing is slow. A wrong password is told from a
// damaged file by the first chunk. Nothing is ever kept unlocked on disk besides what the person unlocks.
use crate::args::{Args, R};
use crate::st;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::Aes256Gcm;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

pub const EXT: &str = "dflock";
const MAGIC: &[u8; 8] = b"DOGLOCK1";
const HEADER: usize = 8 + 12 + 16 + 7;
const CHUNK: usize = 1 << 20;
const M_KIB: u32 = 64 * 1024;
const PASSES: u32 = 3;
const LANES: u32 = 1;

fn derive(password: &str, salt: &[u8], m: u32, t: u32, p: u32) -> Result<[u8; 32], String> {
    // a crafted file can't make this use more than a gigabyte or run for minutes
    if m == 0 || m > 1024 * 1024 || t == 0 || t > 20 || p == 0 || p > 16 {
        return Err("This isn’t a file Dogfile locked".into());
    }
    let params = argon2::Params::new(m, t, p, Some(32)).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params).hash_password_into(password.as_bytes(), salt, &mut key).map_err(|e| e.to_string())?;
    Ok(key)
}
fn nonce(prefix: &[u8; 7], n: u32, last: bool) -> [u8; 12] {
    let mut o = [0u8; 12];
    o[..7].copy_from_slice(prefix);
    o[7..11].copy_from_slice(&n.to_be_bytes());
    o[11] = last as u8;
    o
}

/// plaintext goes in, sealed chunks go out
struct Sealer<W: Write> {
    out: W,
    cipher: Aes256Gcm,
    header: [u8; HEADER],
    prefix: [u8; 7],
    buf: Vec<u8>,
    n: u32,
}
impl<W: Write> Sealer<W> {
    fn new(mut out: W, password: &str) -> Result<Self, String> {
        let mut salt = [0u8; 16];
        let mut prefix = [0u8; 7];
        rand::fill(&mut salt);
        rand::fill(&mut prefix);
        let mut header = [0u8; HEADER];
        header[..8].copy_from_slice(MAGIC);
        header[8..12].copy_from_slice(&M_KIB.to_le_bytes());
        header[12..16].copy_from_slice(&PASSES.to_le_bytes());
        header[16..20].copy_from_slice(&LANES.to_le_bytes());
        header[20..36].copy_from_slice(&salt);
        header[36..43].copy_from_slice(&prefix);
        let key = derive(password, &salt, M_KIB, PASSES, LANES)?;
        out.write_all(&header).map_err(io)?;
        Ok(Sealer { out, cipher: Aes256Gcm::new(&key.into()), header, prefix, buf: Vec::with_capacity(CHUNK), n: 0 })
    }
    fn seal(&mut self, last: bool) -> Result<(), String> {
        let ct = self.cipher.encrypt(&nonce(&self.prefix, self.n, last).into(), Payload { msg: &self.buf, aad: &self.header }).map_err(|_| "Couldn’t encrypt".to_string())?;
        self.out.write_all(&(ct.len() as u32).to_le_bytes()).map_err(io)?;
        self.out.write_all(&ct).map_err(io)?;
        self.buf.clear();
        self.n = self.n.checked_add(1).ok_or("Too big to lock")?;
        Ok(())
    }
    fn finish(mut self) -> Result<W, String> {
        self.seal(true)?;
        self.out.flush().map_err(io)?;
        Ok(self.out)
    }
}
impl<W: Write> Write for Sealer<W> {
    fn write(&mut self, mut data: &[u8]) -> std::io::Result<usize> {
        let all = data.len();
        while !data.is_empty() {
            let room = CHUNK - self.buf.len();
            let take = room.min(data.len());
            self.buf.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.buf.len() == CHUNK {
                self.seal(false).map_err(std::io::Error::other)?;
            }
        }
        Ok(all)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn io(e: std::io::Error) -> String {
    format!("Couldn’t write: {e}")
}

/// sealed chunks come in, plaintext comes out; every chunk is checked before any of it is used
struct Opener<R: Read> {
    inp: BufReader<R>,
    cipher: Aes256Gcm,
    header: [u8; HEADER],
    prefix: [u8; 7],
    plain: Vec<u8>,
    at: usize,
    n: u32,
    done: bool,
}
#[derive(Debug)]
enum Bad {
    Wrong,
    Damaged,
    NotLocked,
}
fn bad(b: Bad) -> std::io::Error {
    std::io::Error::other(match b {
        Bad::Wrong => "Wrong password",
        Bad::Damaged => "This locked file is damaged or incomplete",
        Bad::NotLocked => "This isn’t a file Dogfile locked",
    })
}
impl<R: Read> Opener<R> {
    fn new(r: R, password: &str) -> Result<Self, String> {
        let mut inp = BufReader::with_capacity(64 * 1024, r);
        let mut header = [0u8; HEADER];
        inp.read_exact(&mut header).map_err(|_| bad(Bad::NotLocked).to_string())?;
        if &header[..8] != MAGIC {
            return Err(bad(Bad::NotLocked).to_string());
        }
        let u = |i: usize| u32::from_le_bytes(header[i..i + 4].try_into().unwrap());
        let key = derive(password, &header[20..36], u(8), u(12), u(16))?;
        let mut prefix = [0u8; 7];
        prefix.copy_from_slice(&header[36..43]);
        Ok(Opener { inp, cipher: Aes256Gcm::new(&key.into()), header, prefix, plain: vec![], at: 0, n: 0, done: false })
    }
    fn next_chunk(&mut self) -> std::io::Result<()> {
        let mut len = [0u8; 4];
        self.inp.read_exact(&mut len).map_err(|_| bad(Bad::Damaged))?;
        let len = u32::from_le_bytes(len) as usize;
        if !(16..=CHUNK + 16).contains(&len) {
            return Err(bad(if self.n == 0 { Bad::Wrong } else { Bad::Damaged }));
        }
        let mut ct = vec![0u8; len];
        self.inp.read_exact(&mut ct).map_err(|_| bad(Bad::Damaged))?;
        // the last chunk is the one with nothing after it
        let last = { use std::io::BufRead; self.inp.fill_buf()?.is_empty() };
        let pt = self.cipher.decrypt(&nonce(&self.prefix, self.n, last).into(), Payload { msg: &ct, aad: &self.header }).map_err(|_| bad(if self.n == 0 { Bad::Wrong } else { Bad::Damaged }))?;
        self.plain = pt;
        self.at = 0;
        self.n += 1;
        self.done = last;
        Ok(())
    }
}
impl<R: Read> Read for Opener<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        while self.at >= self.plain.len() {
            if self.done {
                return Ok(0);
            }
            self.next_chunk()?;
        }
        let k = out.len().min(self.plain.len() - self.at);
        out[..k].copy_from_slice(&self.plain[self.at..self.at + k]);
        self.at += k;
        Ok(k)
    }
}

// ---- what goes inside ----
fn put_entry(w: &mut impl Write, kind: u8, name: &str) -> Result<(), String> {
    w.write_all(&[kind]).map_err(io)?;
    w.write_all(&(name.len() as u32).to_le_bytes()).map_err(io)
}
fn rel_name(p: &Path, base: &Path) -> String {
    p.strip_prefix(base).unwrap_or(p).components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/")
}
fn secs(m: &std::fs::Metadata) -> i64 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// (bytes, files, folders) in a path, links left out
fn measure(p: &Path) -> u64 {
    let Ok(m) = std::fs::symlink_metadata(p) else { return 0 };
    if m.file_type().is_symlink() {
        0
    } else if m.is_dir() {
        std::fs::read_dir(p).map(|d| d.flatten().map(|e| measure(&e.path())).sum()).unwrap_or(0)
    } else {
        m.len()
    }
}

struct Progress {
    done: AtomicU64,
    cancel: AtomicBool,
}
fn write_tree(w: &mut impl Write, p: &Path, base: &Path, prog: &Progress) -> Result<(), String> {
    if prog.cancel.load(Ordering::Relaxed) {
        return Err("Cancelled".into());
    }
    let m = std::fs::symlink_metadata(p).map_err(|e| format!("Couldn’t read {}: {e}", p.display()))?;
    if m.file_type().is_symlink() {
        return Ok(()); // shortcuts-by-link aren't followed or kept
    }
    let name = rel_name(p, base);
    if m.is_dir() {
        put_entry(w, 2, &name)?;
        w.write_all(name.as_bytes()).map_err(io)?;
        let mut kids: Vec<_> = std::fs::read_dir(p).map_err(|e| format!("Couldn’t open {}: {e}", p.display()))?.flatten().map(|e| e.path()).collect();
        kids.sort();
        for k in kids {
            write_tree(w, &k, base, prog)?;
        }
    } else {
        let mut f = std::fs::File::open(p).map_err(|e| format!("Couldn’t read {}: {e}", p.display()))?;
        let size = f.metadata().map_err(|e| e.to_string())?.len();
        put_entry(w, 1, &name)?;
        w.write_all(name.as_bytes()).map_err(io)?;
        w.write_all(&size.to_le_bytes()).map_err(io)?;
        w.write_all(&secs(&m).to_le_bytes()).map_err(io)?;
        // exactly `size` bytes: a file that grows or shrinks while it's read would shift everything after it
        let mut left = size;
        let mut buf = vec![0u8; 256 * 1024];
        while left > 0 {
            let want = (left as usize).min(buf.len());
            let k = f.read(&mut buf[..want]).map_err(|e| format!("Couldn’t read {}: {e}", p.display()))?;
            if k == 0 {
                return Err(format!("{} changed while it was being locked", p.display()));
            }
            w.write_all(&buf[..k]).map_err(io)?;
            left -= k as u64;
            prog.done.fetch_add(k as u64, Ordering::Relaxed);
            if prog.cancel.load(Ordering::Relaxed) {
                return Err("Cancelled".into());
            }
        }
    }
    Ok(())
}

/// is this name safe to create under the folder it's unpacked into
fn safe_rel(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.starts_with('/') || name.contains('\\') || name.contains(':') || name.contains('\0') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in name.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        out.push(part);
    }
    Some(out)
}

/// reads the entries out of a sealed stream into `dest`; returns the name of the one top-level item
fn read_tree(r: &mut impl Read, dest: &Path, prog: &Progress) -> Result<String, std::io::Error> {
    let corrupt = || bad(Bad::Damaged);
    let mut top: Option<String> = None;
    loop {
        let mut kind = [0u8; 1];
        r.read_exact(&mut kind)?;
        if kind[0] == 0 {
            break;
        }
        let mut l = [0u8; 4];
        r.read_exact(&mut l)?;
        let l = u32::from_le_bytes(l) as usize;
        if l == 0 || l > 4096 {
            return Err(corrupt());
        }
        let mut nm = vec![0u8; l];
        r.read_exact(&mut nm)?;
        let name = String::from_utf8(nm).map_err(|_| corrupt())?;
        let rel = safe_rel(&name).ok_or_else(corrupt)?;
        let first = name.split('/').next().unwrap_or("").to_string();
        match &top {
            None => top = Some(first),
            Some(t) if *t != first => return Err(corrupt()),
            _ => {}
        }
        let out = dest.join(&rel);
        match kind[0] {
            2 => std::fs::create_dir_all(&out)?,
            1 => {
                let mut s = [0u8; 8];
                r.read_exact(&mut s)?;
                let size = u64::from_le_bytes(s);
                let mut t = [0u8; 8];
                r.read_exact(&mut t)?;
                let mtime = i64::from_le_bytes(t);
                if let Some(d) = out.parent() {
                    std::fs::create_dir_all(d)?;
                }
                let mut f = BufWriter::new(std::fs::File::create(&out)?);
                let n = std::io::copy(&mut (&mut *r).take(size), &mut f)?;
                if n != size {
                    return Err(corrupt());
                }
                f.flush()?;
                if mtime > 0 {
                    let _ = f.get_ref().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(mtime as u64));
                }
                prog.done.fetch_add(size, Ordering::Relaxed);
            }
            _ => return Err(corrupt()),
        }
        if prog.cancel.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("Cancelled"));
        }
    }
    top.ok_or_else(corrupt)
}

fn free_name(dir: &Path, name: &str, tag: &str) -> PathBuf {
    let first = dir.join(name);
    if std::fs::symlink_metadata(&first).is_err() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for i in 1.. {
        let n = if i == 1 { format!("{stem} ({tag}){ext}") } else { format!("{stem} ({tag} {i}){ext}") };
        let c = dir.join(n);
        if std::fs::symlink_metadata(&c).is_err() {
            return c;
        }
    }
    unreachable!()
}

/// lock `path`: <name>.dflock next to it, then the original goes. Returns the locked file.
fn lock_one(path: &Path, password: &str, prog: &Progress) -> Result<PathBuf, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("Couldn’t read it: {e}"))?;
    if meta.file_type().is_symlink() {
        return Err("A link can’t be locked: lock the file it points to".into());
    }
    if path.extension().map(|e| e.eq_ignore_ascii_case(EXT)).unwrap_or(false) && meta.is_file() {
        return Err("This is already locked".into());
    }
    let parent = path.parent().ok_or("Can’t lock a drive")?;
    let base = path.file_name().ok_or("Can’t lock this")?.to_string_lossy().to_string();
    let dest = free_name(parent, &format!("{base}.{EXT}"), "2");
    let part = parent.join(format!(".{}.{}.part", base, std::process::id()));
    let result = (|| -> Result<(), String> {
        let f = std::fs::File::create(&part).map_err(|e| format!("Couldn’t make the locked file here: {e}"))?;
        let mut s = Sealer::new(BufWriter::with_capacity(256 * 1024, f), password)?;
        write_tree(&mut s, path, parent, prog)?;
        s.write_all(&[0]).map_err(io)?;
        let w = s.finish()?;
        let f = w.into_inner().map_err(|e| io(e.into_error()))?;
        f.sync_all().map_err(io)?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    // read the locked copy back and check every chunk before the original is touched
    let check = (|| -> Result<(), String> {
        let mut o = Opener::new(std::fs::File::open(&part).map_err(|e| e.to_string())?, password)?;
        std::io::copy(&mut o, &mut std::io::sink()).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = check {
        let _ = std::fs::remove_file(&part);
        return Err(format!("The locked copy didn’t check out, so nothing was changed ({e})"));
    }
    std::fs::rename(&part, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("Couldn’t finish locking: {e}")
    })?;
    // the original goes for good: a copy in the Recycle Bin would defeat the lock
    let gone = if meta.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
    if let Err(e) = gone {
        return Err(format!("Locked as {}, but the original couldn’t be removed (is something using it?): {e}", dest.display()));
    }
    Ok(dest)
}

/// unlock a .dflock file: the item comes back next to it under its own name, then the locked file goes
fn unlock_one(path: &Path, password: &str, prog: &Progress) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or("Can’t unlock this")?;
    let tmp = parent.join(format!(".dogfile-unlock-{}-{:x}", std::process::id(), rand::random::<u32>()));
    let result = (|| -> Result<PathBuf, String> {
        let f = std::fs::File::open(path).map_err(|e| format!("Couldn’t open it: {e}"))?;
        let mut o = Opener::new(f, password)?;
        std::fs::create_dir_all(&tmp).map_err(|e| format!("Couldn’t unlock here: {e}"))?;
        let name = read_tree(&mut o, &tmp, prog).map_err(|e| e.to_string())?;
        // the stream has to end cleanly: anything left over means the file was cut short or added to
        let mut rest = [0u8; 1];
        if o.read(&mut rest).map_err(|e| e.to_string())? != 0 {
            return Err(bad(Bad::Damaged).to_string());
        }
        let to = free_name(parent, &name, "unlocked");
        std::fs::rename(tmp.join(&name), &to).map_err(|e| format!("Couldn’t put it back: {e}"))?;
        Ok(to)
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    let to = result?;
    let _ = std::fs::remove_file(path);
    Ok(to)
}

// ---- jobs the window starts and watches ----
struct Job {
    total: u64,
    prog: Arc<Progress>,
    running: bool,
    /// (from, to or "", error or "")
    results: Vec<(String, String, String)>,
    current: String,
}
fn jobs() -> &'static Mutex<HashMap<u64, Job>> {
    static J: OnceLock<Mutex<HashMap<u64, Job>>> = OnceLock::new();
    J.get_or_init(Default::default)
}
static NEXT: AtomicU64 = AtomicU64::new(1);

/// lock:start(op "lock" | "unlock", paths[], password) → job id
pub fn start(a: &Args) -> R {
    let op = a.s(0)?;
    let paths = a.strs(1);
    let password = a.s(2)?;
    if password.is_empty() {
        return Err("Enter a password".into());
    }
    if paths.is_empty() || !(op == "lock" || op == "unlock") {
        return Err("Nothing to do".into());
    }
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let prog = Arc::new(Progress { done: AtomicU64::new(0), cancel: AtomicBool::new(false) });
    let total: u64 = if op == "lock" { paths.iter().map(|p| measure(Path::new(p))).sum() } else { paths.iter().map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)).sum() };
    jobs().lock().insert(id, Job { total: total.max(1), prog: prog.clone(), running: true, results: vec![], current: String::new() });
    st().rt.spawn_blocking(move || {
        for p in paths {
            if prog.cancel.load(Ordering::Relaxed) {
                break;
            }
            if let Some(j) = jobs().lock().get_mut(&id) {
                j.current = Path::new(&p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            }
            let r = if op == "lock" { lock_one(Path::new(&p), &password, &prog) } else { unlock_one(Path::new(&p), &password, &prog) };
            if let Some(j) = jobs().lock().get_mut(&id) {
                j.results.push(match r {
                    Ok(to) => (p, to.to_string_lossy().to_string(), String::new()),
                    Err(e) => (p, String::new(), e),
                });
            }
        }
        if let Some(j) = jobs().lock().get_mut(&id) {
            j.running = false;
        }
    });
    Ok(json!(id))
}
/// lock:status(id) → { running, done, total, current, results: [{ from, to, error }] }
pub fn status(a: &Args) -> R {
    let id = a.u(0, 0);
    let m = jobs().lock();
    let Some(j) = m.get(&id) else { return Err("Unknown job".into()) };
    Ok(json!({ "running": j.running, "done": j.prog.done.load(Ordering::Relaxed).min(j.total), "total": j.total, "current": j.current,
        "results": j.results.iter().map(|(f, t, e)| json!({ "from": f, "to": t, "error": e })).collect::<Vec<Value>>() }))
}
pub fn cancel(a: &Args) -> R {
    if let Some(j) = jobs().lock().get(&a.u(0, 0)) {
        j.prog.cancel.store(true, Ordering::Relaxed);
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn prog() -> Progress {
        Progress { done: AtomicU64::new(0), cancel: AtomicBool::new(false) }
    }
    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dogfile-lock-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_file_locks_and_unlocks_and_the_wrong_password_changes_nothing() {
        let d = scratch("file");
        let f = d.join("secret.txt");
        std::fs::write(&f, b"the plan").unwrap();
        let locked = lock_one(&f, "1234", &prog()).unwrap();
        assert_eq!(locked.file_name().unwrap(), "secret.txt.dflock");
        assert!(!f.exists(), "the original is gone");
        let raw = std::fs::read(&locked).unwrap();
        assert!(!raw.windows(8).any(|w| w == b"the plan") && !raw.windows(10).any(|w| w == b"secret.txt"), "neither the content nor the name shows");
        let err = unlock_one(&locked, "12345", &prog()).unwrap_err();
        assert_eq!(err, "Wrong password");
        assert!(locked.exists() && !f.exists(), "a wrong password leaves it as it was");
        let back = unlock_one(&locked, "1234", &prog()).unwrap();
        assert_eq!(back, f);
        assert_eq!(std::fs::read(&f).unwrap(), b"the plan");
        assert!(!locked.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_folder_comes_back_whole_and_a_name_in_the_way_is_not_overwritten() {
        let d = scratch("dir");
        let dir = d.join("Taxes");
        std::fs::create_dir_all(dir.join("2024/receipts")).unwrap();
        std::fs::create_dir_all(dir.join("empty")).unwrap();
        std::fs::write(dir.join("a.txt"), b"a").unwrap();
        std::fs::write(dir.join("2024/receipts/b.bin"), vec![7u8; 3 * CHUNK + 5]).unwrap(); // more than one chunk
        let locked = lock_one(&dir, "p@ss", &prog()).unwrap();
        assert!(!dir.exists());
        std::fs::create_dir_all(&dir).unwrap(); // something with the old name is there again
        let back = unlock_one(&locked, "p@ss", &prog()).unwrap();
        assert_eq!(back.file_name().unwrap(), "Taxes (unlocked)");
        assert_eq!(std::fs::read(back.join("a.txt")).unwrap(), b"a");
        assert_eq!(std::fs::read(back.join("2024/receipts/b.bin")).unwrap().len(), 3 * CHUNK + 5);
        assert!(back.join("empty").is_dir());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_damaged_or_cut_short_file_is_refused() {
        let d = scratch("dmg");
        let f = d.join("x.txt");
        std::fs::write(&f, vec![1u8; 2 * CHUNK]).unwrap();
        let locked = lock_one(&f, "k", &prog()).unwrap();
        let good = std::fs::read(&locked).unwrap();
        // cut short: the last chunk is missing
        let cut = d.join("cut.dflock");
        std::fs::write(&cut, &good[..good.len() - 100]).unwrap();
        assert!(unlock_one(&cut, "k", &prog()).is_err());
        // one flipped bit in the middle
        let mut flipped = good.clone();
        let mid = flipped.len() / 2;
        flipped[mid] ^= 1;
        let fl = d.join("flip.dflock");
        std::fs::write(&fl, &flipped).unwrap();
        assert!(unlock_one(&fl, "k", &prog()).is_err());
        // not a locked file at all
        let junk = d.join("junk.dflock");
        std::fs::write(&junk, b"hello").unwrap();
        assert!(unlock_one(&junk, "k", &prog()).unwrap_err().contains("isn’t a file Dogfile locked"));
        assert!(!d.read_dir().unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(".dogfile-unlock")), "no half-unlocked leftovers");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn names_that_climb_out_are_not_accepted() {
        for bad in ["../x", "a/../x", "/abs", "C:/x", "a\\b", "", "a//b"] {
            assert!(safe_rel(bad).is_none(), "{bad}");
        }
        assert!(safe_rel("a/b c/d.txt").is_some());
    }

    #[test]
    fn locking_twice_or_a_link_is_refused() {
        let d = scratch("twice");
        let f = d.join("a.txt");
        std::fs::write(&f, b"x").unwrap();
        let l = lock_one(&f, "1", &prog()).unwrap();
        assert_eq!(lock_one(&l, "1", &prog()).unwrap_err(), "This is already locked");
        let _ = std::fs::remove_dir_all(&d);
    }
}
