// Free, private AI search: open models (CLIP for pictures, Whisper for speech, MiniLM for text, CLAP for sound)
// downloaded once from Hugging Face and run in the window. This serves the model files and keeps an
// embedding cache so each file is only looked at once.
use crate::args::{Args, R};
use crate::http::Resp;
use crate::{st, util};
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

struct Model {
    repo: &'static str,
    label: &'static str,
    files: &'static [&'static str],
    optional: &'static [&'static str],
}
const MODELS: [(&str, Model); 8] = [
    ("clip", Model { repo: "Xenova/clip-vit-base-patch32", label: "Pictures & video (CLIP)", files: &["config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/text_model_quantized.onnx", "onnx/vision_model_quantized.onnx"], optional: &["special_tokens_map.json"] }),
    ("whisper", Model { repo: "Xenova/whisper-base", label: "Speech to text (Whisper)", files: &["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"], optional: &["special_tokens_map.json", "added_tokens.json"] }),
    ("minilm", Model { repo: "Xenova/all-MiniLM-L6-v2", label: "Text understanding (MiniLM)", files: &["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"], optional: &["special_tokens_map.json"] }),
    // the writing helper in Notepad (summarize, rewrite, fix grammar, write…): a small instruction model,
    // int8 for the processor (works everywhere) or 4-bit for the graphics card (much faster where WebGPU works)
    ("writer", Model { repo: "onnx-community/Qwen2.5-0.5B-Instruct", label: "Writing helper (Qwen2.5 0.5B)", files: &["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"], optional: &["generation_config.json"] }),
    ("writer-gpu", Model { repo: "onnx-community/Qwen2.5-0.5B-Instruct", label: "Writing helper for the graphics card (Qwen2.5 0.5B)", files: &["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_q4f16.onnx"], optional: &["generation_config.json"] }),
    // the assistant's language model (llama.cpp, GGUF): 4B for most PCs, 2B where memory is short
    ("brain", Model { repo: "unsloth/Qwen3.5-4B-GGUF", label: "Assistant (Qwen3.5 4B)", files: &["Qwen3.5-4B-Q4_K_M.gguf"], optional: &[] }),
    ("brain-small", Model { repo: "unsloth/Qwen3.5-2B-GGUF", label: "Assistant, smaller (Qwen3.5 2B)", files: &["Qwen3.5-2B-Q4_K_M.gguf"], optional: &[] }),
    ("clap", Model { repo: "Xenova/clap-htsat-unfused", label: "Music & sounds (CLAP)", files: &["config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/text_model_quantized.onnx", "onnx/audio_model_quantized.onnx"], optional: &["special_tokens_map.json"] }),
];
/// the file of a downloaded single-file model (the assistant's GGUF), when it's all there
pub fn ready_file(k: &str) -> Option<PathBuf> {
    let m = model(k)?;
    let f = dir_of(m).join(m.files.first()?);
    let partial = f.with_extension("part");
    (f.exists() && !partial.exists()).then_some(f)
}
/// every non-optional file of a model is in `dir`, with no download half-done
fn complete_in(m: &Model, dir: &std::path::Path) -> bool {
    m.files.iter().filter(|f| !m.optional.contains(f)).all(|f| {
        let p = dir.join(f);
        p.is_file() && !p.with_extension("part").exists()
    })
}
/// Models a different install of Dogfile on this PC downloaded (the Store package, the setup program's install, a
/// portable copy, Atlas Files): moved here (instant on the same drive, else copied), so updating from one kind of
/// install to another never asks to download them again.
pub fn adopt_models() {
    if std::env::var_os("ATLAS_MODELS_DIR").is_some() {
        return;
    }
    let now = st().data_dir.clone();
    let others = crate::store::other_data_dirs(&now);
    for (k, m) in MODELS.iter() {
        let here = dir_of(m);
        if complete_in(m, &here) {
            continue;
        }
        let rel: PathBuf = m.repo.split('/').collect();
        let Some(src) = others.iter().map(|d| d.join("models").join(&rel)).find(|d| complete_in(m, d)) else { continue };
        // the same folder seen through two paths (the Store package's view of AppData): nothing to do
        if matches!((src.canonicalize(), here.canonicalize()), (Ok(a), Ok(b)) if a == b) {
            continue;
        }
        // file by file, and nothing here is deleted first: a file already here at the same size stays as it is
        let mut moved = 0;
        let mut failed = None;
        for f in m.files {
            let (from, to) = (src.join(f), here.join(f));
            let Ok(md) = std::fs::metadata(&from) else { continue };
            if std::fs::metadata(&to).map(|t| t.len() == md.len()).unwrap_or(false) {
                continue;
            }
            if let Some(p) = to.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            let r = std::fs::rename(&from, &to).or_else(|_| {
                // another drive: copied under a temporary name, then named, so a half copy never looks complete
                let tmp = to.with_extension("part");
                std::fs::copy(&from, &tmp).and_then(|_| std::fs::rename(&tmp, &to))
            });
            match r {
                Ok(()) => {
                    moved += 1;
                    let _ = std::fs::remove_file(to.with_extension("part"));
                }
                Err(e) => {
                    failed = Some(e.to_string());
                    break;
                }
            }
        }
        match failed {
            None => crate::errlog(&format!("ai: model {k} taken over from {} ({moved} files)", src.display())),
            Some(e) => crate::errlog(&format!("ai: couldn't take model {k} over from {}: {e}", src.display())),
        }
    }
    crate::events::broadcast("ai:modelsChanged", json!(null));
}
pub fn models_dir() -> PathBuf {
    root()
}
fn model(k: &str) -> Option<&'static Model> {
    MODELS.iter().find(|(n, _)| *n == k).map(|(_, m)| m)
}
fn root() -> PathBuf {
    std::env::var("ATLAS_MODELS_DIR").map(PathBuf::from).unwrap_or_else(|_| st().data_dir.join("models"))
}
fn dir_of(m: &Model) -> PathBuf {
    m.repo.split('/').fold(root(), |p, x| p.join(x))
}
fn base() -> String {
    std::env::var("ATLAS_MODEL_BASE").unwrap_or_else(|_| "https://huggingface.co".into())
}

