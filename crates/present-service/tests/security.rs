//! Regression coverage for the recovered security review. Every endpoint and resource is local.
mod common;
use common::*;
use serde_json::{Value, json};

#[tokio::test]
async fn revoked_live_stream_stops_before_later_content_and_roles_refresh() {
    let s = Stack::start().await;
    let owner = s.person("c:owner");
    let viewer = s.person("c:viewer");
    let id = s.deck(&owner, "Private notes").await;
    s.share("decks", &id, &owner, &viewer.handle, "editor").await;
    let mut stream = Sse::connect(&format!("{}/v1/decks/{id}/live", s.url), Some(&viewer.token)).await;
    stream.next("sync").await;
    assert_eq!(s.req("PATCH", &format!("/v1/decks/{id}/access/{}", viewer.uuid), Some(&owner), Some(json!({"role":"viewer"}))).await.0, 200);
    assert_eq!(stream.next("deck").await.data["role"], "viewer");
    assert_eq!(s.req("DELETE", &format!("/v1/decks/{id}/access/{}", viewer.uuid), Some(&owner), None).await.0, 204);
    assert_eq!(s.edits(&id, &owner, json!([{"op":"add_slide","slide":{"notes":"SECRET AFTER REVOCATION"}}])).await.0, 200);
    let event = loop {
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), stream.rx.recv()).await.unwrap().unwrap();
        if event.event != "ping" { break event; }
    };
    assert_eq!(event.event, "deck");
    assert!(event.data["role"].is_null());
    assert!(tokio::time::timeout(std::time::Duration::from_secs(5), stream.rx.recv()).await.unwrap().is_none());
    drop(stream);
    s.stop().await;
}

#[tokio::test]
async fn anonymous_live_stream_loses_access_when_public_link_is_disabled() {
    let s = Stack::start().await;
    let owner = s.person("c:owner");
    let id = s.deck(&owner, "Public then private").await;
    assert_eq!(s.req("PUT", &format!("/v1/decks/{id}/public"), Some(&owner), Some(json!({"mode":"view"}))).await.0, 200);
    let mut stream = Sse::connect(&format!("{}/v1/decks/{id}/live", s.url), None).await;
    stream.next("sync").await;
    assert_eq!(s.req("PUT", &format!("/v1/decks/{id}/public"), Some(&owner), Some(json!({"mode":"off"}))).await.0, 200);
    let event = stream.next("deck").await;
    assert!(event.data["role"].is_null());
    drop(stream);
    s.stop().await;
}

#[tokio::test]
async fn viewers_cannot_export_or_render_history_but_can_read_latest() {
    let s = Stack::start().await;
    let owner = s.person("c:owner");
    let viewer = s.person("c:viewer");
    let id = s.deck(&owner, "History").await;
    s.share("decks", &id, &owner, &viewer.handle, "viewer").await;
    let original = s.content(&id, &owner).await;
    let slide = original["slides"][0]["id"].as_str().unwrap();
    assert_eq!(s.edits(&id, &owner, json!([{"op":"add_slide","slide":{"notes":"current"}}])).await.0, 200);
    for path in [format!("/v1/decks/{id}/export?format=pdf"), format!("/v1/decks/{id}/slides/{slide}/render?format=png")] {
        assert_eq!(s.get(&format!("{path}&version=1"), Some(&viewer)).await.0, 403);
        assert_eq!(s.get(&format!("{path}&version=2"), Some(&viewer)).await.0, 200);
        assert_eq!(s.get(&format!("{path}&version=1"), Some(&owner)).await.0, 200);
    }
    s.stop().await;
}

#[tokio::test]
async fn uploads_are_sandboxed_and_presence_is_bounded() {
    let s = Stack::start().await;
    let owner = s.person("c:owner");
    let id = s.deck(&owner, "Assets").await;
    for (content_type, disposition) in [("text/html", "attachment"), ("image/svg+xml", "inline"), ("application/javascript", "attachment"), ("image/png", "inline")] {
        let response = s.http.post(format!("{}/v1/decks/{id}/assets", s.url)).bearer_auth(&owner.token).header("content-type", content_type).body("<script>fetch('/api/v1/decks')</script>").send().await.unwrap();
        assert_eq!(response.status(), 201);
        let asset: Value = response.json().await.unwrap();
        let response = s.http.get(format!("{}/v1/assets/{}", s.url, asset["id"].as_str().unwrap())).bearer_auth(&owner.token).send().await.unwrap();
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert!(response.headers()["content-security-policy"].to_str().unwrap().starts_with("sandbox;"));
        assert!(response.headers()["content-disposition"].to_str().unwrap().starts_with(disposition));
    }
    let path = format!("/v1/decks/{id}/presence");
    assert_eq!(s.post(&path, &owner, json!({"session":"invalid","cursor":{"blob":"arbitrary"}})).await.0, 400);
    assert_eq!(s.post(&path, &owner, json!({"session":"invalid","selection":["x".repeat(201)]})).await.0, 400);
    for i in 0..8 { assert_eq!(s.post(&path, &owner, json!({"session":format!("tab-{i}"),"cursor":{"x":10,"y":20}})).await.0, 200); }
    assert_eq!(s.post(&path, &owner, json!({"session":"tab-overflow"})).await.0, 429);
    assert_eq!(s.post(&path, &owner, json!({"session":"tab-0"})).await.0, 200);
    s.stop().await;
}
