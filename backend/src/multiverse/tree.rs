// Multiverse, the part that never touches the disk: what a folder looked like when the reality was made (the
// baseline), the changes someone made to it in that reality (moves, renames, deletes, new folders, copies), and the
// virtual folder that results from replaying those changes. Every rule that protects files lives here and in `exec`.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Dir,
    /// a link or anything Dogfile can't see into (symlink, junction, a folder it isn't allowed to read): listed,
    /// never moved, copied or deleted by a reality
    Link,
}

/// One thing in the folder when the reality was made
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BEntry {
    #[serde(rename = "p")]
    pub path: String,
    #[serde(rename = "k")]
    pub kind: Kind,
    #[serde(rename = "s")]
    pub size: u64,
    #[serde(rename = "m")]
    pub mtime: i64,
}

/// A change. Paths are inside the folder, with `/` between the parts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum OpKind {
    /// move or rename (a rename is a move within the same folder)
    Move { from: String, to: String },
    Delete { path: String },
    Mkdir { path: String },
    Copy { from: String, to: String },
    /// new contents for a file that is in the folder. The new contents are kept as a blob (named by its SHA-256);
    /// the old file goes to the Recycle Bin, last. `from_*` say which contents the new ones were made from (the size, date and
    /// SHA-256 of the file as it was), so that new contents made from one version are never written over another.
    Put { path: String, blob: String, size: u64, from_size: u64, from_mtime: i64, from_hash: String },
    /// a new file with these contents
    NewFile { path: String, blob: String, size: u64 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Op {
    pub id: u32,
    /// what the person was doing ("Sort by type", "Rename"): changes made together are approved together
    pub group: String,
    #[serde(flatten)]
    pub kind: OpKind,
    pub on: bool,
}

#[derive(Clone, Debug)]
pub struct Node {
    pub path: String,
    pub kind: Kind,
    pub size: u64,
    pub mtime: i64,
    /// the path it has on disk today (None for folders made in the reality)
    pub origin: Option<String>,
    /// made by a Copy
    pub copy: bool,
    /// the blob holding its new contents (a file whose contents were changed here, or a new file)
    pub put: Option<String>,
}

/// One thing done to the disk, in the order it is done. A change in the reality becomes one or more of these.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "act", rename_all = "camelCase")]
pub enum Act {
    Mv { from: String, to: String },
    Mkdir { path: String },
    CopyFile { from: String, to: String },
    /// delete: set aside (reversible) and only recycled when everything else has worked
    Stage { path: String },
    /// write a file's contents from a blob. `replace`: there is a file there now, which is set aside first (and recycled last)
    Put { path: String, blob: String, size: u64, replace: bool, from_hash: String },
}

/// What a change relies on in the folder as it was: if any of this is different on disk when the changes are applied,
/// something outside Dogfile has changed it and the change isn't made.
#[derive(Clone, Debug, Default)]
pub struct Footprint {
    /// files that must be there with the same size and date
    pub files: Vec<String>,
    /// folders that must be there
    pub dirs: Vec<String>,
    /// folders that must hold exactly what they held (the change moves everything in them to the Recycle Bin or copies it)
    pub deep: Vec<String>,
}

const RESERVED: [&str; 22] = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
pub const MAX_PATH_CHARS: usize = 220;

fn check_blob(blob: &str, size: u64) -> Result<(), String> {
    if !super::blobs::valid(blob) {
        return Err("That new content isn’t valid".into());
    }
    if size > super::blobs::MAX_BLOB {
        return Err("That is too much new content for one file".into());
    }
    Ok(())
}

/// One part of a name: nothing Windows would refuse (the rules are the same everywhere so a reality works on any PC)
pub fn check_name(n: &str) -> Result<(), String> {
    if n.is_empty() {
        return Err("A name can’t be empty".into());
    }
    if n == "." || n == ".." {
        return Err(format!("“{n}” isn’t a name"));
    }
    if let Some(c) = n.chars().find(|c| c.is_control() || "<>:\"/\\|?*".contains(*c)) {
        return Err(format!("A name can’t contain {}", if c.is_control() { "control characters".to_string() } else { format!("“{c}”") }));
    }
    if n.ends_with(' ') || n.ends_with('.') {
        return Err(format!("“{n}” can’t end with a space or a dot"));
    }
    if n.chars().count() > 200 {
        return Err("That name is too long".into());
    }
    // names Dogfile uses for its own set-aside folders and half-made files are never given to anything
    if n.starts_with(super::exec::STAGE_PREFIX) || n.contains(".dogfile-part-") {
        return Err(format!("“{n}” is a name Dogfile keeps for itself"));
    }
    let stem = n.split('.').next().unwrap_or("").trim_end().to_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return Err(format!("“{n}” is a name Windows keeps for itself"));
    }
    Ok(())
}

