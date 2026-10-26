//! Email-gated public links: every content path is protected, entered email is not authentication,
//! viewer history is owner-only, and existing streams recheck the requirement before sending content.
mod common;

use common::*;
use serde_json::{Value, json};
use std::time::Duration;

const EMAIL_HEADER: &str = "x-present-viewer-email";

async fn public(s: &Stack, deck: &str, owner: &Person, mode: &str, required: bool) {
    let (status, body) = s
        .req(
            "PUT",
            &format!("/v1/decks/{deck}/public"),
            Some(owner),
            Some(json!({"mode":mode,"requireEmail":required})),
        )
        .await;
    assert_eq!(status, 200, "{body}");
}

async fn guest(s: &Stack, path: &str, email: &str) -> (u16, Value) {
    s.req_h("GET", path, None, None, &[(EMAIL_HEADER, email)])
        .await
        .0
}

async fn viewers(s: &Stack, deck: &str, owner: &Person) -> Vec<Value> {
    let (status, body) = s
        .get(&format!("/v1/decks/{deck}/viewers"), Some(owner))
        .await;
    assert_eq!(status, 200, "{body}");
    body["viewers"].as_array().expect("viewers array").clone()
}

async fn asset(s: &Stack, deck: &str, owner: &Person) -> String {
    let response = s
        .http
        .post(format!("{}/v1/decks/{deck}/assets", s.url))
        .bearer_auth(&owner.token)
        .header("content-type", "image/png")
        .body(PNG)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 201);
    response.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn presentation(s: &Stack, deck: &str, owner: &Person) -> String {
    let (status, body) = s
        .post(&format!("/v1/decks/{deck}/presentations"), owner, json!({}))
        .await;
    assert_eq!(status, 201, "{body}");
    body["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn every_public_read_and_head_requires_email_but_converter_capabilities_still_work() {
    let s = Stack::start().await;
    let owner = s.person("c:owner");
    let id = s.deck(&owner, "Gated content").await;
    let slide = s.content(&id, &owner).await["slides"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let asset = asset(&s, &id, &owner).await;
    let pid = presentation(&s, &id, &owner).await;
    public(&s, &id, &owner, "view", true).await;
    let paths = [
        format!("/v1/decks/{id}"),
        format!("/v1/decks/{id}/content"),
        format!("/v1/decks/{id}/threads"),
        format!("/v1/decks/{id}/presentations"),
        format!("/v1/decks/{id}/live"),
        format!("/v1/decks/{id}/export?format=pdf"),
        format!("/v1/decks/{id}/slides/{slide}/render?format=png"),
        format!("/v1/assets/{asset}"),
        format!("/v1/presentations/{pid}"),
        format!("/v1/presentations/{pid}/live"),
    ];
    for path in &paths {
        let (status, body) = s.get(path, None).await;
        assert_eq!(status, 403, "GET {path}: {body}");
        assert_eq!(body["error"]["code"], "email_required", "{path}: {body}");
        let ((status, _), _) = s.req_h("HEAD", path, None, None, &[]).await;
        assert_eq!(status, 403, "HEAD {path}");
    }
    assert_eq!(s.get(&format!("/v1/decks/{id}/content?email=pretend@example.test&viewer_email=pretend@example.test"), None).await.0, 403);
    let ((status, _), _) = s
        .req_h(
            "GET",
            &format!("/v1/assets/{asset}"),
            None,
            None,
            &[("range", "bytes=0-3")],
        )
        .await;
    assert_eq!(status, 403);
    assert!(viewers(&s, &id, &owner).await.is_empty());

    // Neither title metadata nor background/image requests constitute a view.
    assert_eq!(
        guest(&s, &format!("/v1/decks/{id}"), "guest@example.test")
            .await
            .0,
        200
    );
    assert_eq!(
        guest(&s, &format!("/v1/assets/{asset}"), "guest@example.test")
            .await
            .0,
        200
    );
    assert!(viewers(&s, &id, &owner).await.is_empty());
    for path in paths.iter().filter(|path| !path.ends_with("/live")) {
        assert_eq!(guest(&s, path, "guest@example.test").await.0, 200, "{path}");
    }
    assert_eq!(viewers(&s, &id, &owner).await[0]["views"], 1);

    // Only the converter receives this short-lived deck-scoped capability. Normal asset URLs still gate.
    let signed_base = s
        .converter
        .calls
        .lock()
        .unwrap()
        .iter()
        .find_map(|(_, body)| body["assetBase"].as_str().map(str::to_owned))
        .unwrap();
    let signed = s
        .http
        .get(format!("{signed_base}{asset}"))
        .send()
        .await
        .unwrap();
    assert_eq!(signed.status(), 200);
    assert_eq!(signed.bytes().await.unwrap().as_ref(), PNG);
    assert_eq!(
        s.get(
            &format!("/v1/assets/{asset}?deck={id}&exp=9999999999&sig=forged"),
            None
        )
        .await
        .0,
        403
    );
    s.stop().await;
}

#[tokio::test]
async fn owner_history_distinguishes_account_and_entered_email_and_deduplicates_visits() {
    let s = Stack::start().await;
    let owner = s.person_with("c:owner", Some("owner@example.test"));
    let account = s.person_with("c:reader", Some("Account@Example.Test"));
    let no_email = s.person("si:no-email");
    let id = s.deck(&owner, "Viewer identities").await;
    public(&s, &id, &owner, "view", true).await;
    let content = format!("/v1/decks/{id}/content");
    assert_eq!(s.get(&content, Some(&owner)).await.0, 200);
    assert!(viewers(&s, &id, &owner).await.is_empty());

    // This is the account's first request: an async profile refresh must not let the header win.
    let ((status, body), _) = s
        .req_h(
            "GET",
            &content,
            Some(&account),
            None,
            &[(EMAIL_HEADER, "forged@example.test")],
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let first = viewers(&s, &id, &owner).await;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["email"], "account@example.test");
    assert_eq!(first[0]["source"], "account");
    assert_eq!(guest(&s, &content, "account@example.test").await.0, 200);
    let same_email = viewers(&s, &id, &owner).await;
    assert_eq!(
        same_email.len(),
        2,
        "entered and account provenance remain separate for the same email"
    );
    assert!(same_email.iter().any(|row| row["source"] == "entered"));
    assert!(same_email.iter().any(|row| row["source"] == "account"));

    let (status, body) = s.get(&content, Some(&no_email)).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["error"]["code"], "email_required");
    assert_eq!(
        s.req_h(
            "GET",
            &content,
            Some(&no_email),
            None,
            &[(EMAIL_HEADER, "Entered@Example.Test")]
        )
        .await
        .0
        .0,
        200
    );
    assert_eq!(guest(&s, &content, "ENTERED@example.test").await.0, 200);
    assert_eq!(guest(&s, &content, "entered@example.test").await.0, 200);
    let rows = viewers(&s, &id, &owner).await;
    assert_eq!(rows.len(), 3);
    let entered = rows
        .iter()
        .find(|row| row["email"] == "entered@example.test")
        .unwrap();
    assert_eq!(entered["source"], "entered");
    assert_eq!(entered["views"], 1);
    assert!(entered["firstViewedAt"].as_str().is_some());
    assert!(entered["lastViewedAt"].as_str().is_some());
    sqlx::query("update deck_viewers set last_counted_at = now() - interval '31 minutes' where deck = $1 and email = $2")
        .bind(&id).bind("entered@example.test").execute(&s.pool).await.unwrap();
    assert_eq!(guest(&s, &content, "entered@example.test").await.0, 200);
    assert_eq!(
        viewers(&s, &id, &owner)
            .await
            .iter()
            .find(|row| row["email"] == "entered@example.test")
            .unwrap()["views"],
        2
    );

    s.share("decks", &id, &owner, &account.handle, "editor")
        .await;
    let list = format!("/v1/decks/{id}/viewers");
    assert_eq!(s.get(&list, Some(&account)).await.0, 403);
    assert_eq!(guest(&s, &list, "owner@example.test").await.0, 401);
    let (status, body) = s
        .req(
            "PUT",
            &format!("/v1/decks/{id}/public"),
            Some(&account),
            Some(json!({"mode":"view","requireEmail":false})),
        )
        .await;
    assert_eq!(status, 403, "{body}");
    s.stop().await;
}

#[tokio::test]
async fn entered_email_never_grants_write_or_private_access_and_inherited_public_decks_gate() {
    let s = Stack::start().await;
    let owner = s.person("c:owner");
    let shared = s.person("c:shared-without-email");
    let id = s.deck(&owner, "Public permissions").await;
    public(&s, &id, &owner, "edit", true).await;
    assert_eq!(
        guest(&s, &format!("/v1/decks/{id}/content"), "owner@example.test")
            .await
            .0,
        200
    );
    let ((status, _), _) = s
        .req_h(
            "POST",
            &format!("/v1/decks/{id}/edits"),
            None,
            Some(json!({"ops":[{"op":"add_slide","slide":{}}]})),
            &[(EMAIL_HEADER, "owner@example.test")],
        )
        .await;
    assert_eq!(status, 401);
    public(&s, &id, &owner, "off", true).await;
    assert_eq!(
        guest(&s, &format!("/v1/decks/{id}/content"), "owner@example.test")
            .await
            .0,
        401
    );
    s.share("decks", &id, &owner, &shared.handle, "viewer")
        .await;
    assert_eq!(
        s.get(&format!("/v1/decks/{id}/content"), Some(&shared))
            .await
            .0,
        200,
        "the requirement is inactive on a private deck"
    );
    public(&s, &id, &owner, "view", true).await;
    assert_eq!(
        s.get(&format!("/v1/decks/{id}/content"), Some(&shared))
            .await
            .0,
        403,
        "public gated links include non-owner collaborators"
    );

    let (status, folder) = s
        .post("/v1/folders", &owner, json!({"name":"Public folder"}))
        .await;
    assert_eq!(status, 201, "{folder}");
    let folder = folder["id"].as_str().unwrap();
    assert_eq!(
        s.req(
            "PUT",
            &format!("/v1/folders/{folder}/public"),
            Some(&owner),
            Some(json!({"mode":"view"}))
        )
        .await
        .0,
        200
    );
    let (status, inside) = s
        .post(
            "/v1/decks",
            &owner,
            json!({"title":"Inherited public link","folder":folder}),
        )
        .await;
    assert_eq!(status, 201, "{inside}");
    let inside = inside["id"].as_str().unwrap();
    public(&s, inside, &owner, "off", true).await;
    assert_eq!(
        s.get(&format!("/v1/decks/{inside}/content"), None).await.0,
        403
    );
    assert_eq!(
        guest(
            &s,
            &format!("/v1/decks/{inside}/content"),
            "guest@example.test"
        )
        .await
        .0,
        200
    );
    s.stop().await;
}

#[tokio::test]
async fn enabling_email_requirement_revokes_open_deck_and_follow_streams_before_more_content() {
    let s = Stack::start().await;
    let owner = s.person("c:owner");
    let id = s.deck(&owner, "Live gate").await;
    let pid = presentation(&s, &id, &owner).await;
    public(&s, &id, &owner, "view", false).await;
    let mut deck_stream = Sse::connect(&format!("{}/v1/decks/{id}/live", s.url), None).await;
    let mut follow = Sse::connect(&format!("{}/v1/presentations/{pid}/live", s.url), None).await;
    deck_stream.next("sync").await;
    follow.next("state").await;
    public(&s, &id, &owner, "view", true).await;
    assert_eq!(
        s.edits(
            &id,
            &owner,
            json!([{"op":"add_slide","slide":{"notes":"PRIVATE AFTER GATE"}}])
        )
        .await
        .0,
        200
    );
    assert_eq!(
        s.req(
            "PUT",
            &format!("/v1/presentations/{pid}"),
            Some(&owner),
            Some(json!({"step":7}))
        )
        .await
        .0,
        200
    );
    let deck_event = next_content(&mut deck_stream).await;
    assert_eq!(deck_event.event, "deck");
    assert!(deck_event.data["role"].is_null());
    let follow_event = next_content(&mut follow).await;
    assert_eq!(follow_event.event, "ended");
    assert!(follow_event.data["role"].is_null());
    assert!(
        tokio::time::timeout(Duration::from_secs(5), deck_stream.rx.recv())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(5), follow.rx.recv())
            .await
            .unwrap()
            .is_none()
    );
    drop((deck_stream, follow));
    s.stop().await;
}

