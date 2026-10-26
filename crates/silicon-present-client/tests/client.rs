//! The package against a mock Silicon Present: every route sends what the architecture says and
//! reads what the service answers.

use serde_json::{Value, json};
use silicon_present_client::ops::{EditRequest, Op};
use silicon_present_client::{Anchor, Client, NewDeck, PublicMode, RenderOptions, ResourceKind, Role, Scope, Secret};
use wiremock::matchers::{body_json, body_partial_json, header, method, path, query_param};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

async fn setup() -> (MockServer, Client) {
    let server = MockServer::start().await;
    let client = Client::new(&server.uri()).unwrap().with_token(Secret::new("tok"));
    (server, client)
}

fn deck(id: &str, title: &str) -> Value {
    json!({ "id": id, "title": title, "owner": { "uuid": "u1", "id": "si:writer", "kind": "silicon", "displayName": "Writer" },
            "creator": null, "folder": null, "publicMode": "off", "role": "owner", "version": 3, "trashedAt": null,
            "createdAt": "2026-10-17T00:00:00Z", "updatedAt": "2026-10-17T00:00:00Z", "link": "http://x/decks/1" })
}

#[tokio::test]
async fn decks_are_listed_created_and_read_with_the_token() {
    let (server, c) = setup().await;
    Mock::given(method("GET"))
        .and(path("/v1/decks"))
        .and(query_param("scope", "shared"))
        .and(header("authorization", "Bearer tok"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "decks": [deck("dk7Hq2mP9xRt", "Q4")] })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/decks"))
        .and(body_json(json!({ "title": "New", "from": { "deck": "dk7Hq2mP9xRt", "version": 2 } })))
        .respond_with(ResponseTemplate::new(201).set_body_json(deck("dkNEWdeck123", "New")))
        .mount(&server)
        .await;
    let list = c.decks(Scope::Shared, None).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].public.as_deref(), Some("off"));
    assert_eq!(list[0].owner.as_ref().unwrap().display_name, "Writer");
    assert_eq!(list[0].extra["link"], "http://x/decks/1");
    let new = c
        .create_deck(&NewDeck {
            title: Some("New".into()),
            folder: None,
            from: Some(silicon_present_client::FromVersion { deck: "dk7Hq2mP9xRt".into(), version: Some(2) }),
        })
        .await
        .unwrap();
    assert_eq!(new.id, "dkNEWdeck123");
}

#[tokio::test]
async fn errors_carry_code_message_hint_and_request_id() {
    let (server, c) = setup().await;
    Mock::given(method("GET"))
        .and(path("/v1/decks/missingdeck1"))
        .respond_with(
            ResponseTemplate::new(404)
                .insert_header("x-request-id", "req-9")
                .set_body_json(json!({ "error": { "code": "deck_not_found", "message": "No deck `missingdeck1`.", "hint": "Check the id." } })),
        )
        .mount(&server)
        .await;
    let e = c.deck("missingdeck1").await.unwrap_err();
    assert_eq!(e.code(), "deck_not_found");
    assert_eq!(e.status(), Some(404));
    assert_eq!(e.hint(), Some("Check the id."));
    assert_eq!(e.request_id(), Some("req-9"));
}

#[tokio::test]
async fn unreachable_service_is_a_transport_error_with_a_hint() {
    let c = Client::new("http://127.0.0.1:9").unwrap();
    let e = c.me().await.unwrap_err();
    assert_eq!(e.code(), "connection_failed");
    assert!(e.hint().unwrap().contains("--api-url"));
}

