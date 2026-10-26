//! Writer validation. Readers deliberately use the tolerant normalizers instead.
use crate::{
    DeckError,
    normalize::{KINDS, LAYOUTS, SHAPES, number, string_value},
};
use serde_json::{Map, Value};
use std::collections::HashSet;

pub(crate) fn invalid_value(path: &str) -> DeckError {
    DeckError::new(
        "invalid_value",
        format!("`{path}` has a value its field does not accept."),
        "Use the field's documented type, or null for its default.",
    )
}
pub(crate) fn invalid_field(path: &str) -> DeckError {
    DeckError::new(
        "invalid_field",
        format!("`{path}` is not a field that can be set here."),
        "Use only the fields documented for this object and element kind.",
    )
}
pub(crate) fn keys(m: &Map<String, Value>, allowed: &[&str]) -> Result<(), DeckError> {
    for k in m.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(invalid_field(k));
        }
    }
    Ok(())
}
fn optional(
    v: Option<&Value>,
    path: &str,
    check: impl FnOnce(&Value) -> bool,
) -> Result<(), DeckError> {
    if let Some(v) = v.filter(|v| !v.is_null()) {
        if !check(v) {
            return Err(invalid_value(path));
        }
    }
    Ok(())
}
fn object(v: Option<&Value>, path: &str) -> Result<Map<String, Value>, DeckError> {
    optional(v, path, Value::is_object)?;
    Ok(v.and_then(Value::as_object).cloned().unwrap_or_default())
}
fn list<'a>(v: Option<&'a Value>, path: &str) -> Result<&'a [Value], DeckError> {
    optional(v, path, Value::is_array)?;
    Ok(v.and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]))
}
fn string(v: Option<&Value>, path: &str) -> Result<(), DeckError> {
    optional(v, path, |v| string_value(v).is_some())
}
fn boolean(v: Option<&Value>, path: &str) -> Result<(), DeckError> {
    optional(v, path, Value::is_boolean)
}
fn numeric(v: Option<&Value>, path: &str) -> Result<(), DeckError> {
    optional(v, path, |v| number(v).is_some())
}
fn enumeration(v: Option<&Value>, path: &str, values: &[&str]) -> Result<(), DeckError> {
    optional(v, path, |v| v.as_str().is_some_and(|s| values.contains(&s)))
}
fn id(v: Option<&Value>) -> Result<(), DeckError> {
    optional(v, "id", Value::is_string)
}
fn duplicate(id: &str) -> DeckError {
    DeckError::new(
        "duplicate_id",
        format!("The id `{id}` occurs more than once."),
        "Give each object in this list a unique id.",
    )
}

