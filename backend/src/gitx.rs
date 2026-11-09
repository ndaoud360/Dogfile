// Git for the terminal section's Git tab: what has changed, stage / unstage / discard, commit, push, pull, fetch, stash,
// merge, a file's diff, who you are, and starting or cloning a repository. (git.rs has the status bar's branch menu.)
// It all goes through the git program, so it behaves exactly like git in the terminal.
use crate::args::{Args, R};
use crate::util;
use serde_json::{json, Value};
use std::path::Path;

const DIFF_CAP: usize = 300_000;

async fn git(dir: &str, args: &[&str], timeout: u64) -> Result<String, String> {
    let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let o = util::run("git", &a, Some(Path::new(dir)), timeout).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { "Git isn’t installed, or isn’t on the PATH".to_string() } else { e.to_string() }
    })?;
    if o.ok {
        Ok(o.out())
    } else {
        let e = o.err();
        let t = if e.trim().is_empty() { o.out() } else { e };
        Err(t.trim().chars().take(600).collect())
    }
}

/// the repository's top folder, or an error that says it isn't one
async fn root(dir: &str) -> Result<String, String> {
    git(dir, &["rev-parse", "--show-toplevel"], 8000).await.map(|s| s.trim().replace('/', std::path::MAIN_SEPARATOR_STR)).map_err(|e| if e.to_lowercase().contains("not a git") { "This folder isn’t a Git repository".to_string() } else { e })
}