async fn next_content(stream: &mut Sse) -> Ev {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = stream
                .rx
                .recv()
                .await
                .expect("stream ended before its revocation event");
            if event.event != "ping" {
                return event;
            }
        }
    })
    .await
    .unwrap()
}

/// A bounded streaming reader so guest headers are exercised without changing the shared harness.
struct GuestStream {
    response: reqwest::Response,
    pending: String,
}

impl GuestStream {
    async fn connect(s: &Stack, path: &str) -> Self {
        let response = s
            .http
            .get(format!("{}{path}", s.url))
            .header(EMAIL_HEADER, "stream@example.test")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        Self {
            response,
            pending: String::new(),
        }
    }

    async fn next(&mut self, wanted: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                while let Some(end) = self.pending.find("\n\n") {
                    let block = self.pending[..end].to_owned();
                    self.pending.drain(..end + 2);
                    let event = block
                        .lines()
                        .find_map(|line| line.strip_prefix("event:"))
                        .map(str::trim)
                        .unwrap_or("message");
                    if event == "ended" {
                        panic!("identified guest unexpectedly revoked: {block}");
                    }
                    if event == wanted {
                        let data = block
                            .lines()
                            .filter_map(|line| line.strip_prefix("data:"))
                            .collect::<Vec<_>>()
                            .join("\n");
                        return serde_json::from_str(&data).unwrap();
                    }
                }
                let chunk = self
                    .response
                    .chunk()
                    .await
                    .unwrap()
                    .expect("guest stream closed");
                self.pending.push_str(&String::from_utf8_lossy(&chunk));
            }
        })
        .await
        .expect("guest stream event within five seconds")
    }
}

