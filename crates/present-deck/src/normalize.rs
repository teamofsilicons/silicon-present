//! Canonical deck JSON: every field present, defaults filled, numbers canonical.
//!
//! Readers default invalid values and drop unknown object keys. Writers validate first (`validate`), then use
//! these same normalizers; invalid input is never silently stored or discarded on a write.

use serde_json::{Map, Value, json};
use std::collections::HashSet;

use crate::anyconv::canon;
use crate::error::DeckError;
use crate::ids::{element_id, slide_id};
use crate::richtext::normalize_rich;

pub(crate) const KINDS: [&str; 8] = [
    "text", "shape", "image", "video", "audio", "table", "chart", "html",
];
pub(crate) const LAYOUTS: [&str; 7] = [
    "title",
    "title-body",
    "two-columns",
    "section",
    "title-only",
    "image-caption",
    "blank",
];

pub(crate) const SHAPES: [&str; 20] = [
    "rect",
    "round-rect",
    "ellipse",
    "triangle",
    "right-triangle",
    "diamond",
    "pentagon",
    "hexagon",
    "octagon",
    "star",
    "heart",
    "arrow-right",
    "arrow-left",
    "arrow-up",
    "arrow-down",
    "line",
    "chevron",
    "callout",
    "cloud",
    "plus",
];

pub(crate) fn number(v: &Value) -> Option<f64> {
    let n = match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let s = s.trim_matches([' ', '\t', '\n', '\r']);
            match serde_json::from_str::<Value>(s).ok()? {
                Value::Number(n) => n.as_f64(),
                _ => None,
            }
        }
        _ => None,
    }?;
    n.is_finite().then_some(if n == 0.0 { 0.0 } else { n })
}
pub(crate) fn string_value(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(_) => {
            let n = number(v)?;
            (n == 0.0 || (n.abs() >= 1e-6 && n.abs() < 1e21)).then(|| format!("{n}"))
        }
        _ => None,
    }
}
pub(crate) fn normalize_size(v: &Value) -> Value {
    let side = |k: &str, d: f64| {
        crate::anyconv::float_to_json(v.get(k).and_then(number).filter(|n| *n > 0.0).unwrap_or(d))
    };
    json!({"width":side("width",1920.0),"height":side("height",1080.0)})
}
fn enum_or(v: Option<&Value>, values: &[&str], default: &str) -> Value {
    Value::String(
        v.and_then(Value::as_str)
            .filter(|s| values.contains(s))
            .unwrap_or(default)
            .into(),
    )
}

/// The theme a new deck gets ("Paper", the same default as `packages/deck`).
pub fn default_theme() -> Value {
    json!({
        "name": "Paper",
        "fonts": { "heading": "Inter", "body": "Inter" },
        "colors": {
            "background": "#ffffff", "text": "#1b1b1f", "accent": "#2f5bea",
            "accent2": "#e5484d", "accent3": "#12a594", "muted": "#6f6f78"
        },
        "customFonts": []
    })
}

/// A theme with every key: missing fonts and colors come from the default theme; other keys are kept.
pub fn normalize_theme(value: &Value) -> Value {
    let d = default_theme();
    let mut m = value.as_object().cloned().unwrap_or_default();
    m.insert("name".into(), str_or(m.get("name"), "Paper"));
    for key in ["fonts", "colors"] {
        let mut merged = m
            .get(key)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (k, default) in d[key].as_object().unwrap() {
            merged.insert(k.clone(), str_or(merged.get(k), default.as_str().unwrap()));
        }
        m.insert(key.into(), Value::Object(merged));
    }
    if !matches!(m.get("customFonts"), Some(Value::Array(_))) {
        m.insert("customFonts".into(), json!([]));
    }
    canon(Value::Object(m))
}

/// A new deck: one title slide with an empty title (heading 1, anchored to the bottom) and an empty subtitle,
/// the same placeholders as `packages/deck`'s "title" layout.
pub fn default_deck() -> Value {
    json!({
        "size": { "width": 1920, "height": 1080 },
        "theme": default_theme(),
        "master": { "elements": [] },
        "slides": [ {
            "id": slide_id(), "layout": "title",
            "elements": [
                { "id": element_id(), "kind": "text", "x": 140, "y": 300, "w": 1640, "h": 280,
                  "style": { "verticalAlign": "bottom" }, "text": { "paragraphs": [ { "heading": 1, "runs": [] } ] } },
                { "id": element_id(), "kind": "text", "x": 140, "y": 610, "w": 1640, "h": 160,
                  "style": { "verticalAlign": "top" }, "text": { "paragraphs": [ { "runs": [] } ] } }
            ]
        } ]
    })
}

