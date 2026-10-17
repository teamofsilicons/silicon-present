//! Reconcile: make a live document equal a target deck with minimal changes (restore a version, undo a
//! Carbon's or Silicon's changes, open a file on top of a deck). Text changes go through character diffs and
//! slide/element order through a longest-common-subsequence, so concurrent work elsewhere survives.

use std::collections::HashSet;

use serde_json::{Map, Value};
use yrs::updates::decoder::Decode;
use yrs::{Any, ArrayRef, Doc, Map as YMap, MapRef, Out, ReadTxn, Transact, TransactionMut, Update};

use crate::convert::{element_ids, put_plain, read_id_list, roots, slide_ids, write_element, write_slide, Roots, MASTER_KEY};
use crate::error::DeckError;
use crate::normalize::{normalize_deck, y_fields};
use crate::ops::{
    child_array, child_map, child_text, insert_after, plain_differs, remove_all, set_cells,
};
use crate::richtext::{normalize_rich, set_plain, set_rich};

/// How much of the deck to reconcile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    /// The whole deck: size, theme, master, every slide and their order.
    Deck,
    /// One slide (or `master`). Brought back if it is gone, removed if the target doesn't have it.
    Slide(String),
    /// One element. Brought back if it is gone (with its slide, when the slide is gone too), removed if the
    /// target doesn't have it.
    Element { slide: String, element: String },
}

pub(crate) fn apply_update_bytes(doc: &Doc, update: &[u8]) -> Result<(), DeckError> {
    let u = Update::decode_v1(update)
        .map_err(|e| DeckError::new("invalid_update", format!("A Yjs update could not be decoded: {e}."), "Resend the update."))?;
    doc.transact_mut()
        .apply_update(u)
        .map_err(|e| DeckError::new("invalid_update", format!("A Yjs update could not be applied: {e}."), "Resend the update."))
}

/// Reconciles a copy of `doc` and returns the Yjs update that does it, without changing `doc`.
pub fn reconcile_update(doc: &Doc, target: &Value, scope: &Scope) -> Result<Vec<u8>, DeckError> {
    let scratch = crate::clone_doc(doc);
    let sv = scratch.transact().state_vector();
    reconcile(&scratch, target, scope)?;
    Ok(scratch.transact().encode_state_as_update_v1(&sv))
}