/// `git status --porcelain=v2 --branch -z` as { branch, upstream, ahead, behind, files: [...] }
pub fn parse_status(out: &str) -> Value {
    let (mut branch, mut upstream, mut oid) = (String::new(), String::new(), String::new());
    let (mut ahead, mut behind) = (0i64, 0i64);
    let mut files: Vec<Value> = vec![];
    let parts: Vec<&str> = out.split('\0').collect();
    let mut i = 0;
    while i < parts.len() {
        let s = parts[i];
        i += 1;
        if s.is_empty() {
            continue;
        }
        if let Some(h) = s.strip_prefix("# ") {
            if let Some(v) = h.strip_prefix("branch.head ") {
                branch = v.to_string();
            } else if let Some(v) = h.strip_prefix("branch.upstream ") {
                upstream = v.to_string();
            } else if let Some(v) = h.strip_prefix("branch.oid ") {
                oid = v.to_string();
            } else if let Some(v) = h.strip_prefix("branch.ab ") {
                for t in v.split_whitespace() {
                    if let Some(n) = t.strip_prefix('+') {
                        ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = t.strip_prefix('-') {
                        behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let kind = s.as_bytes()[0];
        let entry = |xy: &str, path: &str, orig: Option<&str>, conflicted: bool| {
            let (x, y) = (xy.chars().next().unwrap_or('.'), xy.chars().nth(1).unwrap_or('.'));
            json!({ "path": path, "x": x.to_string(), "y": y.to_string(), "staged": x != '.' && !conflicted, "unstaged": y != '.' || conflicted, "untracked": false, "conflicted": conflicted, "orig": orig })
        };
        match kind {
            b'1' => {
                let f: Vec<&str> = s.splitn(9, ' ').collect();
                if f.len() == 9 {
                    files.push(entry(f[1], f[8], None, false));
                }
            }
            b'2' => {
                let f: Vec<&str> = s.splitn(10, ' ').collect();
                let orig = parts.get(i).copied();
                i += 1;
                if f.len() == 10 {
                    files.push(entry(f[1], f[9], orig, false));
                }
            }
            b'u' => {
                let f: Vec<&str> = s.splitn(11, ' ').collect();
                if f.len() == 11 {
                    files.push(entry(f[1], f[10], None, true));
                }
            }
            b'?' => files.push(json!({ "path": &s[2..], "x": "?", "y": "?", "staged": false, "unstaged": true, "untracked": true, "conflicted": false, "orig": null })),
            _ => {}
        }
    }
    let detached = branch == "(detached)";
    json!({ "branch": branch, "detached": detached, "oid": oid, "upstream": upstream, "ahead": ahead, "behind": behind, "files": files })
}

/// git:overview(dir) → the repository's state, or { repo: false } when the folder isn't one
pub async fn overview(a: &Args) -> R {
    let dir = a.s(0)?;
    let top = match root(&dir).await {
        Ok(t) => t,
        Err(e) if e.contains("isn’t a Git repository") => return Ok(json!({ "repo": false })),
        Err(e) => return Err(e),
    };
    let out = git(&top, &["status", "--porcelain=v2", "--branch", "-z", "-unormal"], 20000).await?;
    let mut v = parse_status(&out);
    let stashes = git(&top, &["stash", "list"], 8000).await.map(|s| s.lines().count()).unwrap_or(0);
    let remotes: Vec<Value> = git(&top, &["remote", "-v"], 8000)
        .await
        .map(|s| s.lines().filter(|l| l.ends_with("(push)")).filter_map(|l| { let mut p = l.split_whitespace(); Some(json!({ "name": p.next()?, "url": p.next()? })) }).collect())
        .unwrap_or_default();
    v["repo"] = json!(true);
    v["root"] = json!(top);
    v["stashes"] = json!(stashes);
    v["remotes"] = json!(remotes);
    Ok(v)
}

fn paths(a: &Args, i: usize) -> Vec<String> {
    a.strs(i)
}

pub async fn stage(a: &Args) -> R {
    let (dir, p) = (a.s(0)?, paths(a, 1));
    let top = root(&dir).await?;
    let mut args = vec!["add"];
    if p.is_empty() {
        args.push("-A");
    } else {
        args.push("--");
        args.extend(p.iter().map(|s| s.as_str()));
    }
    git(&top, &args, 60000).await?;
    Ok(json!(true))
}

pub async fn unstage(a: &Args) -> R {
    let (dir, p) = (a.s(0)?, paths(a, 1));
    let top = root(&dir).await?;
    let mut args = vec!["restore", "--staged", "--"];
    if p.is_empty() {
        args.push(".");
    } else {
        args.extend(p.iter().map(|s| s.as_str()));
    }
    if git(&top, &args, 60000).await.is_err() {
        // a repository with no commit yet has nothing to restore to
        let mut rm = vec!["rm", "--cached", "-r", "-q", "--"];
        if p.is_empty() {
            rm.push(".");
        } else {
            rm.extend(p.iter().map(|s| s.as_str()));
        }
        git(&top, &rm, 60000).await?;
    }
    Ok(json!(true))
}

/// git:discard(dir, paths, untracked): throw changes away. Cannot be undone, so the window asks first.
pub async fn discard(a: &Args) -> R {
    let (dir, p, untracked) = (a.s(0)?, paths(a, 1), a.b(2));
    if p.is_empty() {
        return Err("Choose what to discard".into());
    }
    let top = root(&dir).await?;
    let mut args = if untracked { vec!["clean", "-fd", "--"] } else { vec!["restore", "--"] };
    args.extend(p.iter().map(|s| s.as_str()));
    git(&top, &args, 60000).await?;
    Ok(json!(true))
}

pub async fn commit(a: &Args) -> R {
    let (dir, msg, amend) = (a.s(0)?, a.s(1)?, a.b(2));
    if msg.trim().is_empty() && !amend {
        return Err("Write a commit message first".into());
    }
    let top = root(&dir).await?;
    let mut args = vec!["commit"];
    if amend {
        args.push("--amend");
    }
    if msg.trim().is_empty() {
        args.push("--no-edit");
    } else {
        args.extend(["-m", msg.as_str()]);
    }
    let out = git(&top, &args, 60000).await.map_err(|e| {
        if e.to_lowercase().contains("tell me who you are") || e.to_lowercase().contains("empty ident") { "NEED_IDENTITY".to_string() } else { e }
    })?;
    Ok(json!(out.lines().next().unwrap_or("Committed")))
}

pub async fn push(a: &Args) -> R {
    let dir = a.s(0)?;
    let top = root(&dir).await?;
    if git(&top, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 8000).await.is_ok() {
        return Ok(json!(git(&top, &["push"], 180_000).await?));
    }
    // a new branch: send it and remember where it went
    let remote = git(&top, &["remote"], 8000).await?.lines().next().map(String::from).ok_or("There is no remote to push to. Add one first (git remote add origin <url>).")?;
    Ok(json!(git(&top, &["push", "-u", &remote, "HEAD"], 180_000).await?))
}

pub async fn fetch(a: &Args) -> R {
    let top = root(&a.s(0)?).await?;
    Ok(json!(git(&top, &["fetch", "--all", "--prune"], 180_000).await?))
}

/// git:sync(dir, mode): "ff" (only when it can just move forward), "rebase" or "merge"
pub async fn sync(a: &Args) -> R {
    let (dir, mode) = (a.s(0)?, a.s(1).unwrap_or_else(|_| "ff".into()));
    let top = root(&dir).await?;
    let flag = match mode.as_str() {
        "rebase" => "--rebase",
        "merge" => "--no-rebase",
        _ => "--ff-only",
    };
    Ok(json!(git(&top, &["pull", flag], 180_000).await?))
}

/// git:diff(dir, path, staged): the change in one file as text
pub async fn diff(a: &Args) -> R {
    let (dir, path, staged) = (a.s(0)?, a.s(1)?, a.b(2));
    let top = root(&dir).await?;
    let mut args = vec!["diff", "--no-color"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", path.as_str()]);
    let mut out = git(&top, &args, 30000).await?;
    if out.trim().is_empty() {
        // a file git doesn't know yet: show it as new
        let full = Path::new(&top).join(&path);
        if let Ok(t) = std::fs::read_to_string(&full) {
            out = format!("New file: {path}\n\n{}", t.lines().take(2000).map(|l| format!("+{l}")).collect::<Vec<_>>().join("\n"));
        }
    }
    let truncated = out.len() > DIFF_CAP;
    if truncated {
        out = out.chars().take(DIFF_CAP).collect();
    }
    Ok(json!({ "text": out, "truncated": truncated }))
}

/// git:stash(dir, op, arg): list, push (with a name), pop, apply, drop
pub async fn stash(a: &Args) -> R {
    let (dir, op) = (a.s(0)?, a.s(1)?);
    let arg = a.s(2).unwrap_or_default();
    let top = root(&dir).await?;
    match op.as_str() {
        "list" => {
            let out = git(&top, &["stash", "list", "--format=%gd\x1f%gs\x1f%cr"], 8000).await?;
            Ok(json!(out.lines().filter(|l| !l.is_empty()).map(|l| { let p: Vec<&str> = l.split('\x1f').collect(); json!({ "ref": p.first(), "message": p.get(1), "when": p.get(2) }) }).collect::<Vec<_>>()))
        }
        "push" => {
            let mut args = vec!["stash", "push", "-u"];
            if !arg.trim().is_empty() {
                args.extend(["-m", arg.as_str()]);
            }
            Ok(json!(git(&top, &args, 60000).await?))
        }
        "pop" | "apply" | "drop" => {
            let target = if arg.is_empty() { "stash@{0}" } else { arg.as_str() };
            Ok(json!(git(&top, &["stash", op.as_str(), target], 60000).await?))
        }
        _ => Err("Unknown stash action".into()),
    }
}

pub async fn merge(a: &Args) -> R {
    let (dir, br) = (a.s(0)?, a.s(1)?);
    let top = root(&dir).await?;
    Ok(json!(git(&top, &["merge", "--no-edit", &br], 120_000).await?))
}

pub async fn branch_delete(a: &Args) -> R {
    let (dir, br, force) = (a.s(0)?, a.s(1)?, a.b(2));
    let top = root(&dir).await?;
    git(&top, &["branch", if force { "-D" } else { "-d" }, &br], 30000).await?;
    Ok(json!(true))
}

pub async fn identity(a: &Args) -> R {
    let dir = a.s(0)?;
    let get = |k: &'static str| {
        let d = dir.clone();
        async move { git(&d, &["config", k], 8000).await.map(|s| s.trim().to_string()).unwrap_or_default() }
    };
    Ok(json!({ "name": get("user.name").await, "email": get("user.email").await }))
}

pub async fn set_identity(a: &Args) -> R {
    let (dir, name, email, global) = (a.s(0)?, a.s(1)?, a.s(2)?, a.b(3));
    if name.trim().is_empty() || !email.contains('@') {
        return Err("Enter your name and your email address".into());
    }
    let scope = if global { "--global" } else { "--local" };
    git(&dir, &["config", scope, "user.name", name.trim()], 8000).await?;
    git(&dir, &["config", scope, "user.email", email.trim()], 8000).await?;
    Ok(json!(true))
}

pub async fn init(a: &Args) -> R {
    let dir = a.s(0)?;
    git(&dir, &["init", "-b", "main"], 15000).await.or(git(&dir, &["init"], 15000).await)?;
    Ok(json!(true))
}

/// git:clone(url, parentFolder): the new folder's path
pub async fn clone(a: &Args) -> R {
    let (url, parent) = (a.s(0)?, a.s(1)?);
    if url.trim().is_empty() || url.starts_with('-') {
        return Err("Enter the repository address".into());
    }
    let name = url.trim_end_matches('/').trim_end_matches(".git").rsplit(['/', ':']).next().filter(|s| !s.is_empty()).unwrap_or("repository").to_string();
    let target = Path::new(&parent).join(&name);
    if target.exists() {
        return Err(format!("“{name}” already exists in that folder"));
    }
    git(&parent, &["clone", "--", url.trim(), &name], 900_000).await?;
    Ok(json!(target.to_string_lossy()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_text_becomes_files_and_branch_facts() {
        let raw = "# branch.oid abc123\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
            1 M. N... 100644 100644 100644 aaa bbb staged.txt\0\
            1 .M N... 100644 100644 100644 aaa bbb changed file.txt\0\
            2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt\0old name.txt\0\
            u UU N... 100644 100644 100644 100644 a b c both.txt\0\
            ? brand new.txt\0";
        let v = parse_status(raw);
        assert_eq!((v["branch"].as_str(), v["upstream"].as_str(), v["ahead"].as_i64(), v["behind"].as_i64()), (Some("main"), Some("origin/main"), Some(2), Some(1)));
        let f = v["files"].as_array().unwrap();
        assert_eq!(f.len(), 5);
        assert_eq!((f[0]["path"].as_str(), f[0]["staged"].as_bool(), f[0]["unstaged"].as_bool()), (Some("staged.txt"), Some(true), Some(false)));
        assert_eq!((f[1]["path"].as_str(), f[1]["staged"].as_bool(), f[1]["unstaged"].as_bool()), (Some("changed file.txt"), Some(false), Some(true)));
        assert_eq!((f[2]["path"].as_str(), f[2]["orig"].as_str()), (Some("new name.txt"), Some("old name.txt")));
        assert_eq!((f[3]["conflicted"].as_bool(), f[3]["path"].as_str()), (Some(true), Some("both.txt")));
        assert_eq!((f[4]["untracked"].as_bool(), f[4]["path"].as_str()), (Some(true), Some("brand new.txt")));
        assert_eq!(parse_status("# branch.head (detached)\0")["detached"], true);
    }

    fn have_git() -> bool {
        std::process::Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_real_repository_end_to_end() {
        if !have_git() {
            return;
        }
        let d = std::env::temp_dir().join(format!("dogfile-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let dir = d.to_string_lossy().to_string();
        let call = |args: Vec<Value>| Args(args);
        // not a repository yet
        assert_eq!(overview(&call(vec![json!(dir)])).await.unwrap()["repo"], false);
        init(&call(vec![json!(dir)])).await.unwrap();
        set_identity(&call(vec![json!(dir), json!("Test Person"), json!("t@example.com"), json!(false)])).await.unwrap();
        assert_eq!(identity(&call(vec![json!(dir)])).await.unwrap()["name"], "Test Person");
        std::fs::write(d.join("a.txt"), "one\n").unwrap();
        std::fs::write(d.join("b b.txt"), "two\n").unwrap();
        let o = overview(&call(vec![json!(dir)])).await.unwrap();
        assert_eq!(o["repo"], true);
        assert_eq!(o["files"].as_array().unwrap().len(), 2);
        assert!(o["files"][0]["untracked"].as_bool().unwrap());
        // stage one, commit, then change it again
        stage(&call(vec![json!(dir), json!(["a.txt"])])).await.unwrap();
        let o = overview(&call(vec![json!(dir)])).await.unwrap();
        assert_eq!(o["files"].as_array().unwrap().iter().filter(|f| f["staged"] == true).count(), 1);
        unstage(&call(vec![json!(dir), json!(["a.txt"])])).await.unwrap(); // works before the first commit too
        stage(&call(vec![json!(dir)])).await.unwrap();
        assert!(commit(&call(vec![json!(dir), json!("first"), json!(false)])).await.is_ok());
        assert!(commit(&call(vec![json!(dir), json!("  "), json!(false)])).await.is_err());
        std::fs::write(d.join("a.txt"), "one\nchanged\n").unwrap();
        let df = diff(&call(vec![json!(dir), json!("a.txt"), json!(false)])).await.unwrap();
        assert!(df["text"].as_str().unwrap().contains("+changed"));
        // stash it away and bring it back
        stash(&call(vec![json!(dir), json!("push"), json!("wip")])).await.unwrap();
        assert_eq!(stash(&call(vec![json!(dir), json!("list")])).await.unwrap().as_array().unwrap().len(), 1);
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap().replace("\r\n", "\n"), "one\n"); // Windows git may check out CRLF
        stash(&call(vec![json!(dir), json!("pop")])).await.unwrap();
        assert!(std::fs::read_to_string(d.join("a.txt")).unwrap().contains("changed"));
        // throw the change away
        discard(&call(vec![json!(dir), json!(["a.txt"]), json!(false)])).await.unwrap();
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap().replace("\r\n", "\n"), "one\n"); // Windows git may check out CRLF
        // an untracked file is removed only when asked for as such
        std::fs::write(d.join("new.txt"), "x").unwrap();
        discard(&call(vec![json!(dir), json!(["new.txt"]), json!(true)])).await.unwrap();
        assert!(!d.join("new.txt").exists());
        // no remote: pushing says so
        assert!(push(&call(vec![json!(dir)])).await.is_err());
        // a repository can be cloned
        let copy = std::env::temp_dir().join(format!("dogfile-git-clone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&copy);
        std::fs::create_dir_all(&copy).unwrap();
        let got = clone(&call(vec![json!(dir), json!(copy.to_string_lossy())])).await.unwrap();
        assert!(Path::new(got.as_str().unwrap()).join(".git").exists());
        assert!(clone(&call(vec![json!(dir), json!(copy.to_string_lossy())])).await.is_err());
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&copy);
    }
}
