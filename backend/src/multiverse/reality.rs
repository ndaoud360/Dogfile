// A reality: the folder as it was, plus the changes made to it in the what-if copy. Kept in one small file per reality.
use super::env::Env;
use super::exec::{Step, STAGE_PREFIX};
use super::tree::*;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MAX_ENTRIES: usize = 60_000;
const MAX_DEPTH: usize = 48;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Applied {
    pub at: i64,
    pub steps: Vec<Step>,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Reality {
    pub id: String,
    pub name: String,
    pub root: String,
    pub created: i64,
    pub ci: bool,
    pub base: Vec<BEntry>,
    pub ops: Vec<Op>,
    pub next_id: u32,
    /// set once the changes have been made for real (what Undo reverses)
    pub applied: Option<Applied>,
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Look at the folder: everything in it, down to every level. Links and folders that can't be read are listed and left alone.
pub fn scan(env: &dyn Env, root: &Path) -> Result<Vec<BEntry>, String> {
    match env.stat(root) {
        Ok(Some(m)) if m.kind == Kind::Dir => {}
        _ => return Err("That isn’t a folder".into()),
    }
    let mut out: Vec<BEntry> = vec![];
    let mut stack: Vec<(String, usize)> = vec![(String::new(), 0)];
    while let Some((rel, depth)) = stack.pop() {
        let dir = super::exec::dp(root, &rel);
        let list = match env.list(&dir) {
            Ok(l) => l,
            Err(e) => {
                if rel.is_empty() {
                    return Err(format!("The folder can’t be read: {e}"));
                }
                // a folder Dogfile may not look into: kept as an item that is never changed
                if let Some(x) = out.iter_mut().find(|x| x.path == rel) {
                    x.kind = Kind::Link;
                }
                continue;
            }
        };
        for (name, m) in list {
            if name.starts_with(STAGE_PREFIX) {
                continue;
            }
            let p = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            let mut kind = m.kind;
            if kind == Kind::Dir && depth + 1 >= MAX_DEPTH {
                kind = Kind::Link;
            }
            out.push(BEntry { path: p.clone(), kind, size: m.size, mtime: m.mtime });
            if out.len() > MAX_ENTRIES {
                return Err(format!("That folder has more than {MAX_ENTRIES} items. Try a smaller folder."));
            }
            if kind == Kind::Dir {
                stack.push((p, depth + 1));
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    On,
    Off,
    /// switched on but can't be made (why)
    Blocked(String),
}

pub struct Replay {
    pub tree: Tree,
    pub state: Vec<(u32, State)>,
    /// what the ones that can be made rely on, and what they do to the disk, in order
    pub foot: Footprint,
    pub acts: Vec<Act>,
}

/// Make every change that is switched on, in order, in the virtual folder. One that can't be made is marked and skipped,
/// and so is anything that depends on it. `can_delete`: deletes are possible here (there is a Recycle Bin).
pub fn replay(base: &[BEntry], ci: bool, ops: &[Op], can_delete: bool) -> Replay {
    let mut tree = Tree::from_base(base, ci);
    let mut state = vec![];
    let mut foot = Footprint::default();
    let mut acts = vec![];
    for op in ops {
        if !op.on {
            state.push((op.id, State::Off));
            continue;
        }
        if !can_delete && matches!(op.kind, OpKind::Delete { .. }) {
            state.push((op.id, State::Blocked("This drive has no Recycle Bin, so deleting isn’t safe here".into())));
            continue;
        }
        let mut f = Footprint::default();
        // a change that fails leaves the virtual folder exactly as it was (every check comes before the first change; a test holds it to that)
        match tree.apply(&op.kind, Some(&mut f)) {
            Ok(a) => {
                foot.files.extend(f.files);
                foot.dirs.extend(f.dirs);
                foot.deep.extend(f.deep);
                acts.extend(a);
                state.push((op.id, State::On));
            }
            Err(e) => state.push((op.id, State::Blocked(e))),
        }
    }
    Replay { tree, state, foot, acts }
}

// ---------- files ----------
pub fn dir(data: &Path) -> PathBuf {
    data.join("multiverse")
}
pub fn file(data: &Path, id: &str) -> PathBuf {
    dir(data).join(format!("{id}.json"))
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}
pub fn new_id() -> String {
    use rand::Rng;
    let mut r = rand::rng();
    (0..12).map(|_| "0123456789abcdefghijklmnopqrstuvwxyz".as_bytes()[r.random_range(0..36)] as char).collect()
}
pub fn save(data: &Path, r: &Reality) -> Result<(), String> {
    if !valid_id(&r.id) {
        return Err("bad id".into());
    }
    let d = dir(data);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let tmp = d.join(format!("{}.json.tmp", r.id));
    let body = serde_json::to_vec(r).map_err(|e| e.to_string())?;
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&body).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, file(data, &r.id)).map_err(|e| e.to_string())
}
pub fn load(data: &Path, id: &str) -> Result<Reality, String> {
    if !valid_id(id) {
        return Err("That reality isn’t there".into());
    }
    let b = std::fs::read(file(data, id)).map_err(|_| "That reality isn’t there".to_string())?;
    serde_json::from_slice(&b).map_err(|e| format!("That reality is damaged: {e}"))
}
pub fn list(data: &Path) -> Vec<Reality> {
    let mut v: Vec<Reality> = std::fs::read_dir(dir(data))
        .map(|rd| rd.flatten().filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false)).filter_map(|e| std::fs::read(e.path()).ok()).filter_map(|b| serde_json::from_slice(&b).ok()).collect())
        .unwrap_or_default();
    v.sort_by(|a, b| b.created.cmp(&a.created));
    v
}
pub fn remove(data: &Path, id: &str) {
    if valid_id(id) {
        let _ = std::fs::remove_file(file(data, id));
    }
}

impl Reality {
    pub fn new(env: &dyn Env, name: &str, root: &str) -> Result<Reality, String> {
        let rp = Path::new(root);
        let base = scan(env, rp)?;
        Ok(Reality { id: new_id(), name: name.trim().chars().take(80).collect(), root: root.to_string(), created: now(), ci: env.case_insensitive(rp), base, ops: vec![], next_id: 1, applied: None })
    }
    pub fn add(&mut self, group: &str, kinds: Vec<OpKind>) -> Vec<u32> {
        let mut ids = vec![];
        for k in kinds {
            let id = self.next_id;
            self.next_id += 1;
            self.ops.push(Op { id, group: group.chars().take(60).collect(), kind: k, on: true });
            ids.push(id);
        }
        ids
    }
}
