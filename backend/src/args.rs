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
        // like f(): a number, or a number written as text ("42"); negative counts as 0
        self.0.get(i).and_then(|v| v.as_u64().or_else(|| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())).map(|f: f64| f.max(0.0) as u64))).unwrap_or(d)
    }
    /// b(), with `d` when the argument wasn't given at all (null counts as given: no)
    pub fn b_or(&self, i: usize, d: bool) -> bool {
        if self.0.get(i).is_none() { d } else { self.b(i) }
    }
    pub fn b(&self, i: usize) -> bool {
        match self.0.get(i) {
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
            // text from a form or a setting: "false" and "0" mean no (JavaScript would call any non-empty text true)
            Some(Value::String(s)) => !matches!(s.trim().to_ascii_lowercase().as_str(), "" | "false" | "0" | "no" | "off"),
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

#[cfg(test)]
mod tests {
    use super::Args;
    use serde_json::json;
    #[test]
    fn yes_and_no_read_the_way_people_write_them() {
        let a = Args(vec![json!(true), json!(false), json!(1), json!(0), json!("true"), json!("false"), json!("0"), json!(""), json!("yes"), json!(null)]);
        let got: Vec<bool> = (0..11).map(|i| a.b(i)).collect();
        assert_eq!(got, [true, false, true, false, true, false, false, false, true, false, false]);
        assert!(Args(vec![]).b_or(0, true) && !Args(vec![json!(false)]).b_or(0, true));
    }
    #[test]
    fn numbers_read_the_same_whether_sent_as_numbers_or_text() {
        let a = Args(vec![json!(42), json!("42"), json!(" 7 "), json!(-3), json!("x"), json!(2.9)]);
        assert_eq!((a.u(0, 0), a.u(1, 0), a.u(2, 0), a.u(3, 9), a.u(4, 9), a.u(5, 0)), (42, 42, 7, 0, 9, 2));
        assert_eq!((a.f(0, 0.0), a.f(1, 0.0), a.f(4, 1.5)), (42.0, 42.0, 1.5));
    }
}
