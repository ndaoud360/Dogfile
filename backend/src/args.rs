// The arguments of one call from the window, with friendly accessors.
use serde_json::Value;

pub type R = Result<Value, String>;

pub struct Args(pub Vec<Value>);

impl Args {
    pub fn v(&self, i: usize) -> Value {
        self.0.get(i).cloned().unwrap_or(Value::Null)
    }
    pub fn r(&self, i: usize) -> &Value {
        static NULL: Value = Value::Null;
        self.0.get(i).unwrap_or(&NULL)
    }
    /// required string
    pub fn s(&self, i: usize) -> Result<String, String> {
        match self.0.get(i) {
            Some(Value::String(s)) => Ok(s.clone()),
            Some(Value::Number(n)) => Ok(n.to_string()),
            _ => Err(format!("argument {} must be text", i + 1)),
        }
    }
    pub fn os(&self, i: usize) -> Option<String> {
        match self.0.get(i) {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Number(n)) => Some(n.to_string()),
            _ => None,
        }
    }
    pub fn s_or(&self, i: usize, d: &str) -> String {
        self.os(i).unwrap_or_else(|| d.to_string())
    }
    pub fn f(&self, i: usize, d: f64) -> f64 {
        self.0.get(i).and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(d)
    }
    pub fn u(&self, i: usize, d: u64) -> u64 {
        self.0.get(i).and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f.max(0.0) as u64))).unwrap_or(d)
    }
    pub fn b(&self, i: usize) -> bool {
        match self.0.get(i) {
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
            Some(Value::String(s)) => !s.is_empty(),
            _ => false,
        }
    }
    pub fn strs(&self, i: usize) -> Vec<String> {
        strs(self.r(i))
    }
}

pub fn strs(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        Value::String(s) => vec![s.clone()],
        _ => vec![],
    }
}

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}
