// Reading an NTFS drive's master file table ($MFT) directly, the way the Everything search tool does: one big
// sequential read gives every file's name, folder, size, date and attributes in a few seconds, instead of
// opening millions of folders. Needs administrator rights on Windows (the drive is opened as a device), so
// Dogfile uses it when it has them and otherwise walks the folders.
use crate::index::{Tree, F_DIR, F_HIDDEN, F_LINK, F_SYSTEM};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};

const FT_UNIX_DIFF_MS: i64 = 11_644_473_600_000;
fn ft_ms(ft: u64) -> i64 {
    (ft / 10_000) as i64 - FT_UNIX_DIFF_MS
}
fn u16le(b: &[u8], o: usize) -> u16 { u16::from_le_bytes([b[o], b[o + 1]]) }
fn u32le(b: &[u8], o: usize) -> u32 { u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) }
fn u64le(b: &[u8], o: usize) -> u64 { u64::from_le_bytes(b[o..o + 8].try_into().unwrap()) }

#[derive(Debug, Clone)]
pub struct Boot {
    pub bytes_per_cluster: u64,
    pub mft_lcn: u64,
    pub record_size: usize,
}
pub fn parse_boot(b: &[u8]) -> Result<Boot, String> {
    if b.len() < 512 || &b[3..11] != b"NTFS    " { return Err("not an NTFS drive".into()) }
    let bps = u16le(b, 0x0b) as u64;
    let spc_raw = b[0x0d];
    let spc: u64 = if spc_raw > 0x80 { 1u64 << (256 - spc_raw as u32) } else { spc_raw as u64 };
    let bpc = bps * spc;
    let mft_lcn = u64le(b, 0x30);
    let cpr = b[0x40] as i8;
    let record_size = if cpr < 0 { 1usize << (-(cpr as i32)) } else { cpr as usize * bpc as usize };
    if bpc == 0 || record_size < 256 || record_size > 65536 { return Err("unexpected NTFS layout".into()) }
    Ok(Boot { bytes_per_cluster: bpc, mft_lcn, record_size })
}

/// Undo NTFS's "update sequence" protection on one record. False if the record is torn.
pub fn fixup(rec: &mut [u8]) -> bool {
    if rec.len() < 48 { return false }
    let off = u16le(rec, 4) as usize;
    let cnt = u16le(rec, 6) as usize;
    if cnt == 0 || off + cnt * 2 > rec.len() { return false }
    let usn = [rec[off], rec[off + 1]];
    for i in 1..cnt {
        let end = i * 512 - 2;
        if end + 2 > rec.len() { break }
        if rec[end..end + 2] != usn { return false }
        rec[end] = rec[off + i * 2];
        rec[end + 1] = rec[off + i * 2 + 1];
    }
    true
}

/// (lcn, clusters) runs; lcn None = sparse.
pub fn decode_runs(b: &[u8]) -> Vec<(Option<i64>, u64)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut lcn: i64 = 0;
    while i < b.len() && b[i] != 0 {
        let h = b[i];
        let (ln, on) = ((h & 0x0f) as usize, (h >> 4) as usize);
        i += 1;
        if i + ln + on > b.len() || ln == 0 || ln > 8 || on > 8 { break }
        let mut len: u64 = 0;
        for k in 0..ln { len |= (b[i + k] as u64) << (8 * k) }
        i += ln;
        if on == 0 { out.push((None, len)); continue }
        let mut off: i64 = 0;
        for k in 0..on { off |= (b[i + k] as i64) << (8 * k) }
        if b[i + on - 1] & 0x80 != 0 { off -= 1i64 << (8 * on) } // sign-extend
        i += on;
        lcn += off;
        out.push((Some(lcn), len));
    }
    out
}

#[derive(Default, Clone, Debug)]
pub struct Rec {
    pub in_use: bool,
    pub is_dir: bool,
    pub parent: u64,
    pub name: String,
    pub name_rank: u8, // 3 = best (Win32), 0 = none
    pub size: u64,
    pub mtime: i64,
    pub attrs: u32,
    pub link: bool,
    pub base: u64,
}

