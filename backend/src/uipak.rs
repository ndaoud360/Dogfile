//! The interface packed into the program (build/pack-ui.mjs writes it, the app compiles it in): files are
//! inflated when a page asks for them, so nothing about the interface sits beside the exe.
//! Format: "DGPK" | u32 LE index length | deflated JSON index { name: [offset, length] } | deflated files.
use std::collections::HashMap;
use std::io::Read;

pub struct Pak {
    files: &'static [u8],
    index: HashMap<String, (usize, usize)>,
}

fn inflate(b: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(b.len() * 3);
    flate2::read::DeflateDecoder::new(b).read_to_end(&mut out).ok()?;
    Some(out)
}

impl Pak {
    pub fn parse(data: &'static [u8]) -> Option<Pak> {
        if data.len() < 8 || &data[..4] != b"DGPK" {
            return None;
        }
        let n = u32::from_le_bytes(data[4..8].try_into().ok()?) as usize;
        let idx = inflate(data.get(8..8 + n)?)?;
        let raw: HashMap<String, (usize, usize)> = serde_json::from_slice(&idx).ok()?;
        Some(Pak { files: &data[8 + n..], index: raw })
    }
    pub fn get(&self, name: &str) -> Option<Vec<u8>> {
        let &(off, len) = self.index.get(name.trim_start_matches('/'))?;
        inflate(self.files.get(off..off + len)?)
    }
    pub fn len(&self) -> usize {
        self.index.len()
    }
}
