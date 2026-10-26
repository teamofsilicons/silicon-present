use present_deck::*;
use serde_json::{Value, json};
use yrs::{Any, Array, Map, MapPrelim, Out, ReadTxn, Transact};
fn doc() -> yrs::Doc {
    json_to_doc(&json!({"slides":[{"id":"s_one","notes":"İstanbul plan Σ", "elements":[{"id":"e_text","kind":"text","text":{"paragraphs":[{"runs":[{"text":"Total: "},{"text":"42","bold":true},{"text":" units"}]}]}},{"id":"e_table","kind":"table","w":600,"h":200,"cells":[["a","b"],["c","d"]]}]}]})).unwrap()
}
fn ops(v: Value) -> Vec<Op> {
    parse_ops(&v).unwrap()
}
fn edit(doc: &yrs::Doc, set: Value) {
    apply_ops(
        doc,
        &ops(json!([{"op":"update_element","slide":"s_one","element":"e_table","set":set}])),
    )
    .unwrap();
}
fn table(doc: &yrs::Doc) -> Value {
    doc_to_json(doc)["slides"][0]["elements"][1].clone()
}
#[test]
fn writers_reject_while_readers_canonicalize() {
    for (input, code) in [
        (json!({"unknown":0}), "invalid_field"),
        (json!({"slides":[{"id":"master"}]}), "reserved_id"),
        (
            json!({"slides":[{"id":"same"},{"id":"same"}]}),
            "duplicate_id",
        ),
        (
            json!({"master":{"elements":[{"id":"x","kind":"text"},{"id":"x","kind":"shape"}]}}),
            "duplicate_id",
        ),
        (
            json!({"slides":[{"elements":[{"kind":"constructor"}]}]}),
            "unknown_element_kind",
        ),
        (
            json!({"slides":[{"elements":[{"kind":"text","x":"0x10"}]}]}),
            "invalid_value",
        ),
        (json!({"size":{"width":0}}), "invalid_value"),
        (json!({"size":{"unit":"px"}}), "invalid_field"),
        (
            json!({"slides":[{"elements":[{"kind":"table","rows":2.5}]}]}),
            "invalid_value",
        ),
        (
            json!({"slides":[{"elements":[{"kind":"table","rows":1,"cells":[[],[]]}]}]}),
            "invalid_value",
        ),
        (
            json!({"slides":[{"elements":[{"kind":"text","text":{"paragraphs":[{"list":"checked"}]}}]}]}),
            "invalid_value",
        ),
        (
            json!({"slides":[{"elements":[{"kind":"text","text":{"paragraphs":[{"runs":[{"text":"x","align":"left"}]}]}}]}]}),
            "invalid_field",
        ),
    ] {
        assert_eq!(json_to_doc(&input).unwrap_err().code, code, "{input}");
        let normalized = normalize_deck(&input).unwrap();
        assert!(
            json_to_doc(&normalized).is_ok(),
            "reader output must be valid: {normalized}"
        );
    }
}
#[test]
fn numeric_grammar_and_float64_are_shared() {
    let input = json!({"slides":[{"id":"s","notes":1.0,"elements":[{"id":"e","kind":"chart","x":" \n1e3\t","w":null,"style":{"large":9007199254740993u64},"chart":{"labels":[1.0,12345678901234567890u64,null],"series":[{"name":2.5,"values":["-0.5",null]}]}}]}]});
    let out = doc_to_json(&json_to_doc(&input).unwrap());
    let e = &out["slides"][0]["elements"][0];
    assert_eq!(out["slides"][0]["notes"], "1");
    assert_eq!(e["x"], 1000);
    assert_eq!(e["w"], 400);
    assert_eq!(e["style"]["large"].as_f64(), Some(9007199254740992.0));
    assert_eq!(
        e["chart"]["labels"],
        json!(["1", "12345678901234567000", ""])
    );
    for x in ["0x10", "1.", ".5", "+1", "Infinity", "1e400", "", "\u{a0}1"] {
        assert!(json_to_doc(&json!({"slides":[{"elements":[{"kind":"text","x":x}]}]})).is_err());
    }
    assert!(matches!(
        json_to_any(&json!(9007199254740993u64)),
        Any::Number(yrs::any::Number::Float(_))
    ));
}
#[test]
fn table_resize_keeps_maps_and_dimensions_canonical() {
    let d = doc();
    edit(&d, json!({"rows":3,"cols":3}));
    let t = table(&d);
    assert_eq!(
        t["rowHeights"],
        json!([200.0 / 3.0, 200.0 / 3.0, 200.0 / 3.0])
    );
    assert_eq!(t["colWidths"], json!([200, 200, 200]));
    assert_eq!(t["cells"].as_array().unwrap().len(), 3);
    apply_ops(&d,&ops(json!([{"op":"update_element","slide":"s_one","element":"e_table","set":{"cells":[["A"]]}}]))).unwrap();
    assert_eq!(table(&d)["rows"], 1);
    assert_eq!(table(&d)["cols"], 1);
    edit(&d, json!({"rows":2,"cols":2}));
    assert_eq!(plain_text(&table(&d)["cells"][1][1]["text"]), "");
    edit(&d, json!({"w":1200,"h":400}));
    assert_eq!(table(&d)["colWidths"], json!([600, 600]));
    assert_eq!(table(&d)["rowHeights"], json!([200, 200]));
    edit(&d, json!({"cells":null}));
    assert_eq!(plain_text(&table(&d)["cells"][0][0]["text"]), "");
}
#[test]
fn strict_op_shapes_and_atomic_failures() {
    for op in [
        json!({"op":"add_slide"}),
        json!({"op":"add_element","slide":"s_one","element":{},"z":1.5}),
        json!({"op":"replace_text","slide":"s_one","find":"x","replace":"y","all":"yes"}),
        json!({"op":"delete_slide","slide":"s_one","oops":true}),
        json!({"op":"move_slide","slide":"s_one","after":"master"}),
    ] {
        assert_eq!(parse_ops(&json!([op])).unwrap_err().code, "invalid_op");
    }
    let d = doc();
    let before = encode_doc(&d);
    let e=apply_ops(&d,&ops(json!([{"op":"update_slide","slide":"s_one","set":{"notes":"changed"}},{"op":"update_slide","slide":"s_one","set":{"elementOrder":[]}}]))).unwrap_err();
    assert_eq!(e.code, "invalid_field");
    assert_eq!(e.op_index, Some(1));
    assert_eq!(encode_doc(&d), before);
    apply_ops(&d,&ops(json!([{"op":"add_element","slide":"s_one","element":{"id":"new","kind":"text"},"z":1.0}]))).unwrap();
    assert_eq!(doc_to_json(&d)["slides"][0]["elements"][1]["id"], "new");
}
#[test]
fn replace_keeps_deleted_character_style_and_casefold_offsets() {
    let d = doc();
    apply_ops(&d,&ops(json!([{"op":"replace_text","slide":"s_one","element":"e_text","find":"42 units","replace":"43 units"},{"op":"replace_text","slide":"s_one","field":"notes","find":"PLAN σ","replace":"map","matchCase":false}]))).unwrap();
    let out = doc_to_json(&d);
    assert_eq!(out["slides"][0]["notes"], "İstanbul map");
    assert_eq!(
        out["slides"][0]["elements"][0]["text"]["paragraphs"][0]["runs"][1],
        json!({"text":"43","bold":true})
    );
    let e=apply_ops(&d,&ops(json!([{"op":"replace_text","slide":"s_one","field":"notes","find":"i","replace":"x","matchCase":false}]))).unwrap_err();
    assert_eq!(e.code, "text_not_found");
}
#[test]
fn base_rejects_map_collisions_and_deleted_targets_without_mutation() {
    let base = doc();
    let live = clone_doc(&base);
    edit(&live, json!({"rows":3}));
    let update =
        ops(json!([{"op":"update_element","slide":"s_one","element":"e_table","set":{"rows":3}}]));
    assert_eq!(
        apply_ops_update_with_live(&base, &live, &update)
            .unwrap_err()
            .code,
        "id_exists"
    );
    let live = clone_doc(&base);
    apply_ops(
        &live,
        &ops(json!([{"op":"delete_element","slide":"s_one","element":"e_text"}])),
    )
    .unwrap();
    let before = encode_doc(&live);
    assert_eq!(
        apply_ops_update_with_live(
            &base,
            &live,
            &ops(json!([{"op":"update_element","slide":"s_one","element":"e_text","set":{"x":2}}]))
        )
        .unwrap_err()
        .code,
        "element_not_found"
    );
    assert_eq!(encode_doc(&live), before);
    assert!(
        apply_ops_update_with_live(
            &base,
            &live,
            &ops(json!([{"op":"delete_element","slide":"s_one","element":"e_text"}]))
        )
        .is_ok()
    );
}
#[test]
fn reader_drops_wrong_types_and_unknown_kinds_without_writing() {
    let d = doc();
    let slides = d.get_or_insert_map("slides");
    let order = d.get_or_insert_array("order");
    {
        let mut tx = d.transact_mut();
        order.push_back(&mut tx, "master");
        order.push_back(&mut tx, "s_one");
        let Out::YMap(slide) = slides.get(&tx, "s_one").unwrap() else {
            panic!()
        };
        let Out::YMap(es) = slide.get(&tx, "elements").unwrap() else {
            panic!()
        };
        let Out::YArray(z) = slide.get(&tx, "elementOrder").unwrap() else {
            panic!()
        };
        let bad = es.insert(&mut tx, "bad", MapPrelim::default());
        bad.insert(&mut tx, "kind", "constructor");
        z.push_back(&mut tx, "bad");
        let Out::YMap(e) = es.get(&tx, "e_text").unwrap() else {
            panic!()
        };
        e.insert(&mut tx, "id", "wrong");
        e.insert(&mut tx, "style", MapPrelim::default());
        e.insert(
            &mut tx,
            "text",
            json_to_any(&json!({"paragraphs":[{"runs":[{"text":"wrong type"}]}]})),
        );
    }
    let before = encode_doc(&d);
    let out = doc_to_json(&d);
    assert_eq!(out["slides"].as_array().unwrap().len(), 1);
    assert_eq!(out["slides"][0]["elements"].as_array().unwrap().len(), 2);
    assert_eq!(out["slides"][0]["elements"][0]["id"], "e_text");
    assert_eq!(
        out["slides"][0]["elements"][0]["text"],
        json!({"paragraphs":[]})
    );
    assert_eq!(encode_doc(&d), before);
    let empty = new_doc();
    assert_eq!(empty.transact().root_refs().count(), 0);
    doc_to_json(&empty);
    assert_eq!(empty.transact().root_refs().count(), 0);
}
#[test]
fn canonical_rewrite_repairs_ids_values_and_removes_unknown_keys() {
    let d = doc();
    let slides = d.get_or_insert_map("slides");
    {
        let mut tx = d.transact_mut();
        let Out::YMap(s) = slides.get(&tx, "s_one").unwrap() else {
            panic!()
        };
        s.insert(&mut tx, "id", "wrong");
        s.insert(&mut tx, "extra", true);
        let Out::YMap(es) = s.get(&tx, "elements").unwrap() else {
            panic!()
        };
        let Out::YMap(e) = es.get(&tx, "e_text").unwrap() else {
            panic!()
        };
        e.insert(&mut tx, "id", "wrong");
        e.insert(&mut tx, "x", "10");
        e.insert(&mut tx, "extra", true);
    }
    apply_ops(
        &d,
        &ops(json!([{"op":"update_slide","slide":"s_one","set":{}}])),
    )
    .unwrap();
    let tx = d.transact();
    let Out::YMap(s) = slides.get(&tx, "s_one").unwrap() else {
        panic!()
    };
    assert!(!s.contains_key(&tx, "extra"));
    let Out::YMap(es) = s.get(&tx, "elements").unwrap() else {
        panic!()
    };
    let Out::YMap(e) = es.get(&tx, "e_text").unwrap() else {
        panic!()
    };
    assert!(!e.contains_key(&tx, "extra"));
    assert_eq!(
        e.get(&tx, "x"),
        Some(Out::Any(Any::Number(yrs::any::Number::Int(10))))
    );
}

