// A share package: one what-if copy as a small file you can give to someone else (or keep). It holds the changes only:
// the names of the things changed, never what is inside the files you didn't change. A package from anyone is just data:
// it is read with strict limits, every change in it is checked against the folder it is brought into like any other,
// and nothing in it is ever run.
use super::tree::*;
use serde::{Deserialize, Serialize};

pub const FORMAT: &str = "dogfile-multiverse";
pub const VERSION: u32 = 1;
pub const MAX_PACK_BYTES: u64 = 64 << 20;
pub const MAX_OPS: usize = 20_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackOp {
    pub group: String,
    #[serde(flatten)]
    pub kind: OpKind,
    pub on: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Pack {
    pub format: String,
    pub version: u32,
    pub name: String,
    /// the name of the folder it was made for (not where it is)
    #[serde(rename = "folderName")]
    pub folder_name: String,
    pub created: i64,
    pub ops: Vec<PackOp>,
    /// new contents that changes in `ops` write, by the SHA-256 of what is in them (base64)
    #[serde(default)]
    pub blobs: std::collections::BTreeMap<String, String>,
}

pub fn encode(p: &Pack) -> Result<Vec<u8>, String> {
    serde_json::to_vec(p).map_err(|e| e.to_string())
}

/// Read a package from bytes: only what is understood, within the limits, is accepted.
pub fn decode(bytes: &[u8]) -> Result<Pack, String> {
    if bytes.len() as u64 > MAX_PACK_BYTES {
        return Err("That file is too big to be a Multiverse package".into());
    }
    let p: Pack = serde_json::from_slice(bytes).map_err(|_| "That isn’t a Multiverse package".to_string())?;
    if p.format != FORMAT {
        return Err("That isn’t a Multiverse package".into());
    }
    if p.version == 0 || p.version > VERSION {
        return Err("That package was made by a newer Dogfile. Update Dogfile to open it.".into());
    }
    if p.ops.len() > MAX_OPS {
        return Err("That package has too many changes".into());
    }
    if p.ops.iter().any(|o| o.group.len() > 400) {
        return Err("That package isn’t valid".into());
    }
    for (id, b64) in &p.blobs {
        if !super::blobs::valid(id) {
            return Err("That package isn’t valid".into());
        }
        if b64.len() as u64 > super::blobs::MAX_BLOB * 4 / 3 + 8 {
            return Err("That package isn’t valid".into());
        }
    }
    Ok(p)
}

/// the contents of one blob in a package, checked against its name
pub fn blob_bytes(p: &Pack, id: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let b64 = p.blobs.get(id).ok_or_else(|| "A change in that package needs contents that aren’t in it".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "That package isn’t valid".to_string())?;
    if bytes.len() as u64 > super::blobs::MAX_BLOB || super::blobs::hash_bytes(&bytes) != id {
        return Err("That package is damaged".into());
    }
    Ok(bytes)
}