#[derive(Default, Clone)]
struct Dl {
    received: u64,
    total: u64,
    file: String,
    done: bool,
    error: Option<String>,
}
fn dls() -> &'static Mutex<HashMap<String, Dl>> {
    static D: OnceLock<Mutex<HashMap<String, Dl>>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(HashMap::new()))
}
fn dl_json(d: &Dl) -> Value {
    json!({ "received": d.received, "total": d.total, "file": d.file, "done": d.done, "error": d.error })
}

pub async fn status() -> R {
    let mut out = Map::new();
    let d = dls().lock().clone();
    for (k, m) in MODELS.iter() {
        let mut bytes = 0;
        let ready = m.files.iter().filter(|f| !m.optional.contains(f)).all(|f| match std::fs::metadata(dir_of(m).join(f)) {
            Ok(md) => {
                bytes += md.len();
                true
            }
            Err(_) => false,
        });
        let dl = d.get(*k);
        out.insert(k.to_string(), json!({ "ready": ready, "bytes": bytes, "label": m.label, "downloading": dl.map(|x| !x.done).unwrap_or(false), "progress": dl.map(dl_json) }));
    }
    Ok(Value::Object(out))
}

pub async fn download(a: &Args) -> R {
    let k = a.s(0)?;
    let m = model(&k).ok_or("Unknown model")?;
    if let Some(d) = dls().lock().get(&k) {
        if !d.done {
            return Ok(dl_json(d));
        }
    }
    dls().lock().insert(k.clone(), Dl::default());
    let key = k.clone();
    tokio::spawn(async move {
        let set = |f: &dyn Fn(&mut Dl)| {
            if let Some(d) = dls().lock().get_mut(&key) {
                f(d)
            }
        };
        let r: Result<(), String> = async {
            let dir = dir_of(m);
            std::fs::create_dir_all(dir.join("onnx")).map_err(|e| e.to_string())?;
            let client = util::http();
            // sizes and checksums first. Asked of huggingface.co itself without following its redirect: that answer
            // carries the file's size and SHA-256 (X-Linked-Size, X-Linked-Etag); the storage server it redirects to
            // has an ETag of its own that isn't the file's SHA-256, so that one is never used as a checksum
            let head_client = reqwest::Client::builder().user_agent("Dogfile/2.0").redirect(reqwest::redirect::Policy::none()).connect_timeout(std::time::Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
            let mut sizes: HashMap<&str, u64> = HashMap::new();
            let mut sums: HashMap<&str, String> = HashMap::new();
            for f in m.files {
                let url = format!("{}/{}/resolve/main/{f}", base(), m.repo);
                let mut n: u64 = 0;
                if let Ok(r) = head_client.head(&url).send().await {
                    let h = |k: &str| r.headers().get(k).and_then(|v| v.to_str().ok()).map(String::from);
                    n = h("x-linked-size").and_then(|s| s.parse().ok()).unwrap_or(0);
                    if let Some(sum) = h("x-linked-etag").map(|v| v.trim_start_matches("W/").trim_matches('"').to_lowercase()).filter(|v| v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit())) {
                        sums.insert(f, sum);
                    }
                    // a small file served directly (no redirect): its own length
                    if n == 0 && r.status().is_success() {
                        n = h("content-length").and_then(|s| s.parse().ok()).unwrap_or(0);
                    }
                }
                if n == 0 {
                    n = match client.head(&url).send().await {
                        Ok(r) => r.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).unwrap_or(0),
                        Err(_) => 0,
                    };
                }
                sizes.insert(f, n);
            }
            let total: u64 = sizes.values().sum();
            set(&|d| d.total = total);
            for f in m.files {
                let dest = dir.join(f);
                if let Ok(md) = std::fs::metadata(&dest) {
                    let want = sizes.get(f).copied().unwrap_or(0);
                    if want == 0 || md.len() == want {
                        set(&|d| d.received += md.len());
                        continue;
                    }
                }
                set(&|d| d.file = f.to_string());
                let url = format!("{}/{}/resolve/main/{f}", base(), m.repo);
                let r = client.get(&url).send().await.map_err(|e| e.to_string())?;
                if !r.status().is_success() {
                    if m.optional.contains(f) { continue }
                    return Err(format!("Download failed ({}) for {f}", r.status().as_u16()));
                }
                // the SHA-256 Hugging Face gave for this file (large files have one): a download that doesn't match is
                // thrown away instead of being used
                let want: Option<String> = sums.get(f).cloned();
                let tmp = dest.with_extension("part");
                let mut out = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
                let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
                let mut s = r.bytes_stream();
                while let Some(chunk) = s.next().await {
                    let c = chunk.map_err(|e| e.to_string())?;
                    out.write_all(&c).map_err(|e| e.to_string())?;
                    sha2::Digest::update(&mut hasher, &c);
                    let n = c.len() as u64;
                    set(&|d| d.received += n);
                }
                drop(out);
                if let Some(want) = want {
                    let got: String = sha2::Digest::finalize(hasher).iter().map(|b| format!("{b:02x}")).collect();
                    if got != want {
                        let _ = std::fs::remove_file(&tmp);
                        return Err(format!("{f} arrived damaged (its checksum doesn’t match). Try again."));
                    }
                }
                std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        .await;
        set(&|d| {
            d.done = true;
            d.file.clear();
            if let Err(e) = &r {
                d.error = Some(e.clone());
            }
        });
    });
    Ok(dl_json(&dls().lock().get(&k).cloned().unwrap_or_default()))
}
pub async fn remove(a: &Args) -> R {
    let k = a.s(0)?;
    let m = model(&k).ok_or("Unknown model")?;
    let _ = std::fs::remove_dir_all(dir_of(m));
    dls().lock().remove(&k);
    caches().lock().remove(&k);
    let _ = std::fs::remove_file(cache_file(&k));
    Ok(json!(true))
}

/// /models/<repo>/<file>
pub fn serve(rest: &str) -> Resp {
    let rel = urlencoding::decode(rest).map(|c| c.into_owned()).unwrap_or_default();
    if rel.split(['/', '\\']).any(|s| s == "..") {
        return Resp::text(403, "Forbidden");
    }
    let file = root().join(&rel);
    match std::fs::read(&file) {
        Ok(b) => Resp::bytes(200, if rel.ends_with(".json") { "application/json" } else { "application/octet-stream" }, b),
        Err(_) => Resp::text(404, "Not found"),
    }
}

// embedding cache: one JSON file per model, key = path|size|mtime -> base64 floats
fn caches() -> &'static Mutex<HashMap<String, Map<String, Value>>> {
    static C: OnceLock<Mutex<HashMap<String, Map<String, Value>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}
