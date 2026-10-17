use present_deck::*;
use serde_json::{Value, json};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

fn everything() -> Value {
    serde_json::from_str(include_str!("data/everything.json")).unwrap()
}

fn content(v: &Value) -> Value {
    let mut v = normalize_deck(v).unwrap();
    let m = v.as_object_mut().unwrap();
    m.remove("id");
    m.remove("title");
    m.remove("version");
    v
}

fn apply(doc: &Doc, update: &[u8]) {
    doc.transact_mut().apply_update(Update::decode_v1(update).unwrap()).unwrap();
}

/// Brings two documents to the same state, like two clients syncing.
fn sync(a: &Doc, b: &Doc) {
    let sv_a = a.transact().state_vector();
    let sv_b = b.transact().state_vector();
    let for_b = a.transact().encode_state_as_update_v1(&sv_b);
    let for_a = b.transact().encode_state_as_update_v1(&sv_a);
    apply(b, &for_b);
    apply(a, &for_a);
}

fn ops(v: Value) -> Vec<Op> {
    parse_ops(&v).unwrap()
}

fn slide<'a>(deck: &'a Value, id: &str) -> &'a Value {
    deck["slides"].as_array().unwrap().iter().find(|s| s["id"] == id).unwrap()
}

fn element<'a>(deck: &'a Value, slide_id: &str, id: &str) -> &'a Value {
    let s = if slide_id == "master" { &deck["master"] } else { slide(deck, slide_id) };
    s["elements"].as_array().unwrap().iter().find(|e| e["id"] == id).unwrap()
}

fn plain(rich: &Value) -> String {
    plain_text(rich)
}

#[test]
fn json_round_trips_through_yjs() {
    let deck = everything();
    let doc = json_to_doc(&deck).unwrap();
    assert_eq!(doc_to_json(&doc), content(&deck));
    let bytes = encode_doc(&doc);
    assert_eq!(doc_to_json(&decode_doc(&bytes).unwrap()), content(&deck));
    let meta = DeckMeta { id: "dk1".into(), title: "T".into(), version: 3 };
    let with = meta.attach(doc_to_json(&doc));
    assert_eq!(with["id"], "dk1");
    assert_eq!(with["version"], 3);
}

#[test]
fn defaults_fill_partial_json_and_unknown_keys_drop() {
    let deck = json!({ "slides": [ { "elements": [ { "kind": "text", "text": "Hi\nthere", "mystery": 1 }, { "kind": "table", "cells": [["a", "b", "c"]] } ] } ] });
    let doc = json_to_doc(&deck).unwrap();
    let out = doc_to_json(&doc);
    let s = &out["slides"][0];
    assert!(s["id"].as_str().unwrap().starts_with("s_"));
    assert_eq!(s["layout"], "blank");
    let t = &s["elements"][0];
    assert!(t["id"].as_str().unwrap().starts_with("e_"));
    assert!(t.get("mystery").is_none());
    assert_eq!(t["text"]["paragraphs"].as_array().unwrap().len(), 2);
    let table = &s["elements"][1];
    assert_eq!(table["rows"], 1);
    assert_eq!(table["cols"], 3);
    assert_eq!(table["colWidths"].as_array().unwrap().len(), 3);
    assert_eq!(out["theme"]["name"], "Paper");
    assert_eq!(out["size"]["width"], 1920);
}

#[test]
fn default_deck_has_one_title_slide() {
    let d = doc_to_json(&json_to_doc(&default_deck()).unwrap());
    assert_eq!(d["slides"].as_array().unwrap().len(), 1);
    assert_eq!(d["slides"][0]["layout"], "title");
    assert_eq!(d["slides"][0]["elements"][0]["text"]["paragraphs"][0]["heading"], 1);
}

