mod common;

use common::{Sse, Stack};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    time::Duration,
};

struct Standin {
    process: Child,
    url: String,
}
impl Drop for Standin {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}
impl Standin {
    async fn start() -> Self {
        let mut process = Command::new("node")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tools/ting-standin/server.mjs"))
            .env("TING_PORT", "0")
            .env("TING_VERIFY", "off")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(process.stdout.take().unwrap()).read_line(&mut ready).unwrap();
        let url = ready
            .split_whitespace()
            .find(|s| s.starts_with("http://"))
            .expect("stand-in address")
            .to_owned();
        let types: Vec<Value> = serde_json::from_str(include_str!("../../../deploy/ting-types.json")).unwrap();
        for kind in types {
            let response = reqwest::Client::new()
                .post(format!("{url}/v1/apps/present/types"))
                .bearer_auth("sap_test")
                .json(&kind)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 201, "{}", response.text().await.unwrap());
        }
        Self { process, url }
    }
}

#[tokio::test]
async fn live_sessions_are_bound_isolated_and_replaced_after_disconnect() {
    let ting = Standin::start().await;
    let s = Stack::start_with_receiver(&ting.url).await;
    let ada = s.person("c:ada");
    let outsider = s.person("c:other");
    assert_eq!(s.get("/v1/library/events", None).await.0, 401);
    let url = format!("{}/v1/library/events", s.url);
    let mut first = Sse::connect(&url, Some(&ada.token)).await;
    let mut second = Sse::connect(&format!("{url}?session_id=someone-elses-session"), Some(&ada.token)).await;
    let mut other = Sse::connect(&url, Some(&outsider.token)).await;
    let one = first.next("ready").await.data["session_id"].as_str().unwrap().to_owned();
    let two = second.next("ready").await.data["session_id"].as_str().unwrap().to_owned();
    let foreign = other.next("ready").await.data["session_id"].as_str().unwrap().to_owned();
    assert_ne!(one, two);
    assert_ne!(two, "someone-elses-session");
    let deck = s.deck(&ada, "A private title").await;
    assert_eq!(first.next("library").await.data, json!({}));
    assert_eq!(second.next("library").await.data, json!({}));
    let sent = s.ting.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 2);
    for ting in &sent {
        assert_eq!(ting.kind, "present.libraryChanged");
        assert_eq!(ting.data, json!({}));
        assert!(ting.session_id.as_ref().is_some_and(|id| id == &one || id == &two));
        assert!(ting.body().get("for").is_none() && ting.body().get("from").is_none());
        assert!(!ting.body().to_string().contains(&deck));
    }
    assert!(sent.iter().all(|t| t.session_id.as_deref() != Some(foreign.as_str())));

    // A disconnected address is removed; reconnect binds a fresh address before
    // its ready/reconciliation event. It cannot inherit the old session's work.
    s.http.delete(format!("{}/_sessions", ting.url)).send().await.unwrap();
    for _ in 0..100 {
        let count: i64 = sqlx::query_scalar("select count(*) from ting_library_sessions")
            .fetch_one(&s.pool)
            .await
            .unwrap();
        if count == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let count: i64 = sqlx::query_scalar("select count(*) from ting_library_sessions")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let mut reconnected = Sse::connect(&url, Some(&ada.token)).await;
    let replacement = reconnected.next("ready").await.data["session_id"].as_str().unwrap().to_owned();
    assert_ne!(one, replacement);
    sqlx::query(
        "insert into ting_outbox(idempotency_key,type,recipient,payload,session_id) values('stale','present.libraryChanged',$1,'{}',$2)",
    )
    .bind(ada.uuid)
    .bind(&one)
    .execute(&s.pool)
    .await
    .unwrap();
    present_service::tings::deliver_due(&s.state).await.unwrap();
    let state: String = sqlx::query_scalar("select state from ting_outbox where idempotency_key='stale'")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(state, "failed");
    s.req("PATCH", &format!("/v1/decks/{deck}"), Some(&ada), Some(json!({"title":"Renamed"})))
        .await;
    assert_eq!(reconnected.next("library").await.data, json!({}));
    drop((first, second, other, reconnected));
    s.stop().await;
}

#[tokio::test]
async fn library_audience_includes_old_folder_and_removed_members_and_limits_sessions() {
    let ting = Standin::start().await;
    let s = Stack::start_with_receiver(&ting.url).await;
    let ada = s.person("c:ada");
    let cam = s.person("c:cam");
    let other = s.person("c:other");
    let (_, folder) = s.post("/v1/folders", &ada, json!({"name":"Shared"})).await;
    let folder = folder["id"].as_str().unwrap();
    s.share("folders", folder, &ada, "c:cam", "viewer").await;
    let (_, deck) = s.post("/v1/decks", &ada, json!({"title":"Moved", "folder":folder})).await;
    let deck = deck["id"].as_str().unwrap();
    let mut cam_events = Sse::connect(&format!("{}/v1/library/events", s.url), Some(&cam.token)).await;
    let address = cam_events.next("ready").await.data["session_id"].as_str().unwrap().to_owned();
    assert_eq!(
        s.req("PATCH", &format!("/v1/decks/{deck}"), Some(&ada), Some(json!({"folder":"root"})))
            .await
            .0,
        200
    );
    cam_events.next("library").await;
    assert_eq!(
        s.req("DELETE", &format!("/v1/folders/{folder}/access/{}", cam.uuid), Some(&ada), None)
            .await
            .0,
        204
    );
    cam_events.next("library").await;
    let hints = s
        .ting
        .sent
        .lock()
        .unwrap()
        .iter()
        .filter(|t| t.session_id.as_deref() == Some(&address))
        .count();
    assert_eq!(hints, 2);
    assert!(s.ting.sent.lock().unwrap().iter().all(|t| t.recipient != other.uuid));
    for _ in 0..8 {
        sqlx::query("insert into ting_library_sessions values($1,$2,now()+interval '45 seconds')")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(ada.uuid)
            .execute(&s.pool)
            .await
            .unwrap();
    }
    assert_eq!(s.get("/v1/library/events", Some(&ada)).await.0, 503);
    // Expired leases do not block fresh observers.
    sqlx::query("update ting_library_sessions set expires_at=now()-interval '1 second' where owner=$1")
        .bind(ada.uuid)
        .execute(&s.pool)
        .await
        .unwrap();
    let mut restored = Sse::connect(&format!("{}/v1/library/events", s.url), Some(&ada.token)).await;
    restored.next("ready").await;
    drop((cam_events, restored));
    s.stop().await;
}
