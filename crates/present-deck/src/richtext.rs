//! Rich text: Quill-style deltas on `Y.Text`.
//!
//! Character runs carry inline attributes; each paragraph ends with `"\n"` whose attributes are the paragraph's.
//! In JSON a rich text is `{ "paragraphs": [ { align?, list?, indent?, heading?, lineHeight?, runs: [ { text, bold?, … } ] } ] }`.
//!
//! Decisions (shared with `packages/deck`):
//! - An empty `Y.Text` is `{ "paragraphs": [] }`. Every paragraph written ends with `"\n"`; text after the last
//!   `"\n"` (typed by a client that never closed it) reads as one more paragraph with no paragraph attributes.
//! - Only `align`, `list`, `indent`, `heading` and `lineHeight` are paragraph attributes (read from the `"\n"`);
//!   `bold`, `italic`, `underline`, `strike`, `color`, `highlight`, `size`, `font`, `link` and `code` are inline
//!   (read from characters). Anything else, and inline attributes on a `"\n"`, is ignored.
//! - Attributes whose value is `null`, `false` or `""` (and `indent: 0`) are the same as absent and never written.
//! - Adjacent runs with the same attributes are merged; empty runs are dropped.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Value, json};
use yrs::types::text::YChange;
use yrs::types::Attrs;
use yrs::{Any, Out, Text, TextRef, TransactionMut, ReadTxn};

use crate::anyconv::{any_to_json, canon, json_to_any};

pub(crate) const PARAGRAPH_KEYS: [&str; 5] = ["align", "list", "indent", "heading", "lineHeight"];

pub(crate) fn is_paragraph_key(key: &str) -> bool {
    PARAGRAPH_KEYS.contains(&key)
}

pub(crate) fn is_inline_key(key: &str) -> bool {
    INLINE_KEYS.contains(&key)
}

pub(crate) const INLINE_KEYS: [&str; 10] =
    ["bold", "italic", "underline", "strike", "color", "highlight", "size", "font", "link", "code"];

/// Attributes that are the same as absent: null, false, "" (and indent 0 for paragraphs).
fn keep_attr(v: &Value) -> bool {
    !matches!(v, Value::Null | Value::Bool(false)) && v.as_str() != Some("")
}

fn keep_paragraph_attr(key: &str, v: &Value) -> bool {
    keep_attr(v) && !(key == "indent" && v.as_f64() == Some(0.0))
}

/// A rich text made from plain text: one paragraph per line (`""` is one empty paragraph), no formatting.
pub fn rich_from_plain(text: &str) -> Value {
    let paragraphs: Vec<Value> = text
        .split('\n')
        .map(|line| if line.is_empty() { json!({ "runs": [] }) } else { json!({ "runs": [ { "text": line } ] }) })
        .collect();
    json!({ "paragraphs": paragraphs })
}

/// Plain text written over existing rich text keeps its look: every line gets the first paragraph's attributes
/// (heading, list, align, …) and the first run's (bold, size, colour, font, …), like `present set … text=…`.
pub(crate) fn restyle_plain(text: &str, current: &Value) -> Value {
    let first = current.get("paragraphs").and_then(|p| p.get(0));
    let mut para = first.and_then(Value::as_object).cloned().unwrap_or_default();
    para.remove("runs");
    let mut run = first.and_then(|p| p.get("runs")).and_then(|r| r.get(0)).and_then(Value::as_object).cloned().unwrap_or_default();
    run.remove("text");
    let paragraphs: Vec<Value> = text
        .split('\n')
        .map(|line| {
            let mut p = para.clone();
            let runs = if line.is_empty() {
                vec![]
            } else {
                let mut r = run.clone();
                r.insert("text".into(), Value::String(line.to_string()));
                vec![Value::Object(r)]
            };
            p.insert("runs".into(), Value::Array(runs));
            Value::Object(p)
        })
        .collect();
    normalize_rich(&json!({ "paragraphs": paragraphs }))
}

