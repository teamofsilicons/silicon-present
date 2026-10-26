//! Edit ops (`POST /v1/decks/{id}/edits`): every op in `docs/architecture.md`, applied in one Yjs transaction.

use serde_json::{Map, Value, json};
use yrs::{
    Any, Array, ArrayRef, Doc, Map as YMap, MapPrelim, MapRef, Out, ReadTxn, Text, TextPrelim,
    TextRef, Transact, TransactionMut,
};

use crate::anyconv::any_to_json;
use crate::convert::{
    MASTER_KEY, Roots, element_ids, put_plain, roots, slide_ids, write_cell, write_element,
    write_slide,
};
use crate::error::DeckError;
use crate::normalize::{normalize_cell, normalize_element, normalize_slide, y_fields};
use crate::richtext::{normalize_rich, set_rich, utf16_len};

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
    UpdateDeck {
        set: Map<String, Value>,
    },
    AddSlide {
        after: Place,
        slide: Value,
    },
    UpdateSlide {
        slide: String,
        set: Map<String, Value>,
    },
    MoveSlide {
        slide: String,
        after: Place,
    },
    DeleteSlide {
        slide: String,
    },
    AddElement {
        slide: String,
        element: Value,
        z: Option<usize>,
    },
    UpdateElement {
        slide: String,
        element: String,
        set: Map<String, Value>,
    },
    ReplaceText {
        slide: String,
        element: Option<String>,
        field: Option<String>,
        find: String,
        replace: String,
        all: bool,
        match_case: bool,
    },
    ReorderElement {
        slide: String,
        element: String,
        to: ZTarget,
    },
    DeleteElement {
        slide: String,
        element: String,
    },
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

const OP_NAMES: &str = "update_deck, add_slide, update_slide, move_slide, delete_slide, add_element, update_element, replace_text, reorder_element, delete_element";

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
        Some(_) => Err(DeckError::invalid(
            "`after` must be a slide id or null.",
            "Use \"after\": \"s_abc123\", or null to put it first.",
        )),
    }
}

/// Parses `ops` (a JSON array) into ops.
pub fn parse_ops(value: &Value) -> Result<Vec<Op>, DeckError> {
    let Some(items) = value.as_array() else {
        return Err(DeckError::invalid(
            "`ops` must be a JSON array of ops.",
            "Send \"ops\": [ { \"op\": \"add_slide\", … } ].",
        ));
    };
    items
        .iter()
        .enumerate()
        .map(|(i, v)| parse_op(v).map_err(|e| e.at(i)))
        .collect()
}

