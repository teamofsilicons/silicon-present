//! Turns two copies of a deck into the edit ops that change one into the other.
//!
//! This is what `present push` sends: the deck as it was pulled (`base`) against the deck as the
//! folder holds it now (`local`). Only what differs becomes an op, so the service can merge the
//! change with anything others did since the pull.
//!
//! Rules (documented for Silicons in `present docs pull`):
//! - Slides and elements are matched by id. One without an id (or with an id the base doesn't
//!   have) is new and gets added; one missing from `local` is deleted.
//! - A field present in `local` that differs from `base` is set. A field missing from `local`
//!   is left alone; set it to `null` to clear it.
//! - Text written as a plain string is turned into rich text (one paragraph per line) first.
//! - Order follows `local`: the fewest slide moves (longest increasing subsequence), and
//!   elements are put at their position back to front.

use crate::deck::{new_element_id, new_slide_id, rich_text};
use crate::ops::{Op, ZTarget};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

/// Slide fields an `update_slide` op can set.
pub const SLIDE_FIELDS: [&str; 7] = [
    "layout",
    "background",
    "skipped",
    "section",
    "hideMaster",
    "transition",
    "notes",
];

/// Element fields that hold rich text.
const RICH_FIELDS: [&str; 1] = ["text"];

/// Fills ids that are missing and turns plain-string text into rich text, in place. Run this on
/// the local copy before [`ops_between`] so new slides and elements keep stable ids.
pub fn prepare_local(deck: &mut Value) {
    if let Some(slides) = deck.get_mut("slides").and_then(Value::as_array_mut) {
        for slide in slides {
            if let Some(obj) = slide.as_object_mut() {
                if !obj.get("id").is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty())) {
                    obj.insert("id".into(), Value::String(new_slide_id()));
                }
                prepare_elements(obj);
            }
        }
    }
    if let Some(master) = deck.get_mut("master").and_then(Value::as_object_mut) {
        prepare_elements(master);
    }
}

fn prepare_elements(slide: &mut Map<String, Value>) {
    if let Some(Value::Array(elements)) = slide.get_mut("elements") {
        for el in elements {
            prepare_element(el);
        }
    }
}