/// Parse one (fixed-up) FILE record.
pub fn parse_record(b: &[u8]) -> Option<Rec> {
    if &b[0..4] != b"FILE" { return None }
    let flags = u16le(b, 22);
    let mut r = Rec { in_use: flags & 1 != 0, is_dir: flags & 2 != 0, base: u64le(b, 32) & 0xFFFF_FFFF_FFFF, ..Default::default() };
    if !r.in_use { return Some(r) }
    let mut a = u16le(b, 20) as usize;
    let used = (u32le(b, 24) as usize).min(b.len());
    let mut fn_mtime = 0i64;
    while a + 16 <= used {
        let ty = u32le(b, a);
        if ty == 0xFFFF_FFFF { break }
        let len = u32le(b, a + 4) as usize;
        if len < 16 || a + len > used { break }
        let non_res = b[a + 8] != 0;
        let name_len = b[a + 9];
        let (vlen, voff) = if !non_res { (u32le(b, a + 16) as usize, u16le(b, a + 20) as usize) } else { (0, 0) };
        let val = if !non_res && voff + vlen <= len { &b[a + voff..a + voff + vlen] } else { &[][..] };
        match ty {
            0x10 if val.len() >= 36 => {
                r.mtime = ft_ms(u64le(val, 8));
                r.attrs = u32le(val, 32);
            }
            0x30 if val.len() >= 66 => {
                let nl = val[64] as usize;
                let ns = val[65];
                if val.len() >= 66 + nl * 2 {
                    let rank = match ns { 1 | 3 => 3, 0 => 2, _ => 1 };
                    if rank > r.name_rank {
                        let u: Vec<u16> = val[66..66 + nl * 2].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                        r.name = String::from_utf16_lossy(&u);
                        r.name_rank = rank;
                        r.parent = u64le(val, 0) & 0xFFFF_FFFF_FFFF;
                        fn_mtime = ft_ms(u64le(val, 16));
                        if !r.is_dir && r.size == 0 { r.size = u64le(val, 48) } // fallback; $DATA wins below
                    }
                }
            }
            0x80 if name_len == 0 => {
                if non_res {
                    if len >= 64 && u64le(b, a + 16) == 0 { r.size = u64le(b, a + 48) }
                } else {
                    r.size = vlen as u64;
                }
            }
            0xC0 if val.len() >= 4 => {
                let tag = u32le(val, 0);
                r.link = tag == 0xA000_0003 || tag == 0xA000_000C; // junction / symbolic link
            }
            _ => {}
        }
        a += len;
    }
    if r.mtime == 0 { r.mtime = fn_mtime }
    Some(r)
}

/// Read all records of the volume `v` (a drive device or an image file).
pub fn read_all<V: Read + Seek>(v: &mut V, progress: &dyn Fn(u64)) -> Result<Vec<Rec>, String> {
    let mut boot = vec![0u8; 4096];
    v.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let n = v.read(&mut boot).map_err(|e| e.to_string())?;
    let bt = parse_boot(&boot[..n])?;
    let rs = bt.record_size;
    // record 0 is $MFT itself: its $DATA runs say where the whole table is
    let mut r0 = vec![0u8; rs.max(4096)];
    v.seek(SeekFrom::Start(bt.mft_lcn * bt.bytes_per_cluster)).map_err(|e| e.to_string())?;
    v.read_exact(&mut r0).map_err(|e| e.to_string())?;
    let r0 = &mut r0[..rs];
    if !fixup(r0) { return Err("damaged $MFT record".into()) }
    let mut runs_raw: Vec<(u64, Vec<(Option<i64>, u64)>)> = Vec::new();
    let mut mft_size = 0u64;
    {
        let mut a = u16le(r0, 20) as usize;
        let used = (u32le(r0, 24) as usize).min(rs);
        while a + 16 <= used {
            let ty = u32le(r0, a);
            if ty == 0xFFFF_FFFF { break }
            let len = u32le(r0, a + 4) as usize;
            if len < 16 || a + len > used { break }
            if ty == 0x80 && r0[a + 8] != 0 && r0[a + 9] == 0 {
                let start_vcn = u64le(r0, a + 16);
                if start_vcn == 0 { mft_size = u64le(r0, a + 48) }
                let ro = u16le(r0, a + 32) as usize;
                runs_raw.push((start_vcn, decode_runs(&r0[a + ro..a + len])));
            }
            a += len;
        }
    }
    runs_raw.sort_by_key(|x| x.0);
    let runs: Vec<(Option<i64>, u64)> = runs_raw.into_iter().flat_map(|x| x.1).collect();
    if runs.is_empty() || mft_size == 0 { return Err("couldn't find the file table".into()) }
    let total_records = (mft_size / rs as u64) as usize;
    let mut recs: Vec<Rec> = Vec::with_capacity(total_records);
    let mut ext: Vec<(u64, Rec)> = Vec::new();
    let chunk_clusters = ((4u64 << 20) / bt.bytes_per_cluster).max(1);
    let mut buf: Vec<u8> = Vec::new();
    let mut carry: Vec<u8> = Vec::new(); // a record can straddle two runs when clusters are smaller than records
    'runs: for (lcn, len) in runs {
        let mut done = 0u64;
        while done < len {
            let take = chunk_clusters.min(len - done);
            let bytes = (take * bt.bytes_per_cluster) as usize;
            buf.resize(bytes, 0);
            match lcn {
                Some(l) => {
                    v.seek(SeekFrom::Start((l as u64 + done) * bt.bytes_per_cluster)).map_err(|e| e.to_string())?;
                    v.read_exact(&mut buf).map_err(|e| e.to_string())?;
                }
                None => buf.iter_mut().for_each(|x| *x = 0),
            }
            done += take;
            carry.extend_from_slice(&buf);
            let whole = carry.len() / rs * rs;
            for rec in carry[..whole].chunks_exact_mut(rs) {
                if recs.len() >= total_records { break 'runs }
                let parsed = if rec[0..4] == *b"FILE" && fixup(rec) { parse_record(rec) } else { None };
                let r = parsed.unwrap_or_default();
                if r.in_use && r.base != 0 { ext.push((r.base, r.clone())); recs.push(Rec::default()); } else { recs.push(r) }
            }
            carry.drain(..whole);
            progress(recs.len() as u64);
        }
    }
    // extension records carry extra names / sizes for their base record
    for (base, e) in ext {
        if let Some(b) = recs.get_mut(base as usize) {
            if e.name_rank > b.name_rank { b.name = e.name; b.name_rank = e.name_rank; b.parent = e.parent }
            if e.size > 0 && !b.is_dir { b.size = e.size }
        }
    }
    Ok(recs)
}