pub(crate) fn size(v: &Value) -> Result<(), DeckError> {
    let m = object(Some(v), "size")?;
    keys(&m, &["width", "height"])?;
    for k in ["width", "height"] {
        optional(m.get(k), k, |v| number(v).is_some_and(|n| n > 0.0))?;
    }
    Ok(())
}
pub(crate) fn theme(v: &Value) -> Result<(), DeckError> {
    let m = object(Some(v), "theme")?;
    string(m.get("name"), "theme.name")?;
    for (key, known) in [
        ("fonts", &["heading", "body"][..]),
        (
            "colors",
            &[
                "background",
                "text",
                "accent",
                "accent2",
                "accent3",
                "muted",
            ][..],
        ),
    ] {
        let child = object(m.get(key), key)?;
        for k in known {
            string(child.get(*k), k)?;
        }
    }
    list(m.get("customFonts"), "customFonts")?;
    Ok(())
}
fn chart(v: &Value) -> Result<(), DeckError> {
    let m = object(Some(v), "chart")?;
    enumeration(
        m.get("type"),
        "chart.type",
        &["bar", "column", "line", "area", "pie", "donut", "scatter"],
    )?;
    boolean(m.get("legend"), "chart.legend")?;
    for v in list(m.get("labels"), "chart.labels")? {
        string(Some(v), "chart label")?;
    }
    for v in list(m.get("series"), "chart.series")? {
        let s = object(Some(v), "chart series")?;
        string(s.get("name"), "series.name")?;
        for v in list(s.get("values"), "series.values")? {
            numeric(Some(v), "series value")?;
        }
    }
    Ok(())
}
pub(crate) fn attr(key: &str, v: &Value) -> Option<Value> {
    if v.is_null() || v == &Value::Bool(false) || v.as_str() == Some("") {
        return None;
    }
    let n = number(v);
    match key {
        "bold" | "italic" | "underline" | "strike" | "code" => {
            (v == &Value::Bool(true)).then(|| v.clone())
        }
        "color" | "highlight" | "font" | "link" => {
            string_value(v).filter(|s| !s.is_empty()).map(Value::String)
        }
        "size" | "lineHeight" => n.filter(|n| *n > 0.0).map(crate::anyconv::float_to_json),
        "indent" => n
            .filter(|n| n.fract() == 0.0 && (1.0..=8.0).contains(n))
            .map(crate::anyconv::float_to_json),
        "heading" => n
            .filter(|n| n.fract() == 0.0 && (1.0..=3.0).contains(n))
            .map(crate::anyconv::float_to_json),
        "align" => v
            .as_str()
            .filter(|s| ["left", "center", "right", "justify"].contains(s))
            .map(|s| Value::String(s.into())),
        "list" => v
            .as_str()
            .filter(|s| ["bullet", "ordered"].contains(s))
            .map(|s| Value::String(s.into())),
        _ => None,
    }
}
fn attrs(m: &Map<String, Value>, allowed: &[&str], own: &str) -> Result<(), DeckError> {
    for (k, v) in m {
        if k == own {
            continue;
        }
        if !allowed.contains(&k.as_str()) {
            return Err(invalid_field(k));
        }
        let absent = v.is_null()
            || v == &Value::Bool(false)
            || v.as_str() == Some("")
            || (k == "indent" && number(v) == Some(0.0));
        if !absent && attr(k, v).is_none() {
            return Err(invalid_value(k));
        }
    }
    Ok(())
}
pub(crate) fn rich(v: &Value) -> Result<(), DeckError> {
    if v.is_null() {
        return Ok(());
    }
    if string_value(v).is_some() {
        return Ok(());
    }
    let m = object(Some(v), "rich text")?;
    keys(&m, &["paragraphs"])?;
    for p in list(m.get("paragraphs"), "paragraphs")? {
        let p = object(Some(p), "paragraph")?;
        attrs(&p, &crate::richtext::PARAGRAPH_KEYS, "runs")?;
        for r in list(p.get("runs"), "runs")? {
            let r = object(Some(r), "run")?;
            attrs(&r, &crate::richtext::INLINE_KEYS, "text")?;
            string(r.get("text"), "run.text")?;
        }
    }
    Ok(())
}
fn cell(v: &Value) -> Result<(), DeckError> {
    if v.is_null() || string_value(v).is_some() {
        return Ok(());
    }
    let m = object(Some(v), "cell")?;
    keys(&m, &["text", "fill"])?;
    rich(m.get("text").unwrap_or(&Value::Null))?;
    string(m.get("fill"), "fill")
}
pub(crate) fn element(v: &Value) -> Result<(), DeckError> {
    let m = v.as_object().ok_or_else(|| invalid_value("element"))?;
    let kind = m.get("kind").and_then(Value::as_str).unwrap_or("");
    if !KINDS.contains(&kind) {
        return Err(DeckError::new(
            "unknown_element_kind",
            format!("Unknown element kind `{kind}`."),
            "Use text, shape, image, video, audio, table, chart or html.",
        ));
    }
    let mut allowed = vec![
        "id",
        "kind",
        "x",
        "y",
        "w",
        "h",
        "rotation",
        "locked",
        "group",
        "link",
        "animation",
        "style",
    ];
    allowed.extend(match kind {
        "text" => vec!["text"],
        "shape" => vec!["shape", "text"],
        "image" => vec!["src", "alt", "fit"],
        "audio" => vec!["src", "alt", "autoplay", "loop", "muted"],
        "video" => vec!["src", "alt", "autoplay", "loop", "muted", "poster"],
        "table" => vec![
            "rows",
            "cols",
            "cells",
            "colWidths",
            "rowHeights",
            "headerRow",
        ],
        "chart" => vec!["chart"],
        "html" => vec!["html", "css", "js"],
        _ => vec![],
    });
    keys(m, &allowed)?;
    id(m.get("id"))?;
    for k in ["x", "y", "w", "h", "rotation"] {
        numeric(m.get(k), k)?;
    }
    for k in ["locked", "headerRow", "autoplay", "loop", "muted"] {
        boolean(m.get(k), k)?;
    }
    for k in ["group", "link", "src", "alt", "poster", "html", "css", "js"] {
        string(m.get(k), k)?;
    }
    for k in ["animation", "style"] {
        object(m.get(k), k)?;
    }
    enumeration(m.get("shape"), "shape", &SHAPES)?;
    enumeration(m.get("fit"), "fit", &["cover", "contain", "fill"])?;
    if let Some(v) = m.get("text") {
        rich(v)?;
    }
    if let Some(v) = m.get("chart") {
        chart(v)?;
    }
    if kind == "table" {
        let grid = list(m.get("cells"), "cells")?;
        let mut widest = 0;
        for row in grid {
            let row = list(Some(row), "cell row")?;
            widest = widest.max(row.len());
            for c in row {
                cell(c)?;
            }
        }
        let mut dims = Vec::new();
        for (k, inferred) in [("rows", grid.len()), ("cols", widest)] {
            optional(m.get(k), k, |v| {
                number(v).is_some_and(|n| n.fract() == 0.0 && (1.0..=100.0).contains(&n))
            })?;
            let n = m
                .get(k)
                .and_then(number)
                .map(|n| n as usize)
                .unwrap_or(if inferred == 0 { 2 } else { inferred });
            if n > 100 || inferred > n {
                return Err(invalid_value("cells"));
            }
            dims.push(n);
        }
        for (k, n) in [("rowHeights", dims[0]), ("colWidths", dims[1])] {
            if let Some(v) = m.get(k).filter(|v| !v.is_null()) {
                let arr = list(Some(v), k)?;
                if arr.len() != n {
                    return Err(invalid_value(k));
                }
                for v in arr {
                    if number(v).is_none() {
                        return Err(invalid_value(k));
                    }
                }
            }
        }
    }
    Ok(())
}
fn elements(v: Option<&Value>) -> Result<(), DeckError> {
    let mut seen = HashSet::new();
    for e in list(v, "elements")? {
        element(e)?;
        if let Some(id) = e
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            if !seen.insert(id) {
                return Err(duplicate(id));
            }
        }
    }
    Ok(())
}
pub(crate) fn slide(v: &Value) -> Result<(), DeckError> {
    let m = v.as_object().ok_or_else(|| invalid_value("slide"))?;
    keys(
        m,
        &[
            "id",
            "layout",
            "background",
            "skipped",
            "section",
            "hideMaster",
            "transition",
            "notes",
            "elements",
        ],
    )?;
    id(m.get("id"))?;
    if m.get("id").and_then(Value::as_str) == Some("master") {
        return Err(DeckError::new(
            "reserved_id",
            "The slide id `master` is reserved.",
            "Choose another slide id.",
        ));
    }
    enumeration(m.get("layout"), "layout", &LAYOUTS)?;
    object(m.get("background"), "background")?;
    object(m.get("transition"), "transition")?;
    boolean(m.get("skipped"), "skipped")?;
    boolean(m.get("hideMaster"), "hideMaster")?;
    string(m.get("section"), "section")?;
    string(m.get("notes"), "notes")?;
    elements(m.get("elements"))
}
pub(crate) fn deck(v: &Value) -> Result<(), DeckError> {
    let m = v.as_object().ok_or_else(|| invalid_value("deck"))?;
    keys(
        m,
        &[
            "id", "title", "version", "size", "theme", "master", "slides",
        ],
    )?;
    size(m.get("size").unwrap_or(&Value::Null))?;
    theme(m.get("theme").unwrap_or(&Value::Null))?;
    let master = object(m.get("master"), "master")?;
    keys(&master, &["elements"])?;
    elements(master.get("elements"))?;
    let mut seen = HashSet::new();
    for s in list(m.get("slides"), "slides")? {
        slide(s)?;
        if let Some(id) = s
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            if !seen.insert(id) {
                return Err(duplicate(id));
            }
        }
    }
    Ok(())
}
