//! The assistant's language model (Qwen3.5, GGUF, run by llama.cpp inside Dogfile: nothing leaves the PC).
//!
//! It only turns a request into steps. The prompt and the output grammar come from backend/brain.json: the model is
//! told what Dogfile can do and how to answer, and a grammar built from the JSON schema below makes it impossible for
//! it to answer anything but a valid plan using real feature names. The interface (assistant-brain.js) then checks
//! every file name against the real folder and asks before anything risky.
//!
//! The model runs on a thread of its own, which owns it: requests arrive over a channel. The long fixed part of the
//! prompt (instructions, features, examples) is processed once and its state kept (in memory and on disk), so each
//! request only reads its own few lines.
use serde_json::{json, Value};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::session::LlamaStateSeqFlags;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;

pub const BRAIN: &str = include_str!("../brain.json");
const N_CTX: u32 = 8192;
const MAX_OUT: usize = 600;

fn brain() -> &'static Value {
    static B: OnceLock<Value> = OnceLock::new();
    B.get_or_init(|| serde_json::from_str(BRAIN).expect("brain.json"))
}

/// the JSON schema every answer follows (feature ids from brain.json)
pub fn schema() -> Value {
    let ids: Vec<Value> = brain()["features"].as_object().map(|o| o.keys().map(|k| json!(k)).collect()).unwrap_or_default();
    let s = |d: &str| json!({ "type": "string", "maxLength": 300, "description": d });
    let step = |kind: &str, props: Value, required: &[&str]| {
        let mut p = json!({ "do": { "const": kind } });
        for (k, v) in props.as_object().unwrap() {
            p[k] = v.clone();
        }
        let mut req = vec!["do".to_string()];
        req.extend(required.iter().map(|x| x.to_string()));
        json!({ "type": "object", "properties": p, "required": req, "additionalProperties": false })
    };
    json!({
        "type": "object",
        "properties": {
            "steps": { "type": "array", "minItems": 1, "maxItems": 8, "items": { "oneOf": [
                step("files", json!({
                    "action": { "enum": ["find", "open", "move", "copy", "delete", "zip", "rename", "tag", "group", "count", "size", "shelf", "new_folder", "select"] },
                    "names": { "type": "array", "items": { "type": "string", "maxLength": 200 }, "maxItems": 20 },
                    "what": s("kind of files and filters"),
                    "where": s("where to look"),
                    "to": s("destination, name or details"),
                }), &["action"]),
                step("feature", json!({ "id": { "enum": ids }, "detail": s("specifics") }), &["id"]),
                step("go", json!({ "place": s("place or folder") }), &["place"]),
                step("app", json!({ "request": s("request") }), &["request"]),
                step("write", json!({ "request": s("request") }), &["request"]),
                step("help", json!({ "question": s("question") }), &["question"]),
                step("ask", json!({ "question": s("question") }), &["question"]),
                step("say", json!({ "text": s("reply") }), &["text"]),
            ] } }
        },
        "required": ["steps"],
        "additionalProperties": false
    })
}

/// the fixed start of every prompt (ChatML, as Qwen expects)
pub fn system_prompt() -> String {
    let b = brain();
    let mut s = String::new();
    for l in b["system"].as_array().into_iter().flatten() {
        s.push_str(l.as_str().unwrap_or(""));
        s.push('\n');
    }
    s.push_str("\nFeatures (id: what it is):\n");
    for (k, v) in b["features"].as_object().into_iter().flatten() {
        s.push_str(&format!("- {k}: {}\n", v.as_str().unwrap_or("")));
    }
    s.push_str("\nExamples:\n");
    for ex in b["examples"].as_array().into_iter().flatten() {
        s.push_str(&format!("{}\nAnswer: {}\n\n", ex[0].as_str().unwrap_or(""), ex[1]));
    }
    format!("<|im_start|>system\n{}<|im_end|>\n", s.trim_end())
}
/// one request: the context lines (folder, selection…) and the request, then the start of the answer
/// (an empty think block: Qwen3.5 answers directly)
pub fn request_prompt(context: &str) -> String {
    format!("<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n", context.trim())
}

