//! Runs the assistant's model over build/brain-cases.json and checks each answer against what's expected.
//!   cargo run --release -p dogfile-backend --example brain_eval -- <model.gguf> <cases.json> <out.json>
//! A case passes when the answer's steps, in order, include steps matching `expect` (or one of `alt`): every field
//! given must match (text: contains, ignoring case; lists: all items present).
use serde_json::{json, Value};
use std::sync::mpsc::channel;

fn norm(s: &str) -> String {
    s.to_lowercase().replace(['\\', '/', ':'], "")
}
fn field_ok(want: &Value, got: Option<&Value>) -> bool {
    match (want, got) {
        (Value::String(w), Some(Value::String(g))) => norm(g).contains(&norm(w)) || norm(w).contains(&norm(g)) && !g.is_empty(),
        (Value::Array(ws), Some(Value::Array(gs))) => ws.iter().all(|w| gs.iter().any(|g| field_ok(w, Some(g)))),
        (Value::Array(ws), Some(Value::String(g))) => ws.iter().all(|w| field_ok(w, Some(&json!(g)))),
        (w, Some(g)) => w == g,
        _ => false,
    }
}
fn step_ok(want: &Value, got: &Value) -> bool {
    want.as_object().map(|o| o.iter().all(|(k, v)| field_ok(v, got.get(k)))).unwrap_or(false)
}
/// the expected steps appear in order (other steps may sit between them)
fn seq_ok(want: &[Value], got: &[Value]) -> bool {
    let mut i = 0;
    for g in got {
        if i < want.len() && step_ok(&want[i], g) {
            i += 1;
        }
    }
    i == want.len()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (model, cases, out) = (&args[1], &args[2], &args[3]);
    let mut cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(cases).unwrap()).unwrap();
    if let Some(n) = std::env::var("BRAIN_LIMIT").ok().and_then(|v| v.parse::<usize>().ok()) {
        cases.truncate(n);
    }
    let (tx, rx) = channel();
    let m = std::path::PathBuf::from(model);
    let state_dir = std::env::var("BRAIN_STATE_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_| std::env::temp_dir().join("dogfile-brain-eval"));
    let t0 = std::time::Instant::now();
    std::thread::spawn(move || {
        let st = |s: &str| eprintln!("[{:.1}s] {s}", t0.elapsed().as_secs_f32());
        // DOGFILE_LLAMA_SERVER=<llama-server> runs it through llama.cpp's server program, as Dogfile does when it's there
        let r = match dogfile_backend::llm_server::find() {
            Some(exe) => dogfile_backend::llm_server::serve(&exe, &m, &state_dir, &rx, &st),
            None => dogfile_backend::llm::serve(&m, &state_dir, rx, &st),
        };
        if let Err(e) = r {
            eprintln!("model error: {e}");
        }
    });
    let mut results = vec![];
    let mut pass = 0;
    let mut ms_total = 0u64;
    for (i, c) in cases.iter().enumerate() {
        let (rtx, rrx) = channel();
        tx.send(dogfile_backend::llm::Job { context: c["ctx"].as_str().unwrap().to_string(), reply: rtx }).unwrap();
        let r = rrx.recv().unwrap();
        let r_meta: Result<(u64, u64, String), ()> = r.as_ref().map(|v| (v["tokensIn"].as_u64().unwrap_or(0), v["tokensOut"].as_u64().unwrap_or(0), v["timing"].to_string())).map_err(|_| ());
        let (ok, plan, ms, err) = match r {
            Ok(v) => {
                let steps = v["plan"]["steps"].as_array().cloned().unwrap_or_default();
                let want = c["expect"].as_array().cloned().unwrap_or_default();
                let mut ok = seq_ok(&want, &steps);
                if !ok {
                    for alt in c["alt"].as_array().into_iter().flatten() {
                        if seq_ok(alt.as_array().map(|a| a.as_slice()).unwrap_or(&[]), &steps) {
                            ok = true;
                        }
                    }
                }
                if let Some(min) = c["min_steps"].as_u64() {
                    ok = ok && steps.len() as u64 >= min;
                }
                (ok, v["plan"].clone(), v["ms"].as_u64().unwrap_or(0), None)
            }
            Err(e) => (false, Value::Null, 0, Some(e)),
        };
        if ok {
            pass += 1;
        }
        ms_total += ms;
        let req = c["ctx"].as_str().unwrap().lines().last().unwrap_or("").to_string();
        eprintln!("{} {:>3} {:>6}ms  {}  =>  {}", if ok { "PASS" } else { "FAIL" }, i + 1, ms, req, plan);
        if let Ok(v) = &r_meta { eprintln!("          tokens in {} out {}  {}", v.0, v.1, v.2); }
        results.push(json!({ "ok": ok, "request": req, "ctx": c["ctx"], "plan": plan, "expect": c["expect"], "ms": ms, "error": err }));
    }
    let summary = json!({ "pass": pass, "total": cases.len(), "avgMs": if cases.is_empty() { 0 } else { ms_total / cases.len() as u64 }, "model": model, "results": results });
    std::fs::write(out, serde_json::to_string_pretty(&summary).unwrap()).unwrap();
    eprintln!("{pass}/{} passed, {} ms per request on average", cases.len(), summary["avgMs"]);
}
