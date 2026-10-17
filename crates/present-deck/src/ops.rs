//! Edit ops (`POST /v1/decks/{id}/edits`): every op in `docs/architecture.md`, applied in one Yjs transaction.

use serde_json::{Map, Value, json};
use yrs::{Any, Array, ArrayRef, Doc, Map as YMap, MapPrelim, MapRef, Out, ReadTxn, Text, TextPrelim, TextRef, Transact, TransactionMut};

use crate::anyconv::any_to_json;
use crate::convert::{
    element_ids, put_plain, roots, slide_ids, write_cell, write_element, write_slide, Roots, MASTER_KEY,
};
use crate::error::DeckError;
use crate::normalize::{normalize_cell, normalize_element, normalize_slide, y_fields, LAYOUTS};
use crate::richtext::{normalize_rich, set_plain, set_rich, utf16_len};

/// Where a slide goes: after a slide, first (`null`), or last (field left out).
#[derive(Debug, Clone, PartialEq)]
pub enum Place {
    End,
    First,
    After(String),
}

/// Where an element goes in the z order.
#[derive(Debug, Clone, PartialEq)]
pub enum ZTarget {
    Front,
    Back,
    Forward,
    Backward,
    Index(usize),
}

/// One edit op.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    UpdateDeck { set: Map<String, Value> },
    AddSlide { after: Place, slide: Value },
    UpdateSlide { slide: String, set: Map<String, Value> },
    MoveSlide { slide: String, after: Place },
    DeleteSlide { slide: String },
    AddElement { slide: String, element: Value, z: Option<usize> },
    UpdateElement { slide: String, element: String, set: Map<String, Value> },
    ReplaceText { slide: String, element: Option<String>, field: Option<String>, find: String, replace: String, all: bool },
    ReorderElement { slide: String, element: String, to: ZTarget },
    DeleteElement { slide: String, element: String },
}

/// What applying ops produced.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OpsOutcome {
    /// Ids of slides added, in op order.
    pub slides_added: Vec<String>,
    /// `(slide, element)` ids of elements added, in op order.
    pub elements_added: Vec<(String, String)>,
    /// How many passages `replace_text` ops replaced in total.
    pub replacements: usize,
}

const OP_NAMES: &str =
    "update_deck, add_slide, update_slide, move_slide, delete_slide, add_element, update_element, replace_text, reorder_element, delete_element";

fn str_field(op: &Map<String, Value>, key: &str, name: &str) -> Result<String, DeckError> {
    match op.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Ok(s.clone()),
        _ => Err(DeckError::invalid(
            format!("`{name}` needs `{key}` (a string)."),
            format!("Add \"{key}\" to the op; see `docs/architecture.md` (Edit ops)."),
        )),
    }
}

fn set_field(op: &Map<String, Value>, name: &str) -> Result<Map<String, Value>, DeckError> {
    match op.get("set") {
        Some(Value::Object(m)) => Ok(m.clone()),
        _ => Err(DeckError::invalid(
            format!("`{name}` needs `set` (an object of the fields to change)."),
            "Add \"set\": { … } with the fields to change.",
        )),
    }
}

fn place(op: &Map<String, Value>) -> Result<Place, DeckError> {
    match op.get("after") {
        None => Ok(Place::End),
        Some(Value::Null) => Ok(Place::First),
        Some(Value::String(s)) => Ok(Place::After(s.clone())),
        Some(_) => Err(DeckError::invalid("`after` must be a slide id or null.", "Use \"after\": \"s_abc123\", or null to put it first.")),
    }
}

/// Parses `ops` (a JSON array) into ops.
pub fn parse_ops(value: &Value) -> Result<Vec<Op>, DeckError> {
    let Some(items) = value.as_array() else {
        return Err(DeckError::invalid("`ops` must be a JSON array of ops.", "Send \"ops\": [ { \"op\": \"add_slide\", … } ]."));
    };
    items.iter().enumerate().map(|(i, v)| parse_op(v).map_err(|e| e.at(i))).collect()
}