fn parse_op(v: &Value) -> Result<Op, DeckError> {
    let bad = || {
        DeckError::invalid(
            "The op has an invalid shape or value.",
            "Use the exact keys and types documented under Edit ops.",
        )
    };
    let op = v.as_object().ok_or_else(bad)?;
    let name = op.get("op").and_then(Value::as_str).ok_or_else(bad)?;
    let required: &[&str] = match name {
        "update_deck" => &["set"],
        "add_slide" => &["slide"],
        "update_slide" => &["slide", "set"],
        "move_slide" | "delete_slide" => &["slide"],
        "add_element" => &["slide", "element"],
        "update_element" => &["slide", "element", "set"],
        "replace_text" => &["slide", "find", "replace"],
        "reorder_element" => &["slide", "element", "to"],
        "delete_element" => &["slide", "element"],
        _ => {
            return Err(DeckError::invalid(
                format!("`{name}` is not an op."),
                format!("Use one of: {OP_NAMES}."),
            ));
        }
    };
    let optional: &[&str] = match name {
        "add_slide" | "move_slide" => &["after"],
        "add_element" => &["z"],
        "replace_text" => &["element", "field", "all", "matchCase"],
        _ => &[],
    };
    for k in op.keys() {
        if k != "op" && !required.contains(&k.as_str()) && !optional.contains(&k.as_str()) {
            return Err(bad());
        }
    }
    for k in required {
        if !op.contains_key(*k) || op[*k].is_null() {
            return Err(bad());
        }
    }
    let present = |k: &str| op.get(k).filter(|v| !v.is_null());
    for k in ["slide", "element", "find", "replace", "field", "after"] {
        if (k == "slide" && name == "add_slide") || (k == "element" && name == "add_element") {
            continue;
        }
        if let Some(v) = present(k) {
            let t = v.as_str().ok_or_else(bad)?;
            if t.is_empty() && !["replace", "field"].contains(&k) {
                return Err(bad());
            }
        }
    }
    for k in ["all", "matchCase"] {
        if let Some(v) = present(k) {
            if !v.is_boolean() {
                return Err(bad());
            }
        }
    }
    let index = |v: &Value| -> Result<usize, DeckError> {
        let n = v.as_f64().ok_or_else(bad)?;
        if n.is_finite() && n >= 0.0 && n.fract() == 0.0 {
            Ok(n.min(usize::MAX as f64) as usize)
        } else {
            Err(bad())
        }
    };
    if op.get("after").and_then(Value::as_str) == Some(MASTER_KEY)
        || (["update_slide", "move_slide", "delete_slide"].contains(&name)
            && op.get("slide").and_then(Value::as_str) == Some(MASTER_KEY))
    {
        return Err(bad());
    }
    let id = |k: &str| str_field(op, k, name);
    Ok(match name {
        "update_deck" => Op::UpdateDeck {
            set: set_field(op, name)?,
        },
        "add_slide" => {
            let slide = op["slide"].clone();
            if !slide.is_object() {
                return Err(bad());
            }
            Op::AddSlide {
                after: place(op)?,
                slide,
            }
        }
        "update_slide" => Op::UpdateSlide {
            slide: id("slide")?,
            set: set_field(op, name)?,
        },
        "move_slide" => {
            if op.get("slide") == op.get("after") {
                return Err(bad());
            }
            Op::MoveSlide {
                slide: id("slide")?,
                after: place(op)?,
            }
        }
        "delete_slide" => Op::DeleteSlide {
            slide: id("slide")?,
        },
        "add_element" => {
            let element = op["element"].clone();
            if !element.is_object() {
                return Err(bad());
            }
            Op::AddElement {
                slide: id("slide")?,
                element,
                z: present("z").map(index).transpose()?,
            }
        }
        "update_element" => Op::UpdateElement {
            slide: id("slide")?,
            element: id("element")?,
            set: set_field(op, name)?,
        },
        "replace_text" => Op::ReplaceText {
            slide: id("slide")?,
            element: present("element").and_then(Value::as_str).map(String::from),
            field: present("field").and_then(Value::as_str).map(String::from),
            find: id("find")?,
            replace: op["replace"].as_str().ok_or_else(bad)?.into(),
            all: present("all").and_then(Value::as_bool).unwrap_or(false),
            match_case: present("matchCase")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        },
        "reorder_element" => {
            let to = match op["to"].as_str() {
                Some("front") => ZTarget::Front,
                Some("back") => ZTarget::Back,
                Some("forward") => ZTarget::Forward,
                Some("backward") => ZTarget::Backward,
                Some(_) => return Err(bad()),
                None => ZTarget::Index(index(&op["to"])?),
            };
            Op::ReorderElement {
                slide: id("slide")?,
                element: id("element")?,
                to,
            }
        }
        "delete_element" => Op::DeleteElement {
            slide: id("slide")?,
            element: id("element")?,
        },
        _ => unreachable!(),
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
pub(crate) fn slide_map<T: ReadTxn>(
    txn: &T,
    r: &Roots,
    id: &str,
    allow_master: bool,
) -> Result<MapRef, DeckError> {
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
        Some(Out::Any(a)) => {
            let plain = crate::normalize::string_value(&any_to_json(&a));
            if key == "text" {
                let rich = plain
                    .as_ref()
                    .map(|s| normalize_rich(&Value::String(s.clone())))
                    .unwrap_or_else(|| json!({"paragraphs":[]}));
                crate::convert::put_rich(txn, parent, key, &rich)
            } else {
                parent.insert(txn, key, TextPrelim::new(plain.unwrap_or_default()))
            }
        }
        _ => parent.insert(txn, key, TextPrelim::new("")),
    }
}

pub(crate) fn element_map<T: ReadTxn>(
    txn: &T,
    slide: &MapRef,
    slide_id: &str,
    id: &str,
) -> Result<MapRef, DeckError> {
    if !element_ids(txn, slide).iter().any(|e| e == id) {
        return Err(DeckError::element_not_found(slide_id, id));
    }
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
pub(crate) fn insert_after(
    txn: &mut TransactionMut,
    arr: &ArrayRef,
    after: Option<&str>,
    id: &str,
) {
    let idx = match after {
        None => 0,
        Some(a) => raw_positions(txn, arr, a)
            .first()
            .map(|p| p + 1)
            .unwrap_or_else(|| arr.len(txn)),
    };
    arr.insert(txn, idx, id);
}

/// Inserts `id` into an id array right before `before` (first occurrence), last when `None`.
pub(crate) fn insert_before(
    txn: &mut TransactionMut,
    arr: &ArrayRef,
    before: Option<&str>,
    id: &str,
) {
    let idx = match before {
        None => arr.len(txn),
        Some(b) => raw_positions(txn, arr, b)
            .first()
            .copied()
            .unwrap_or_else(|| arr.len(txn)),
    };
    arr.insert(txn, idx, id);
}

pub(crate) fn plain_differs<T: ReadTxn>(txn: &T, map: &MapRef, key: &str, value: &Value) -> bool {
    match map.get(txn, key) {
        Some(Out::Any(a)) => {
            !crate::anyconv::is_canonical(&a)
                || any_to_json(&a) != crate::anyconv::canon(value.clone())
        }
        _ => true,
    }
}

fn apply_op(
    txn: &mut TransactionMut,
    r: &Roots,
    op: &Op,
    out: &mut OpsOutcome,
) -> Result<(), DeckError> {
    match op {
        Op::UpdateDeck { set } => {
            for (k, v) in set {
                match k.as_str() {
                    "size" => {
                        crate::validate::size(v)?;
                        put_plain(txn, &r.deck, k, &crate::normalize::normalize_size(v));
                    }
                    "theme" => {
                        crate::validate::theme(v)?;
                        put_plain(txn, &r.deck, k, &crate::normalize::normalize_theme(v));
                    }
                    other => return Err(crate::validate::invalid_field(other)),
                }
            }
        }
        Op::AddSlide { after, slide } => {
            crate::validate::slide(slide)?;
            let slide = normalize_slide(slide)?;
            for el in slide["elements"].as_array().into_iter().flatten() {
                ensure_unused_element(txn, r, el["id"].as_str().unwrap())?;
            }
            let id = slide["id"].as_str().unwrap_or_default().to_string();
            if id == MASTER_KEY || r.slides.contains_key(txn, &id) {
                return Err(DeckError::new(
                    "slide_exists",
                    format!("A slide with id `{id}` already exists."),
                    "Leave `id` out to get a new one, or pick an unused id (s_ + 6 base36 characters).",
                ));
            }
            remove_all(txn, &r.order, &id);
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
            update_slide_fields(txn, &m, slide, set)?;
        }
        Op::MoveSlide { slide, after } => {
            slide_map(txn, r, slide, false)?;
            if let Place::After(a) = after {
                if a == slide {
                    return Err(DeckError::invalid(
                        "A slide can't be moved after itself.",
                        "Pass the id of another slide, or null to move it first.",
                    ));
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
            let m = if slide == MASTER_KEY
                && !matches!(r.slides.get(txn, MASTER_KEY), Some(Out::YMap(_)))
            {
                write_slide(txn, &r.slides, MASTER_KEY, &json!({"elements":[]}), true)
            } else {
                slide_map(txn, r, slide, true)?
            };
            crate::validate::element(element)?;
            let el = normalize_element(element)?;
            let id = el["id"].as_str().unwrap_or_default().to_string();
            ensure_unused_element(txn, r, &id)?;
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
            remove_all(txn, &order, &id);
            match z {
                Some(z) if *z < ids.len() => insert_before(txn, &order, Some(&ids[*z]), &id),
                _ => insert_before(txn, &order, None, &id),
            }
            out.elements_added.push((slide.clone(), id));
        }
        Op::UpdateElement {
            slide,
            element,
            set,
        } => {
            let m = slide_map(txn, r, slide, true)?;
            let el = element_map(txn, &m, slide, element)?;
            update_element_fields(txn, &el, element, set)?;
        }
        Op::ReplaceText {
            slide,
            element,
            field,
            find,
            replace,
            all,
            match_case,
        } => {
            let m = slide_map(txn, r, slide, true)?;
            out.replacements += replace_text(
                txn,
                &m,
                slide,
                element.as_deref(),
                field.as_deref(),
                find,
                replace,
                *all,
                *match_case,
            )?;
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

fn ensure_unused_element<T: ReadTxn>(txn: &T, r: &Roots, id: &str) -> Result<(), DeckError> {
    for (_, s) in r.slides.iter(txn) {
        if let Out::YMap(s) = s {
            if let Some(Out::YMap(e)) = s.get(txn, "elements") {
                if e.contains_key(txn, id) {
                    return Err(DeckError::new(
                        "element_exists",
                        format!("Element `{id}` already exists in this deck."),
                        "Choose an unused id, or omit id.",
                    ));
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn update_slide_fields(
    txn: &mut TransactionMut,
    m: &MapRef,
    id: &str,
    set: &Map<String, Value>,
) -> Result<(), DeckError> {
    crate::validate::keys(
        set,
        &[
            "layout",
            "background",
            "skipped",
            "section",
            "hideMaster",
            "transition",
            "notes",
        ],
    )?;
    let mut target = crate::convert::read_slide(txn, id, m, false);
    target.as_object_mut().unwrap().extend(set.clone());
    crate::validate::slide(&target)?;
    let target = normalize_slide(&target)?;
    crate::reconcile::reconcile_slide(txn, m, &target, false);
    Ok(())
}

pub(crate) fn update_element_fields(
    txn: &mut TransactionMut,
    el: &MapRef,
    id: &str,
    set: &Map<String, Value>,
) -> Result<(), DeckError> {
    let current = crate::convert::read_element(txn, id, el);
    let kind = current["kind"].as_str().unwrap_or("");
    for k in ["id", "kind"] {
        if let Some(v) = set.get(k) {
            if v != &current[k] {
                return Err(crate::validate::invalid_field(k));
            }
        }
    }
    let mut target = current.clone();
    let m = target
        .as_object_mut()
        .ok_or_else(|| crate::validate::invalid_value("element"))?;
    m.extend(set.clone());
    if let Some(v) = set.get("text").and_then(crate::normalize::string_value) {
        m.insert(
            "text".into(),
            crate::richtext::restyle_plain(&v, &current["text"]),
        );
    }
    if kind == "table" {
        merge_table_update(&current, set, m)?;
    }
    crate::validate::element(&target)?;
    let target = normalize_element(&target)?;
    crate::reconcile::reconcile_element(txn, el, kind, target.as_object().unwrap().clone());
    Ok(())
}

fn merge_table_update(
    current: &Value,
    set: &Map<String, Value>,
    m: &mut Map<String, Value>,
) -> Result<(), DeckError> {
    let grid = set.get("cells").and_then(Value::as_array);
    for (dim, axis, total) in [("rows", "rowHeights", "h"), ("cols", "colWidths", "w")] {
        let inferred = grid
            .map(|g| {
                if dim == "rows" {
                    g.len()
                } else {
                    g.iter()
                        .filter_map(Value::as_array)
                        .map(Vec::len)
                        .max()
                        .unwrap_or(0)
                }
            })
            .map(|n| if n == 0 { 2 } else { n });
        let n = match set.get(dim).filter(|v| !v.is_null()) {
            Some(v) => crate::normalize::number(v)
                .filter(|n| n.fract() == 0.0 && (1.0..=100.0).contains(n))
                .ok_or_else(|| crate::validate::invalid_value(dim))?
                as usize,
            None => inferred.unwrap_or(current[dim].as_u64().unwrap_or(2) as usize),
        };
        if n > 100 {
            return Err(crate::validate::invalid_value(dim));
        }
        m.insert(dim.into(), json!(n));
        let new_total = m
            .get(total)
            .filter(|v| !v.is_null())
            .and_then(crate::normalize::number)
            .unwrap_or(if total == "w" { 400.0 } else { 200.0 });
        if !set.contains_key(axis) {
            if n != current[dim].as_u64().unwrap_or(2) as usize {
                m.remove(axis);
            } else if new_total != current[total].as_f64().unwrap_or(0.0) {
                let old_total = current[total].as_f64().unwrap_or(0.0);
                if old_total == 0.0 {
                    m.remove(axis);
                } else {
                    let scaled: Vec<Value> = current[axis]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| {
                            crate::anyconv::float_to_json(
                                v.as_f64().unwrap_or(0.0) * (new_total / old_total),
                            )
                        })
                        .collect();
                    m.insert(axis.into(), Value::Array(scaled));
                }
            }
        }
    }
    if !set.contains_key("cells") {
        let rows = m["rows"].as_u64().unwrap() as usize;
        let cols = m["cols"].as_u64().unwrap() as usize;
        let cells: Vec<Value> = current["cells"]
            .as_array()
            .unwrap()
            .iter()
            .take(rows)
            .map(|r| Value::Array(r.as_array().unwrap().iter().take(cols).cloned().collect()))
            .collect();
        m.insert("cells".into(), Value::Array(cells));
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
                    let stale: Vec<String> = m
                        .keys(txn)
                        .filter(|k| !matches!(*k, "text" | "fill"))
                        .map(String::from)
                        .collect();
                    for k in stale {
                        m.remove(txn, &k);
                    }
                }
                _ => write_cell(txn, &cm, &key, &cell),
            }
        }
    }
    let stale: Vec<String> = cm
        .keys(txn)
        .filter(|k| !wanted.contains(*k))
        .map(String::from)
        .collect();
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
    if field == Some("notes") && (element.is_some() || slide_id == MASTER_KEY) {
        return Err(DeckError::invalid(
            "This replace_text scope cannot address notes.",
            "Use notes only on a regular slide without element.",
        ));
    }
    let mut out = Vec::new();
    let element_fields = |txn: &mut TransactionMut,
                          el: &MapRef,
                          eid: &str,
                          field: Option<&str>|
     -> Result<Vec<(String, TextRef)>, DeckError> {
        let kind = match el.get(txn, "kind") {
            Some(Out::Any(Any::String(s))) => s.to_string(),
            _ => String::new(),
        };
        let mut v = Vec::new();
        if kind == "table" && field.is_none() {
            let canonical = crate::convert::read_element(txn, eid, el);
            set_cells(txn, el, &canonical["cells"]);
        }
        match field {
            Some(f) if f.starts_with("cell:") => {
                let key = &f[5..];
                if kind != "table" {
                    return Err(DeckError::new(
                        "field_not_found",
                        format!("Element `{eid}` has no field `{f}`."),
                        "Use a text field of this element's kind.",
                    ));
                }
                let canonical = crate::convert::read_element(txn, eid, el);
                let (row, col) = crate::convert::cell_coordinates(key).ok_or_else(|| {
                    DeckError::new(
                        "field_not_found",
                        format!("Invalid cell field `{f}`."),
                        "Use cell:R:C with decimal coordinates and no leading zeroes.",
                    )
                })?;
                if row >= canonical["rows"].as_u64().unwrap_or(0) as usize
                    || col >= canonical["cols"].as_u64().unwrap_or(0) as usize
                {
                    return Err(DeckError::new(
                        "cell_not_found",
                        format!("Table `{eid}` has no cell `{key}`."),
                        "Choose a cell inside the table.",
                    ));
                }
                set_cells(txn, el, &canonical["cells"]);
                match el.get(txn, "cells") {
                    Some(Out::YMap(cm)) => match cm.get(txn, key) {
                        Some(Out::YMap(cell)) => {
                            v.push((format!("{eid} {f}"), child_text(txn, &cell, "text")))
                        }
                        _ => {
                            return Err(DeckError::invalid(
                                format!("Element `{eid}` has no cell `{key}`."),
                                "Cells are named row:col from 0, e.g. \"cell:0:1\".",
                            ));
                        }
                    },
                    _ => {
                        return Err(DeckError::invalid(
                            format!("Element `{eid}` is not a table."),
                            "Use \"field\": \"cell:r:c\" only on tables.",
                        ));
                    }
                }
            }
            Some(f) => {
                if f == "cells" || !y_fields(&kind).contains(&f) {
                    return Err(DeckError::new(
                        "field_not_found",
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
                                    v.push((
                                        format!("{eid} cell:{key}"),
                                        child_text(txn, &cell, "text"),
                                    ));
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
            if slide_id != MASTER_KEY && (field.is_none() || field == Some("notes")) {
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
    match_case: bool,
) -> Result<usize, DeckError> {
    let targets = text_targets(txn, slide, slide_id, element, field)?;
    let mut found: Vec<(TextRef, String, Vec<(usize, usize)>, bool)> = Vec::new();
    let mut total = 0;
    for (name, t) in &targets {
        crate::richtext::remove_embeds(txn, t);
        let s = yrs::GetString::get_string(t, txn);
        let positions = crate::textdiff::matches(&s, find, match_case);
        total += positions.len();
        if !positions.is_empty() {
            found.push((
                t.clone(),
                s,
                positions,
                name == "notes" || [" html", " css", " js"].iter().any(|f| name.ends_with(f)),
            ));
        }
    }
    let place = match element {
        Some(e) => format!("element `{e}` on slide `{slide_id}`"),
        None => format!("slide `{slide_id}`"),
    };
    if total == 0 {
        let texts: Vec<String> = targets
            .iter()
            .map(|(_, t)| yrs::GetString::get_string(t, txn))
            .collect();
        let hint = match closest_match(find, &texts) {
            Some(c) => format!(
                "The closest passage is: \"{c}\". Copy the exact text from `present read` and try again."
            ),
            None => {
                "That text has nothing in it to match. Read the deck again with `present read`."
                    .to_string()
            }
        };
        return Err(DeckError::new(
            "text_not_found",
            format!("\"{find}\" doesn't appear in {place}."),
            hint,
        ));
    }
    if total > 1 && !all {
        return Err(DeckError::new(
            "text_ambiguous",
            format!(
                "\"{find}\" appears {total} times in {place}, so it's not clear which one to replace."
            ),
            "Include more of the surrounding text so it matches once, or set \"all\": true to replace every one.",
        ));
    }
    for (t, s, positions, plain_field) in found {
        let old = OldText::read(txn, &t);
        for (byte, byte_end) in positions.into_iter().rev() {
            let passage = &s[byte..byte_end];
            let start = utf16_len(&s[..byte]);
            let end = start + utf16_len(passage);
            let mut pos = start;
            let mut old_pos = start;
            let mut deleted = None;
            for (kind, x) in crate::textdiff::diff(passage, replace) {
                let n = utf16_len(&x);
                match kind {
                    crate::textdiff::Kind::Equal => {
                        pos += n;
                        old_pos += n;
                        deleted = None;
                    }
                    crate::textdiff::Kind::Delete => {
                        t.remove_range(txn, pos, n);
                        deleted = Some((old_pos, old_pos + n));
                        old_pos += n;
                    }
                    crate::textdiff::Kind::Insert => {
                        old.insert_like(txn, &t, pos, &x, old_pos, start, end, deleted.take());
                        pos += n;
                    }
                }
            }
        }
        if plain_field {
            let current = yrs::GetString::get_string(&t, txn);
            crate::richtext::set_unformatted(txn, &t, &current);
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
            let score =
                2.0 * equal as f64 / (find.chars().count() + candidate.chars().count()) as f64;
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

    /// The paragraph attributes of the first paragraph break at or after `offset`.
    fn paragraph_after(&self, offset: u32) -> yrs::types::Attrs {
        self.segs
            .iter()
            .find(|s| s.2 && s.0 >= offset)
            .map(|s| {
                s.3.iter()
                    .filter(|(k, _)| crate::richtext::is_paragraph_key(k))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Inserts `x` at `pos`, formatted like the replaced passage around `old_pos` (inside `start..end`): text takes
    /// the formatting of the character it replaces (or the one before it in the passage), a paragraph break takes
    /// the attributes of the paragraph it splits.
    #[allow(clippy::too_many_arguments)]
    fn insert_like(
        &self,
        txn: &mut TransactionMut,
        t: &TextRef,
        pos: u32,
        x: &str,
        old_pos: u32,
        start: u32,
        end: u32,
        deleted: Option<(u32, u32)>,
    ) {
        let chosen = deleted
            .and_then(|(a, b)| self.segs.iter().find(|s| !s.2 && s.1 > a && s.0 < b))
            .or_else(|| {
                self.segs
                    .iter()
                    .rev()
                    .find(|s| !s.2 && s.0 < old_pos && s.1 > start)
            })
            .or_else(|| {
                self.segs
                    .iter()
                    .find(|s| !s.2 && s.1 > old_pos && s.0 < end)
            });
        let inline: yrs::types::Attrs = chosen
            .map(|s| {
                s.3.iter()
                    .filter(|(k, _)| crate::richtext::is_inline_key(k))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let mut at = pos;
        for (i, piece) in x.split('\n').enumerate() {
            if i > 0 {
                t.insert_with_attributes(txn, at, "\n", self.paragraph_after(old_pos));
                at += 1;
            }
            if piece.is_empty() {
                continue;
            }
            t.insert_with_attributes(txn, at, piece, inline.clone());
            at += utf16_len(piece);
        }
    }
}

/// Applies edits authored against `base`, checking creations and references against `live` before producing an
/// update. Neither document changes. The update still derives from the base, preserving concurrent live typing.
pub fn apply_ops_update_with_live(
    base: &Doc,
    live: &Doc,
    ops: &[Op],
) -> Result<(Vec<u8>, OpsOutcome), DeckError> {
    use std::collections::{HashMap, HashSet};
    #[derive(Default)]
    struct Inventory {
        slides: HashSet<String>,
        visible: HashSet<String>,
        elements: HashSet<(String, String)>,
        visible_elements: HashSet<(String, String)>,
        cells: HashSet<(String, String, String)>,
    }
    fn inventory(doc: &Doc) -> Inventory {
        let r = roots(doc);
        let txn = doc.transact();
        let mut out = Inventory::default();
        out.visible.extend(slide_ids(&txn, &r));
        out.visible.insert(MASTER_KEY.into());
        for (sid, s) in r.slides.iter(&txn) {
            out.slides.insert(sid.into());
            if let Out::YMap(s) = s {
                if out.visible.contains(sid) {
                    out.visible_elements.extend(
                        element_ids(&txn, &s)
                            .into_iter()
                            .map(|eid| (sid.to_string(), eid)),
                    );
                }
                if let Some(Out::YMap(es)) = s.get(&txn, "elements") {
                    for (eid, e) in es.iter(&txn) {
                        out.elements.insert((sid.into(), eid.into()));
                        if let Out::YMap(e) = e {
                            if let Some(Out::YMap(cs)) = e.get(&txn, "cells") {
                                for (key, c) in cs.iter(&txn) {
                                    if matches!(c, Out::YMap(_)) {
                                        out.cells.insert((sid.into(), eid.into(), key.into()));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        out
    }
    fn json_elements(deck: &Value) -> HashMap<(String, String), Value> {
        let mut out = HashMap::new();
        for slide in deck["slides"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(std::iter::once(&deck["master"]))
        {
            let sid = slide["id"].as_str().unwrap_or(MASTER_KEY);
            for e in slide["elements"].as_array().into_iter().flatten() {
                out.insert((sid.into(), e["id"].as_str().unwrap().into()), e.clone());
            }
        }
        out
    }
    let scratch = crate::clone_doc(base);
    let sv = scratch.transact().state_vector();
    let mut live = inventory(live);
    let mut outcome = OpsOutcome::default();
    for (index, op) in ops.iter().enumerate() {
        let checked = (|| -> Result<(), DeckError> {
            let before = inventory(&scratch);
            let old_json = crate::doc_to_json(&scratch);
            let mut named_slides = Vec::new();
            let mut named_element = None;
            match op {
                Op::AddSlide {
                    after: Place::After(a),
                    ..
                } => named_slides.push(a.as_str()),
                Op::UpdateSlide { slide, .. } | Op::AddElement { slide, .. } => {
                    named_slides.push(slide.as_str())
                }
                Op::MoveSlide { slide, after } => {
                    named_slides.push(slide.as_str());
                    if let Place::After(a) = after {
                        named_slides.push(a.as_str());
                    }
                }
                Op::UpdateElement { slide, element, .. }
                | Op::ReorderElement { slide, element, .. } => {
                    named_slides.push(slide.as_str());
                    named_element = Some((slide, element));
                }
                Op::ReplaceText { slide, element, .. } => {
                    named_slides.push(slide.as_str());
                    if let Some(e) = element {
                        named_element = Some((slide, e));
                    }
                }
                _ => {}
            }
            for sid in named_slides {
                if before.visible.contains(sid) && !live.visible.contains(sid) {
                    return Err(DeckError::slide_not_found(sid));
                }
            }
            if let Some((sid, eid)) = named_element {
                let key = (sid.clone(), eid.clone());
                if before.elements.contains(&key) && !live.visible_elements.contains(&key) {
                    return Err(DeckError::element_not_found(sid, eid));
                }
            }
            let r = roots(&scratch);
            {
                let mut txn = scratch.transact_mut();
                apply_op(&mut txn, &r, op, &mut outcome)?;
            }
            let after = inventory(&scratch);
            let exists = |name: String| {
                DeckError::new(
                    "id_exists",
                    format!("`{name}` was created after the base version."),
                    "Pull the current deck and make the edit against its version.",
                )
            };
            for sid in after.slides.difference(&before.slides) {
                if live.slides.contains(sid) {
                    return Err(exists(sid.clone()));
                }
            }
            for (sid, eid) in after.elements.difference(&before.elements) {
                if live.elements.iter().any(|(_, e)| e == eid) {
                    return Err(exists(format!("{sid}/{eid}")));
                }
            }
            for cell in after.cells.difference(&before.cells) {
                if live.cells.contains(cell) {
                    return Err(exists(format!("{}/{}/{}", cell.0, cell.1, cell.2)));
                }
            }
            let old_elements = json_elements(&old_json);
            let new_elements = json_elements(&crate::doc_to_json(&scratch));
            for (key, new) in &new_elements {
                if let Some(old) = old_elements.get(key) {
                    if new != old && !live.visible_elements.contains(key) {
                        return Err(DeckError::element_not_found(&key.0, &key.1));
                    }
                    if new["kind"] == "table" {
                        for (ri, row) in new["cells"].as_array().into_iter().flatten().enumerate() {
                            for (ci, cell) in row.as_array().into_iter().flatten().enumerate() {
                                let coordinate = format!("{ri}:{ci}");
                                let ck = (key.0.clone(), key.1.clone(), coordinate.clone());
                                let named = matches!(op,Op::ReplaceText{field:Some(f),..} if f==&format!("cell:{coordinate}"));
                                let explicit_grid = matches!(op,Op::UpdateElement{slide,element,set} if slide==&key.0 && element==&key.1 && set.contains_key("cells"));
                                if before.cells.contains(&ck)
                                    && !live.cells.contains(&ck)
                                    && (named
                                        || explicit_grid
                                        || old["cells"].get(ri).and_then(|r| r.get(ci))
                                            != Some(cell))
                                {
                                    return Err(DeckError::new(
                                        "cell_not_found",
                                        format!(
                                            "Cell `{coordinate}` in `{}` was deleted after the base version.",
                                            key.1
                                        ),
                                        "Pull the current deck before changing this cell.",
                                    ));
                                }
                            }
                        }
                    }
                }
            }
            for sid in before.slides.difference(&after.slides) {
                live.slides.remove(sid);
                live.visible.remove(sid);
            }
            for sid in after.slides.difference(&before.slides) {
                live.slides.insert(sid.clone());
                live.visible.insert(sid.clone());
            }
            for key in before.elements.difference(&after.elements) {
                live.elements.remove(key);
                live.visible_elements.remove(key);
            }
            for key in after.elements.difference(&before.elements) {
                live.elements.insert(key.clone());
                live.visible_elements.insert(key.clone());
            }
            for key in before.cells.difference(&after.cells) {
                live.cells.remove(key);
            }
            for key in after.cells.difference(&before.cells) {
                live.cells.insert(key.clone());
            }
            Ok(())
        })();
        checked.map_err(|e| e.at(index))?;
    }
    Ok((scratch.transact().encode_state_as_update_v1(&sv), outcome))
}
