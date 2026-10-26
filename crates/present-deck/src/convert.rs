//! Deck JSON ⇄ the deck's Yjs document, laid out exactly as `docs/architecture.md` says.

use serde_json::{Map, Value, json};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Array, ArrayPrelim, ArrayRef, Doc, In, Map as YMap, MapPrelim, MapRef, OffsetKind,
    Options, Out, ReadTxn, StateVector, TextPrelim, TextRef, Transact, TransactionMut, Update,
};

use crate::anyconv::{any_to_json, json_to_any};
use crate::error::DeckError;
use crate::normalize::{normalize_deck, normalize_element, normalize_slide, y_fields};
use crate::richtext::{read_rich, write_rich};

/// The key of the master slide in the `slides` map. It is never in `order`.
pub const MASTER_KEY: &str = "master";

/// What the deck JSON carries that isn't in the document: id, title (from the decks table) and the version (the
/// update sequence number the JSON was read at).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeckMeta {
    pub id: String,
    pub title: String,
    pub version: i64,
}

impl DeckMeta {
    /// Adds `id`, `title` and `version` to deck JSON from `doc_to_json`.
    pub fn attach(&self, mut deck: Value) -> Value {
        if let Value::Object(m) = &mut deck {
            m.insert("id".into(), json!(self.id));
            m.insert("title".into(), json!(self.title));
            m.insert("version".into(), json!(self.version));
        }
        deck
    }
}

/// A new, empty document using UTF-16 offsets (like Yjs in the browser) and a random client id.
pub fn new_doc() -> Doc {
    Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}

pub(crate) struct Roots {
    pub deck: MapRef,
    pub order: ArrayRef,
    pub slides: MapRef,
}

pub(crate) fn roots(doc: &Doc) -> Roots {
    Roots {
        deck: doc.get_or_insert_map("deck"),
        order: doc.get_or_insert_array("order"),
        slides: doc.get_or_insert_map("slides"),
    }
}