#[tokio::test]
async fn guest_identity_survives_stream_rechecks_and_reconnect_without_extra_view_counts() {
    let s = Stack::start().await;
    let owner = s.person("c:owner");
    let id = s.deck(&owner, "Identified stream").await;
    let pid = presentation(&s, &id, &owner).await;
    public(&s, &id, &owner, "view", true).await;
    let path = format!("/v1/decks/{id}/live");
    let mut deck_stream = GuestStream::connect(&s, &path).await;
    deck_stream.next("sync").await;
    let mut follow = GuestStream::connect(&s, &format!("/v1/presentations/{pid}/live")).await;
    follow.next("state").await;
    assert_eq!(
        s.edits(
            &id,
            &owner,
            json!([{"op":"add_slide","slide":{"notes":"STILL PUBLIC TO THIS GUEST"}}])
        )
        .await
        .0,
        200
    );
    deck_stream.next("update").await;
    deck_stream.next("ping").await;
    assert_eq!(
        s.req(
            "PUT",
            &format!("/v1/presentations/{pid}"),
            Some(&owner),
            Some(json!({"step":3}))
        )
        .await
        .0,
        200
    );
    assert_eq!(follow.next("state").await["step"], 3);
    drop(deck_stream);
    let mut again = GuestStream::connect(&s, &path).await;
    again.next("sync").await;
    let list = viewers(&s, &id, &owner).await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["email"], "stream@example.test");
    assert_eq!(list[0]["views"], 1);
    drop((again, follow));
    s.stop().await;
}

#[tokio::test]
async fn invalid_email_and_failed_content_requests_do_not_record_views() {
    let s = Stack::start().await;
    let owner = s.person("c:owner");
    let id = s.deck(&owner, "Failed views").await;
    public(&s, &id, &owner, "view", true).await;
    for email in ["not-an-email", "a@", "@example.test", "a b@example.test"] {
        let (status, _) = guest(&s, &format!("/v1/decks/{id}/content"), email).await;
        assert!(
            (400..500).contains(&status),
            "accepted invalid email: {email}"
        );
    }
    assert_eq!(
        guest(
            &s,
            &format!("/v1/decks/{id}/export?format=unknown"),
            "failed@example.test"
        )
        .await
        .0,
        400
    );
    assert_eq!(
        guest(
            &s,
            &format!("/v1/decks/{id}/slides/missing/render"),
            "failed@example.test"
        )
        .await
        .0,
        404
    );
    assert!(viewers(&s, &id, &owner).await.is_empty());
    s.stop().await;
}
