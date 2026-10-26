//! Plain JSON values ⇄ Yjs `Any`.
//!
//! Integral numbers become `Number::Int` (what Yjs writes for a JS integer) and come back as JSON integers, so a
//! value round-trips identically through Rust and TypeScript.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Number as JsonNumber, Value};
use yrs::Any;
use yrs::any::Number;

/// JSON → `Any`.
pub fn json_to_any(value: &Value) -> Any {
    match value {
        Value::Null => Any::Null,
        Value::Bool(b) => Any::Bool(*b),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            if f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0 {
                Any::Number(Number::Int(f as i64))
            } else {
                Any::Number(Number::Float(f))
            }
        }
        Value::String(s) => Any::String(Arc::from(s.as_str())),
        Value::Array(items) => Any::Array(items.iter().map(json_to_any).collect::<Vec<_>>().into()),
        Value::Object(map) => {
            let m: HashMap<String, Any> = map
                .iter()
                .map(|(k, v)| (k.clone(), json_to_any(v)))
                .collect();
            Any::Map(Arc::new(m))
        }
    }
}

/// `Any` → JSON. `undefined` reads as `null`; buffers read as arrays of bytes.
pub fn any_to_json(any: &Any) -> Value {
    match any {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(b) => Value::Bool(*b),
        Any::Number(Number::Int(i)) => float_to_json(*i as f64),
        Any::Number(Number::Float(f)) => float_to_json(*f),
        Any::String(s) => Value::String(s.to_string()),
        Any::Buffer(b) => Value::Array(b.iter().map(|x| Value::Number((*x).into())).collect()),
        Any::Array(items) => Value::Array(items.iter().map(any_to_json).collect()),
        Any::Map(m) => {
            let mut out = Map::new();
            for (k, v) in m.iter() {
                out.insert(k.clone(), any_to_json(v));
            }
            Value::Object(out)
        }
    }
}

pub(crate) fn float_to_json(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0 {
        Value::Number((f as i64).into())
    } else {
        JsonNumber::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

/// Makes every integral float an integer, recursively, so `1920.0` and `1920` compare equal.
pub(crate) fn canon(value: Value) -> Value {
    match value {
        Value::Number(n) => float_to_json(n.as_f64().unwrap_or(0.0)),
        Value::Array(items) => Value::Array(items.into_iter().map(canon).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, canon(v))).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_plain_values() {
        let v = json!({"a": 1, "b": 1.5, "c": [true, null, "x"], "d": {"e": -3}, "f": 2.0});
        let back = any_to_json(&json_to_any(&v));
        assert_eq!(back, canon(v));
        assert_eq!(back["f"], json!(2));
    }
}

/// Values requiring a canonical rewrite even when their JSON projection compares equal (notably BigInts).
pub(crate) fn is_canonical(any: &Any) -> bool {
    match any {
        Any::Undefined | Any::Buffer(_) => false,
        Any::Number(Number::Int(n)) => n.unsigned_abs() <= 9_007_199_254_740_991,
        Any::Number(Number::Float(n)) => n.is_finite() && (*n != 0.0 || !n.is_sign_negative()),
        Any::Array(a) => a.iter().all(is_canonical),
        Any::Map(m) => m.values().all(is_canonical),
        _ => true,
    }
}