/// Makes `doc` equal `target` (deck JSON) within `scope`, in one transaction.
pub fn reconcile(doc: &Doc, target: &Value, scope: &Scope) -> Result<(), DeckError> {
    let target = normalize_deck(target)?;
    let r = roots(doc);
    let mut txn = doc.transact_mut();
    let find_slide = |id: &str| -> Option<&Value> {
        if id == MASTER_KEY {
            return target.get("master");
        }
        target["slides"].as_array().into_iter().flatten().find(|s| s["id"].as_str() == Some(id))
    };
    match scope {
        Scope::Deck => {
            for key in ["size", "theme"] {
                if plain_differs(&txn, &r.deck, key, &target[key]) {
                    put_plain(&mut txn, &r.deck, key, &target[key]);
                }
            }
            reconcile_slide_by_id(&mut txn, &r, MASTER_KEY, &target["master"], &target)?;
            let target_ids: Vec<String> =
                target["slides"].as_array().into_iter().flatten().filter_map(|s| s["id"].as_str().map(String::from)).collect();
            let wanted: HashSet<&String> = target_ids.iter().collect();
            for id in slide_ids(&txn, &r) {
                if !wanted.contains(&id) {
                    remove_all(&mut txn, &r.order, &id);
                    r.slides.remove(&mut txn, &id);
                }
            }
            for slide in target["slides"].as_array().into_iter().flatten() {
                let id = slide["id"].as_str().unwrap_or_default();
                match r.slides.get(&txn, id) {
                    Some(Out::YMap(m)) => reconcile_slide(&mut txn, &m, slide, false),
                    _ => {
                        write_slide(&mut txn, &r.slides, id, slide, false);
                    }
                }
            }
            reorder_ids(&mut txn, &r.order, &target_ids);
        }
        Scope::Slide(id) => {
            let in_live = id == MASTER_KEY || slide_ids(&txn, &r).contains(id);
            match (find_slide(id), in_live) {
                (Some(t), _) => reconcile_slide_by_id(&mut txn, &r, id, t, &target)?,
                (None, true) => {
                    remove_all(&mut txn, &r.order, id);
                    r.slides.remove(&mut txn, id);
                }
                (None, false) => {
                    return Err(DeckError::new(
                        "slide_not_found",
                        format!("Slide `{id}` exists neither now nor in the version to restore from."),
                        "List the slide ids with `present read --version N`.",
                    ));
                }
            }
        }
        Scope::Element { slide, element } => {
            let target_slide = find_slide(slide);
            let target_el = target_slide.and_then(|s| {
                s["elements"].as_array().into_iter().flatten().find(|e| e["id"].as_str() == Some(element.as_str()))
            });
            let live_slide = if slide == MASTER_KEY || slide_ids(&txn, &r).contains(slide) {
                match r.slides.get(&txn, slide) {
                    Some(Out::YMap(m)) => Some(m),
                    _ => None,
                }
            } else {
                None
            };
            match (live_slide, target_el) {
                (None, Some(_)) => {
                    // Decision: the element's slide is gone too, so the slide comes back as it was in the target.
                    reconcile_slide_by_id(&mut txn, &r, slide, target_slide.unwrap_or(&Value::Null), &target)?;
                }
                (None, None) => {
                    return Err(DeckError::new(
                        "element_not_found",
                        format!("Element `{element}` on slide `{slide}` exists neither now nor in the version to restore from."),
                        "List the element ids with `present read --version N`.",
                    ));
                }
                (Some(m), Some(t)) => {
                    let elements = child_map(&mut txn, &m, "elements");
                    let exists = matches!(elements.get(&txn, element), Some(Out::YMap(_)));
                    if exists {
                        reconcile_element_in(&mut txn, &elements, t);
                    } else {
                        write_element(&mut txn, &elements, t);
                        let target_order: Vec<String> = target_slide
                            .map(|s| s["elements"].as_array().into_iter().flatten().filter_map(|e| e["id"].as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        let live = element_ids(&txn, &m);
                        let order = child_array(&mut txn, &m, "elementOrder");
                        remove_all(&mut txn, &order, element);
                        let prev = previous_present(&target_order, element, &live);
                        insert_after(&mut txn, &order, prev.as_deref(), element);
                    }
                }
                (Some(m), None) => {
                    if let Some(Out::YMap(em)) = m.get(&txn, "elements") {
                        em.remove(&mut txn, element);
                    }
                    if let Some(Out::YArray(order)) = m.get(&txn, "elementOrder") {
                        remove_all(&mut txn, &order, element);
                    }
                }
            }
        }
    }
    Ok(())
}

/// The id before `id` in `target_order` that also exists in `live`, walking back.
fn previous_present(target_order: &[String], id: &str, live: &[String]) -> Option<String> {
    let pos = target_order.iter().position(|x| x == id)?;
    target_order[..pos].iter().rev().find(|x| live.contains(x)).cloned()
}

fn reconcile_slide_by_id(txn: &mut TransactionMut, r: &Roots, id: &str, target: &Value, deck: &Value) -> Result<(), DeckError> {
    let master = id == MASTER_KEY;
    let live_ids = slide_ids(txn, r);
    let exists = master || live_ids.iter().any(|s| s == id);
    match r.slides.get(txn, id) {
        Some(Out::YMap(m)) if exists => reconcile_slide(txn, &m, target, master),
        _ => {
            write_slide(txn, &r.slides, id, target, master);
            if !master {
                let target_order: Vec<String> =
                    deck["slides"].as_array().into_iter().flatten().filter_map(|s| s["id"].as_str().map(String::from)).collect();
                remove_all(txn, &r.order, id);
                let prev = previous_present(&target_order, id, &live_ids);
                insert_after(txn, &r.order, prev.as_deref(), id);
            }
        }
    }
    Ok(())
}

const SLIDE_Y_KEYS: [&str; 4] = ["notes", "elements", "elementOrder", "id"];

fn reconcile_slide(txn: &mut TransactionMut, m: &MapRef, target: &Value, master: bool) {
    if !master {
        let t = target.as_object().cloned().unwrap_or_default();
        for (k, v) in &t {
            match k.as_str() {
                "id" | "elements" => {}
                "notes" => {
                    let text = child_text(txn, m, "notes");
                    set_plain(txn, &text, v.as_str().unwrap_or(""));
                }
                _ => {
                    if plain_differs(txn, m, k, v) {
                        put_plain(txn, m, k, v);
                    }
                }
            }
        }
        let stale: Vec<String> =
            m.keys(txn).filter(|k| !t.contains_key(*k) && !SLIDE_Y_KEYS.contains(k)).map(String::from).collect();
        for k in stale {
            m.remove(txn, &k);
        }
    }
    let elements = child_map(txn, m, "elements");
    let target_els: Vec<&Value> = target["elements"].as_array().into_iter().flatten().collect();
    let target_ids: Vec<String> = target_els.iter().filter_map(|e| e["id"].as_str().map(String::from)).collect();
    let wanted: HashSet<&String> = target_ids.iter().collect();
    let live: Vec<String> = elements.keys(txn).map(String::from).collect();
    for id in &live {
        if !wanted.contains(id) {
            elements.remove(txn, id);
        }
    }
    for el in &target_els {
        reconcile_element_in(txn, &elements, el);
    }
    let order = child_array(txn, m, "elementOrder");
    // Drop ids of elements that no longer exist, then fix the order.
    for id in read_id_list(txn, &order) {
        if !wanted.contains(&id) {
            remove_all(txn, &order, &id);
        }
    }
    reorder_ids(txn, &order, &target_ids);
}

/// Reconciles (or creates) one element inside an `elements` map.
fn reconcile_element_in(txn: &mut TransactionMut, elements: &MapRef, target: &Value) {
    let id = target["id"].as_str().unwrap_or_default();
    let kind = target["kind"].as_str().unwrap_or_default();
    let el = match elements.get(txn, id) {
        Some(Out::YMap(m)) => {
            let live_kind = match m.get(txn, "kind") {
                Some(Out::Any(Any::String(s))) => s.to_string(),
                _ => String::new(),
            };
            if live_kind != kind {
                write_element(txn, elements, target);
                return;
            }
            m
        }
        _ => {
            write_element(txn, elements, target);
            return;
        }
    };
    reconcile_element(txn, &el, kind, target.as_object().cloned().unwrap_or_default());
}

fn reconcile_element(txn: &mut TransactionMut, el: &MapRef, kind: &str, t: Map<String, Value>) {
    for (k, v) in &t {
        if y_fields(kind).contains(&k.as_str()) {
            match k.as_str() {
                "text" => {
                    let text = child_text(txn, el, "text");
                    set_rich(txn, &text, &normalize_rich(v));
                }
                "cells" => set_cells(txn, el, v),
                _ => {
                    let text = child_text(txn, el, k);
                    set_plain(txn, &text, v.as_str().unwrap_or(""));
                }
            }
        } else if plain_differs(txn, el, k, v) {
            put_plain(txn, el, k, v);
        }
    }
    let stale: Vec<String> = el.keys(txn).filter(|k| !t.contains_key(*k)).map(String::from).collect();
    for k in stale {
        el.remove(txn, &k);
    }
}

/// Makes an id array read as `target` (ids not in `target` must already be gone), moving as few ids as possible:
/// the longest common subsequence stays put and everything else is re-inserted after its target predecessor.
pub(crate) fn reorder_ids(txn: &mut TransactionMut, arr: &ArrayRef, target: &[String]) {
    let current: Vec<String> = read_id_list(txn, arr).into_iter().filter(|id| target.contains(id)).collect();
    if current == target {
        return;
    }
    let keep = lcs(&current, target);
    for id in &current {
        if !keep.contains(id) {
            remove_all(txn, arr, id);
        }
    }
    let mut prev: Option<&String> = None;
    for id in target {
        if !keep.contains(id) {
            remove_all(txn, arr, id);
            insert_after(txn, arr, prev.map(String::as_str), id);
        }
        prev = Some(id);
    }
}

fn lcs(a: &[String], b: &[String]) -> HashSet<String> {
    let (n, m) = (a.len(), b.len());
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] { dp[i + 1][j + 1] + 1 } else { dp[i + 1][j].max(dp[i][j + 1]) };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut out = HashSet::new();
    while i < n && j < m {
        if a[i] == b[j] {
            out.insert(a[i].clone());
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}
