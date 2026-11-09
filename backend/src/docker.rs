// Docker for the terminal section's Docker tab: containers (start, stop, restart, pause, remove, logs, inspect), images,
// volumes, networks, clean-up, and Compose projects in a folder. It runs the docker program (so it needs Docker Desktop or
// Docker Engine installed) and never goes through a shell, so a name can't turn into a command.
use crate::args::{Args, R};
use crate::util;
use serde_json::{json, Value};
use std::path::Path;

const LOG_CAP: usize = 400_000;

struct Out {
    out: String,
    err: String,
}

async fn docker_in(dir: Option<&str>, args: &[&str], timeout: u64) -> Result<Out, String> {
    let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let o = util::run("docker", &a, dir.map(Path::new), timeout).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { "NO_DOCKER".to_string() } else { e.to_string() }
    })?;
    if o.ok {
        Ok(Out { out: o.out(), err: o.err() })
    } else {
        let e = o.err();
        let t = if e.trim().is_empty() { o.out() } else { e };
        let t: String = t.trim().chars().take(700).collect();
        // the docker program is there but its engine isn't running
        if t.contains("error during connect") || t.contains("Cannot connect to the Docker daemon") || t.contains("docker daemon") && t.contains("running") {
            Err("NO_ENGINE".to_string())
        } else {
            Err(t)
        }
    }
}
async fn docker(args: &[&str], timeout: u64) -> Result<Out, String> {
    docker_in(None, args, timeout).await
}

/// a name, id, tag or address that is safe to pass on
fn safe(s: &str) -> Result<&str, String> {
    if !s.is_empty() && s.len() < 300 && !s.starts_with('-') && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.:/@-+".contains(c)) {
        Ok(s)
    } else {
        Err(format!("“{s}” isn’t a valid Docker name"))
    }
}

/// one JSON object per line (what `--format '{{json .}}'` prints)
fn json_lines(s: &str) -> Vec<Value> {
    s.lines().filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok()).collect()
}

fn label(labels: &str, key: &str) -> String {
    labels.split(',').find_map(|kv| kv.strip_prefix(&format!("{key}="))).unwrap_or("").to_string()
}

pub fn container_row(v: &Value) -> Value {
    let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
    let id = s("ID");
    let labels = s("Labels");
    json!({
        "id": id, "shortId": id.chars().take(12).collect::<String>(), "name": s("Names"), "image": s("Image"),
        "state": s("State"), "status": s("Status"), "ports": s("Ports"), "created": s("CreatedAt"),
        "compose": label(&labels, "com.docker.compose.project"), "service": label(&labels, "com.docker.compose.service"),
    })
}

pub async fn status(_a: &Args) -> R {
    match docker(&["info", "--format", "{{json .}}"], 12_000).await {
        Ok(o) => {
            let v: Value = serde_json::from_str(o.out.trim()).unwrap_or(Value::Null);
            Ok(json!({ "installed": true, "running": true, "version": v["ServerVersion"], "os": v["OperatingSystem"], "context": v["Name"],
                "containers": v["Containers"], "running_count": v["ContainersRunning"], "paused": v["ContainersPaused"], "stopped": v["ContainersStopped"], "images": v["Images"] }))
        }
        Err(e) if e == "NO_DOCKER" => Ok(json!({ "installed": false, "running": false })),
        Err(e) if e == "NO_ENGINE" => Ok(json!({ "installed": true, "running": false })),
        Err(e) => Ok(json!({ "installed": true, "running": false, "error": e })),
    }
}

/// start Docker Desktop (Windows) when its engine isn't running
pub async fn start_engine(_a: &Args) -> R {
    let candidates = [std::env::var("ProgramFiles").unwrap_or_default() + "\\Docker\\Docker\\Docker Desktop.exe", "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe".to_string()];
    for c in candidates {
        if Path::new(&c).is_file() {
            return std::process::Command::new(&c).spawn().map(|_| json!(true)).map_err(|e| format!("Couldn’t start Docker Desktop: {e}"));
        }
    }
    Err("Docker Desktop wasn’t found. Start Docker from the Start menu.".into())
}