fn num_or(v: Option<&Value>, d: f64) -> Value {
    crate::anyconv::float_to_json(v.and_then(number).unwrap_or(d))
}
fn str_or(v: Option<&Value>, d: &str) -> Value {
    Value::String(v.and_then(string_value).unwrap_or_else(|| d.into()))
}
fn bool_or(v: Option<&Value>, d: bool) -> Value {
    Value::Bool(v.and_then(Value::as_bool).unwrap_or(d))
}
fn str_or_null(v: Option<&Value>) -> Value {
    v.and_then(string_value)
        .map(Value::String)
        .unwrap_or(Value::Null)
}
fn value_or_null(v: Option<&Value>) -> Value {
    v.filter(|v| v.is_object())
        .cloned()
        .map(canon)
        .unwrap_or(Value::Null)
}

/// Which element fields are Yjs types (not plain values) for an element kind.
pub(crate) fn y_fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "text" | "shape" => &["text"],
        "html" => &["html", "css", "js"],
        "table" => &["cells"],
        _ => &[],
    }
}

/// Canonical element JSON: every key of its kind, coerced to its type; unknown keys are dropped (like
/// `packages/deck`). Requires a valid `kind`; gives the element a new id when it has none.
pub fn normalize_element(value: &Value) -> Result<Value, DeckError> {
    let Value::Object(e) = value else {
        return Err(DeckError::invalid(
            "An element must be a JSON object.",
            "Send an element like {\"kind\": \"text\", \"x\": 100, \"y\": 100, \"w\": 800, \"h\": 200, \"text\": \"Hello\"}.",
        ));
    };
    let kind = e
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !KINDS.contains(&kind.as_str()) {
        return Err(DeckError::new(
            "unknown_element_kind",
            format!("The element kind \"{kind}\" is not one Silicon Present knows."),
            format!("Use one of: {}.", KINDS.join(", ")),
        ));
    }
    let mut m = Map::new();
    let id = match e.get("id") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => element_id(),
    };
    m.insert("id".into(), Value::String(id));
    m.insert("kind".into(), Value::String(kind.clone()));
    m.insert("x".into(), num_or(e.get("x"), 0.0));
    m.insert("y".into(), num_or(e.get("y"), 0.0));
    m.insert("w".into(), num_or(e.get("w"), 400.0));
    m.insert("h".into(), num_or(e.get("h"), 200.0));
    m.insert("rotation".into(), num_or(e.get("rotation"), 0.0));
    m.insert("locked".into(), bool_or(e.get("locked"), false));
    m.insert("group".into(), str_or_null(e.get("group")));
    m.insert("link".into(), str_or_null(e.get("link")));
    m.insert("animation".into(), value_or_null(e.get("animation")));
    m.insert(
        "style".into(),
        match e.get("style") {
            Some(Value::Object(st)) => canon(Value::Object(st.clone())),
            _ => json!({}),
        },
    );
    match kind.as_str() {
        "text" | "shape" => {
            if kind == "shape" {
                m.insert("shape".into(), enum_or(e.get("shape"), &SHAPES, "rect"));
            }
            m.insert(
                "text".into(),
                normalize_rich(e.get("text").unwrap_or(&Value::Null)),
            );
        }
        "image" => {
            m.insert("src".into(), str_or(e.get("src"), ""));
            m.insert("alt".into(), str_or(e.get("alt"), ""));
            m.insert(
                "fit".into(),
                enum_or(e.get("fit"), &["cover", "contain", "fill"], "contain"),
            );
        }
        "video" | "audio" => {
            m.insert("src".into(), str_or(e.get("src"), ""));
            m.insert("alt".into(), str_or(e.get("alt"), ""));
            m.insert("autoplay".into(), bool_or(e.get("autoplay"), false));
            m.insert("loop".into(), bool_or(e.get("loop"), false));
            m.insert("muted".into(), bool_or(e.get("muted"), false));
            if kind == "video" {
                m.insert("poster".into(), str_or_null(e.get("poster")));
            }
        }
        "table" => normalize_table(e, &mut m),
        "chart" => {
            let mut chart = e
                .get("chart")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            chart.insert(
                "type".into(),
                enum_or(
                    chart.get("type"),
                    &["bar", "column", "line", "area", "pie", "donut", "scatter"],
                    "column",
                ),
            );
            let labels: Vec<Value> = chart
                .get("labels")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|l| str_or(Some(l), ""))
                .collect();
            chart.insert("labels".into(), Value::Array(labels));
            let series: Vec<Value> = chart
                .get("series")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|s| {
                    let mut so = s.as_object().cloned().unwrap_or_default();
                    so.insert("name".into(), str_or(so.get("name"), ""));
                    let values: Vec<Value> = so
                        .get("values")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .map(|v| num_or(Some(v), 0.0))
                        .collect();
                    so.insert("values".into(), Value::Array(values));
                    Value::Object(so)
                })
                .collect();
            chart.insert("series".into(), Value::Array(series));
            chart.insert("legend".into(), bool_or(chart.get("legend"), true));
            m.insert("chart".into(), canon(Value::Object(chart)));
        }
        "html" => {
            for k in ["html", "css", "js"] {
                m.insert(k.into(), str_or(e.get(k), ""));
            }
        }
        _ => {}
    }
    Ok(canon(Value::Object(m)))
}

