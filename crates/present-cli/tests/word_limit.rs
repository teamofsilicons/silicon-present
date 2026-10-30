//! A slide takes up to 50 words from the CLI; adding text past that needs --dangerously-add-long-text.
use serde_json::{Value, json};
use std::{path::Path, process::Command};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const DECK: &str = "dk7Hq2mP9xRt";

/// Runs the CLI and returns (success, JSON output).
async fn cli(home: &Path, args: &[&str]) -> (bool, Value) {
    let home = home.to_owned();
    let args: Vec<_> = args.iter().map(|a| a.to_string()).collect();
    let out = tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_present"))
            .env("SILICON_HOME", home)
            .env_remove("PRESENT_API_URL")
            .env_remove("ACCOUNTS_URL")
            .arg("--json")
            .args(args)
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    let text = if out.stdout.is_empty() { out.stderr } else { out.stdout };
    (out.status.success(), serde_json::from_slice(&text).unwrap_or(Value::Null))
}

fn words(n: usize) -> String {
    vec!["word"; n].join(" ")
}

fn text_element(id: &str, text: &str) -> Value {
    json!({ "id": id, "kind": "text", "x": 140, "y": 300, "w": 1640, "h": 200,
        "text": { "paragraphs": [{ "runs": [{ "text": text }] }] }, "style": {} })
}

/// A deck whose one slide has `n` words, a mock service for it, and a signed-in CLI home.
async fn setup(n: usize) -> (MockServer, tempfile::TempDir) {
    let server = MockServer::start().await;
    let content = json!({
        "id": DECK, "title": "Words", "version": 3, "size": { "width": 1920, "height": 1080 },
        "theme": { "name": "Paper", "fonts": { "heading": "Inter", "body": "Inter" }, "colors": { "accent": "#2f5bea" }, "customFonts": [] },
        "master": { "id": "master", "elements": [] },
        "slides": [{ "id": "s_one111", "layout": "blank", "elements": [text_element("e_body11", &words(n))] }],
    });
    Mock::given(method("GET")).and(path(format!("/v1/decks/{DECK}/content"))).respond_with(ResponseTemplate::new(200).set_body_json(content)).mount(&server).await;
    Mock::given(method("POST")).and(path(format!("/v1/decks/{DECK}/edits"))).respond_with(ResponseTemplate::new(200).set_body_json(json!({ "version": 4 }))).mount(&server).await;
    let root = tempfile::tempdir().unwrap();
    let api = server.uri();
    std::fs::create_dir(root.path().join(".present")).unwrap();
    std::fs::write(root.path().join(".present/state.json"), json!({"api_url":api,"accounts_url":api,"sign_ins":{&api:{
        "accounts_url":api,"app_id":"present","access_token":"test","refresh_token":"test","expires_at":4102444800_i64,
        "account":{"uuid":"test","id":"si:test","kind":"silicon"},"method":"slt","signed_in_at":0
    }}}).to_string()).unwrap();
    (server, root)
}

async fn edits_sent(server: &MockServer) -> usize {
    server.received_requests().await.unwrap().iter().filter(|r| r.url.path().ends_with("/edits")).count()
}

fn refused(out: &(bool, Value)) {
    assert!(!out.0, "{}", out.1);
    assert_eq!(out.1["error"]["code"], "slide_too_text_heavy", "{}", out.1);
    let message = out.1["error"]["message"].as_str().unwrap();
    assert!(message.starts_with("This slide is getting too text heavy, prefer adding more graphical elements to convey the idea instead."), "{message}");
    assert_eq!(out.1["error"]["hint"], "If you still need to add this text element you can add it via --dangerously-add-long-text");
}

#[tokio::test]
async fn text_up_to_fifty_words_is_added() {
    let (server, home) = setup(45).await;
    let out = cli(home.path(), &["add", "text", DECK, "1", &words(5)]).await;
    assert!(out.0, "{}", out.1);
    assert_eq!(edits_sent(&server).await, 1);
}

#[tokio::test]
async fn text_past_fifty_words_is_refused_until_overridden() {
    let (server, home) = setup(45).await;
    refused(&cli(home.path(), &["add", "text", DECK, "1", &words(6)]).await);
    refused(&cli(home.path(), &["add", "shape", DECK, "1", "rect", "--text", &words(6)]).await);
    refused(&cli(home.path(), &["add", "table", DECK, "1", "--cell", &format!("0,0={}", words(3)), "--cell", &format!("1,1={}", words(3))]).await);
    assert_eq!(edits_sent(&server).await, 0);
    let out = cli(home.path(), &["add", "text", DECK, "1", &words(6), "--dangerously-add-long-text"]).await;
    assert!(out.0, "{}", out.1);
    assert_eq!(edits_sent(&server).await, 1);
}

#[tokio::test]
async fn graphics_and_punctuation_do_not_count() {
    let (server, home) = setup(50).await;
    assert!(cli(home.path(), &["add", "shape", DECK, "1", "ellipse"]).await.0);
    assert!(cli(home.path(), &["add", "chart", DECK, "1", "--labels", "A,B", "--series", "S=1,2"]).await.0);
    assert!(cli(home.path(), &["add", "text", DECK, "1", "• — •"]).await.0);
    assert_eq!(edits_sent(&server).await, 3);
}

#[tokio::test]
async fn a_new_slide_counts_its_layout_text() {
    let (server, home) = setup(0).await;
    refused(&cli(home.path(), &["slide", "add", DECK, "--title", "Plan", "--body", &words(50)]).await);
    assert!(cli(home.path(), &["slide", "add", DECK, "--title", "Plan", "--body", &words(49)]).await.0);
    assert_eq!(edits_sent(&server).await, 1);
}

#[tokio::test]
async fn set_text_is_checked_but_shortening_is_always_allowed() {
    let (server, home) = setup(60).await;
    refused(&cli(home.path(), &["set", DECK, "1", "e_body11", &format!("text={}", words(61))]).await);
    assert!(cli(home.path(), &["set", DECK, "1", "e_body11", &format!("text={}", words(55))]).await.0);
    assert_eq!(edits_sent(&server).await, 1);
}