/// Fills a missing id and turns plain-string rich fields (and table cell strings) into rich text.
pub fn prepare_element(el: &mut Value) {
    let Some(obj) = el.as_object_mut() else { return };
    if !obj.get("id").is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty())) {
        obj.insert("id".into(), Value::String(new_element_id()));
    }
    for f in RICH_FIELDS {
        if let Some(Value::String(s)) = obj.get(f) {
            let r = rich_text(s);
            obj.insert(f.into(), r);
        }
    }
    if let Some(Value::Array(rows)) = obj.get_mut("cells") {
        for row in rows {
            if let Value::Array(cells) = row {
                for cell in cells {
                    match cell {
                        Value::String(s) => {
                            *cell = serde_json::json!({ "text": rich_text(s), "fill": null });
                        }
                        Value::Object(c) => {
                            if let Some(Value::String(s)) = c.get("text") {
                                let r = rich_text(s);
                                c.insert("text".into(), r);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

/// Like [`prepare_local`], but text written as a plain string over an element that already
/// exists in `base` keeps that element's look: the first paragraph's attributes (heading, list,
/// align) and the first run's (size, bold, colour, font).
pub fn prepare_against(base: &Value, local: &mut Value) {
    // element id -> (first run's attributes, first paragraph's attributes)
    type Look = (Map<String, Value>, Map<String, Value>);
    let mut styles: HashMap<String, Look> = HashMap::new();
    let mut collect = |slide: &Value| {
        for e in list(slide, "elements") {
            if let (Some(id), Some(p)) = (e.get("id").and_then(Value::as_str), e.pointer("/text/paragraphs/0").and_then(Value::as_object)) {
                let mut para = p.clone();
                para.remove("runs");
                let mut run = p.get("runs").and_then(|r| r.get(0)).and_then(Value::as_object).cloned().unwrap_or_default();
                run.remove("text");
                styles.insert(id.to_owned(), (run, para));
            }
        }
    };
    list(base, "slides").iter().for_each(&mut collect);
    if let Some(m) = base.get("master") {
        collect(m);
    }
    let mut restyle = |slide: &mut Value| {
        if let Some(els) = slide.get_mut("elements").and_then(Value::as_array_mut) {
            for e in els {
                let id = e.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
                if let (Some(Value::String(t)), Some((run, para))) = (e.get("text").cloned(), styles.get(&id)) {
                    e["text"] = crate::deck::rich_text_styled(&t, run, para);
                }
            }
        }
    };
    if let Some(slides) = local.get_mut("slides").and_then(Value::as_array_mut) {
        slides.iter_mut().for_each(&mut restyle);
    }
    if let Some(m) = local.get_mut("master") {
        restyle(m);
    }
    prepare_local(local);
}

/// The ops that turn `base` into `local`. Call [`prepare_local`] on `local` first.
pub fn ops_between(base: &Value, local: &Value) -> Vec<Op> {
    let mut ops = Vec::new();

    // Deck-level plain values.
    let mut set = Map::new();
    for key in ["size", "theme"] {
        if let Some(v) = local.get(key)
            && base.get(key) != Some(v)
        {
            set.insert(key.into(), v.clone());
        }
    }
    if !set.is_empty() {
        ops.push(Op::UpdateDeck { set });
    }

    // Master elements.
    let empty = Value::Null;
    elements_ops(
        "master",
        base.get("master").unwrap_or(&empty),
        local.get("master").unwrap_or(&empty),
        &mut ops,
    );

    let base_slides = list(base, "slides");
    let local_slides = list(local, "slides");
    let base_by_id: HashMap<&str, &Value> = base_slides
        .iter()
        .filter_map(|s| Some((s.get("id")?.as_str()?, s)))
        .collect();
    let local_ids: Vec<&str> = local_slides
        .iter()
        .filter_map(|s| s.get("id").and_then(Value::as_str))
        .collect();
    let local_set: HashSet<&str> = local_ids.iter().copied().collect();

    // Deletions first.
    for s in base_slides {
        if let Some(id) = s.get("id").and_then(Value::as_str)
            && !local_set.contains(id)
        {
            ops.push(Op::DeleteSlide { slide: id.into() });
        }
    }

    // Order: keep the longest run of slides that are already in base order, move the rest.
    let base_pos: HashMap<&str, usize> = base_slides
        .iter()
        .enumerate()
        .filter_map(|(i, s)| Some((s.get("id")?.as_str()?, i)))
        .collect();
    let common: Vec<(&str, usize)> = local_ids
        .iter()
        .filter_map(|id| base_pos.get(id).map(|p| (*id, *p)))
        .collect();
    let stable: HashSet<&str> = lis(&common.iter().map(|(_, p)| *p).collect::<Vec<_>>())
        .into_iter()
        .map(|i| common[i].0)
        .collect();

    let mut prev: Option<String> = None;
    for slide in local_slides {
        let Some(id) = slide.get("id").and_then(Value::as_str) else { continue };
        match base_by_id.get(id) {
            None => ops.push(Op::AddSlide {
                after: prev.clone(),
                slide: slide.clone(),
            }),
            Some(base_slide) => {
                if !stable.contains(id) {
                    ops.push(Op::MoveSlide {
                        slide: id.into(),
                        after: prev.clone(),
                    });
                }
                let mut set = Map::new();
                for key in SLIDE_FIELDS {
                    if let Some(v) = slide.get(key)
                        && !same(base_slide.get(key), v)
                    {
                        set.insert(key.into(), v.clone());
                    }
                }
                if !set.is_empty() {
                    ops.push(Op::UpdateSlide {
                        slide: id.into(),
                        set,
                    });
                }
                elements_ops(id, base_slide, slide, &mut ops);
            }
        }
        prev = Some(id.to_owned());
    }
    ops
}

/// Treats a missing value and `null` alike, and `""` notes like missing notes.
fn same(base: Option<&Value>, local: &Value) -> bool {
    match base {
        Some(b) => b == local,
        None => local.is_null() || local == &Value::String(String::new()),
    }
}

fn list<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn elements_ops(slide_id: &str, base: &Value, local: &Value, ops: &mut Vec<Op>) {
    let base_els = list(base, "elements");
    let local_els = list(local, "elements");
    if local.get("elements").is_none() && slide_id == "master" {
        return; // no master in the folder: leave it alone
    }
    let base_by_id: HashMap<&str, &Value> = base_els
        .iter()
        .filter_map(|e| Some((e.get("id")?.as_str()?, e)))
        .collect();
    let local_set: HashSet<&str> = local_els
        .iter()
        .filter_map(|e| e.get("id").and_then(Value::as_str))
        .collect();

    // The z order as the service will hold it while ops apply.
    let mut order: Vec<String> = Vec::new();
    for e in base_els {
        let Some(id) = e.get("id").and_then(Value::as_str) else { continue };
        if local_set.contains(id) {
            order.push(id.into());
        } else {
            ops.push(Op::DeleteElement {
                slide: slide_id.into(),
                element: id.into(),
            });
        }
    }

    for (i, el) in local_els.iter().enumerate() {
        let Some(id) = el.get("id").and_then(Value::as_str) else { continue };
        match base_by_id.get(id) {
            None => {
                ops.push(Op::AddElement {
                    slide: slide_id.into(),
                    element: el.clone(),
                    z: Some(i as u64),
                });
                order.insert(i.min(order.len()), id.into());
            }
            Some(base_el) => {
                let mut set = Map::new();
                if let Some(obj) = el.as_object() {
                    for (k, v) in obj {
                        if k == "id" || k == "kind" {
                            continue;
                        }
                        if !same(base_el.get(k), v) {
                            set.insert(k.clone(), v.clone());
                        }
                    }
                }
                if !set.is_empty() {
                    ops.push(Op::UpdateElement {
                        slide: slide_id.into(),
                        element: id.into(),
                        set,
                    });
                }
                if order.get(i).map(String::as_str) != Some(id) {
                    if let Some(from) = order.iter().position(|o| o == id) {
                        let moved = order.remove(from);
                        order.insert(i.min(order.len()), moved);
                    }
                    ops.push(Op::ReorderElement {
                        slide: slide_id.into(),
                        element: id.into(),
                        to: ZTarget::Index(i as u64),
                    });
                }
            }
        }
    }
}

/// Indices of one longest strictly increasing subsequence.
fn lis(seq: &[usize]) -> Vec<usize> {
    let mut tails: Vec<usize> = Vec::new(); // index into seq
    let mut parent: Vec<Option<usize>> = vec![None; seq.len()];
    for i in 0..seq.len() {
        let pos = tails.partition_point(|&t| seq[t] < seq[i]);
        if pos > 0 {
            parent[i] = Some(tails[pos - 1]);
        }
        if pos == tails.len() {
            tails.push(i);
        } else {
            tails[pos] = i;
        }
    }
    let mut out = Vec::new();
    let mut cur = tails.last().copied();
    while let Some(i) = cur {
        out.push(i);
        cur = parent[i];
    }
    out.reverse();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn deck(ids: &[&str]) -> Value {
        json!({ "slides": ids.iter().map(|id| json!({"id": id, "elements": []})).collect::<Vec<_>>() })
    }

    /// Applies the slide-order ops the way the service does, to check the result.
    fn apply_order(base: &[&str], ops: &[Op]) -> Vec<String> {
        let mut order: Vec<String> = base.iter().map(|s| (*s).to_owned()).collect();
        for op in ops {
            match op {
                Op::DeleteSlide { slide } => order.retain(|s| s != slide),
                Op::AddSlide { after, slide } => {
                    let id = slide["id"].as_str().unwrap().to_owned();
                    let at = after.as_ref().map_or(0, |a| order.iter().position(|s| s == a).unwrap() + 1);
                    order.insert(at, id);
                }
                Op::MoveSlide { slide, after } => {
                    order.retain(|s| s != slide);
                    let at = after.as_ref().map_or(0, |a| order.iter().position(|s| s == a).unwrap() + 1);
                    order.insert(at, slide.clone());
                }
                _ => {}
            }
        }
        order
    }

    #[test]
    fn slide_order_changes_come_out_as_few_moves() {
        let cases: &[(&[&str], &[&str])] = &[
            (&["a", "b", "c"], &["c", "a", "b"]),
            (&["a", "b", "c"], &["b", "c", "a"]),
            (&["a", "b", "c", "d"], &["a", "x", "d", "b"]),
            (&["a", "b", "c", "d", "e"], &["e", "d", "c", "b", "a"]),
            (&["a"], &["y", "a", "z"]),
            (&["a", "b"], &[]),
        ];
        for (base, local) in cases {
            let ops = ops_between(&deck(base), &deck(local));
            assert_eq!(apply_order(base, &ops), local.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>(), "{base:?} -> {local:?}: {ops:?}");
        }
        let ops = ops_between(&deck(&["a", "b", "c"]), &deck(&["c", "a", "b"]));
        assert_eq!(ops.len(), 1);
    }

    #[test]
    fn only_changed_fields_become_ops() {
        let base = json!({"size": {"width": 1920, "height": 1080}, "slides": [
            {"id": "s_1", "layout": "title", "notes": "old", "elements": [
                {"id": "e_1", "kind": "text", "x": 10, "y": 10, "w": 100, "h": 50, "text": rich_text("Hello")},
                {"id": "e_2", "kind": "html", "x": 0, "y": 0, "w": 10, "h": 10, "html": "<p>a</p>", "css": "", "js": ""},
                {"id": "e_3", "kind": "shape", "x": 0, "y": 0, "w": 10, "h": 10}
            ]}
        ]});
        let mut local = json!({"size": {"width": 1920, "height": 1080}, "slides": [
            {"id": "s_1", "layout": "title", "notes": "new", "elements": [
                {"id": "e_1", "kind": "text", "x": 10, "y": 10, "w": 100, "h": 50, "text": "Hello there"},
                {"id": "e_2", "kind": "html", "x": 0, "y": 0, "w": 10, "h": 10, "html": "<p>b</p>", "css": "", "js": ""},
                {"kind": "text", "x": 1, "y": 1, "w": 1, "h": 1, "text": "new"}
            ]}
        ]});
        prepare_local(&mut local);
        let ops = ops_between(&base, &local);
        let kinds: Vec<String> = ops.iter().map(Op::describe).collect();
        assert_eq!(ops.len(), 5, "{kinds:#?}");
        assert!(matches!(&ops[0], Op::UpdateSlide { set, .. } if set["notes"] == "new"));
        assert!(matches!(&ops[1], Op::DeleteElement { element, .. } if element == "e_3"));
        assert!(matches!(&ops[2], Op::UpdateElement { element, set, .. } if element == "e_1" && set.len() == 1 && set["text"]["paragraphs"][0]["runs"][0]["text"] == "Hello there"));
        assert!(matches!(&ops[3], Op::UpdateElement { element, set, .. } if element == "e_2" && set.len() == 1));
        assert!(matches!(&ops[4], Op::AddElement { z: Some(2), .. }));
    }

    #[test]
    fn element_z_order_follows_the_local_list() {
        let base = json!({"slides": [{"id": "s_1", "elements": [
            {"id": "e_a", "kind": "shape"}, {"id": "e_b", "kind": "shape"}, {"id": "e_c", "kind": "shape"}
        ]}]});
        let local = json!({"slides": [{"id": "s_1", "elements": [
            {"id": "e_c", "kind": "shape"}, {"id": "e_a", "kind": "shape"}, {"id": "e_b", "kind": "shape"}
        ]}]});
        let ops = ops_between(&base, &local);
        assert_eq!(ops.len(), 1, "{ops:?}");
        assert!(matches!(&ops[0], Op::ReorderElement { element, to: ZTarget::Index(0), .. } if element == "e_c"));
    }

    #[test]
    fn plain_text_over_an_existing_element_keeps_its_look() {
        let base = json!({"slides": [{"id": "s_1", "elements": [
            {"id": "e_1", "kind": "text", "text": {"paragraphs": [{"heading": 1, "runs": [{"text": "Old", "bold": true}]}]}}
        ]}]});
        let mut local = json!({"slides": [{"id": "s_1", "elements": [{"id": "e_1", "kind": "text", "text": "New"}]}]});
        prepare_against(&base, &mut local);
        assert_eq!(local["slides"][0]["elements"][0]["text"], json!({"paragraphs": [{"heading": 1, "runs": [{"text": "New", "bold": true}]}]}));
    }

    #[test]
    fn nothing_changed_means_no_ops() {
        let base = json!({"size": {"width": 1920, "height": 1080}, "theme": {"name": "plain"}, "master": {"elements": []}, "slides": [
            {"id": "s_1", "notes": "", "elements": [{"id": "e_1", "kind": "text", "text": rich_text("x")}]}
        ]});
        let mut local = base.clone();
        prepare_local(&mut local);
        assert!(ops_between(&base, &local).is_empty());
    }
}