#[test]
fn base_cannot_edit_a_live_element_removed_from_the_order() {
    let base = doc();
    let live = clone_doc(&base);
    let slides = live.get_or_insert_map("slides");
    {
        let mut tx = live.transact_mut();
        let Out::YMap(slide) = slides.get(&tx, "s_one").unwrap() else {
            panic!()
        };
        let Out::YArray(order) = slide.get(&tx, "elementOrder").unwrap() else {
            panic!()
        };
        order.remove(&mut tx, 0);
    }
    let err = apply_ops_update_with_live(
        &base,
        &live,
        &ops(json!([{"op":"update_element","slide":"s_one","element":"e_text","set":{"x":10}}])),
    )
    .unwrap_err();
    assert_eq!(err.code, "element_not_found");
}

#[test]
fn raw_table_cell_arrays_are_not_y_maps_and_large_dimensions_stay_bounded() {
    let d = doc();
    let slides = d.get_or_insert_map("slides");
    {
        let mut tx = d.transact_mut();
        let Out::YMap(s) = slides.get(&tx, "s_one").unwrap() else {
            panic!()
        };
        let Out::YMap(es) = s.get(&tx, "elements").unwrap() else {
            panic!()
        };
        let Out::YMap(t) = es.get(&tx, "e_table").unwrap() else {
            panic!()
        };
        t.insert(&mut tx, "rows", 1e100);
        t.insert(&mut tx, "cells", json_to_any(&json!([["wrong"]])));
    }
    let t = table(&d);
    assert_eq!(t["rows"], 2);
    assert_eq!(plain_text(&t["cells"][0][0]["text"]), "");
}

