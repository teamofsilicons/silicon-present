//! `present theme` with saved themes: listing yours, using one in a deck, saving a deck's theme, renaming, deleting.
use serde_json::{Value, json};
use std::{path::Path, process::Command};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const DECK: &str = "dk7Hq2mP9xRt";

fn brand() -> Value {
    json!({
        "id": "th7Hq2mP9xRt", "name": "Brand",
        "fonts": { "heading": "Brand Sans", "body": "Inter" },
        "colors": { "background": "#101820", "text": "#f2f2f2", "accent": "#fee715", "accent2": "#e5484d", "accent3": "#12a594", "muted": "#888888" },
        "customFonts": [{ "family": "Brand Sans", "src": "theme-font:fn7Hq2mP9xRt" }]
    })
}

async fn cli(home: &Path, args: &[&str]) -> (bool, Value) {
    let home = home.to_owned();
    let args: Vec<_> = args.iter().map(|a| a.to_string()).collect();
    let out = tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_present")).env("SILICON_HOME", home).env_remove("PRESENT_API_URL").env_remove("ACCOUNTS_URL").arg("--json").args(args).output().unwrap()
    })
    .await
    .unwrap();
    let text = if out.status.success() { out.stdout } else { out.stderr };
    let first = String::from_utf8_lossy(&text).lines().next().unwrap_or("").to_string();
    (out.status.success(), serde_json::from_str(&first).unwrap_or(Value::Null))
}

async fn signed_in(server: &MockServer) -> tempfile::TempDir {
    let api = server.uri();
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join(".present")).unwrap();
    std::fs::write(root.path().join(".present/state.json"), json!({"api_url":api,"accounts_url":api,"sign_ins":{&api:{
        "accounts_url":api,"app_id":"present","access_token":"test","refresh_token":"test","expires_at":4102444800_i64,
        "account":{"uuid":"test","id":"c:test","kind":"carbon"},"method":"slt","signed_in_at":0
    }}}).to_string()).unwrap();
    root
}

async fn bodies(server: &MockServer, method: &str, p: &str) -> Vec<Value> {
    server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.method.as_str() == method && r.url.path() == p)
        .map(|r| serde_json::from_slice(&r.body).unwrap_or(Value::Null))
        .collect()
}

#[tokio::test]
async fn saved_themes_list_apply_save_rename_and_delete() {
    let server = MockServer::start().await;
    let mut deck_theme = brand();
    deck_theme["customFonts"] = json!([{ "family": "Brand Sans", "src": "asset:as7Hq2mP9xRt" }]);
    Mock::given(method("GET")).and(path("/v1/themes")).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "themes": [brand()] }))).mount(&server).await;
    Mock::given(method("GET")).and(path(format!("/v1/decks/{DECK}/content"))).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "theme": { "name": "Paper" }, "slides": [] }))).mount(&server).await;
    Mock::given(method("POST")).and(path("/v1/themes/th7Hq2mP9xRt/use")).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "theme": deck_theme, "deck": DECK }))).mount(&server).await;
    Mock::given(method("POST")).and(path(format!("/v1/decks/{DECK}/edits"))).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "version": 3 }))).mount(&server).await;
    Mock::given(method("POST")).and(path("/v1/themes")).respond_with(ResponseTemplate::new(201).set_body_json(json!({ "id": "th2", "name": "Launch" }))).mount(&server).await;
    Mock::given(method("PATCH")).and(path("/v1/themes/th7Hq2mP9xRt")).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "th7Hq2mP9xRt", "name": "Brand 2" }))).mount(&server).await;
    Mock::given(method("DELETE")).and(path("/v1/themes/th7Hq2mP9xRt")).respond_with(ResponseTemplate::new(204)).mount(&server).await;
    let home = signed_in(&server).await;

    // The list has the seven built-in themes and yours.
    let (ok, list) = cli(home.path(), &["theme", "--list"]).await;
    assert!(ok);
    assert_eq!(list["themes"].as_array().unwrap().len(), 7);
    assert_eq!(list["yours"][0]["name"], "Brand");

    // A saved theme by name (any case): the service copies its fonts, the CLI sets the returned theme.
    let (ok, _) = cli(home.path(), &["theme", DECK, "brand", "--color", "muted=#777777"]).await;
    assert!(ok);
    assert_eq!(bodies(&server, "POST", "/v1/themes/th7Hq2mP9xRt/use").await, vec![json!({ "deck": DECK })]);
    let edits = bodies(&server, "POST", &format!("/v1/decks/{DECK}/edits")).await;
    let theme = &edits[0]["ops"][0]["set"]["theme"];
    assert_eq!(theme["name"], "Brand");
    assert_eq!(theme["customFonts"][0]["src"], "asset:as7Hq2mP9xRt");
    assert_eq!(theme["colors"]["muted"], "#777777");

    // Unknown names say what exists.
    let (ok, err) = cli(home.path(), &["theme", DECK, "Nope"]).await;
    assert!(!ok);
    assert_eq!(err["error"]["code"], "unknown_theme");
    assert!(err["error"]["hint"].as_str().unwrap().contains("\"Brand\""));

    // --save alone saves without changing the deck.
    let (ok, saved) = cli(home.path(), &["theme", DECK, "--save", "Launch"]).await;
    assert!(ok);
    assert_eq!(saved["name"], "Launch");
    assert_eq!(bodies(&server, "POST", "/v1/themes").await, vec![json!({ "deck": DECK, "name": "Launch" })]);
    assert_eq!(bodies(&server, "POST", &format!("/v1/decks/{DECK}/edits")).await.len(), 1);

    let (ok, _) = cli(home.path(), &["theme", "--rename", "Brand", "--to", "Brand 2"]).await;
    assert!(ok);
    assert_eq!(bodies(&server, "PATCH", "/v1/themes/th7Hq2mP9xRt").await, vec![json!({ "name": "Brand 2" })]);
    let (ok, deleted) = cli(home.path(), &["theme", "--delete", "th7Hq2mP9xRt"]).await;
    assert!(ok);
    assert_eq!(deleted["deleted"], "th7Hq2mP9xRt");
    let (ok, err) = cli(home.path(), &["theme", "--delete", "Missing"]).await;
    assert!(!ok);
    assert_eq!(err["error"]["code"], "theme_not_found");
}