/// A path inside the folder, tidied: `/` between parts, no empty parts, no `.` or `..`, every part a good name.
/// The folder itself is "".
pub fn norm(p: &str) -> Result<String, String> {
    let s = p.replace('\\', "/");
    let parts: Vec<&str> = s.split('/').filter(|x| !x.is_empty()).collect();
    for x in &parts {
        check_name(x)?;
    }
    let out = parts.join("/");
    if out.chars().count() > MAX_PATH_CHARS {
        return Err("That path is too long".into());
    }
    Ok(out)
}
/// like `norm` for a path that already exists in the baseline: its parts are whatever the disk has
pub fn norm_loose(p: &str) -> String {
    p.replace('\\', "/").split('/').filter(|x| !x.is_empty()).collect::<Vec<_>>().join("/")
}
pub fn parent_of(p: &str) -> &str {
    p.rsplit_once('/').map(|x| x.0).unwrap_or("")
}
pub fn name_of(p: &str) -> &str {
    p.rsplit_once('/').map(|x| x.1).unwrap_or(p)
}
pub fn join(a: &str, b: &str) -> String {
    if a.is_empty() { b.to_string() } else if b.is_empty() { a.to_string() } else { format!("{a}/{b}") }
}

#[derive(Clone)]
pub struct Tree {
    pub ci: bool,
    map: BTreeMap<String, Node>,
}