fn parse_op(v: &Value) -> Result<Op, DeckError> {
    let Some(op) = v.as_object() else {
        return Err(DeckError::invalid("Each op must be a JSON object.", "Send ops like { \"op\": \"delete_slide\", \"slide\": \"s_abc123\" }."));
    };
    let name = op.get("op").and_then(Value::as_str).unwrap_or("");
    Ok(match name {
        "update_deck" => Op::UpdateDeck { set: set_field(op, name)? },
        "add_slide" => Op::AddSlide { after: place(op)?, slide: op.get("slide").cloned().unwrap_or_else(|| json!({})) },
        "update_slide" => Op::UpdateSlide { slide: str_field(op, "slide", name)?, set: set_field(op, name)? },
        "move_slide" => Op::MoveSlide { slide: str_field(op, "slide", name)?, after: place(op)? },
        "delete_slide" => Op::DeleteSlide { slide: str_field(op, "slide", name)? },
        "add_element" => {
            let z = match op.get("z") {
                None | Some(Value::Null) => None,
                Some(Value::Number(n)) => Some(n.as_u64().unwrap_or(0) as usize),
                Some(_) => return Err(DeckError::invalid("`z` must be a number (0 = back).", "Leave `z` out to put the element in front.")),
            };
            let element = op.get("element").cloned().ok_or_else(|| {
                DeckError::invalid("`add_element` needs `element`.", "Add \"element\": { \"kind\": \"text\", … }.")
            })?;
            Op::AddElement { slide: str_field(op, "slide", name)?, element, z }
        }
        "update_element" => Op::UpdateElement {
            slide: str_field(op, "slide", name)?,
            element: str_field(op, "element", name)?,
            set: set_field(op, name)?,
        },
        "replace_text" => {
            let find = op.get("find").and_then(Value::as_str).unwrap_or("").to_string();
            if find.is_empty() {
                return Err(DeckError::invalid("`replace_text` needs `find` (the exact passage to replace).", "Add \"find\": \"the exact text\"."));
            }
            let replace = match op.get("replace") {
                Some(Value::String(s)) => s.clone(),
                _ => return Err(DeckError::invalid("`replace_text` needs `replace` (a string, may be empty).", "Add \"replace\": \"new text\".")),
            };
            Op::ReplaceText {
                slide: str_field(op, "slide", name)?,
                element: op.get("element").and_then(Value::as_str).map(String::from),
                field: op.get("field").and_then(Value::as_str).map(String::from),
                find,
                replace,
                all: op.get("all").and_then(Value::as_bool).unwrap_or(false),
            }
        }
        "reorder_element" => {
            let to = match op.get("to") {
                Some(Value::String(s)) => match s.as_str() {
                    "front" => ZTarget::Front,
                    "back" => ZTarget::Back,
                    "forward" => ZTarget::Forward,
                    "backward" => ZTarget::Backward,
                    other => {
                        return Err(DeckError::invalid(
                            format!("`{other}` is not a z position."),
                            "Use \"front\", \"back\", \"forward\", \"backward\" or a number (0 = back).",
                        ));
                    }
                },
                Some(Value::Number(n)) => ZTarget::Index(n.as_u64().unwrap_or(0) as usize),
                _ => return Err(DeckError::invalid("`reorder_element` needs `to`.", "Use \"front\", \"back\", \"forward\", \"backward\" or a number (0 = back).")),
            };
            Op::ReorderElement { slide: str_field(op, "slide", name)?, element: str_field(op, "element", name)?, to }
        }
        "delete_element" => Op::DeleteElement { slide: str_field(op, "slide", name)?, element: str_field(op, "element", name)? },
        other => {
            return Err(DeckError::invalid(format!("`{other}` is not an op."), format!("Use one of: {OP_NAMES}.")));
        }
    })
}

/// Applies ops to a copy of `doc` and returns the Yjs update they make (relative to `doc`) without changing
/// `doc`. If any op fails nothing is produced, so all ops apply or none do.
pub fn apply_ops_update(doc: &Doc, ops: &[Op]) -> Result<(Vec<u8>, OpsOutcome), DeckError> {
    let scratch = crate::clone_doc(doc);
    let sv = scratch.transact().state_vector();
    let outcome = apply_in_place(&scratch, ops)?;
    let update = scratch.transact().encode_state_as_update_v1(&sv);
    Ok((update, outcome))
}