/// Canonical rich text from whatever a caller sent: a plain string, `{paragraphs}`, or anything else (empty).
/// Only known attributes are kept; a `"\n"` inside a run splits the paragraph there (like `packages/deck`).
pub(crate) fn normalize_rich(value: &Value) -> Value {
    match value {
        Value::String(s) => rich_from_plain(s),
        Value::Object(obj) if obj.get("paragraphs").is_some_and(Value::is_array) => {
            let mut out = Vec::new();
            for p in obj["paragraphs"].as_array().into_iter().flatten() {
                let mut para = Map::new();
                for key in PARAGRAPH_KEYS {
                    if let Some(v) = p.get(key)
                        && keep_paragraph_attr(key, v)
                    {
                        para.insert(key.to_string(), canon(v.clone()));
                    }
                }
                let mut runs: Vec<Map<String, Value>> = Vec::new();
                for r in p.get("runs").and_then(Value::as_array).into_iter().flatten() {
                    let text = match r.get("text") {
                        Some(Value::String(s)) => s.clone(),
                        Some(Value::Null) | None => String::new(),
                        Some(other) => other.to_string(),
                    };
                    let mut attrs = Map::new();
                    for key in INLINE_KEYS {
                        if let Some(v) = r.get(key)
                            && keep_attr(v)
                        {
                            attrs.insert(key.to_string(), canon(v.clone()));
                        }
                    }
                    for (i, piece) in text.split('\n').enumerate() {
                        if i > 0 {
                            let mut done = para.clone();
                            done.insert("runs".into(), Value::Array(std::mem::take(&mut runs).into_iter().map(Value::Object).collect()));
                            out.push(Value::Object(done));
                        }
                        if !piece.is_empty() {
                            push_run(&mut runs, piece.to_string(), attrs.clone());
                        }
                    }
                }
                para.insert("runs".into(), Value::Array(runs.into_iter().map(Value::Object).collect()));
                out.push(Value::Object(para));
            }
            json!({ "paragraphs": out })
        }
        _ => json!({ "paragraphs": [] }),
    }
}

fn push_run(runs: &mut Vec<Map<String, Value>>, text: String, attrs: Map<String, Value>) {
    if let Some(last) = runs.last_mut() {
        let mut last_attrs = last.clone();
        last_attrs.remove("text");
        if last_attrs == attrs {
            let joined = format!("{}{}", last.get("text").and_then(Value::as_str).unwrap_or(""), text);
            last.insert("text".into(), Value::String(joined));
            return;
        }
    }
    let mut run = Map::new();
    run.insert("text".into(), Value::String(text));
    for (k, v) in attrs {
        run.insert(k, v);
    }
    runs.push(run);
}

/// The plain string a rich text is stored as: every paragraph's text followed by `"\n"`.
pub fn plain_text(rich: &Value) -> String {
    let mut s = String::new();
    for p in rich.get("paragraphs").and_then(Value::as_array).into_iter().flatten() {
        for r in p.get("runs").and_then(Value::as_array).into_iter().flatten() {
            s.push_str(r.get("text").and_then(Value::as_str).unwrap_or(""));
        }
        s.push('\n');
    }
    s
}

/// One piece of a Y.Text with its attributes. A paragraph break is always its own segment (`"\n"`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Seg {
    pub text: String,
    pub attrs: Attrs,
}

pub(crate) fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

fn attrs_from_json(obj: &Map<String, Value>, paragraph: bool) -> Attrs {
    let mut attrs: Attrs = HashMap::new();
    for (k, v) in obj {
        if k == "text" || k == "runs" {
            continue;
        }
        let known = if paragraph { is_paragraph_key(k) && keep_paragraph_attr(k, v) } else { is_inline_key(k) && keep_attr(v) };
        if !known {
            continue;
        }
        attrs.insert(Arc::from(k.as_str()), json_to_any(v));
    }
    attrs
}

/// The segments a canonical rich text is written as.
pub(crate) fn segments(rich: &Value) -> Vec<Seg> {
    let rich = normalize_rich(rich);
    let mut out = Vec::new();
    for p in rich["paragraphs"].as_array().into_iter().flatten() {
        for r in p["runs"].as_array().into_iter().flatten() {
            let obj = r.as_object().cloned().unwrap_or_default();
            out.push(Seg {
                text: obj.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                attrs: attrs_from_json(&obj, false),
            });
        }
        let pobj = p.as_object().cloned().unwrap_or_default();
        out.push(Seg { text: "\n".into(), attrs: attrs_from_json(&pobj, true) });
    }
    out
}