#[test]
fn every_op_applies() {
    let doc = json_to_doc(&everything()).unwrap();
    let outcome = apply_ops(
        &doc,
        &ops(json!([
            { "op": "update_deck", "set": { "size": { "width": 1280, "height": 720 } } },
            { "op": "add_slide", "after": "s_bbbbb1", "slide": { "layout": "title-only", "notes": "new notes",
               "elements": [ { "kind": "text", "text": "Added" } ] } },
            { "op": "add_slide", "after": null, "slide": { "id": "s_first1" } },
            { "op": "update_slide", "slide": "s_bbbbb2", "set": { "skipped": true, "section": "Demo", "notes": "Now with notes" } },
            { "op": "move_slide", "slide": "s_bbbbb2", "after": null },
            { "op": "add_element", "slide": "s_bbbbb1", "element": { "id": "e_new001", "kind": "shape", "shape": "star" }, "z": 0 },
            { "op": "update_element", "slide": "s_bbbbb1", "element": "e_shape1", "set": { "x": 999, "style": { "fill": "#000000" } } },
            { "op": "update_element", "slide": "s_bbbbb2", "element": "e_html01", "set": { "css": "#app { color: blue; }" } },
            { "op": "replace_text", "slide": "s_bbbbb1", "element": "e_text01", "find": "bold", "replace": "strong" },
            { "op": "reorder_element", "slide": "s_bbbbb1", "element": "e_text01", "to": "front" },
            { "op": "delete_element", "slide": "s_bbbbb2", "element": "e_audio1" },
            { "op": "add_element", "slide": "master", "element": { "kind": "text", "text": "Footer" } },
            { "op": "delete_slide", "slide": "s_first1" }
        ])),
    )
    .unwrap();
    assert_eq!(outcome.slides_added.len(), 2);
    assert_eq!(outcome.elements_added.len(), 2);
    assert_eq!(outcome.replacements, 1);
    let d = doc_to_json(&doc);
    assert_eq!(d["size"]["width"], 1280);
    let ids: Vec<&str> = d["slides"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
    assert_eq!(ids.len(), 3);
    assert_eq!(ids[0], "s_bbbbb2");
    assert_eq!(ids[1], "s_bbbbb1");
    assert_eq!(slide(&d, ids[2])["layout"], "title-only");
    assert_eq!(slide(&d, ids[2])["notes"], "new notes");
    assert_eq!(slide(&d, "s_bbbbb2")["skipped"], true);
    assert_eq!(slide(&d, "s_bbbbb2")["notes"], "Now with notes");
    let s1 = slide(&d, "s_bbbbb1");
    let order: Vec<&str> = s1["elements"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(order.first(), Some(&"e_new001"));
    assert_eq!(order.last(), Some(&"e_text01"));
    assert_eq!(element(&d, "s_bbbbb1", "e_shape1")["x"], 999);
    assert_eq!(element(&d, "s_bbbbb1", "e_shape1")["style"], json!({ "fill": "#000000" }));
    assert_eq!(element(&d, "s_bbbbb2", "e_html01")["css"], "#app { color: blue; }");
    // The replaced run keeps its bold formatting; neighbours are untouched.
    let runs = &element(&d, "s_bbbbb1", "e_text01")["text"]["paragraphs"][0]["runs"];
    assert_eq!(runs[1], json!({ "text": "strong", "bold": true }));
    assert_eq!(runs[3]["color"], "#ff0000");
    assert!(slide(&d, "s_bbbbb2")["elements"].as_array().unwrap().iter().all(|e| e["id"] != "e_audio1"));
    assert_eq!(plain(&d["master"]["elements"][1]["text"]), "Footer\n");
}

#[test]
fn a_failing_op_changes_nothing() {
    let doc = json_to_doc(&everything()).unwrap();
    let before = doc_to_json(&doc);
    let err = apply_ops(
        &doc,
        &ops(json!([
            { "op": "update_slide", "slide": "s_bbbbb1", "set": { "skipped": true } },
            { "op": "delete_element", "slide": "s_bbbbb1", "element": "e_nope00" }
        ])),
    )
    .unwrap_err();
    assert_eq!(err.code, "element_not_found");
    assert_eq!(err.op_index, Some(1));
    assert_eq!(doc_to_json(&doc), before);
}

#[test]
fn replace_text_reports_missing_and_ambiguous_passages() {
    let doc = json_to_doc(&everything()).unwrap();
    let err = apply_ops(&doc, &ops(json!([{ "op": "replace_text", "slide": "s_bbbbb1", "element": "e_text01", "find": "Helo bold", "replace": "x" }]))).unwrap_err();
    assert_eq!(err.code, "text_not_found");
    assert!(err.hint.contains("Hello bold"), "{}", err.hint);
    // "an" appears in "and" and in "ünïcødé"? Use a passage that appears twice in the element.
    let err = apply_ops(&doc, &ops(json!([{ "op": "replace_text", "slide": "s_bbbbb1", "element": "e_text01", "find": "i", "replace": "I" }]))).unwrap_err();
    assert_eq!(err.code, "text_ambiguous");
    assert!(err.message.contains("times"), "{}", err.message);
    let out = apply_ops(&doc, &ops(json!([{ "op": "replace_text", "slide": "s_bbbbb1", "element": "e_text01", "find": "emoji 🎉", "replace": "party 🎈🎈", "all": true }]))).unwrap();
    assert_eq!(out.replacements, 1);
    let d = doc_to_json(&doc);
    let last = &element(&d, "s_bbbbb1", "e_text01")["text"]["paragraphs"][4]["runs"][0];
    assert_eq!(last["text"], "party 🎈🎈 and ünïcødé");
    assert_eq!(last["strike"], true);
}

#[test]
fn replace_text_in_notes_cells_and_whole_slide() {
    let doc = json_to_doc(&everything()).unwrap();
    apply_ops(
        &doc,
        &ops(json!([
            { "op": "replace_text", "slide": "s_bbbbb1", "field": "notes", "find": "Second line", "replace": "2nd line" },
            { "op": "replace_text", "slide": "s_bbbbb1", "element": "e_table1", "field": "cell:1:0", "find": "Q4", "replace": "Q4 2026" },
            { "op": "replace_text", "slide": "s_bbbbb1", "find": "In a shape", "replace": "Inside a shape" },
            { "op": "replace_text", "slide": "s_bbbbb2", "element": "e_html01", "find": "Running", "replace": "Live!" }
        ])),
    )
    .unwrap();
    let d = doc_to_json(&doc);
    assert!(slide(&d, "s_bbbbb1")["notes"].as_str().unwrap().contains("2nd line ünïcødé 🎉"));
    assert_eq!(plain(&element(&d, "s_bbbbb1", "e_table1")["cells"][1][0]["text"]), "Q4 2026\n");
    assert_eq!(plain(&element(&d, "s_bbbbb1", "e_shape1")["text"]), "Inside a shape\n");
    assert!(element(&d, "s_bbbbb2", "e_html01")["js"].as_str().unwrap().contains("Live!"));
}

#[test]
fn minimal_text_diffs_keep_concurrent_typing() {
    let a = json_to_doc(&everything()).unwrap();
    let b = clone_doc(&a);
    // A Silicon rewrites one word through an op while a Carbon types at the end of the same paragraph.
    apply_ops(&a, &ops(json!([{ "op": "replace_text", "slide": "s_bbbbb1", "element": "e_text01", "find": "Hello", "replace": "Hi" }]))).unwrap();
    apply_ops(&b, &ops(json!([{ "op": "replace_text", "slide": "s_bbbbb1", "element": "e_text01", "find": "italic red", "replace": "italic red!!" }]))).unwrap();
    sync(&a, &b);
    let da = doc_to_json(&a);
    assert_eq!(da, doc_to_json(&b));
    let p0 = &element(&da, "s_bbbbb1", "e_text01")["text"]["paragraphs"][0]["runs"];
    assert_eq!(p0[0]["text"], "Hi ");
    assert_eq!(p0[3]["text"], "italic red!!");
    // update_element with a whole new text also diffs: concurrent HTML edits both survive.
    apply_ops(&a, &ops(json!([{ "op": "update_element", "slide": "s_bbbbb2", "element": "e_html01", "set": { "html": "<div id=\"app\">Live now</div>" } }]))).unwrap();
    apply_ops(&b, &ops(json!([{ "op": "update_element", "slide": "s_bbbbb2", "element": "e_html01", "set": { "html": "<main><div id=\"app\">Live</div>" } }]))).unwrap();
    sync(&a, &b);
    assert_eq!(element(&doc_to_json(&a), "s_bbbbb2", "e_html01")["html"], "<main><div id=\"app\">Live now</div>");
}

#[test]
fn setting_rich_text_changes_only_formatting_where_it_differs() {
    let doc = json_to_doc(&everything()).unwrap();
    let mut target = element(&doc_to_json(&doc), "s_bbbbb1", "e_text01")["text"].clone();
    target["paragraphs"][0]["runs"][0]["underline"] = json!(true);
    target["paragraphs"][1]["align"] = json!("center");
    let sv = doc.transact().state_vector();
    apply_ops(&doc, &ops(json!([{ "op": "update_element", "slide": "s_bbbbb1", "element": "e_text01", "set": { "text": target.clone() } }]))).unwrap();
    let now = doc_to_json(&doc);
    let got = &element(&now, "s_bbbbb1", "e_text01")["text"];
    assert_eq!(got, &normalize_element(&json!({"kind": "text", "text": target})).unwrap()["text"]);
    // Only formatting changed, so no characters were deleted: the update has no delete set beyond format markers.
    let update = doc.transact().encode_state_as_update_v1(&sv);
    assert!(update.len() < 400, "formatting-only change should be small, got {} bytes", update.len());
}

#[test]
fn ops_on_an_old_base_merge_into_newer_edits() {
    let base = json_to_doc(&everything()).unwrap();
    let base_state = encode_doc(&base);
    let live = clone_doc(&base);
    // Meanwhile someone else edits the live deck.
    apply_ops(&live, &ops(json!([
        { "op": "update_element", "slide": "s_bbbbb1", "element": "e_shape1", "set": { "y": 777 } },
        { "op": "replace_text", "slide": "s_bbbbb1", "element": "e_text01", "find": "Hello", "replace": "Howdy" }
    ]))).unwrap();
    // A Silicon edits its pulled copy (the base) and the resulting update merges into live.
    let old = decode_doc(&base_state).unwrap();
    let (update, _) = apply_ops_update(&old, &ops(json!([
        { "op": "replace_text", "slide": "s_bbbbb1", "element": "e_text01", "find": "italic red", "replace": "italic blue" },
        { "op": "update_element", "slide": "s_bbbbb1", "element": "e_shape1", "set": { "x": 5 } }
    ]))).unwrap();
    apply(&live, &update);
    let d = doc_to_json(&live);
    let e = element(&d, "s_bbbbb1", "e_shape1");
    assert_eq!(e["x"], 5);
    assert_eq!(e["y"], 777);
    let runs = &element(&d, "s_bbbbb1", "e_text01")["text"]["paragraphs"][0]["runs"];
    assert_eq!(runs[0]["text"], "Howdy ");
    assert_eq!(runs[3]["text"], "italic blue");
}

#[test]
fn reconcile_restores_whole_deck_slide_and_element() {
    let doc = json_to_doc(&everything()).unwrap();
    let v1 = doc_to_json(&doc);
    apply_ops(&doc, &ops(json!([
        { "op": "delete_slide", "slide": "s_bbbbb2" },
        { "op": "update_element", "slide": "s_bbbbb1", "element": "e_chart1", "set": { "chart": { "type": "pie", "labels": [], "series": [] } } },
        { "op": "delete_element", "slide": "s_bbbbb1", "element": "e_table1" },
        { "op": "add_slide", "slide": { "id": "s_later1" } },
        { "op": "move_slide", "slide": "s_later1", "after": null },
        { "op": "update_deck", "set": { "theme": { "name": "Other" } } }
    ]))).unwrap();
    // One element back.
    reconcile(&doc, &v1, &Scope::Element { slide: "s_bbbbb1".into(), element: "e_table1".into() }).unwrap();
    let d = doc_to_json(&doc);
    let order: Vec<&str> = slide(&d, "s_bbbbb1")["elements"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(order, vec!["e_text01", "e_shape1", "e_table1", "e_chart1"]);
    assert_eq!(element(&d, "s_bbbbb1", "e_chart1")["chart"]["type"], "pie");
    // One slide back, in its old place.
    reconcile(&doc, &v1, &Scope::Slide("s_bbbbb2".into())).unwrap();
    let d = doc_to_json(&doc);
    let ids: Vec<&str> = d["slides"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["s_later1", "s_bbbbb1", "s_bbbbb2"]);
    // The whole deck back.
    reconcile(&doc, &v1, &Scope::Deck).unwrap();
    assert_eq!(doc_to_json(&doc), v1);
    // Reconciling to the same deck changes nothing.
    let sv = doc.transact().state_vector();
    reconcile(&doc, &v1, &Scope::Deck).unwrap();
    assert_eq!(doc.transact().state_vector(), sv);
}

#[test]
fn reconcile_keeps_concurrent_work_elsewhere() {
    let a = json_to_doc(&everything()).unwrap();
    let v1 = doc_to_json(&a);
    apply_ops(&a, &ops(json!([{ "op": "update_element", "slide": "s_bbbbb1", "element": "e_shape1", "set": { "x": 1 } }]))).unwrap();
    let b = clone_doc(&a);
    // b restores slide 1 while a edits slide 2 concurrently.
    let upd = reconcile_update(&b, &v1, &Scope::Slide("s_bbbbb1".into())).unwrap();
    apply(&b, &upd);
    apply_ops(&a, &ops(json!([{ "op": "update_slide", "slide": "s_bbbbb2", "set": { "notes": "concurrent" } }]))).unwrap();
    sync(&a, &b);
    let d = doc_to_json(&a);
    assert_eq!(element(&d, "s_bbbbb1", "e_shape1")["x"], 100);
    assert_eq!(slide(&d, "s_bbbbb2")["notes"], "concurrent");
}

#[test]
fn diff_and_summary_say_what_changed() {
    let a = everything();
    let doc = json_to_doc(&a).unwrap();
    let before = doc_to_json(&doc);
    apply_ops(&doc, &ops(json!([{ "op": "update_element", "slide": "s_bbbbb2", "element": "e_html01", "set": { "x": 10 } }]))).unwrap();
    let d = diff(&before, &doc_to_json(&doc));
    assert_eq!(d.slides_changed.len(), 1);
    assert_eq!(d.slides_changed[0].elements_changed[0].fields, vec!["x".to_string()]);
    assert_eq!(summarize(&d), "changed slide 2");
    assert_eq!(d.touched(), vec!["s_bbbbb2".to_string()]);

    let before = doc_to_json(&doc);
    apply_ops(&doc, &ops(json!([{ "op": "add_slide", "slide": {} }, { "op": "add_slide", "slide": {} }]))).unwrap();
    assert_eq!(summarize(&diff(&before, &doc_to_json(&doc))), "added 2 slides");

    let before = doc_to_json(&doc);
    apply_ops(&doc, &ops(json!([
        { "op": "delete_element", "slide": "s_bbbbb1", "element": "e_text01" },
        { "op": "delete_element", "slide": "s_bbbbb1", "element": "e_shape1" },
        { "op": "add_element", "slide": "s_bbbbb1", "element": { "kind": "text" } },
        { "op": "add_element", "slide": "s_bbbbb1", "element": { "kind": "html" } },
        { "op": "update_deck", "set": { "theme": { "name": "Ink" } } },
        { "op": "move_slide", "slide": "s_bbbbb2", "after": null }
    ]))).unwrap();
    let s = summarize(&diff(&before, &doc_to_json(&doc)));
    assert!(s.contains("rebuilt slide"), "{s}");
    assert!(s.contains("changed the theme"), "{s}");
    assert!(s.contains("moved slide"), "{s}");
    let before = doc_to_json(&doc);
    assert_eq!(summarize(&diff(&before, &before)), "made no visible changes");
}

#[test]
fn text_view_shows_everything_a_silicon_needs() {
    let mut deck = everything();
    deck["id"] = json!("dkEverything");
    deck["title"] = json!("Every element kind");
    deck["version"] = json!(7);
    let deck = normalize_deck(&deck).unwrap();
    let threads = vec![
        json!({ "id": "th1", "state": "open", "anchor": { "kind": "element", "slide": "s_bbbbb1", "element": "e_chart1" },
                "comments": [ { "id": "c1", "author": { "id": "c:ada" }, "body": "@si:designer make this simpler" },
                              { "id": "c2", "author": { "id": "si:designer" }, "body": "On it" } ] }),
        json!({ "id": "th2", "state": "resolved", "anchor": { "kind": "slide", "slide": "s_bbbbb1" }, "comments": [ { "id": "c3", "author": { "id": "c:ada" }, "body": "hidden" } ] }),
        json!({ "id": "th3", "state": "open", "anchor": { "kind": "deck" }, "comments": [ { "id": "c4", "author": { "id": "c:bob" }, "body": "Looks good" } ] }),
        json!({ "id": "th4", "state": "open", "anchor": { "kind": "slide", "slide": "s_gone00" }, "snapshot": { "label": "slide 9" }, "comments": [ { "id": "c5", "author": { "id": "c:bob" }, "body": "old" } ] }),
    ];
    let text = to_text(&deck, Some(&threads));
    for want in [
        "Every element kind",
        "deck dkEverything · version 7 · 2 slides · 1920×1080",
        "── Slide 1 · s_bbbbb1 · layout title-body · section \"Intro\"",
        "e_text01 text  x 100 y 80 w 1720 h 160",
        "Hello **bold** and _italic red_",
        "  - A point with a [link](https://example.com)",
        "| **Quarter** | **Revenue** |",
        "column chart \"Revenue\"",
        "2026: 1.5, 2, 3.25",
        "html:",
        "document.getElementById",
        "notes:",
        "Second line ünïcødé 🎉",
        "      comment [th1 on e_chart1, open] c:ada: @si:designer make this simpler",
        "↳ si:designer: On it",
        "Comments on the deck:",
        "c:bob: Looks good",
        "Comments on deleted slides",
        "(was: slide 9)",
        "── Master",
        "e_logo01 image",
    ] {
        assert!(text.contains(want), "missing {want:?} in:\n{text}");
    }
    assert!(!text.contains("hidden"));
}

#[test]
fn concurrent_reorders_never_duplicate_slides() {
    let a = json_to_doc(&everything()).unwrap();
    let b = clone_doc(&a);
    apply_ops(&a, &ops(json!([{ "op": "move_slide", "slide": "s_bbbbb1", "after": "s_bbbbb2" }]))).unwrap();
    apply_ops(&b, &ops(json!([{ "op": "move_slide", "slide": "s_bbbbb1", "after": "s_bbbbb2" }]))).unwrap();
    sync(&a, &b);
    let d = doc_to_json(&a);
    assert_eq!(d["slides"].as_array().unwrap().len(), 2);
    assert_eq!(d, doc_to_json(&b));
}

#[test]
fn updates_from_series_rebuild_a_document() {
    let doc = json_to_doc(&everything()).unwrap();
    let first = encode_doc(&doc);
    let sv = doc.transact().state_vector();
    apply_ops(&doc, &ops(json!([{ "op": "delete_slide", "slide": "s_bbbbb2" }]))).unwrap();
    let second = doc.transact().encode_state_as_update_v1(&sv);
    let rebuilt = doc_from_updates([first.as_slice(), second.as_slice()]).unwrap();
    assert_eq!(doc_to_json(&rebuilt), doc_to_json(&doc));
    assert!(decode_doc(b"garbage").is_err());
    let _ = StateVector::default();
}

#[test]
fn undo_author_reverts_only_their_changes_even_when_others_edited_after() {
    let doc = json_to_doc(&everything()).unwrap();
    let base = encode_doc(&doc);
    let mut later: Vec<(bool, Vec<u8>)> = Vec::new();
    let mut step = |theirs: bool, o: Value| {
        let (u, _) = apply_ops_update(&doc, &ops(o)).unwrap();
        apply(&doc, &u);
        later.push((theirs, u));
    };
    // They rewrite the shape's text and add a slide; someone else edits the notes and the title afterwards.
    step(true, json!([{ "op": "update_element", "slide": "s_bbbbb1", "element": "e_shape1", "set": { "text": "Rewritten by them", "x": 1 } },
                      { "op": "add_slide", "slide": { "id": "s_theirs" } }]));
    step(false, json!([{ "op": "update_slide", "slide": "s_bbbbb1", "set": { "notes": "Kept notes" } }]));
    step(true, json!([{ "op": "delete_element", "slide": "s_bbbbb2", "element": "e_audio1" }]));
    step(false, json!([{ "op": "replace_text", "slide": "s_bbbbb1", "element": "e_text01", "find": "Hello", "replace": "Howdy" }]));
    let refs: Vec<(bool, &[u8])> = later.iter().map(|(t, u)| (*t, u.as_slice())).collect();
    let out = undo_author(&[base.as_slice()], &refs).unwrap();
    assert_eq!(plain_text(&element(&out, "s_bbbbb1", "e_shape1")["text"]), "In a shape\n");
    assert_eq!(element(&out, "s_bbbbb1", "e_shape1")["x"], 100);
    assert!(out["slides"].as_array().unwrap().iter().all(|s| s["id"] != "s_theirs"));
    assert!(slide(&out, "s_bbbbb2")["elements"].as_array().unwrap().iter().any(|e| e["id"] == "e_audio1"));
    assert_eq!(slide(&out, "s_bbbbb1")["notes"], "Kept notes");
    assert_eq!(element(&out, "s_bbbbb1", "e_text01")["text"]["paragraphs"][0]["runs"][0]["text"], "Howdy ");
}

#[test]
fn undo_author_keeps_later_work_positioned_after_theirs() {
    // The web's history spec: a friend adds a slide and changes the owner's text, then the owner adds a slide right
    // after the friend's. Undoing the friend must keep the owner's slide and bring the owner's text back.
    let doc = json_to_doc(&json!({ "slides": [ { "id": "s_his001", "elements": [ { "id": "e_ow0001", "kind": "text", "text": "Owner's first slide" } ] } ] })).unwrap();
    let base = encode_doc(&doc);
    let mut later: Vec<(bool, Vec<u8>)> = Vec::new();
    let mut step = |theirs: bool, o: Value| {
        let (u, _) = apply_ops_update(&doc, &ops(o)).unwrap();
        apply(&doc, &u);
        later.push((theirs, u));
    };
    step(true, json!([{ "op": "add_slide", "after": "s_his001", "slide": { "id": "s_his002", "elements": [ { "kind": "text", "text": "Friend's slide" } ] } },
                      { "op": "update_element", "slide": "s_his001", "element": "e_ow0001", "set": { "text": "Friend changed this" } }]));
    step(false, json!([{ "op": "add_slide", "after": "s_his002", "slide": { "id": "s_his003", "elements": [ { "kind": "text", "text": "Owner's last slide" } ] } }]));
    let refs: Vec<(bool, &[u8])> = later.iter().map(|(t, u)| (*t, u.as_slice())).collect();
    let out = undo_author(&[base.as_slice()], &refs).unwrap();
    let ids: Vec<&str> = out["slides"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["s_his001", "s_his003"]);
    assert_eq!(plain_text(&element(&out, "s_his001", "e_ow0001")["text"]), "Owner's first slide\n");
}

#[test]
fn plain_text_set_over_an_element_keeps_its_look() {
    let doc = json_to_doc(&json!({ "slides": [ { "id": "s_1", "elements": [
        { "id": "e_1", "kind": "text", "text": { "paragraphs": [ { "heading": 1, "align": "center", "runs": [ { "text": "Old", "bold": true, "size": 72 } ] } ] } },
        { "id": "e_2", "kind": "text", "text": { "paragraphs": [ { "heading": 1, "runs": [] } ] } }
    ] } ] })).unwrap();
    apply_ops(&doc, &ops(json!([
        { "op": "update_element", "slide": "s_1", "element": "e_1", "set": { "text": "New title\nSecond line" } },
        { "op": "update_element", "slide": "s_1", "element": "e_2", "set": { "text": "Into an empty heading" } }
    ]))).unwrap();
    let d = doc_to_json(&doc);
    assert_eq!(element(&d, "s_1", "e_1")["text"], json!({ "paragraphs": [
        { "heading": 1, "align": "center", "runs": [ { "text": "New title", "bold": true, "size": 72 } ] },
        { "heading": 1, "align": "center", "runs": [ { "text": "Second line", "bold": true, "size": 72 } ] } ] }));
    assert_eq!(element(&d, "s_1", "e_2")["text"], json!({ "paragraphs": [ { "heading": 1, "runs": [ { "text": "Into an empty heading" } ] } ] }));
}
