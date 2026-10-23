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
use llama_cpp_2::token::data::LlamaTokenData;
use llama_cpp_2::token::data_array::LlamaTokenDataArray;
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
/// what llama.cpp was built with and found (AVX2 = 1 …)
pub fn system_info() -> String {
    unsafe { std::ffi::CStr::from_ptr(llama_cpp_sys_2::llama_print_system_info()) }.to_string_lossy().trim().to_string()
}
/// threads for generating (one token at a time: physical cores are best) and for reading (batches: all of them)
fn threads() -> (i32, i32) {
    let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    ((n / 2).clamp(2, 8) as i32, n.clamp(2, 16) as i32)
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
    status(&format!("cpu: {} | threads {:?}", system_info(), threads()));
    let mparams = LlamaModelParams::default();
    let model = LlamaModel::load_from_file(backend, model_path, &mparams).map_err(|e| format!("The assistant's model couldn't be loaded: {e}"))?;
    let (n_gen, n_read) = threads();
    let cparams = LlamaContextParams::default().with_n_ctx(NonZeroU32::new(N_CTX)).with_n_batch(512).with_n_threads(n_gen).with_n_threads_batch(n_read);
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
            let t_restore = t0.elapsed().as_millis() as u64;
            let toks = vocab.tokenize(request_prompt(&job.context).as_bytes(), false, true);
            if sys_tokens.len() + toks.len() + MAX_OUT > N_CTX as usize {
                return Err("That request is too long for the assistant".into());
            }
            let mut pos = sys_tokens.len() as i32;
            decode_tokens(&mut ctx, &toks, pos, true)?;
            pos += toks.len() as i32;
            let t_read = t0.elapsed().as_millis() as u64 - t_restore;
            let (mut t_sample, mut t_decode, mut fallbacks) = (0u128, 0u128, 0u32);
            // greedy decoding under the grammar. Checking the grammar against all ~250k tokens every step is slow, so
            // (like llama.cpp's own sampler) take the most likely token first and only fall back to filtering the whole
            // vocabulary when the grammar rejects it.
            let mut grammar_s = LlamaSampler::grammar(&model, &grammar, "root").map_err(|e| format!("grammar: {e}"))?;
            let mut out: Vec<u8> = Vec::new();
            let mut batch = LlamaBatch::new(1, 1);
            let mut n_out = 0;
            loop {
                let ts = Instant::now();
                let logits = ctx.get_logits_ith(-1);
                let best = logits.iter().enumerate().fold((0usize, f32::NEG_INFINITY), |m, (i, &l)| if l > m.1 { (i, l) } else { m });
                let cand = LlamaToken::new(best.0 as i32);
                let mut one = LlamaTokenDataArray::new(vec![LlamaTokenData::new(cand, best.1, 0.0)], false);
                grammar_s.apply(&mut one);
                let tok = if one.data[0].logit().is_finite() {
                    cand
                } else {
                    fallbacks += 1;
                    let mut all = ctx.token_data_array_ith(-1);
                    grammar_s.apply(&mut all);
                    all.data.iter().filter(|d| d.logit().is_finite()).max_by(|x, y| x.logit().total_cmp(&y.logit())).map(|d| d.id()).ok_or("The assistant got stuck")?
                };
                if vocab.is_eog(tok) || n_out >= MAX_OUT {
                    break;
                }
                grammar_s.accept(tok);
                out.extend(vocab.token_to_piece(tok, false, None));
                n_out += 1;
                t_sample += ts.elapsed().as_micros();
                let td = Instant::now();
                batch.clear();
                batch.add(tok, pos, &[0], true).map_err(|e| e.to_string())?;
                ctx.decode(&mut batch).map_err(|e| e.to_string())?;
                t_decode += td.elapsed().as_micros();
                pos += 1;
            }
            let text = String::from_utf8_lossy(&out).to_string();
            let plan: Value = serde_json::from_str(text.trim()).map_err(|e| format!("The assistant gave an answer that couldn't be read ({e})"))?;
            Ok(json!({ "plan": plan, "ms": t0.elapsed().as_millis() as u64, "tokensIn": toks.len(), "tokensOut": n_out,
                "timing": { "restoreMs": t_restore, "readMs": t_read, "sampleMs": t_sample / 1000, "decodeMs": t_decode / 1000, "fallbacks": fallbacks } }))
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

// ---------------------------------------------------------------------------------------------------------------
// the calls the interface makes
use crate::args::{Args, R};

/// which model to use: the setting, else the bigger one when it's there
fn chosen() -> Option<(String, PathBuf)> {
    let pref = crate::setting("assistantModel").as_str().unwrap_or("auto").to_string();
    let order: &[&str] = match pref.as_str() {
        "brain-small" => &["brain-small", "brain"],
        _ => &["brain", "brain-small"],
    };
    order.iter().find_map(|k| crate::ai::ready_file(k).map(|f| (k.to_string(), f)))
}
/// development builds only: DOGFILE_TEST_PLANS=<file.json> ({"request text": plan}) stands in for the model
fn test_plans() -> Option<Value> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let f = std::env::var("DOGFILE_TEST_PLANS").ok()?;
    serde_json::from_str(&std::fs::read_to_string(f).ok()?).ok()
}
/// the model is built for processors with AVX2 (nearly every PC since 2015); older ones keep the built-in assistant
pub fn cpu_ok() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma") && is_x86_feature_detected!("f16c") && is_x86_feature_detected!("bmi2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        true
    }
}
/// llm:status
pub fn status(_a: &Args) -> R {
    if test_plans().is_some() {
        return Ok(json!({ "state": "ready", "available": true, "model": "test", "memoryGb": 16 }));
    }
    let c = chosen();
    let mut v = status_json();
    v["available"] = json!(c.is_some() && cpu_ok());
    v["cpuOk"] = json!(cpu_ok());
    v["model"] = json!(c.map(|x| x.0));
    v["memoryGb"] = json!(crate::sys::total_memory_gb());
    Ok(v)
}
/// llm:warm: load the model now (when the assistant opens), so the first request doesn't wait for it
pub fn warm(_a: &Args) -> R {
    if test_plans().is_some() {
        return Ok(json!(true));
    }
    if !cpu_ok() {
        return Err("This PC's processor is too old for the assistant's model".into());
    }
    let (_, f) = chosen().ok_or("The assistant's model isn't downloaded")?;
    ensure(&f, &crate::ai::models_dir());
    touch();
    Ok(json!(true))
}
/// llm:plan {context}: the steps for one request
pub async fn plan(a: &Args) -> R {
    let context = a.s(0)?;
    if let Some(t) = test_plans() {
        let req = context.lines().last().unwrap_or("").trim_start_matches("Request: ").trim().to_string();
        return t.get(&req).map(|p| json!({ "plan": p, "ms": 1 })).ok_or_else(|| format!("no test plan for {req:?}"));
    }
    if !cpu_ok() {
        return Err("This PC's processor is too old for the assistant's model".into());
    }
    let (_, f) = chosen().ok_or("The assistant's model isn't downloaded")?;
    let tx = ensure(&f, &crate::ai::models_dir());
    touch();
    let (rtx, rrx) = channel();
    tx.send(Job { context, reply: rtx }).map_err(|_| "The assistant stopped; try again".to_string())?;
    let r = tokio::task::spawn_blocking(move || rrx.recv_timeout(std::time::Duration::from_secs(240)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| {
            // a stuck or crashed worker is replaced on the next request
            stop();
            state().lock().unwrap().1.clone().unwrap_or_else(|| "The assistant took too long to answer".into())
        })?;
    touch();
    r
}
/// llm:stop
pub fn stop_call(_a: &Args) -> R {
    stop();
    Ok(json!(true))
}