// ---------------------------------------------------------------------------------------------------------------
// the worker thread
pub struct Job {
    pub context: String,
    pub reply: Sender<Result<Value, String>>,
}
fn backend() -> Result<&'static LlamaBackend, String> {
    static B: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();
    B.get_or_init(|| {
        let mut b = LlamaBackend::init().map_err(|e| e.to_string())?;
        b.void_logs();
        Ok(b)
    })
    .as_ref()
    .map_err(|e| e.clone())
}
fn threads() -> i32 {
    let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    // llama.cpp is fastest on physical cores; logical counts are usually twice that
    (n / 2).clamp(2, 8) as i32
}
fn hash(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(s.as_bytes());
    d.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Run the model on this thread until the channel closes. `status` reports progress ("loading", "ready").
pub fn serve(model_path: &Path, state_dir: &Path, rx: Receiver<Job>, status: &dyn Fn(&str)) -> Result<(), String> {
    status("loading");
    let backend = backend()?;
    let mparams = LlamaModelParams::default();
    let model = LlamaModel::load_from_file(backend, model_path, &mparams).map_err(|e| format!("The assistant's model couldn't be loaded: {e}"))?;
    let n = threads();
    let cparams = LlamaContextParams::default().with_n_ctx(NonZeroU32::new(N_CTX)).with_n_batch(512).with_n_threads(n).with_n_threads_batch(n);
    let mut ctx = model.new_context(backend, cparams).map_err(|e| e.to_string())?;
    let grammar = llama_cpp_2::json_schema_to_grammar(&schema().to_string()).map_err(|e| format!("grammar: {e}"))?;
    let vocab = model.vocab();

    // the fixed part: from the disk cache when it's there, otherwise read once and saved
    let sys = system_prompt();
    let sys_tokens = vocab.tokenize(sys.as_bytes(), false, true);
    let cache = state_dir.join(format!("brain-{}-{}.state", hash(&format!("{}|{}", model_path.display(), sys)), sys_tokens.len()));
    let mut loaded = false;
    if cache.exists() {
        if let Ok((toks, _)) = ctx.state_seq_load_file(&cache, 0, sys_tokens.len()) {
            loaded = toks.len() == sys_tokens.len() && toks.iter().zip(&sys_tokens).all(|(a, b)| a == b);
        }
        if !loaded {
            ctx.clear_kv_cache();
        }
    }
    if !loaded {
        status("reading");
        decode_tokens(&mut ctx, &sys_tokens, 0, false)?;
        let _ = std::fs::create_dir_all(state_dir);
        // old caches (another model or prompt) go
        if let Ok(rd) = std::fs::read_dir(state_dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with("brain-") && name.ends_with(".state") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        let _ = ctx.state_seq_save_file(&cache, 0, &sys_tokens);
    }
    let snapshot = ctx.state_seq_get(0, LlamaStateSeqFlags::empty()).map_err(|e| e.to_string())?;
    status("ready");

    while let Ok(job) = rx.recv() {
        let t0 = Instant::now();
        let r = (|| -> Result<Value, String> {
            // back to just after the fixed part
            ctx.clear_kv_cache();
            ctx.state_seq_set(&snapshot, 0).map_err(|e| e.to_string())?;
            let toks = vocab.tokenize(request_prompt(&job.context).as_bytes(), false, true);
            if sys_tokens.len() + toks.len() + MAX_OUT > N_CTX as usize {
                return Err("That request is too long for the assistant".into());
            }
            let mut pos = sys_tokens.len() as i32;
            decode_tokens(&mut ctx, &toks, pos, true)?;
            pos += toks.len() as i32;
            let mut sampler = LlamaSampler::chain_simple([LlamaSampler::grammar(&model, &grammar, "root").map_err(|e| format!("grammar: {e}"))?, LlamaSampler::greedy()]);
            let mut out: Vec<u8> = Vec::new();
            let mut batch = LlamaBatch::new(1, 1);
            let last = -1; // the last logits in the context
            let mut n_out = 0;
            loop {
                let tok: LlamaToken = sampler.sample(&ctx, last);
                sampler.accept(tok);
                if vocab.is_eog(tok) || n_out >= MAX_OUT {
                    break;
                }
                out.extend(vocab.token_to_piece(tok, false, None));
                n_out += 1;
                batch.clear();
                batch.add(tok, pos, &[0], true).map_err(|e| e.to_string())?;
                ctx.decode(&mut batch).map_err(|e| e.to_string())?;
                pos += 1;
            }
            let text = String::from_utf8_lossy(&out).to_string();
            let plan: Value = serde_json::from_str(text.trim()).map_err(|e| format!("The assistant gave an answer that couldn't be read ({e})"))?;
            Ok(json!({ "plan": plan, "ms": t0.elapsed().as_millis() as u64, "tokensIn": toks.len(), "tokensOut": n_out }))
        })();
        let _ = job.reply.send(r);
    }
    Ok(())
}

/// feed tokens in batches; the logits of the last one when `want_last`
fn decode_tokens(ctx: &mut llama_cpp_2::context::LlamaContext, toks: &[LlamaToken], start: i32, want_last: bool) -> Result<(), String> {
    let mut batch = LlamaBatch::new(512, 1);
    for (ci, chunk) in toks.chunks(512).enumerate() {
        batch.clear();
        let last_chunk = (ci + 1) * 512 >= toks.len();
        for (i, t) in chunk.iter().enumerate() {
            let p = start + (ci * 512 + i) as i32;
            batch.add(*t, p, &[0], want_last && last_chunk && i == chunk.len() - 1).map_err(|e| e.to_string())?;
        }
        ctx.decode(&mut batch).map_err(|e| format!("The assistant couldn't read the request: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// inside Dogfile: one worker, started on demand, stopped when idle or when the model changes
struct Worker {
    tx: Sender<Job>,
    model: PathBuf,
}
fn worker() -> &'static Mutex<Option<Worker>> {
    static W: OnceLock<Mutex<Option<Worker>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(None))
}
fn state() -> &'static Mutex<(String, Option<String>, u64)> {
    // (status, error, last used)
    static S: OnceLock<Mutex<(String, Option<String>, u64)>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(("off".into(), None, 0)))
}
fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// start the worker for `model` (no-op when it's already running with it)
pub fn ensure(model: &Path, state_dir: &Path) -> Sender<Job> {
    let mut w = worker().lock().unwrap();
    if let Some(x) = w.as_ref() {
        if x.model == model {
            return x.tx.clone();
        }
    }
    let (tx, rx) = channel::<Job>();
    let m = model.to_path_buf();
    let sd = state_dir.to_path_buf();
    {
        let mut s = state().lock().unwrap();
        *s = ("loading".into(), None, now());
    }
    std::thread::Builder::new()
        .name("dogfile-brain".into())
        .stack_size(8 << 20)
        .spawn(move || {
            let r = serve(&m, &sd, rx, &|st| state().lock().unwrap().0 = st.to_string());
            let mut s = state().lock().unwrap();
            s.0 = "off".into();
            if let Err(e) = r {
                s.1 = Some(e);
            }
        })
        .ok();
    *w = Some(Worker { tx: tx.clone(), model: model.to_path_buf() });
    tx
}
pub fn stop() {
    *worker().lock().unwrap() = None; // the channel closes; the thread finishes and frees the model
}
pub fn status_json() -> Value {
    let s = state().lock().unwrap().clone();
    json!({ "state": s.0, "error": s.1, "lastUsed": s.2 })
}
pub fn touch() {
    state().lock().unwrap().2 = now();
}
/// unload after `secs` without requests (it's a few GB of memory)
pub fn idle_check(secs: u64) {
    let (st, _, last) = state().lock().unwrap().clone();
    if st == "ready" && now().saturating_sub(last) > secs {
        stop();
    }
}
