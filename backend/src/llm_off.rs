//! Builds without the assistant's language model (the "llm" feature off): the assistant keeps its built-in rules.
use crate::args::{Args, R};
use serde_json::json;

pub fn status(_a: &Args) -> R {
    Ok(json!({ "state": "off", "available": false, "builtWithout": true }))
}
pub fn warm(_a: &Args) -> R {
    Err("This version of Dogfile doesn't include the assistant's model".into())
}
pub async fn plan(_a: &Args) -> R {
    Err("This version of Dogfile doesn't include the assistant's model".into())
}
pub fn stop_call(_a: &Args) -> R {
    Ok(json!(true))
}
pub fn idle_check(_secs: u64) {}
pub async fn complete(_prompt: String, _max_tokens: usize) -> Result<String, String> {
    Err("no model".into())
}
pub fn model_ready() -> bool {
    false
}
pub fn free_prompt(system: &str, user: &str) -> String {
    format!("{system}\n\n{user}")
}