/// Applies ops to `doc` as one change. On error `doc` is unchanged.
pub fn apply_ops(doc: &Doc, ops: &[Op]) -> Result<OpsOutcome, DeckError> {
    let (update, outcome) = apply_ops_update(doc, ops)?;
    crate::reconcile::apply_update_bytes(doc, &update)?;
    Ok(outcome)
}

fn apply_in_place(doc: &Doc, ops: &[Op]) -> Result<OpsOutcome, DeckError> {
    let r = roots(doc);
    let mut txn = doc.transact_mut();
    let mut outcome = OpsOutcome::default();
    for (i, op) in ops.iter().enumerate() {
        apply_op(&mut txn, &r, op, &mut outcome).map_err(|e| e.at(i))?;
    }
    Ok(outcome)
}

/// A slide map that is part of the deck (in `order`), or the master when `allow_master`.
pub(crate) fn slide_map<T: ReadTxn>(txn: &T, r: &Roots, id: &str, allow_master: bool) -> Result<MapRef, DeckError> {
    if id == MASTER_KEY {
        if !allow_master {
            return Err(DeckError::invalid(
                "The master slide can't be changed with this op.",
                "Add, change or delete the master's elements with add_element/update_element/delete_element and \"slide\": \"master\".",
            ));
        }
    } else if !slide_ids(txn, r).iter().any(|s| s == id) {
        return Err(DeckError::slide_not_found(id));
    }
    match r.slides.get(txn, id) {
        Some(Out::YMap(m)) => Ok(m),
        _ => Err(DeckError::slide_not_found(id)),
    }
}

pub(crate) fn child_map(txn: &mut TransactionMut, parent: &MapRef, key: &str) -> MapRef {
    match parent.get(txn, key) {
        Some(Out::YMap(m)) => m,
        _ => parent.insert(txn, key, MapPrelim::default()),
    }
}

pub(crate) fn child_array(txn: &mut TransactionMut, parent: &MapRef, key: &str) -> ArrayRef {
    match parent.get(txn, key) {
        Some(Out::YArray(a)) => a,
        _ => parent.insert(txn, key, yrs::ArrayPrelim::default()),
    }
}

pub(crate) fn child_text(txn: &mut TransactionMut, parent: &MapRef, key: &str) -> TextRef {
    match parent.get(txn, key) {
        Some(Out::YText(t)) => t,
        Some(Out::Any(Any::String(s))) => parent.insert(txn, key, TextPrelim::new(s.to_string())),
        _ => parent.insert(txn, key, TextPrelim::new("")),
    }
}

pub(crate) fn element_map<T: ReadTxn>(txn: &T, slide: &MapRef, slide_id: &str, id: &str) -> Result<MapRef, DeckError> {
    match slide.get(txn, "elements") {
        Some(Out::YMap(em)) => match em.get(txn, id) {
            Some(Out::YMap(m)) => Ok(m),
            _ => Err(DeckError::element_not_found(slide_id, id)),
        },
        _ => Err(DeckError::element_not_found(slide_id, id)),
    }
}

fn raw_positions<T: ReadTxn>(txn: &T, arr: &ArrayRef, id: &str) -> Vec<u32> {
    arr.iter(txn)
        .enumerate()
        .filter_map(|(i, v)| match v {
            Out::Any(Any::String(s)) if &*s == id => Some(i as u32),
            _ => None,
        })
        .collect()
}

pub(crate) fn remove_all(txn: &mut TransactionMut, arr: &ArrayRef, id: &str) {
    for i in raw_positions(txn, arr, id).into_iter().rev() {
        arr.remove(txn, i);
    }
}

/// Inserts `id` into an id array right after `after` (first occurrence), first when `None`.
pub(crate) fn insert_after(txn: &mut TransactionMut, arr: &ArrayRef, after: Option<&str>, id: &str) {
    let idx = match after {
        None => 0,
        Some(a) => raw_positions(txn, arr, a).first().map(|p| p + 1).unwrap_or_else(|| arr.len(txn)),
    };
    arr.insert(txn, idx, id);
}

