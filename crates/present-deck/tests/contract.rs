//! The cross-language contract with `packages/deck`: for every `fixtures/contract/<name>.json`, Rust writes
//! checks `<name>.rust.yupdate` (json_to_doc → one v1 update) for the TypeScript tests to read, and every
//! `<name>.ts.yupdate` written by TypeScript must decode here to JSON equal to `<name>.json`.

use std::path::PathBuf;

use present_deck::{decode_doc, doc_to_json, json_to_doc, normalize_deck};
use serde_json::Value;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/contract")
}

fn content(v: &Value) -> Value {
    let mut v = v.clone();
    if let Value::Object(m) = &mut v {
        m.remove("id");
        m.remove("title");
        m.remove("version");
    }
    v
}

#[test]
fn every_fixture_round_trips_and_ts_updates_decode_identically() {
    let dir = fixtures();
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("fixtures/contract exists")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".json"))
        .map(|n| n.trim_end_matches(".json").to_string())
        .collect();
    names.sort();
    assert!(!names.is_empty(), "no fixtures in {}", dir.display());
    let mut ts_checked = 0;
    for name in &names {
        let json: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{name}.json"))).unwrap())
            .unwrap_or_else(|e| panic!("{name}.json: {e}"));
        let want = content(&json);
        // Rust round trip.
        let doc = json_to_doc(&json).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(doc_to_json(&doc), want, "{name}: Rust json_to_doc → doc_to_json differs");
        assert_eq!(normalize_deck(&want).unwrap(), want, "{name}: fixture must already be canonical");
        let rust_path = dir.join(format!("{name}.rust.yupdate"));
        assert!(rust_path.is_file(), "{name}: missing Rust counterpart; regenerate explicitly");
        let back = decode_doc(&std::fs::read(&rust_path).unwrap()).unwrap();
        assert_eq!(doc_to_json(&back), want, "{name}: {name}.rust.yupdate decodes differently");
        // The TypeScript update must decode to the same JSON.
        let ts_path = dir.join(format!("{name}.ts.yupdate"));
        {
            let bytes = std::fs::read(&ts_path).unwrap_or_else(|e| panic!("{name}: missing TS counterpart: {e}"));
            let ts = decode_doc(&bytes).unwrap_or_else(|e| panic!("{name}.ts.yupdate: {e}"));
            let got = doc_to_json(&ts);
            if got != want {
                panic!(
                    "{name}.ts.yupdate decodes to different JSON.\n--- want\n{}\n--- got\n{}",
                    serde_json::to_string_pretty(&want).unwrap(),
                    serde_json::to_string_pretty(&got).unwrap()
                );
            }
            ts_checked += 1;
        }
    }
    eprintln!("checked {} fixtures, {} TypeScript updates", names.len(), ts_checked);
}