/// The segments a Y.Text holds now, with every `"\n"` split into its own segment.
pub(crate) fn read_segments<T: ReadTxn>(txn: &T, text: &TextRef) -> Vec<Seg> {
    let mut out = Vec::new();
    for chunk in text.diff(txn, YChange::identity) {
        let s = match &chunk.insert {
            Out::Any(Any::String(s)) => s.to_string(),
            _ => continue, // embeds are not part of the deck model
        };
        let attrs: Attrs = chunk.attributes.map(|a| *a).unwrap_or_default();
        let mut rest = s.as_str();
        while !rest.is_empty() {
            match rest.find('\n') {
                Some(0) => {
                    out.push(Seg { text: "\n".into(), attrs: attrs.clone() });
                    rest = &rest[1..];
                }
                Some(i) => {
                    out.push(Seg { text: rest[..i].to_string(), attrs: attrs.clone() });
                    rest = &rest[i..];
                }
                None => {
                    out.push(Seg { text: rest.to_string(), attrs: attrs.clone() });
                    rest = "";
                }
            }
        }
    }
    out
}

/// Reads a Y.Text as rich text JSON.
pub(crate) fn read_rich<T: ReadTxn>(txn: &T, text: &TextRef) -> Value {
    let mut paragraphs = Vec::new();
    let mut runs: Vec<Map<String, Value>> = Vec::new();
    let mut open = false;
    for seg in read_segments(txn, text) {
        if seg.text == "\n" {
            let mut para = Map::new();
            for key in PARAGRAPH_KEYS {
                if let Some(v) = seg.attrs.get(key) {
                    let v = any_to_json(v);
                    if keep_attr(&v) {
                        para.insert(key.to_string(), v);
                    }
                }
            }
            para.insert("runs".into(), Value::Array(std::mem::take(&mut runs).into_iter().map(Value::Object).collect()));
            paragraphs.push(Value::Object(para));
            open = false;
        } else {
            let mut attrs = Map::new();
            for (k, v) in seg.attrs.iter() {
                if is_paragraph_key(k) {
                    continue;
                }
                let v = any_to_json(v);
                if keep_attr(&v) {
                    attrs.insert(k.to_string(), v);
                }
            }
            if !seg.text.is_empty() {
                push_run(&mut runs, seg.text, attrs);
                open = true;
            }
        }
    }
    if open {
        let mut para = Map::new();
        para.insert("runs".into(), Value::Array(runs.into_iter().map(Value::Object).collect()));
        paragraphs.push(Value::Object(para));
    }
    json!({ "paragraphs": paragraphs })
}

/// Writes rich text into an empty Y.Text.
pub(crate) fn write_rich(txn: &mut TransactionMut, text: &TextRef, rich: &Value) {
    let mut idx = 0u32;
    for seg in segments(rich) {
        text.insert_with_attributes(txn, idx, &seg.text, seg.attrs);
        idx += utf16_len(&seg.text);
    }
}

/// Replaces a Y.Text's plain content with `target` through a minimal character diff, so concurrent typing
/// elsewhere in the text survives and untouched characters keep their formatting.
pub(crate) fn set_plain(txn: &mut TransactionMut, text: &TextRef, target: &str) {
    let current = text.get_string(txn);
    if current == target {
        return;
    }
    let mut pos = 0u32;
    for chunk in dissimilar::diff(&current, target) {
        match chunk {
            dissimilar::Chunk::Equal(s) => pos += utf16_len(s),
            dissimilar::Chunk::Delete(s) => text.remove_range(txn, pos, utf16_len(s)),
            dissimilar::Chunk::Insert(s) => {
                text.insert(txn, pos, s);
                pos += utf16_len(s);
            }
        }
    }
}

use yrs::GetString;