/// Inserts `id` into an id array right before `before` (first occurrence), last when `None`.
pub(crate) fn insert_before(txn: &mut TransactionMut, arr: &ArrayRef, before: Option<&str>, id: &str) {
    let idx = match before {
        None => arr.len(txn),
        Some(b) => raw_positions(txn, arr, b).first().copied().unwrap_or_else(|| arr.len(txn)),
    };
    arr.insert(txn, idx, id);
}

pub(crate) fn plain_differs<T: ReadTxn>(txn: &T, map: &MapRef, key: &str, value: &Value) -> bool {
    match map.get(txn, key) {
        Some(Out::Any(a)) => any_to_json(&a) != crate::anyconv::canon(value.clone()),
        _ => true,
    }
}

fn apply_op(txn: &mut TransactionMut, r: &Roots, op: &Op, out: &mut OpsOutcome) -> Result<(), DeckError> {
    match op {
        Op::UpdateDeck { set } => {
            for (k, v) in set {
                match k.as_str() {
                    "size" | "theme" if v.is_object() => put_plain(txn, &r.deck, k, v),
                    "size" | "theme" => {
                        return Err(DeckError::invalid(format!("`{k}` must be an object."), "See `docs/architecture.md` for its shape."));
                    }
                    other => {
                        return Err(DeckError::invalid(
                            format!("`update_deck` can't set `{other}`."),
                            "It sets `size` and `theme`; change the title with PATCH /v1/decks/{id}.",
                        ));
                    }
                }
            }
        }
        Op::AddSlide { after, slide } => {
            let slide = normalize_slide(slide)?;
            let id = slide["id"].as_str().unwrap_or_default().to_string();
            if id == MASTER_KEY || r.slides.contains_key(txn, &id) {
                return Err(DeckError::new(
                    "slide_exists",
                    format!("A slide with id `{id}` already exists."),
                    "Leave `id` out to get a new one, or pick an unused id (s_ + 6 base36 characters).",
                ));
            }
            match after {
                Place::After(a) => {
                    slide_map(txn, r, a, false)?;
                    write_slide(txn, &r.slides, &id, &slide, false);
                    insert_after(txn, &r.order, Some(a), &id);
                }
                Place::First => {
                    write_slide(txn, &r.slides, &id, &slide, false);
                    insert_after(txn, &r.order, None, &id);
                }
                Place::End => {
                    write_slide(txn, &r.slides, &id, &slide, false);
                    insert_before(txn, &r.order, None, &id);
                }
            }
            out.slides_added.push(id);
        }
        Op::UpdateSlide { slide, set } => {
            let m = slide_map(txn, r, slide, false)?;
            update_slide_fields(txn, &m, set)?;
        }
        Op::MoveSlide { slide, after } => {
            slide_map(txn, r, slide, false)?;
            if let Place::After(a) = after {
                if a == slide {
                    return Err(DeckError::invalid("A slide can't be moved after itself.", "Pass the id of another slide, or null to move it first."));
                }
                slide_map(txn, r, a, false)?;
            }
            remove_all(txn, &r.order, slide);
            match after {
                Place::After(a) => insert_after(txn, &r.order, Some(a), slide),
                Place::First => insert_after(txn, &r.order, None, slide),
                Place::End => insert_before(txn, &r.order, None, slide),
            }
        }
        Op::DeleteSlide { slide } => {
            slide_map(txn, r, slide, false)?;
            remove_all(txn, &r.order, slide);
            r.slides.remove(txn, slide);
        }
        Op::AddElement { slide, element, z } => {
            let m = slide_map(txn, r, slide, true)?;
            let el = normalize_element(element)?;
            let id = el["id"].as_str().unwrap_or_default().to_string();
            let elements = child_map(txn, &m, "elements");
            if elements.contains_key(txn, &id) {
                return Err(DeckError::new(
                    "element_exists",
                    format!("Slide `{slide}` already has an element `{id}`."),
                    "Leave `id` out to get a new one, or pick an unused id (e_ + 6 base36 characters).",
                ));
            }
            let ids = element_ids(txn, &m);
            write_element(txn, &elements, &el);
            let order = child_array(txn, &m, "elementOrder");
            match z {
                Some(z) if *z < ids.len() => insert_before(txn, &order, Some(&ids[*z]), &id),
                _ => insert_before(txn, &order, None, &id),
            }
            out.elements_added.push((slide.clone(), id));
        }
        Op::UpdateElement { slide, element, set } => {
            let m = slide_map(txn, r, slide, true)?;
            let el = element_map(txn, &m, slide, element)?;
            update_element_fields(txn, &el, set)?;
        }
        Op::ReplaceText { slide, element, field, find, replace, all } => {
            let m = slide_map(txn, r, slide, true)?;
            out.replacements += replace_text(txn, &m, slide, element.as_deref(), field.as_deref(), find, replace, *all)?;
        }
        Op::ReorderElement { slide, element, to } => {
            let m = slide_map(txn, r, slide, true)?;
            element_map(txn, &m, slide, element)?;
            let ids = element_ids(txn, &m);
            let pos = ids.iter().position(|i| i == element).unwrap_or(0);
            let order = child_array(txn, &m, "elementOrder");
            let rest: Vec<&String> = ids.iter().filter(|i| *i != element).collect();
            // The element goes right before `before` (None = in front of everything).
            let before: Option<String> = match to {
                ZTarget::Front => None,
                ZTarget::Back => rest.first().map(|s| s.to_string()),
                ZTarget::Forward => rest.get(pos + 1).map(|s| s.to_string()),
                ZTarget::Backward => rest.get(pos.saturating_sub(1)).map(|s| s.to_string()),
                ZTarget::Index(n) => rest.get(*n).map(|s| s.to_string()),
            };
            remove_all(txn, &order, element);
            insert_before(txn, &order, before.as_deref(), element);
        }
        Op::DeleteElement { slide, element } => {
            let m = slide_map(txn, r, slide, true)?;
            element_map(txn, &m, slide, element)?;
            if let Some(Out::YMap(em)) = m.get(txn, "elements") {
                em.remove(txn, element);
            }
            if let Some(Out::YArray(order)) = m.get(txn, "elementOrder") {
                remove_all(txn, &order, element);
            }
        }
    }
    Ok(())
}