pub async fn containers(_a: &Args) -> R {
    let o = docker(&["ps", "-a", "--no-trunc", "--format", "{{json .}}"], 20_000).await?;
    Ok(json!(json_lines(&o.out).iter().map(container_row).collect::<Vec<_>>()))
}

/// a snapshot of what each running container uses
pub async fn stats(_a: &Args) -> R {
    let o = docker(&["stats", "--no-stream", "--no-trunc", "--format", "{{json .}}"], 30_000).await?;
    let mut m = serde_json::Map::new();
    for v in json_lines(&o.out) {
        if let Some(id) = v["ID"].as_str() {
            m.insert(id.to_string(), json!({ "cpu": v["CPUPerc"], "mem": v["MemUsage"], "memPct": v["MemPerc"], "net": v["NetIO"], "block": v["BlockIO"] }));
        }
    }
    Ok(Value::Object(m))
}

pub async fn images(_a: &Args) -> R {
    let o = docker(&["images", "--no-trunc", "--format", "{{json .}}"], 20_000).await?;
    Ok(json!(json_lines(&o.out).iter().map(|v| {
        let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
        let (repo, tag) = (s("Repository"), s("Tag"));
        let id = s("ID");
        json!({ "id": id, "shortId": id.trim_start_matches("sha256:").chars().take(12).collect::<String>(), "repo": repo, "tag": tag, "created": s("CreatedSince"), "size": s("Size"), "dangling": repo == "<none>",
            "ref": if repo == "<none>" { id.clone() } else { format!("{repo}:{tag}") } })
    }).collect::<Vec<_>>()))
}

pub async fn volumes(_a: &Args) -> R {
    let o = docker(&["volume", "ls", "--format", "{{json .}}"], 20_000).await?;
    Ok(json!(json_lines(&o.out).iter().map(|v| json!({ "name": v["Name"], "driver": v["Driver"], "scope": v["Scope"] })).collect::<Vec<_>>()))
}

pub async fn networks(_a: &Args) -> R {
    let o = docker(&["network", "ls", "--format", "{{json .}}"], 20_000).await?;
    Ok(json!(json_lines(&o.out).iter().map(|v| json!({ "id": v["ID"], "name": v["Name"], "driver": v["Driver"], "scope": v["Scope"] })).collect::<Vec<_>>()))
}

/// docker:action(kind, op, ids): "container" start | stop | restart | pause | unpause | kill | rm | rmf,
/// "image" rm | rmf, "volume" rm, "network" rm
pub async fn action(a: &Args) -> R {
    let (kind, op, ids) = (a.s(0)?, a.s(1)?, a.strs(2));
    if ids.is_empty() {
        return Err("Choose something first".into());
    }
    let mut args: Vec<&str> = match (kind.as_str(), op.as_str()) {
        ("container", "start" | "stop" | "restart" | "pause" | "unpause" | "kill") => vec![op.as_str()],
        ("container", "rm") => vec!["rm"],
        ("container", "rmf") => vec!["rm", "-f"],
        ("image", "rm") => vec!["rmi"],
        ("image", "rmf") => vec!["rmi", "-f"],
        ("volume", "rm") => vec!["volume", "rm"],
        ("network", "rm") => vec!["network", "rm"],
        _ => return Err("That isn’t something Dogfile does with Docker".into()),
    };
    for id in &ids {
        args.push(safe(id)?);
    }
    let o = docker(&args, 180_000).await?;
    Ok(json!(o.out.trim()))
}

/// docker:logs(id, tail): the last lines of a container's output
pub async fn logs(a: &Args) -> R {
    let (id, tail) = (a.s(0)?, a.u(1, 300).clamp(1, 20_000));
    let t = tail.to_string();
    let o = docker(&["logs", "--tail", &t, "--timestamps", safe(&id)?], 30_000).await?;
    // a container writes to both outputs, which docker keeps apart
    let mut text = format!("{}{}", o.out, o.err);
    if text.len() > LOG_CAP {
        text = text[text.len() - LOG_CAP..].to_string();
    }
    Ok(json!(text))
}