/// Full state of a document as one Yjs v1 update.
pub fn encode_doc(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

/// A document from one Yjs v1 update (e.g. a snapshot).
pub fn decode_doc(bytes: &[u8]) -> Result<Doc, DeckError> {
    doc_from_updates([bytes])
}

/// A document from a series of Yjs v1 updates, applied in order.
pub fn doc_from_updates<'a, I: IntoIterator<Item = &'a [u8]>>(
    updates: I,
) -> Result<Doc, DeckError> {
    let doc = new_doc();
    let _ = roots(&doc);
    {
        let mut txn = doc.transact_mut();
        for bytes in updates {
            let update = Update::decode_v1(bytes).map_err(|e| {
                DeckError::new(
                    "invalid_update",
                    format!("A Yjs update could not be decoded: {e}."),
                    "Send updates encoded with Yjs v1 encoding (Y.encodeStateAsUpdate / encodeStateAsUpdate_v1).",
                )
            })?;
            txn.apply_update(update).map_err(|e| {
                DeckError::new(
                    "invalid_update",
                    format!("A Yjs update could not be applied: {e}."),
                    "Resend the update.",
                )
            })?;
        }
    }
    Ok(doc)
}

pub(crate) fn put_plain(txn: &mut TransactionMut, map: &MapRef, key: &str, value: &Value) {
    map.insert(txn, key, In::Any(json_to_any(value)));
}

pub(crate) fn put_text(txn: &mut TransactionMut, map: &MapRef, key: &str, s: &str) -> TextRef {
    map.insert(txn, key, TextPrelim::new(s))
}

pub(crate) fn put_rich(txn: &mut TransactionMut, map: &MapRef, key: &str, rich: &Value) -> TextRef {
    let t = map.insert(txn, key, TextPrelim::new(""));
    write_rich(txn, &t, rich);
    t
}

pub(crate) fn write_cells(txn: &mut TransactionMut, el: &MapRef, cells: &Value) {
    let cm: MapRef = el.insert(txn, "cells", MapPrelim::default());
    for (r, row) in cells.as_array().into_iter().flatten().enumerate() {
        for (c, cell) in row.as_array().into_iter().flatten().enumerate() {
            write_cell(txn, &cm, &format!("{r}:{c}"), cell);
        }
    }
}

pub(crate) fn write_cell(txn: &mut TransactionMut, cells: &MapRef, key: &str, cell: &Value) {
    let m: MapRef = cells.insert(txn, key, MapPrelim::default());
    put_rich(txn, &m, "text", &cell["text"]);
    put_plain(txn, &m, "fill", &cell["fill"]);
}

/// Writes a canonical element into `elements` under its id.
pub(crate) fn write_element(txn: &mut TransactionMut, elements: &MapRef, el: &Value) -> MapRef {
    let id = el["id"].as_str().unwrap_or_default().to_string();
    let kind = el["kind"].as_str().unwrap_or_default().to_string();
    let m: MapRef = elements.insert(txn, id.as_str(), MapPrelim::default());
    for (k, v) in el.as_object().into_iter().flatten() {
        if y_fields(&kind).contains(&k.as_str()) {
            match k.as_str() {
                "text" => {
                    put_rich(txn, &m, "text", v);
                }
                "cells" => write_cells(txn, &m, v),
                _ => {
                    put_text(txn, &m, k, v.as_str().unwrap_or(""));
                }
            }
        } else {
            put_plain(txn, &m, k, v);
        }
    }
    m
}

/// Writes a canonical slide into `slides` under `key` (its id, or `master`).
pub(crate) fn write_slide(
    txn: &mut TransactionMut,
    slides: &MapRef,
    key: &str,
    slide: &Value,
    master: bool,
) -> MapRef {
    let m: MapRef = slides.insert(txn, key, MapPrelim::default());
    if master {
        put_plain(txn, &m, "id", &json!(MASTER_KEY));
    } else {
        for (k, v) in slide.as_object().into_iter().flatten() {
            match k.as_str() {
                "elements" => {}
                "notes" => {
                    put_text(txn, &m, "notes", v.as_str().unwrap_or(""));
                }
                _ => put_plain(txn, &m, k, v),
            }
        }
    }
    let order: ArrayRef = m.insert(txn, "elementOrder", ArrayPrelim::default());
    let elements: MapRef = m.insert(txn, "elements", MapPrelim::default());
    for el in slide["elements"].as_array().into_iter().flatten() {
        order.push_back(txn, el["id"].as_str().unwrap_or_default());
        write_element(txn, &elements, el);
    }
    m
}

/// Writes a whole canonical deck into an empty document.
pub fn write_deck(doc: &Doc, deck: &Value) -> Result<(), DeckError> {
    crate::validate::deck(deck)?;
    let deck = normalize_deck(deck)?;
    let r = roots(doc);
    let mut txn = doc.transact_mut();
    put_plain(&mut txn, &r.deck, "size", &deck["size"]);
    put_plain(&mut txn, &r.deck, "theme", &deck["theme"]);
    put_plain(&mut txn, &r.deck, "version", &json!(1));
    write_slide(&mut txn, &r.slides, MASTER_KEY, &deck["master"], true);
    for slide in deck["slides"].as_array().into_iter().flatten() {
        let id = slide["id"].as_str().unwrap_or_default().to_string();
        r.order.push_back(&mut txn, id.as_str());
        write_slide(&mut txn, &r.slides, &id, slide, false);
    }
    Ok(())
}

/// A new document holding this deck.
pub fn json_to_doc(deck: &Value) -> Result<Doc, DeckError> {
    let doc = new_doc();
    write_deck(&doc, deck)?;
    Ok(doc)
}

pub(crate) fn read_text_plain<T: ReadTxn>(txn: &T, out: &Out) -> String {
    match out {
        Out::YText(t) => yrs::GetString::get_string(t, txn),
        Out::Any(a) => crate::normalize::string_value(&any_to_json(a)).unwrap_or_default(),
        _ => String::new(),
    }
}

pub(crate) fn read_cells<T: ReadTxn>(txn: &T, cells: &MapRef, rows: usize, cols: usize) -> Value {
    let mut grid = Vec::with_capacity(rows);
    for r in 0..rows {
        let mut row = Vec::with_capacity(cols);
        for c in 0..cols {
            let cell = match cells.get(txn, &format!("{r}:{c}")) {
                Some(Out::YMap(m)) => {
                    let text = match m.get(txn, "text") {
                        Some(Out::YText(t)) => read_rich(txn, &t),
                        Some(Out::Any(a @ (Any::String(_) | Any::Number(_)))) => {
                            crate::richtext::normalize_rich(&any_to_json(&a))
                        }
                        _ => json!({ "paragraphs": [] }),
                    };
                    let fill = match m.get(txn, "fill") {
                        Some(Out::Any(a)) => any_to_json(&a),
                        _ => Value::Null,
                    };
                    json!({ "text": text, "fill": fill })
                }
                _ => json!({ "text": { "paragraphs": [] }, "fill": null }),
            };
            row.push(cell);
        }
        grid.push(Value::Array(row));
    }
    Value::Array(grid)
}

/// Reads one element map as canonical element JSON. The map key is the element's id.
pub(crate) fn read_element<T: ReadTxn>(txn: &T, id: &str, m: &MapRef) -> Value {
    let mut out = Map::new();
    let mut cells: Option<MapRef> = None;
    for (k, v) in m.iter(txn) {
        match (k, v) {
            ("cells", Out::YMap(cm)) => cells = Some(cm),
            ("cells", _) => {}
            ("text", Out::YText(t)) => {
                out.insert("text".into(), read_rich(txn, &t));
            }
            (k @ ("html" | "css" | "js"), Out::YText(t)) => {
                out.insert(
                    k.to_string(),
                    Value::String(yrs::GetString::get_string(&t, txn)),
                );
            }
            ("text", Out::Any(a)) => {
                let v = any_to_json(&a);
                out.insert(
                    "text".into(),
                    if v.is_string() || v.is_number() {
                        crate::richtext::normalize_rich(&v)
                    } else {
                        json!({"paragraphs":[]})
                    },
                );
            }
            (k, Out::Any(a)) => {
                out.insert(k.to_string(), any_to_json(&a));
            }
            _ => {}
        }
    }
    out.insert("id".into(), Value::String(id.to_string()));
    if let Some(cm) = cells {
        let dimension = |name: &str, index: usize| {
            out.get(name)
                .and_then(crate::normalize::number)
                .filter(|n| n.fract() == 0.0 && (1.0..=100.0).contains(n))
                .map(|n| n as usize)
                .unwrap_or_else(|| {
                    cm.keys(txn)
                        .filter_map(|k| {
                            cell_coordinates(k).map(|p| if index == 0 { p.0 } else { p.1 })
                        })
                        .max()
                        .map(|n| n.saturating_add(1).min(100))
                        .unwrap_or(2)
                })
        };
        let rows = dimension("rows", 0);
        let cols = dimension("cols", 1);
        out.insert("rows".into(), json!(rows));
        out.insert("cols".into(), json!(cols));
        out.insert("cells".into(), read_cells(txn, &cm, rows, cols));
    }
    let v = Value::Object(out);
    normalize_element(&v).unwrap_or(Value::Null)
}

/// The ordered ids of an array of strings, without duplicates (concurrent moves can leave one).
pub(crate) fn read_id_list<T: ReadTxn>(txn: &T, arr: &ArrayRef) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for v in arr.iter(txn) {
        if let Out::Any(Any::String(s)) = v
            && seen.insert(s.to_string())
        {
            out.push(s.to_string());
        }
    }
    out
}