fn cache_file(k: &str) -> PathBuf {
    root().join(format!("cache-{k}.json"))
}
fn with_cache<T>(k: &str, f: impl FnOnce(&mut Map<String, Value>) -> T) -> T {
    let mut c = caches().lock();
    let m = c.entry(k.to_string()).or_insert_with(|| std::fs::read(cache_file(k)).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default());
    f(m)
}
pub async fn cache_get(a: &Args) -> R {
    let k = a.s(0)?;
    let keys = a.strs(1);
    Ok(with_cache(&k, |m| Value::Object(keys.iter().filter_map(|key| m.get(key).map(|v| (key.clone(), v.clone()))).collect())))
}
pub async fn cache_set(a: &Args) -> R {
    static GEN: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    let k = a.s(0)?;
    let entries = a.v(1);
    with_cache(&k, |m| {
        if let Some(e) = entries.as_object() {
            for (key, v) in e {
                m.insert(key.clone(), v.clone());
            }
        }
    });
    // written a moment later, once a burst of updates is over
    let g = GEN.get_or_init(|| Mutex::new(HashMap::new()));
    let my = {
        let mut gm = g.lock();
        let e = gm.entry(k.clone()).or_insert(0);
        *e += 1;
        *e
    };
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        if g.lock().get(&k).copied() != Some(my) {
            return;
        }
        let body = with_cache(&k, |m| serde_json::to_vec(&Value::Object(m.clone())).unwrap_or_default());
        let _ = std::fs::create_dir_all(root());
        let _ = std::fs::write(cache_file(&k), body);
    });
    Ok(json!(true))
}