#[tokio::test]
async fn content_comes_as_json_or_text() {
    let (server, c) = setup().await;
    Mock::given(method("GET"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/content"))
        .and(query_param("format", "json"))
        .and(query_param("version", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "dk7Hq2mP9xRt", "version": 2, "slides": [] })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/content"))
        .and(query_param("format", "text"))
        .and(query_param("comments", "false"))
        .respond_with(ResponseTemplate::new(200).insert_header("content-type", "text/plain; charset=utf-8").set_body_string("Slide 1\n"))
        .mount(&server)
        .await;
    assert_eq!(c.content("dk7Hq2mP9xRt", Some(2)).await.unwrap()["version"], 2);
    assert_eq!(c.content_text("dk7Hq2mP9xRt", None, false).await.unwrap(), "Slide 1\n");
}

#[tokio::test]
async fn edits_send_ops_with_base_and_read_the_outcome() {
    let (server, c) = setup().await;
    Mock::given(method("POST"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/edits"))
        .and(body_json(json!({ "base": 4, "summary": "Fix", "ops": [
            { "op": "update_slide", "slide": "s_aaaaaa", "set": { "skipped": true } },
            { "op": "delete_element", "slide": "s_aaaaaa", "element": "e_bbbbbb" }
        ]})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "version": 6, "changed": true, "summary": "si:writer changed slide 1", "touched": ["s_aaaaaa"],
            "slidesAdded": [], "elementsAdded": [], "replacements": 0
        })))
        .mount(&server)
        .await;
    let mut set = serde_json::Map::new();
    set.insert("skipped".into(), json!(true));
    let req = EditRequest::new(vec![
        Op::UpdateSlide { slide: "s_aaaaaa".into(), set },
        Op::DeleteElement { slide: "s_aaaaaa".into(), element: "e_bbbbbb".into() },
    ])
    .on(4)
    .summary("Fix");
    let out = c.edit("dk7Hq2mP9xRt", &req).await.unwrap();
    assert_eq!(out.version, 6);
    assert_eq!(out.touched, vec!["s_aaaaaa"]);
}

#[tokio::test]
async fn retryable_edits_send_the_supplied_key_with_the_exact_body() {
    let (server, c) = setup().await;
    let request = EditRequest::new(vec![Op::DeleteSlide { slide: "s_aaaaaa".into() }]).on(4);
    Mock::given(method("POST"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/edits"))
        .and(header("idempotency-key", "push:stable"))
        .and(body_json(serde_json::to_value(&request).unwrap()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"version":5,"changed":true})))
        .expect(2).mount(&server).await;
    for _ in 0..2 {
        assert_eq!(c.edit_idempotent("dk7Hq2mP9xRt", &request, "push:stable").await.unwrap().version, 5);
    }
}

#[tokio::test]
async fn uploads_send_raw_bytes_with_type_and_name() {
    let (server, c) = setup().await;
    Mock::given(method("POST"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/assets"))
        .and(header("content-type", "image/png"))
        .and(header("x-filename", "my%20photo.png"))
        .respond_with(|req: &Request| {
            assert_eq!(req.body, b"\x89PNG");
            ResponseTemplate::new(201).set_body_json(json!({ "id": "as1234567890", "url": "/v1/assets/as1234567890", "contentType": "image/png", "size": 4 }))
        })
        .mount(&server)
        .await;
    let a = c.upload_asset("dk7Hq2mP9xRt", "my photo.png", "image/png", b"\x89PNG".to_vec()).await.unwrap();
    assert_eq!(a.reference(), "asset:as1234567890");
    assert_eq!(a.content_type, "image/png");
}

#[tokio::test]
async fn exports_and_renders_download_files() {
    let (server, c) = setup().await;
    Mock::given(method("GET"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/export"))
        .and(query_param("format", "pdf"))
        .and(query_param("version", "3"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/pdf")
                .insert_header("content-disposition", "attachment; filename=\"Q4.pdf\"; filename*=UTF-8''Q4%20review.pdf")
                .set_body_bytes(b"%PDF-1.7".to_vec()),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/slides/s_aaaaaa/render"))
        .and(query_param("format", "png"))
        .and(query_param("width", "960"))
        .and(query_param("at", "3000"))
        .respond_with(ResponseTemplate::new(200).insert_header("content-type", "image/png").set_body_bytes(b"\x89PNG\r\n".to_vec()))
        .mount(&server)
        .await;
    let f = c.export("dk7Hq2mP9xRt", "pdf", Some(3), None).await.unwrap();
    assert_eq!(f.filename.as_deref(), Some("Q4 review.pdf"));
    assert!(f.bytes.starts_with(b"%PDF"));
    let img = c
        .render("dk7Hq2mP9xRt", "s_aaaaaa", &RenderOptions { format: None, width: Some(960), version: None, at: Some(3000) })
        .await
        .unwrap();
    assert_eq!(img.content_type, "image/png");
}

#[tokio::test]
async fn comments_send_anchors_exactly() {
    let (server, c) = setup().await;
    Mock::given(method("POST"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/threads"))
        .and(body_json(json!({ "body": "@si:designer simpler", "anchor": {
            "kind": "area", "slide": "s_aaaaaa", "x": 100.0, "y": 100.0, "w": 600.0, "h": 400.0, "element": "e_cccccc", "ex": 0.0, "ey": 0.0, "ew": 1.0, "eh": 1.0
        }})))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "id": "th1234567890", "state": "open", "anchor": { "kind": "area", "snapshot": { "slideNumber": 1 } },
            "comments": [{ "id": "cm1234567890", "body": "@si:designer simpler", "author": { "uuid": "u", "id": "c:ada", "kind": "carbon" }, "reactions": [] }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/v1/comments/cm1234567890/reactions/%F0%9F%91%8D"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/threads"))
        .and(query_param("state", "all"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "threads": [{ "id": "th1234567890", "state": "resolved", "snapshot": { "label": "Chart" },
            "comments": [{ "id": "cm0000000001", "body": null, "deleted": true, "author": null, "reactions": [] }] }] })))
        .mount(&server)
        .await;
    let anchor = Anchor::Area {
        slide: "s_aaaaaa".into(),
        x: 100.0,
        y: 100.0,
        w: 600.0,
        h: 400.0,
        element: Some("e_cccccc".into()),
        ex: Some(0.0),
        ey: Some(0.0),
        ew: Some(1.0),
        eh: Some(1.0),
    };
    let t = c.comment("dk7Hq2mP9xRt", &anchor, "@si:designer simpler").await.unwrap();
    assert_eq!(t.comments[0].author.as_ref().unwrap().id, "c:ada");
    assert!(c.react("cm1234567890", "👍", false).await.unwrap().is_null());
    let threads = c.threads("dk7Hq2mP9xRt", "all").await.unwrap();
    assert_eq!(threads[0].state, "resolved");
    assert!(threads[0].comments[0].deleted && threads[0].comments[0].body.is_empty());
    assert_eq!(threads[0].extra["snapshot"]["label"], "Chart");
    assert_eq!(serde_json::to_value(Anchor::Deck).unwrap(), json!({ "kind": "deck" }));
}

#[tokio::test]
async fn sharing_public_and_transfers() {
    let (server, c) = setup().await;
    Mock::given(method("POST"))
        .and(path("/v1/folders/fd1234567890/access"))
        .and(body_json(json!({ "to": "ada@example.test", "role": "viewer" })))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "member": "email:ada@example.test", "account": null, "email": "ada@example.test", "pending": true, "role": "viewer", "via": null
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/access"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "owner": { "uuid": "u1", "id": "si:writer", "kind": "silicon" }, "publicMode": "view", "role": "owner",
            "members": [{ "member": "u2", "account": { "uuid": "u2", "id": "c:ada", "kind": "carbon" }, "role": "editor", "via": { "kind": "folder", "id": "fd1", "name": "Clients" } }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/public"))
        .and(body_json(json!({ "mode": "comment" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "publicMode": "comment", "link": "x" })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/transfers"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "incoming": [{ "id": "tr1234567890", "resource": { "kind": "deck", "id": "dk7Hq2mP9xRt", "name": "Q4" }, "state": "pending" }],
            "outgoing": []
        })))
        .mount(&server)
        .await;
    let m = c.share(ResourceKind::Folder, "fd1234567890", "ada@example.test", Role::Viewer).await.unwrap();
    assert_eq!(m.key().as_deref(), Some("email:ada@example.test"));
    let a = c.access(ResourceKind::Deck, "dk7Hq2mP9xRt").await.unwrap();
    assert_eq!(a.public.as_deref(), Some("view"));
    assert_eq!(a.members[0].key().as_deref(), Some("u2"));
    assert_eq!(c.set_public("dk7Hq2mP9xRt", PublicMode::Comment).await.unwrap()["publicMode"], "comment");
    let t = c.transfers(false).await.unwrap();
    assert_eq!(t.incoming[0].name(), "Q4");
    assert_eq!(t.incoming[0].resource_id(), "dk7Hq2mP9xRt");
}

#[tokio::test]
async fn versions_restore_and_undo() {
    let (server, c) = setup().await;
    Mock::given(method("GET"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/versions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "versions": [{ "version": 9, "from": 7, "author": { "uuid": "u", "id": "si:writer", "kind": "silicon" }, "summary": "si:writer changed slide 2", "change": "changed slide 2", "name": "Sent" }],
            "events": [{ "id": 1, "kind": "deck.renamed" }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/restore"))
        .and(body_json(json!({ "version": 3, "slide": "s_aaaaaa" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "version": 10 })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/undo-account"))
        .and(body_json(json!({ "account": "si:intern", "since": 5 })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "version": 11 })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/versions/9/name"))
        .and(body_partial_json(json!({ "name": "Sent" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "version": 9, "name": "Sent" })))
        .mount(&server)
        .await;
    let v = c.versions("dk7Hq2mP9xRt").await.unwrap();
    assert_eq!((v[0].version, v[0].from, v[0].name.as_deref()), (9, Some(7), Some("Sent")));
    assert_eq!(c.restore("dk7Hq2mP9xRt", 3, Some("s_aaaaaa"), None).await.unwrap()["version"], 10);
    assert_eq!(c.undo_account("dk7Hq2mP9xRt", "si:intern", 5).await.unwrap()["version"], 11);
    assert_eq!(c.name_version("dk7Hq2mP9xRt", 9, "Sent").await.unwrap()["name"], "Sent");
}

#[tokio::test]
async fn presentations_start_move_and_stream() {
    let (server, c) = setup().await;
    Mock::given(method("POST"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/presentations"))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({ "id": "pr1234567890", "followUrl": "http://x/p/pr1234567890", "slide": "s_aaaaaa", "step": 0, "deck": "dk7Hq2mP9xRt" })))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/v1/presentations/pr1234567890"))
        .and(body_json(json!({ "slide": "s_bbbbbb", "step": 1 })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "pr1234567890", "slide": "s_bbbbbb", "step": 1 })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/presentations/pr1234567890/live"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string("event: state\ndata: {\"id\":\"pr1234567890\",\"slide\":\"s_bbbbbb\",\"step\":1}\n\nevent: ended\ndata: {}\n\n"),
        )
        .mount(&server)
        .await;
    let p = c.start_presentation("dk7Hq2mP9xRt", None).await.unwrap();
    assert_eq!(p.follow_url, "http://x/p/pr1234567890");
    assert_eq!(p.deck_id().as_deref(), Some("dk7Hq2mP9xRt"));
    let moved = c.move_presentation("pr1234567890", &json!("s_bbbbbb"), 1).await.unwrap();
    assert_eq!(moved.step, 1);
    let mut s = c.follow_presentation("pr1234567890").await.unwrap();
    let e = s.next().await.unwrap().unwrap();
    assert_eq!((e.event.as_str(), e.json()["step"].as_u64()), ("state", Some(1)));
    assert_eq!(s.next().await.unwrap().unwrap().event, "ended");
    assert!(s.next().await.unwrap().is_none());
}

#[tokio::test]
async fn the_live_stream_sends_the_session_and_parses_events() {
    let (server, c) = setup().await;
    Mock::given(method("GET"))
        .and(path("/v1/decks/dk7Hq2mP9xRt/live"))
        .and(query_param("session", "cli-1"))
        .respond_with(ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(
            "event: sync\ndata: {\"update\":\"AAA=\",\"sv\":\"AA==\",\"version\":3}\n\nevent: update\ndata: {\"version\":4,\"author\":{\"id\":\"c:ada\"},\"touched\":[\"s_aaaaaa\"]}\n\n",
        ))
        .mount(&server)
        .await;
    let mut s = c.live("dk7Hq2mP9xRt", None, Some("cli-1")).await.unwrap();
    assert_eq!(s.next().await.unwrap().unwrap().json()["version"], 3);
    let u = s.next().await.unwrap().unwrap();
    assert_eq!(u.event, "update");
    assert_eq!(u.json()["author"]["id"], "c:ada");
}

#[tokio::test]
async fn public_decks_are_read_without_a_token() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/decks/dk7Hq2mP9xRt"))
        .respond_with(|req: &Request| {
            assert!(!req.headers.contains_key("authorization"));
            ResponseTemplate::new(200).set_body_json(deck("dk7Hq2mP9xRt", "Public"))
        })
        .mount(&server)
        .await;
    let c = Client::new(&server.uri()).unwrap().with_token(Secret::new("tok")).anonymous();
    assert_eq!(c.deck("dk7Hq2mP9xRt").await.unwrap().title, "Public");
}