/// The element ids of a slide map in z order (back to front): the ids in `elementOrder` that exist in
/// `elements`. An element missing from `elementOrder` is not on the slide (like `packages/deck`).
pub(crate) fn element_ids<T: ReadTxn>(txn: &T, slide: &MapRef) -> Vec<String> {
    let elements = match slide.get(txn, "elements") {
        Some(Out::YMap(m)) => m,
        _ => return Vec::new(),
    };
    let mut ids: Vec<String> = match slide.get(txn, "elementOrder") {
        Some(Out::YArray(a)) => read_id_list(txn, &a),
        _ => Vec::new(),
    };
    ids.retain(|id| matches!(elements.get(txn,id),Some(Out::YMap(ref m)) if matches!(m.get(txn,"kind"),Some(Out::Any(Any::String(ref s))) if crate::normalize::KINDS.contains(&s.as_ref()))));
    ids
}

pub(crate) fn read_slide<T: ReadTxn>(txn: &T, id: &str, m: &MapRef, master: bool) -> Value {
    let mut out = Map::new();
    if !master {
        for (k, v) in m.iter(txn) {
            match k {
                "elements" | "elementOrder" => {}
                "notes" => {
                    out.insert("notes".into(), Value::String(read_text_plain(txn, &v)));
                }
                _ => {
                    if let Out::Any(a) = v {
                        out.insert(k.to_string(), any_to_json(&a));
                    }
                }
            }
        }
        out.insert("id".into(), Value::String(id.to_string()));
    }
    let mut elements = Vec::new();
    if let Some(Out::YMap(em)) = m.get(txn, "elements") {
        for eid in element_ids(txn, m) {
            if let Some(Out::YMap(e)) = em.get(txn, &eid) {
                elements.push(read_element(txn, &eid, &e));
            }
        }
    }
    out.insert("elements".into(), Value::Array(elements));
    if master {
        return Value::Object(out);
    }
    let v = Value::Object(out);
    normalize_slide(&v).unwrap_or(v)
}