fn fit_array(v: Option<&Value>, n: usize, total: f64) -> Value {
    let arr = v
        .and_then(Value::as_array)
        .filter(|a| a.len() == n)
        .and_then(|a| a.iter().map(number).collect::<Option<Vec<_>>>());
    canon(json!(arr.unwrap_or_else(|| vec![total / n as f64; n])))
}

fn normalize_table(e: &Map<String, Value>, m: &mut Map<String, Value>) {
    let cells_in = e
        .get("cells")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let count = |v: Option<&Value>, d: usize| -> usize {
        v.and_then(number)
            .filter(|n| n.fract() == 0.0 && (1.0..=100.0).contains(n))
            .map(|n| n as usize)
            .unwrap_or(d.clamp(1, 100))
    };
    let rows = count(
        e.get("rows"),
        if cells_in.is_empty() {
            2
        } else {
            cells_in.len()
        },
    );
    let widest = cells_in
        .iter()
        .filter_map(Value::as_array)
        .map(Vec::len)
        .max()
        .unwrap_or(0);
    let cols = count(e.get("cols"), if widest == 0 { 2 } else { widest });
    let mut grid = Vec::with_capacity(rows);
    for r in 0..rows {
        let row_in = cells_in
            .get(r)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        grid.push(Value::Array(
            (0..cols)
                .map(|c| normalize_cell(row_in.get(c).unwrap_or(&Value::Null)))
                .collect(),
        ));
    }
    let w = m["w"].as_f64().unwrap_or(400.0);
    let h = m["h"].as_f64().unwrap_or(200.0);
    m.insert("rows".into(), json!(rows));
    m.insert("cols".into(), json!(cols));
    m.insert("colWidths".into(), fit_array(e.get("colWidths"), cols, w));
    m.insert("rowHeights".into(), fit_array(e.get("rowHeights"), rows, h));
    m.insert("headerRow".into(), bool_or(e.get("headerRow"), false));
    m.insert("cells".into(), Value::Array(grid));
}

/// A canonical table cell: `{ text: RichText, fill: null | string }`. A plain string is the cell's text.
pub(crate) fn normalize_cell(v: &Value) -> Value {
    match v {
        Value::String(_) | Value::Number(_) => json!({ "text": normalize_rich(v), "fill": null }),
        Value::Object(o) => {
            let fill = str_or_null(o.get("fill"));
            json!({ "text": normalize_rich(o.get("text").unwrap_or(&Value::Null)), "fill": fill })
        }
        _ => json!({ "text": { "paragraphs": [] }, "fill": null }),
    }
}

/// Canonical slide JSON (unknown keys dropped), giving the slide and its elements new ids where they have none.
pub fn normalize_slide(value: &Value) -> Result<Value, DeckError> {
    let Value::Object(s) = value else {
        return Err(DeckError::invalid(
            "A slide must be a JSON object.",
            "Send a slide like {\"layout\": \"title-body\", \"elements\": []}.",
        ));
    };
    let mut m = Map::new();
    let id = match s.get("id") {
        Some(Value::String(x)) if !x.is_empty() => x.clone(),
        _ => slide_id(),
    };
    m.insert("id".into(), Value::String(id));
    m.insert("layout".into(), enum_or(s.get("layout"), &LAYOUTS, "blank"));
    m.insert("background".into(), value_or_null(s.get("background")));
    m.insert("skipped".into(), bool_or(s.get("skipped"), false));
    m.insert("section".into(), str_or_null(s.get("section")));
    m.insert("hideMaster".into(), bool_or(s.get("hideMaster"), false));
    m.insert("transition".into(), value_or_null(s.get("transition")));
    m.insert("notes".into(), str_or(s.get("notes"), ""));
    let elements = normalize_elements(s.get("elements"));
    m.insert("elements".into(), Value::Array(elements));
    Ok(Value::Object(m))
}

fn normalize_elements(v: Option<&Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|e| normalize_element(e).ok())
        .filter(|e| seen.insert(e["id"].as_str().unwrap().to_string()))
        .collect()
}

/// Tolerant, canonical reader for arbitrary deck JSON.
pub fn normalize_deck(value: &Value) -> Result<Value, DeckError> {
    let input = value.as_object().cloned().unwrap_or_default();
    let mut m = Map::new();
    for key in ["id", "title", "version"] {
        if let Some(v) = input.get(key) {
            m.insert(key.into(), canon(v.clone()));
        }
    }
    m.insert(
        "size".into(),
        normalize_size(input.get("size").unwrap_or(&Value::Null)),
    );
    m.insert(
        "theme".into(),
        normalize_theme(input.get("theme").unwrap_or(&Value::Null)),
    );
    m.insert(
        "master".into(),
        json!({"elements":normalize_elements(input.get("master").and_then(|m|m.get("elements")))}),
    );
    let mut seen = HashSet::new();
    let slides: Vec<Value> = input
        .get("slides")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| normalize_slide(s).ok())
        .filter(|s| s["id"] != "master" && seen.insert(s["id"].as_str().unwrap().to_string()))
        .collect();
    m.insert("slides".into(), Value::Array(slides));
    Ok(Value::Object(m))
}
