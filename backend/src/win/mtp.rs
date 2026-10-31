// Phones, cameras and media players (MTP / WPD) through the shell: they live in "This PC" without a drive letter.
// Paths look like  atlas:mtp|<device name>|<folder>/<sub>/<file>
use super::shellx::*;
use crate::args::{strs, R};
use serde_json::{json, Value};
use windows::Win32::Storage::EnhancedStorage::{PKEY_DateModified, PKEY_Size};
use windows::Win32::UI::Shell::{IShellItem, FOLDERID_ComputerFolder};

fn parts(p: &str) -> Vec<String> {
    let i = p.find('|').unwrap_or(0);
    let rest = &p[i + 1..];
    let (dev, path) = match rest.find('|') {
        Some(j) => (&rest[..j], &rest[j + 1..]),
        None => (rest, ""),
    };
    let mut v = vec![dev.to_string()];
    v.extend(path.split('/').filter(|s| !s.is_empty()).map(String::from));
    v
}
fn resolve(parts: &[String]) -> Result<IShellItem, String> {
    super::com_init();
    let mut cur = known_item(&FOLDERID_ComputerFolder).map_err(|e| e.message())?;
    // phones linked through Windows live at the top of the namespace, not in This PC
    if let Some(dev) = parts.first() {
        if find_child(&cur, dev).is_none() {
            if let Ok(root) = known_item(&windows::Win32::UI::Shell::FOLDERID_Desktop) {
                cur = root;
            }
        }
    }
    for n in parts {
        cur = find_child(&cur, n).ok_or_else(|| format!("Not found: {n}"))?;
    }
    Ok(cur)
}
pub fn item_of(p: &str) -> Result<IShellItem, String> {
    resolve(&parts(p))
}
fn list(p: &str) -> R {
    let base = if p.ends_with('|') { p.to_string() } else { format!("{p}/") };
    let f = resolve(&parts(p))?;
    Ok(json!(children(&f)
        .into_iter()
        .map(|c| {
            let name = file_name(&c);
            let dir = is_folder(&c);
            json!({ "name": name, "path": format!("{base}{name}"), "isDir": dir, "size": if dir { Value::Null } else { json!(prop_u64(&c, &PKEY_Size).unwrap_or(0)) },
                "mtime": prop_time(&c, &PKEY_DateModified), "ctime": 0, "ext": if dir { String::new() } else { crate::util::ext(&name) }, "hidden": false, "mtp": true })
        })
        .collect::<Vec<_>>()))
}
pub fn call(name: &str, a0: Value, a1: Value) -> R {
    match name {
        "mtp:list" => list(a0.as_str().unwrap_or("")),
        "mtp:copyOut" => {
            let dest = a1.as_str().unwrap_or("").to_string();
            let d = item(&dest).map_err(|e| e.message())?;
            let mut out = vec![];
            for p in strs(&a0) {
                let it = resolve(&parts(&p))?;
                let op = file_op(NO_UI).map_err(|e| e.message())?;
                copy_item(&op, &it, &d).map_err(|e| e.message())?;
                run_op(&op).map_err(|e| e.message())?;
                out.push(crate::util::join(&dest, &file_name(&it)));
            }
            Ok(json!(out))
        }
        "mtp:copyIn" => {
            let f = resolve(&parts(a1.as_str().unwrap_or("")))?;
            let op = file_op(NO_UI).map_err(|e| e.message())?;
            for lp in strs(&a0) {
                let it = item(&lp).map_err(|e| e.message())?;
                copy_item(&op, &it, &f).map_err(|e| e.message())?;
            }
            run_op(&op).map_err(|e| e.message())?;
            Ok(json!(true))
        }
        "mtp:delete" => {
            let op = file_op(NO_UI).map_err(|e| e.message())?;
            for p in strs(&a0) {
                let it = resolve(&parts(&p))?;
                delete_item(&op, &it).map_err(|e| e.message())?;
            }
            run_op(&op).map_err(|e| e.message())?;
            Ok(json!(true))
        }
        "mtp:mkdir" => {
            let f = resolve(&parts(a0.as_str().unwrap_or("")))?;
            let op = file_op(NO_UI).map_err(|e| e.message())?;
            new_folder(&op, &f, a1.as_str().unwrap_or("New folder")).map_err(|e| e.message())?;
            run_op(&op).map_err(|e| e.message())?;
            Ok(json!(true))
        }
        "mtp:rename" => {
            let it = resolve(&parts(a0.as_str().unwrap_or("")))?;
            let op = file_op(NO_UI).map_err(|e| e.message())?;
            rename_item(&op, &it, a1.as_str().unwrap_or("")).map_err(|e| e.message())?;
            run_op(&op).map_err(|e| e.message())?;
            Ok(json!(true))
        }
        _ => Err(format!("Unknown {name}")),
    }
}