/// The slide ids in `order` that exist in `slides`, without duplicates.
pub(crate) fn slide_ids<T: ReadTxn>(txn: &T, r: &Roots) -> Vec<String> {
    let mut ids = read_id_list(txn, &r.order);
    ids.retain(|id| id != MASTER_KEY && matches!(r.slides.get(txn, id), Some(Out::YMap(_))));
    ids
}

/// Reads the document as canonical deck JSON (without `id`, `title` and `version`; see [`DeckMeta::attach`]).
///
/// Slides that are in `slides` but not in `order` are not part of the deck and are left out.
pub fn doc_to_json(doc: &Doc) -> Value {
    let txn = doc.transact();
    let deck = txn.get_map("deck");
    let slides_map = txn.get_map("slides");
    let order = txn.get_array("order");
    let plain = |key: &str| {
        deck.as_ref()
            .and_then(|d| d.get(&txn, key))
            .and_then(|v| {
                if let Out::Any(a) = v {
                    Some(any_to_json(&a))
                } else {
                    None
                }
            })
            .unwrap_or(Value::Null)
    };
    let master = slides_map
        .as_ref()
        .and_then(|m| m.get(&txn, MASTER_KEY))
        .and_then(|v| {
            if let Out::YMap(m) = v {
                Some(read_slide(&txn, MASTER_KEY, &m, true))
            } else {
                None
            }
        })
        .unwrap_or_else(|| json!({"elements":[]}));
    let mut slides = Vec::new();
    if let (Some(sm), Some(order)) = (slides_map, order) {
        for id in read_id_list(&txn, &order) {
            if id != MASTER_KEY {
                if let Some(Out::YMap(m)) = sm.get(&txn, &id) {
                    slides.push(read_slide(&txn, &id, &m, false));
                }
            }
        }
    }
    normalize_deck(
        &json!({"size":plain("size"),"theme":plain("theme"),"master":master,"slides":slides}),
    )
    .expect("reader normalization cannot fail")
}

/// Canonical zero-based cell coordinates (no leading zeroes).
pub(crate) fn cell_coordinates(key: &str) -> Option<(usize, usize)> {
    let (r, c) = key.split_once(':')?;
    let parse = |s: &str| -> Option<usize> {
        if s.is_empty()
            || (s.len() > 1 && s.starts_with('0'))
            || !s.bytes().all(|b| b.is_ascii_digit())
        {
            None
        } else {
            s.parse().ok()
        }
    };
    Some((parse(r)?, parse(c)?))
}