pub(crate) fn update_slide_fields(txn: &mut TransactionMut, m: &MapRef, set: &Map<String, Value>) -> Result<(), DeckError> {
    for (k, v) in set {
        match k.as_str() {
            "id" | "elements" => {
                return Err(DeckError::invalid(
                    format!("`update_slide` can't set `{k}`."),
                    "Change elements with add_element/update_element/delete_element; slide ids never change.",
                ));
            }
            "notes" => {
                let s = match v {
                    Value::String(s) => s.clone(),
                    Value::Null => String::new(),
                    other => crate::richtext::plain_text(&normalize_rich(other)),
                };
                let t = child_text(txn, m, "notes");
                set_plain(txn, &t, &s);
            }
            "layout" => {
                let layout = v.as_str().unwrap_or("");
                if !LAYOUTS.contains(&layout) {
                    return Err(DeckError::invalid(format!("`{layout}` is not a layout."), format!("Use one of: {}.", LAYOUTS.join(", "))));
                }
                if plain_differs(txn, m, k, v) {
                    put_plain(txn, m, k, v);
                }
            }
            _ => {
                if plain_differs(txn, m, k, v) {
                    put_plain(txn, m, k, v);
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn update_element_fields(txn: &mut TransactionMut, el: &MapRef, set: &Map<String, Value>) -> Result<(), DeckError> {
    let kind = match el.get(txn, "kind") {
        Some(Out::Any(Any::String(s))) => s.to_string(),
        _ => String::new(),
    };
    let id = match el.get(txn, "id") {
        Some(Out::Any(Any::String(s))) => s.to_string(),
        _ => String::new(),
    };
    // rows/cols first so a new `cells` grid is read with the right size.
    let mut keys: Vec<&String> = set.keys().collect();
    keys.sort_by_key(|k| if k.as_str() == "cells" { 1 } else { 0 });
    for k in keys {
        let v = &set[k];
        match k.as_str() {
            "id" if v.as_str() != Some(id.as_str()) => {
                return Err(DeckError::invalid("An element's id can't change.", "Delete it and add a new element instead."));
            }
            "kind" if v.as_str() != Some(kind.as_str()) => {
                return Err(DeckError::invalid(
                    format!("An element's kind can't change (this one is `{kind}`)."),
                    "Delete it and add a new element of the kind you want.",
                ));
            }
            "id" | "kind" => {}
            key if y_fields(&kind).contains(&key) => match key {
                "text" => {
                    let t = child_text(txn, el, "text");
                    // A plain string keeps the element's look; rich text JSON sets exactly what it says.
                    let target = match v {
                        Value::String(plain) => crate::richtext::restyle_plain(plain, &crate::richtext::read_rich(txn, &t)),
                        other => normalize_rich(other),
                    };
                    set_rich(txn, &t, &target);
                }
                "cells" => set_cells(txn, el, v),
                _ => {
                    let t = child_text(txn, el, key);
                    set_plain(txn, &t, v.as_str().unwrap_or(""));
                }
            },
            key => {
                if plain_differs(txn, el, key, v) {
                    put_plain(txn, el, key, v);
                }
            }
        }
    }
    // Keep rows/cols in step with a new grid.
    if let Some(Value::Array(rows)) = set.get("cells") {
        if !set.contains_key("rows") {
            put_plain(txn, el, "rows", &json!(rows.len()));
        }
        if !set.contains_key("cols") {
            let cols = rows.iter().filter_map(Value::as_array).map(Vec::len).max().unwrap_or(1);
            put_plain(txn, el, "cols", &json!(cols));
        }
    }
    Ok(())
}

/// Makes a table's cells equal a grid (rows of cells), changing cell text through minimal diffs.
pub(crate) fn set_cells(txn: &mut TransactionMut, el: &MapRef, grid: &Value) {
    let cm = child_map(txn, el, "cells");
    let mut wanted = std::collections::HashSet::new();
    for (r, row) in grid.as_array().into_iter().flatten().enumerate() {
        for (c, cell) in row.as_array().into_iter().flatten().enumerate() {
            let key = format!("{r}:{c}");
            wanted.insert(key.clone());
            let cell = normalize_cell(cell);
            match cm.get(txn, &key) {
                Some(Out::YMap(m)) => {
                    let t = child_text(txn, &m, "text");
                    set_rich(txn, &t, &cell["text"]);
                    if plain_differs(txn, &m, "fill", &cell["fill"]) {
                        put_plain(txn, &m, "fill", &cell["fill"]);
                    }
                }
                _ => write_cell(txn, &cm, &key, &cell),
            }
        }
    }
    let stale: Vec<String> = cm.keys(txn).filter(|k| !wanted.contains(*k)).map(String::from).collect();
    for k in stale {
        cm.remove(txn, &k);
    }
}

/// The text fields of one element (or a whole slide) that `replace_text` searches, with their names.
fn text_targets(
    txn: &mut TransactionMut,
    slide: &MapRef,
    slide_id: &str,
    element: Option<&str>,
    field: Option<&str>,
) -> Result<Vec<(String, TextRef)>, DeckError> {
    let mut out = Vec::new();
    let element_fields = |txn: &mut TransactionMut, el: &MapRef, eid: &str, field: Option<&str>| -> Result<Vec<(String, TextRef)>, DeckError> {
        let kind = match el.get(txn, "kind") {
            Some(Out::Any(Any::String(s))) => s.to_string(),
            _ => String::new(),
        };
        let mut v = Vec::new();
        match field {
            Some(f) if f.starts_with("cell:") => {
                let key = &f[5..];
                match el.get(txn, "cells") {
                    Some(Out::YMap(cm)) => match cm.get(txn, key) {
                        Some(Out::YMap(cell)) => v.push((format!("{eid} {f}"), child_text(txn, &cell, "text"))),
                        _ => {
                            return Err(DeckError::invalid(
                                format!("Element `{eid}` has no cell `{key}`."),
                                "Cells are named row:col from 0, e.g. \"cell:0:1\".",
                            ));
                        }
                    },
                    _ => return Err(DeckError::invalid(format!("Element `{eid}` is not a table."), "Use \"field\": \"cell:r:c\" only on tables.")),
                }
            }
            Some(f) => {
                if !y_fields(&kind).contains(&f) {
                    return Err(DeckError::invalid(
                        format!("Element `{eid}` ({kind}) has no text field `{f}`."),
                        format!("Its text fields are: {}.", y_fields(&kind).join(", ")),
                    ));
                }
                v.push((format!("{eid} {f}"), child_text(txn, el, f)));
            }
            None => {
                for f in y_fields(&kind) {
                    if *f == "cells" {
                        if let Some(Out::YMap(cm)) = el.get(txn, "cells") {
                            let mut keys: Vec<String> = cm.keys(txn).map(String::from).collect();
                            keys.sort();
                            for key in keys {
                                if let Some(Out::YMap(cell)) = cm.get(txn, &key) {
                                    v.push((format!("{eid} cell:{key}"), child_text(txn, &cell, "text")));
                                }
                            }
                        }
                    } else if el.contains_key(txn, f) {
                        v.push((format!("{eid} {f}"), child_text(txn, el, f)));
                    }
                }
            }
        }
        Ok(v)
    };
    match element {
        Some(eid) => {
            let el = element_map(txn, slide, slide_id, eid)?;
            out.extend(element_fields(txn, &el, eid, field)?);
        }
        None => {
            if field.is_none() || field == Some("notes") {
                out.push(("notes".to_string(), child_text(txn, slide, "notes")));
            }
            if field.is_none() {
                for eid in element_ids(txn, slide) {
                    let el = element_map(txn, slide, slide_id, &eid)?;
                    out.extend(element_fields(txn, &el, &eid, None)?);
                }
            } else if field != Some("notes") {
                return Err(DeckError::invalid(
                    format!("`field` \"{}\" needs `element`.", field.unwrap_or_default()),
                    "Name the element whose text to change, or use \"field\": \"notes\" for speaker notes.",
                ));
            }
        }
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn replace_text(
    txn: &mut TransactionMut,
    slide: &MapRef,
    slide_id: &str,
    element: Option<&str>,
    field: Option<&str>,
    find: &str,
    replace: &str,
    all: bool,
) -> Result<usize, DeckError> {
    let targets = text_targets(txn, slide, slide_id, element, field)?;
    let mut found: Vec<(TextRef, String, Vec<usize>)> = Vec::new();
    let mut total = 0;
    for (_, t) in &targets {
        let s = yrs::GetString::get_string(t, txn);
        let positions: Vec<usize> = s.match_indices(find).map(|(i, _)| i).collect();
        total += positions.len();
        if !positions.is_empty() {
            found.push((t.clone(), s, positions));
        }
    }
    let place = match element {
        Some(e) => format!("element `{e}` on slide `{slide_id}`"),
        None => format!("slide `{slide_id}`"),
    };
    if total == 0 {
        let texts: Vec<String> = targets.iter().map(|(_, t)| yrs::GetString::get_string(t, txn)).collect();
        let hint = match closest_match(find, &texts) {
            Some(c) => format!("The closest passage is: \"{c}\". Copy the exact text from `present read` and try again."),
            None => "That text has nothing in it to match. Read the deck again with `present read`.".to_string(),
        };
        return Err(DeckError::new("text_not_found", format!("\"{find}\" doesn't appear in {place}."), hint));
    }
    if total > 1 && !all {
        return Err(DeckError::new(
            "text_ambiguous",
            format!("\"{find}\" appears {total} times in {place}, so it's not clear which one to replace."),
            "Include more of the surrounding text so it matches once, or set \"all\": true to replace every one.",
        ));
    }
    for (t, s, positions) in found {
        let old = OldText::read(txn, &t);
        for byte in positions.into_iter().rev() {
            let start = utf16_len(&s[..byte]);
            let end = start + utf16_len(find);
            let mut pos = start;
            let mut old_pos = start;
            for chunk in dissimilar::diff(find, replace) {
                match chunk {
                    dissimilar::Chunk::Equal(x) => {
                        pos += utf16_len(x);
                        old_pos += utf16_len(x);
                    }
                    dissimilar::Chunk::Delete(x) => {
                        t.remove_range(txn, pos, utf16_len(x));
                        old_pos += utf16_len(x);
                    }
                    dissimilar::Chunk::Insert(x) => {
                        old.insert_like(txn, &t, pos, x, old_pos, start, end);
                        pos += utf16_len(x);
                    }
                }
            }
        }
    }
    Ok(total)
}

/// The passage most like `find` (by lines), for the `text_not_found` hint.
fn closest_match(find: &str, texts: &[String]) -> Option<String> {
    let want_lines = find.lines().count().max(1);
    let mut best: Option<(f64, String)> = None;
    let mut checked = 0;
    for text in texts {
        let lines: Vec<&str> = text.lines().collect();
        for i in 0..lines.len() {
            if checked > 4000 {
                break;
            }
            let end = (i + want_lines).min(lines.len());
            let candidate = lines[i..end].join("\n");
            let candidate = candidate.trim();
            if candidate.is_empty() {
                continue;
            }
            checked += 1;
            let equal: usize = dissimilar::diff(find, candidate)
                .iter()
                .map(|c| match c {
                    dissimilar::Chunk::Equal(s) => s.chars().count(),
                    _ => 0,
                })
                .sum();
            let score = 2.0 * equal as f64 / (find.chars().count() + candidate.chars().count()) as f64;
            if best.as_ref().is_none_or(|(b, _)| score > *b) {
                let shown: String = candidate.chars().take(200).collect();
                best = Some((score, shown));
            }
        }
    }
    best.filter(|(s, _)| *s > 0.2).map(|(_, c)| c)
}

/// A text's characters and formatting before an edit, so inserted text can look like what it replaces.
struct OldText {
    /// (start, end, is paragraph break, attributes) per segment, in UTF-16 units.
    segs: Vec<(u32, u32, bool, yrs::types::Attrs)>,
}

impl OldText {
    fn read<T: ReadTxn>(txn: &T, t: &TextRef) -> Self {
        let mut at = 0;
        let segs = crate::richtext::read_segments(txn, t)
            .into_iter()
            .map(|s| {
                let len = utf16_len(&s.text);
                let seg = (at, at + len, s.text == "\n", s.attrs);
                at += len;
                seg
            })
            .collect();
        Self { segs }
    }

    /// The formatting of the character at `offset`, if it's not a paragraph break.
    fn inline_at(&self, offset: u32) -> Option<&yrs::types::Attrs> {
        self.segs.iter().find(|s| s.0 <= offset && offset < s.1 && !s.2).map(|s| &s.3)
    }

    /// The paragraph attributes of the first paragraph break at or after `offset`.
    fn paragraph_after(&self, offset: u32) -> yrs::types::Attrs {
        self.segs
            .iter()
            .find(|s| s.2 && s.0 >= offset)
            .map(|s| s.3.iter().filter(|(k, _)| crate::richtext::is_paragraph_key(k)).map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default()
    }

    /// Inserts `x` at `pos`, formatted like the replaced passage around `old_pos` (inside `start..end`): text takes
    /// the formatting of the character it replaces (or the one before it in the passage), a paragraph break takes
    /// the attributes of the paragraph it splits.
    #[allow(clippy::too_many_arguments)]
    fn insert_like(&self, txn: &mut TransactionMut, t: &TextRef, pos: u32, x: &str, old_pos: u32, start: u32, end: u32) {
        let inline: Option<yrs::types::Attrs> = (if old_pos < end { self.inline_at(old_pos) } else { None })
            .or_else(|| if old_pos > start { self.inline_at(old_pos - 1) } else { None })
            .map(|a| a.iter().filter(|(k, _)| crate::richtext::is_inline_key(k)).map(|(k, v)| (k.clone(), v.clone())).collect());
        let mut at = pos;
        for (i, piece) in x.split('\n').enumerate() {
            if i > 0 {
                t.insert_with_attributes(txn, at, "\n", self.paragraph_after(old_pos));
                at += 1;
            }
            if piece.is_empty() {
                continue;
            }
            match &inline {
                Some(a) => t.insert_with_attributes(txn, at, piece, a.clone()),
                None => t.insert(txn, at, piece),
            }
            at += utf16_len(piece);
        }
    }
}