pub async fn inspect(a: &Args) -> R {
    let id = a.s(0)?;
    let o = docker(&["inspect", safe(&id)?], 20_000).await?;
    let v: Value = serde_json::from_str(&o.out).unwrap_or(Value::Null);
    Ok(json!(serde_json::to_string_pretty(&v).unwrap_or(o.out).chars().take(LOG_CAP).collect::<String>()))
}

/// docker:prune(what): "containers" (stopped ones), "images" (unused, untagged), "volumes" (unused), "networks" (unused)
pub async fn prune(a: &Args) -> R {
    let what = a.s(0)?;
    let args: Vec<&str> = match what.as_str() {
        "containers" => vec!["container", "prune", "-f"],
        "images" => vec!["image", "prune", "-f"],
        "volumes" => vec!["volume", "prune", "-f"],
        "networks" => vec!["network", "prune", "-f"],
        _ => return Err("Unknown clean-up".into()),
    };
    Ok(json!(docker(&args, 180_000).await?.out.trim()))
}

pub async fn pull(a: &Args) -> R {
    let image = a.s(0)?;
    Ok(json!(docker(&["pull", safe(&image)?], 900_000).await?.out.trim().lines().last().unwrap_or("Done")))
}

/// docker:composeFile(folder): the Compose file in a folder, if there is one
pub fn compose_file(a: &Args) -> R {
    let dir = a.s(0)?;
    for n in ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"] {
        if Path::new(&dir).join(n).is_file() {
            return Ok(json!(n));
        }
    }
    Ok(Value::Null)
}

/// docker:compose(folder, op): up | down | stop | start | restart | pull | build | ps | logs
pub async fn compose(a: &Args) -> R {
    let (dir, op) = (a.s(0)?, a.s(1)?);
    let args: Vec<&str> = match op.as_str() {
        "up" => vec!["compose", "up", "-d"],
        "down" => vec!["compose", "down"],
        "stop" => vec!["compose", "stop"],
        "start" => vec!["compose", "start"],
        "restart" => vec!["compose", "restart"],
        "pull" => vec!["compose", "pull"],
        "build" => vec!["compose", "build"],
        "ps" => vec!["compose", "ps", "-a"],
        "logs" => vec!["compose", "logs", "--tail", "300", "--no-color", "--timestamps"],
        _ => return Err("Unknown Compose action".into()),
    };
    let o = docker_in(Some(&dir), &args, 900_000).await?;
    Ok(json!(format!("{}{}", o.out, o.err)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_lines_become_rows() {
        let line = r#"{"ID":"0123456789abcdef0123","Image":"nginx:latest","Names":"web","State":"running","Status":"Up 2 hours","Ports":"0.0.0.0:8080->80/tcp","CreatedAt":"2026-11-01 10:00:00 +0000 UTC","Labels":"a=b,com.docker.compose.project=shop,com.docker.compose.service=web"}"#;
        let rows: Vec<Value> = json_lines(&format!("{line}\nnot json\n")).iter().map(container_row).collect();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0]["name"].as_str(), rows[0]["shortId"].as_str(), rows[0]["compose"].as_str(), rows[0]["service"].as_str()), (Some("web"), Some("0123456789ab"), Some("shop"), Some("web")));
    }

    #[test]
    fn only_plain_names_get_through() {
        assert!(safe("nginx:1.27-alpine").is_ok());
        assert!(safe("ghcr.io/me/app@sha256:abc").is_ok());
        assert!(safe("web_1").is_ok());
        assert!(safe("-f").is_err());
        assert!(safe("a b").is_err());
        assert!(safe("a;rm -rf /").is_err());
        assert!(safe("$(x)").is_err());
        assert!(safe("").is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn actions_are_limited_to_the_known_ones() {
        let call = |a: Vec<Value>| Args(a);
        assert!(action(&call(vec![json!("container"), json!("exec"), json!(["x"])])).await.is_err());
        assert!(action(&call(vec![json!("system"), json!("rm"), json!(["x"])])).await.is_err());
        assert!(action(&call(vec![json!("container"), json!("rm"), json!([])])).await.is_err());
        assert!(action(&call(vec![json!("container"), json!("rm"), json!(["--all"])])).await.is_err());
        assert!(prune(&call(vec![json!("system")])).await.is_err());
        assert!(compose(&call(vec![json!("."), json!("exec")])).await.is_err());
    }
}