/// Turn the records into an index tree rooted at `root` ("C:\"); parents always before children.
pub fn to_tree(recs: &[Rec], root: &str) -> Tree {
    let mut kids: HashMap<u64, Vec<u64>> = HashMap::new();
    for (i, r) in recs.iter().enumerate() {
        let i = i as u64;
        if !r.in_use || r.name_rank == 0 || i == 5 || r.base != 0 { continue }
        if i < 24 && r.name.starts_with('$') { continue } // NTFS's own files
        kids.entry(r.parent).or_default().push(i);
    }
    let mut t = Tree::new(root, "mft");
    let mut queue: std::collections::VecDeque<(u64, u32)> = std::collections::VecDeque::from([(5u64, 0u32)]);
    while let Some((rec, idx)) = queue.pop_front() {
        let Some(list) = kids.get(&rec) else { continue };
        for &c in list {
            let r = &recs[c as usize];
            if r.is_dir && (r.name == "$Extend" || crate::util::is_skip_dir(&r.name)) && rec == 5 { continue }
            let flags = (if r.is_dir { F_DIR } else { 0 }) | (if r.attrs & 2 != 0 { F_HIDDEN } else { 0 }) | (if r.attrs & 4 != 0 { F_SYSTEM } else { 0 }) | (if r.link { F_LINK } else { 0 });
            let i = t.push(idx, &r.name, flags, if r.is_dir { 0 } else { r.size }, r.mtime);
            if r.is_dir && !r.link { queue.push_back((c, i)) }
        }
    }
    t.aggregate();
    t
}

/// Index a drive from its file table. Only on Windows, with administrator rights, on NTFS.
#[cfg(windows)]
pub fn build(root: &str, progress: &dyn Fn(u64)) -> Result<Tree, String> {
    let r = root.trim_end_matches('\\');
    if r.len() != 2 || !r.ends_with(':') { return Err("not a drive".into()) }
    let dev = format!("\\\\.\\{}", r);
    let mut f = std::fs::OpenOptions::new().read(true).open(&dev).map_err(|e| format!("no access to {dev}: {e}"))?;
    let recs = read_all(&mut f, progress)?;
    Ok(to_tree(&recs, &format!("{}\\", r)))
}
#[cfg(not(windows))]
pub fn build(_root: &str, _progress: &dyn Fn(u64)) -> Result<Tree, String> {
    Err("only on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runs() {
        // 0x21: 1 length byte, 2 offset bytes: 0x18 clusters at lcn 0x5634; then -0x10 relative
        let r = decode_runs(&[0x21, 0x18, 0x34, 0x56, 0x11, 0x08, 0xF0, 0x00]);
        assert_eq!(r, vec![(Some(0x5634), 0x18), (Some(0x5634 - 0x10), 0x08)]);
    }
    #[test]
    fn image() {
        // the ntfs crate's small test file system (see core/testdata/README)
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/testfs1");
        let Ok(mut f) = std::fs::File::open(&p) else { eprintln!("no test image"); return };
        let recs = read_all(&mut f, &|_| {}).unwrap();
        let t = to_tree(&recs, "T:\\");
        let names: Vec<String> = (1..t.entries.len() as u32).map(|i| t.path(i)).collect();
        eprintln!("{} entries: {:?}", names.len(), &names[..names.len().min(40)]);
        assert!(names.len() > 3);
        assert!(!names.iter().any(|n| n.contains("$MFT")));
    }
}
#[cfg(test)]
mod image_details {
    use super::*;
    #[test]
    fn known_files() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/testfs1");
        let mut f = std::fs::File::open(&p).unwrap();
        let t = to_tree(&read_all(&mut f, &|_| {}).unwrap(), "T:\\");
        let get = |n: &str| t.lookup(&format!("T:\\{n}")).map(|i| t.entries[i as usize]);
        assert_eq!(get("file-with-12345").unwrap().size, 5);
        assert_eq!(get("1000-bytes-file").unwrap().size, 1000);
        assert_eq!(get("sparse-file").unwrap().size, 500005);
        let m = get("many_subdirs").unwrap();
        assert!(m.flags & F_DIR != 0);
        assert_eq!(Some(t.kids(t.lookup("T:\\many_subdirs").unwrap()).count()), Some(512));
        let e = get("empty-file").unwrap();
        assert_eq!(e.size, 0);
        // 2021-01-01 13:37 in whatever time zone the image was made in
        assert!((e.mtime - 1_609_508_220_000).abs() < 14 * 3_600_000, "mtime {}", e.mtime);
        assert_eq!(t.entries[0].size, 5 + 1000 + 500005);
    }
}