impl Tree {
    pub fn new(ci: bool) -> Tree {
        Tree { ci, map: BTreeMap::new() }
    }
    pub fn from_base(base: &[BEntry], ci: bool) -> Tree {
        let mut t = Tree::new(ci);
        for e in base {
            let p = norm_loose(&e.path);
            t.map.insert(t.key(&p), Node { path: p.clone(), kind: e.kind, size: e.size, mtime: e.mtime, origin: Some(p), copy: false, put: None });
        }
        t
    }
    pub fn key(&self, p: &str) -> String {
        if self.ci { p.to_lowercase() } else { p.to_string() }
    }
    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn get(&self, p: &str) -> Option<&Node> {
        self.map.get(&self.key(p))
    }
    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.map.values()
    }
    fn is_dir(&self, p: &str) -> bool {
        p.is_empty() || self.get(p).map(|n| n.kind == Kind::Dir).unwrap_or(false)
    }
    /// everything below a folder (not the folder itself)
    pub fn below(&self, p: &str) -> Vec<&Node> {
        if p.is_empty() {
            return self.map.values().collect();
        }
        let k = self.key(p);
        self.map.range(format!("{k}/")..format!("{k}0")).map(|x| x.1).collect()
    }
    /// what is directly inside a folder
    pub fn children(&self, p: &str) -> Vec<&Node> {
        let prefix = if p.is_empty() { String::new() } else { format!("{}/", self.key(p)) };
        self.below(p).into_iter().filter(|n| !self.key(&n.path)[prefix.len()..].contains('/')).collect()
    }
    fn subtree(&self, p: &str) -> Vec<Node> {
        let mut v: Vec<Node> = self.get(p).into_iter().cloned().collect();
        v.extend(self.below(p).into_iter().cloned());
        v
    }
    fn remove_subtree(&mut self, p: &str) {
        let keys: Vec<String> = self.below(p).iter().map(|n| self.key(&n.path)).collect();
        for k in keys {
            self.map.remove(&k);
        }
        let k = self.key(p);
        self.map.remove(&k);
    }
    fn insert(&mut self, n: Node) {
        let k = self.key(&n.path);
        self.map.insert(k, n);
    }
    fn check_parent(&self, to: &str) -> Result<(), String> {
        let par = parent_of(to);
        if !self.is_dir(par) {
            return Err(format!("The folder “{}” isn’t there", if par.is_empty() { "." } else { par }));
        }
        Ok(())
    }
    fn inside(&self, p: &str, dir: &str) -> bool {
        self.key(p).starts_with(&format!("{}/", self.key(dir)))
    }
    fn need(&self, p: &str) -> Result<&Node, String> {
        let n = self.get(p).ok_or_else(|| format!("“{p}” isn’t there"))?;
        if n.kind == Kind::Link {
            return Err(format!("“{p}” is a link or a folder Dogfile can’t look into, so a reality doesn’t change it"));
        }
        Ok(n)
    }
    fn no_links(&self, p: &str) -> Result<(), String> {
        if let Some(l) = self.below(p).into_iter().find(|n| n.kind == Kind::Link) {
            return Err(format!("“{}” is a link or a folder Dogfile can’t look into, so “{p}” can’t be changed as a whole", l.path));
        }
        Ok(())
    }

    /// Make one change. Nothing is ever replaced: a name that is taken is an error. `fp` collects what the change
    /// relies on in the folder as it was.
    pub fn apply(&mut self, op: &OpKind, mut fp: Option<&mut Footprint>) -> Result<Vec<Act>, String> {
        let acts: Vec<Act>;
        match op {
            OpKind::Mkdir { path } => {
                let p = norm(path)?;
                if p.is_empty() {
                    return Err("That folder is already there".into());
                }
                if self.get(&p).is_some() {
                    return Err(format!("“{p}” already exists"));
                }
                self.check_parent(&p)?;
                acts = vec![Act::Mkdir { path: p.clone() }];
                self.insert(Node { path: p, kind: Kind::Dir, size: 0, mtime: 0, origin: None, copy: false, put: None });
            }
            OpKind::Move { from, to } => {
                let (from, to) = (norm_loose(from), norm(to)?);
                if from.is_empty() || to.is_empty() {
                    return Err("The folder itself can’t be moved".into());
                }
                let node = self.need(&from)?.clone();
                let same_key = self.key(&from) == self.key(&to);
                if from == to {
                    return Err("It’s already there".into());
                }
                if !same_key && self.get(&to).is_some() {
                    return Err(format!("“{to}” already exists"));
                }
                if node.kind == Kind::Dir && self.inside(&to, &from) {
                    return Err("A folder can’t be moved into itself".into());
                }
                self.check_parent(&to)?;
                if let (Some(f), Some(o)) = (fp.as_deref_mut(), node.origin.as_ref()) {
                    if !node.copy {
                        if node.kind == Kind::Dir { f.dirs.push(o.clone()) } else { f.files.push(o.clone()) }
                    }
                }
                let src = node.path.clone();
                acts = vec![Act::Mv { from: src.clone(), to: to.clone() }];
                let moved = self.subtree(&from);
                self.remove_subtree(&from);
                for mut n in moved {
                    n.path = format!("{to}{}", &n.path[src.len()..]);
                    self.insert(n);
                }
            }
            OpKind::Delete { path } => {
                let p = norm_loose(path);
                if p.is_empty() {
                    return Err("The folder itself can’t be deleted".into());
                }
                let node = self.need(&p)?.clone();
                if node.kind == Kind::Dir {
                    self.no_links(&p)?;
                }
                if let Some(f) = fp.as_deref_mut() {
                    self.footprint_of(&p, f);
                }
                acts = vec![Act::Stage { path: node.path.clone() }];
                self.remove_subtree(&p);
            }
            OpKind::Put { path, blob, size, from_size, from_mtime, from_hash } => {
                let p = norm_loose(path);
                if p.is_empty() {
                    return Err("The folder itself has no contents to change".into());
                }
                check_blob(blob, *size)?;
                let node = self.need(&p)?.clone();
                if node.kind != Kind::File {
                    return Err(format!("“{p}” isn’t a file"));
                }
                if node.copy {
                    return Err(format!("“{p}” is a copy. Change the original before copying it."));
                }
                let Some(origin) = node.origin.clone() else {
                    return Err(format!("“{p}” is a new file here. Its contents can’t be changed again."));
                };
                if node.put.is_some() {
                    return Err(format!("The contents of “{p}” are already changed here. Remove that change to change them again."));
                }
                if node.size != *from_size || node.mtime != *from_mtime || !super::blobs::valid(from_hash) {
                    return Err(format!("“{p}” has changed since this change was made"));
                }
                if let Some(f) = fp.as_deref_mut() {
                    f.files.push(origin);
                }
                acts = vec![Act::Put { path: node.path.clone(), blob: blob.clone(), size: *size, replace: true, from_hash: from_hash.clone() }];
                let mut n = node;
                n.put = Some(blob.clone());
                n.size = *size;
                self.insert(n);
            }
            OpKind::NewFile { path, blob, size } => {
                let p = norm(path)?;
                if p.is_empty() {
                    return Err("That is the folder itself".into());
                }
                check_blob(blob, *size)?;
                if self.get(&p).is_some() {
                    return Err(format!("“{p}” already exists"));
                }
                self.check_parent(&p)?;
                acts = vec![Act::Put { path: p.clone(), blob: blob.clone(), size: *size, replace: false, from_hash: String::new() }];
                self.insert(Node { path: p, kind: Kind::File, size: *size, mtime: 0, origin: None, copy: false, put: Some(blob.clone()) });
            }
            OpKind::Copy { from, to } => {
                let (from, to) = (norm_loose(from), norm(to)?);
                if from.is_empty() || to.is_empty() {
                    return Err("The folder itself can’t be copied".into());
                }
                let node = self.need(&from)?.clone();
                if self.get(&to).is_some() {
                    return Err(format!("“{to}” already exists"));
                }
                if node.kind == Kind::Dir && self.inside(&to, &from) {
                    return Err("A folder can’t be copied into itself".into());
                }
                if node.kind == Kind::Dir {
                    self.no_links(&from)?;
                }
                self.check_parent(&to)?;
                if let Some(f) = fp.as_deref_mut() {
                    self.footprint_of(&from, f);
                }
                let mut a = vec![];
                let src = node.path.clone();
                for mut n in self.subtree(&from) {
                    let old = n.path.clone();
                    n.path = format!("{to}{}", &old[src.len()..]);
                    n.copy = true;
                    a.push(if n.kind == Kind::Dir { Act::Mkdir { path: n.path.clone() } } else { Act::CopyFile { from: old, to: n.path.clone() } });
                    self.insert(n);
                }
                acts = a;
            }
        }
        Ok(acts)
    }

    /// everything in `p` (a file or a folder with all it holds) that comes from the baseline
    fn footprint_of(&self, p: &str, f: &mut Footprint) {
        let mut all: Vec<&Node> = self.get(p).into_iter().collect();
        all.extend(self.below(p));
        for n in all {
            if n.copy {
                continue;
            }
            let Some(o) = &n.origin else { continue };
            match n.kind {
                Kind::File => f.files.push(o.clone()),
                Kind::Dir => f.dirs.push(o.clone()),
                Kind::Link => {}
            }
        }
        if let Some(n) = self.get(p) {
            if n.kind == Kind::Dir && !n.copy {
                if let Some(o) = &n.origin {
                    f.deep.push(o.clone());
                }
            }
        }
    }
}

/// How an item compares with the folder as it was, for the badges in the list
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Change {
    Same,
    Renamed,
    Moved,
    New,
    Copy,
}
pub fn change_of(t: &Tree, n: &Node) -> Change {
    if n.copy {
        // only the top of a copied folder is "a copy"; what's inside it came along
        let par = parent_of(&n.path);
        return match t.get(par) {
            Some(p) if p.copy => Change::Same,
            _ => Change::Copy,
        };
    }
    let Some(o) = &n.origin else { return Change::New };
    if *o == n.path {
        return Change::Same;
    }
    // inside a folder that was moved or renamed: it came along, it wasn't moved itself
    if let Some(po) = t.get(parent_of(&n.path)).and_then(|p| p.origin.clone()) {
        if *o == join(&po, name_of(&n.path)) {
            return Change::Same;
        }
    }
    if parent_of(o) == parent_of(&n.path) { Change::Renamed } else { Change::Moved }
}