/// Makes a Y.Text equal a rich text with minimal changes: a character diff first, then formatting fixed only
/// where it differs.
pub(crate) fn set_rich(txn: &mut TransactionMut, text: &TextRef, target: &Value) {
    let target_segs = segments(target);
    let target_plain: String = target_segs.iter().map(|s| s.text.as_str()).collect();
    set_plain(txn, text, &target_plain);
    let current_segs = read_segments(txn, text);
    // Walk both segment lists over UTF-16 units and format each range whose relevant attributes differ.
    let explode = |segs: &[Seg]| -> Vec<(u32, u32, bool, Attrs)> {
        let mut out = Vec::new();
        let mut at = 0u32;
        for s in segs {
            let len = utf16_len(&s.text);
            out.push((at, at + len, s.text == "\n", s.attrs.clone()));
            at += len;
        }
        out
    };
    let cur = explode(&current_segs);
    let tgt = explode(&target_segs);
    let mut patches: Vec<(u32, u32, Attrs)> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    let mut at = 0u32;
    while i < cur.len() && j < tgt.len() {
        let end = cur[i].1.min(tgt[j].1);
        if end > at {
            let newline = tgt[j].2;
            let relevant = |k: &str| if newline { is_paragraph_key(k) } else { is_inline_key(k) };
            let mut patch: Attrs = HashMap::new();
            for (k, v) in tgt[j].3.iter() {
                if relevant(k) && cur[i].3.get(k) != Some(v) {
                    patch.insert(k.clone(), v.clone());
                }
            }
            for (k, v) in cur[i].3.iter() {
                if relevant(k) && !tgt[j].3.contains_key(k) && !matches!(v, Any::Null) {
                    patch.insert(k.clone(), Any::Null);
                }
            }
            if !patch.is_empty() {
                match patches.last_mut() {
                    Some(last) if last.1 == at && last.2 == patch => last.1 = end,
                    _ => patches.push((at, end, patch)),
                }
            }
            at = end;
        }
        if cur[i].1 == end {
            i += 1;
        }
        if tgt[j].1 == end {
            j += 1;
        }
    }
    for (start, end, patch) in patches {
        text.format(txn, start, end - start, patch);
    }
}

/// Rich text as Markdown-ish lines for the text view: `**bold**`, `_italic_`, `~~strike~~`, `` `code` ``,
/// `[text](link)`, `- ` / `1. ` lists and `#` headings.
pub fn rich_to_markdownish(rich: &Value) -> String {
    let mut lines = Vec::new();
    let mut ordered = 0;
    for p in rich.get("paragraphs").and_then(Value::as_array).into_iter().flatten() {
        let mut line = String::new();
        for r in p.get("runs").and_then(Value::as_array).into_iter().flatten() {
            let mut t = r.get("text").and_then(Value::as_str).unwrap_or("").to_string();
            let flag = |k: &str| r.get(k).and_then(Value::as_bool).unwrap_or(false);
            if flag("code") {
                t = format!("`{t}`");
            }
            if flag("bold") {
                t = format!("**{t}**");
            }
            if flag("italic") {
                t = format!("_{t}_");
            }
            if flag("strike") {
                t = format!("~~{t}~~");
            }
            if let Some(link) = r.get("link").and_then(Value::as_str) {
                t = format!("[{t}]({link})");
            }
            line.push_str(&t);
        }
        let indent = p.get("indent").and_then(Value::as_u64).unwrap_or(0) as usize;
        let pad = "  ".repeat(indent);
        match p.get("list").and_then(Value::as_str) {
            Some("bullet") => {
                ordered = 0;
                line = format!("{pad}- {line}");
            }
            Some("ordered") => {
                ordered += 1;
                line = format!("{pad}{ordered}. {line}");
            }
            _ => {
                ordered = 0;
                if let Some(h) = p.get("heading").and_then(Value::as_u64) {
                    line = format!("{} {line}", "#".repeat(h.clamp(1, 3) as usize));
                }
            }
        }
        if let Some(align) = p.get("align").and_then(Value::as_str)
            && align != "left"
        {
            line = format!("{line}  ({align})");
        }
        lines.push(line);
    }
    lines.join("\n")
}