#[test]
fn full_reconcile_cleans_raw_storage_and_is_then_a_noop() {
    let d = doc();
    let target = doc_to_json(&d);
    let deck = d.get_or_insert_map("deck");
    let slides = d.get_or_insert_map("slides");
    let order = d.get_or_insert_array("order");
    {
        let mut txn = d.transact_mut();
        deck.insert(&mut txn, "extra", "remove me");
        deck.insert(&mut txn, "version", "wrong type");
        slides.insert(&mut txn, "unlisted", MapPrelim::default());
        slides.insert(&mut txn, "malformed", true);
        order.push_back(&mut txn, "s_one");
        order.push_back(&mut txn, "missing");
        order.push_back(&mut txn, true);
        let Out::YMap(s) = slides.get(&txn, "s_one").unwrap() else {
            panic!()
        };
        let Out::YArray(z) = s.get(&txn, "elementOrder").unwrap() else {
            panic!()
        };
        z.push_back(&mut txn, "e_text");
        z.push_back(&mut txn, "missing");
    }
    reconcile(&d, &target, &Scope::Deck).unwrap();
    {
        let txn = d.transact();
        assert_eq!(deck.len(&txn), 3);
        assert_eq!(
            deck.get(&txn, "version"),
            Some(Out::Any(Any::Number(yrs::any::Number::Int(1))))
        );
        assert_eq!(slides.len(&txn), 2);
        assert!(!slides.contains_key(&txn, "unlisted"));
        assert!(!slides.contains_key(&txn, "malformed"));
        assert_eq!(order.len(&txn), 1);
        let Out::YMap(s) = slides.get(&txn, "s_one").unwrap() else {
            panic!()
        };
        let Out::YArray(z) = s.get(&txn, "elementOrder").unwrap() else {
            panic!()
        };
        assert_eq!(z.len(&txn), 2);
    }
    assert_eq!(doc_to_json(&d), target);
    let before = encode_doc(&d);
    reconcile(&d, &target, &Scope::Deck).unwrap();
    assert_eq!(encode_doc(&d), before);
}
