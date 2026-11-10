use axum::{
    Json, Router,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use present_service::tings::{HttpTingSender, OutgoingTing, SendOutcome, TingSender};
use serde_json::{Value, json};
use silicon_accounts_client::AccountsClient;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

mod common;

#[tokio::test]
async fn blocked_receipts_and_expired_idempotency_are_terminal_in_the_outbox() {
    use async_trait::async_trait;
    use present_service::{
        AppState, Deps,
        tings::{self, SendFailure},
    };
    struct Blocker;
    #[async_trait]
    impl TingSender for Blocker {
        async fn enrol(&self, _: Uuid, _: &str) -> Result<(), SendFailure> {
            Ok(())
        }
        async fn send(&self, _: &OutgoingTing) -> Result<SendOutcome, SendFailure> {
            Ok(SendOutcome::Blocked)
        }
    }
    let s = common::Stack::start_with(false, false).await;
    let st = AppState::new(
        s.state.cfg.clone(),
        s.pool.clone(),
        Deps {
            verifier: s.state.verifier.clone(),
            directory: s.state.directory.clone(),
            converter: None,
            ting: Some(Arc::new(Blocker)),
        },
    );
    let recipient = Uuid::new_v4();
    tings::enqueue(&st, "present.deckShared", recipient, None, "blocked", json!({}))
        .await
        .unwrap();
    tings::enqueue(&st, "present.deckShared", recipient, None, "too-old", json!({}))
        .await
        .unwrap();
    sqlx::query("update ting_outbox set created_at=now()-interval '14 days' where idempotency_key='too-old'")
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(tings::deliver_due(&st).await.unwrap(), 0);
    assert_eq!(tings::deliver_due(&st).await.unwrap(), 0);
    let rows: Vec<(String, String, i32, bool)> =
        sqlx::query_as("select idempotency_key,state,attempts,sent_at is null from ting_outbox order by idempotency_key")
            .fetch_all(&s.pool)
            .await
            .unwrap();
    assert_eq!(
        rows,
        vec![
            ("blocked".into(), "blocked".into(), 1, true),
            ("too-old".into(), "failed".into(), 0, true)
        ]
    );
    s.stop().await;
}

#[tokio::test]
async fn scoped_proofs_registration_attribution_receipts_and_retries() {
    let issued = Arc::new(Mutex::new(HashMap::<String, usize>::new()));
    let types = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sends = Arc::new(Mutex::new(Vec::<Value>::new()));
    let (proofs, registered, requests) = (issued.clone(), types.clone(), sends.clone());
    let router = Router::new()
        .route(
            "/v1/proofs/app-verification",
            post(move |Json(body): Json<Value>| {
                let proofs = proofs.clone();
                async move {
                    assert_eq!(body["receiving_app"], "ting");
                    let scope = body["scopes"][0].as_str().unwrap();
                    let mut issued = proofs.lock().unwrap();
                    let count = issued.entry(scope.to_owned()).or_default();
                    *count += 1;
                    Json(json!({"proof_token":format!("sap_{scope}_{count}")}))
                }
            }),
        )
        .route(
            "/v1/apps/present/types",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let registered = registered.clone();
                async move {
                    assert_eq!(headers["authorization"], "Bearer sap_types.manage_1");
                    assert_eq!(body["type"].as_str().unwrap().split('.').count(), 2);
                    assert!(body["schema"].is_object());
                    registered.lock().unwrap().push(body);
                    // An existing type is not an error, but arbitrary 409s are.
                    (StatusCode::CONFLICT, Json(json!({"error":{"code":"type_exists"}})))
                }
            }),
        )
        .route(
            "/v1/tings",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let requests = requests.clone();
                async move {
                    requests.lock().unwrap().push(body.clone());
                    let response = match body["key"].as_str().unwrap() {
                        "blocked" => (StatusCode::ACCEPTED, json!({"id":"blocked-id","status":"blocked"})),
                        "gone" => (StatusCode::CONFLICT, json!({"error":{"code":"session_gone"}})),
                        "retry" if headers["authorization"] == "Bearer sap_tings.send_1" => {
                            (StatusCode::UNAUTHORIZED, json!({"error":{"code":"proof_expired"}}))
                        }
                        "unknown" => (StatusCode::OK, json!({})),
                        _ => (StatusCode::ACCEPTED, json!({"id":"accepted-id","status":"accepted"})),
                    };
                    (response.0, Json(response.1))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let accounts = AccountsClient::builder()
        .base_url(&url)
        .allow_insecure_http(true)
        .max_retries(0)
        .build()
        .unwrap();
    let sender = HttpTingSender::new(
        reqwest::Client::new(),
        url,
        accounts,
        "present".into(),
        "sa_test".into(),
        "ting".into(),
    );
    let actor = Uuid::new_v4();
    let mut ting = OutgoingTing {
        kind: "present.mentionReceived".into(),
        recipient: Uuid::new_v4(),
        key: "ok".into(),
        data: json!({}),
        actor: Some(actor),
        session_id: None,
    };
    assert_eq!(sender.send(&ting).await.unwrap(), SendOutcome::Accepted);
    assert_eq!(sender.send(&ting).await.unwrap(), SendOutcome::Accepted);
    assert_eq!(types.lock().unwrap().len(), 6);
    assert_eq!(issued.lock().unwrap().get("tings.send"), Some(&1));
    assert_eq!(sends.lock().unwrap()[0]["from"], actor.to_string());
    assert!(sends.lock().unwrap()[0].get("session_id").is_none());
    ting.key = "blocked".into();
    assert_eq!(sender.send(&ting).await.unwrap(), SendOutcome::Blocked);
    ting.key = "retry".into();
    assert!(sender.send(&ting).await.unwrap_err().retryable);
    assert_eq!(sender.send(&ting).await.unwrap(), SendOutcome::Accepted);
    let requests = sends.lock().unwrap();
    assert_eq!(requests[3], requests[4], "retry preserves every byte-bearing field and key");
    drop(requests);
    assert_eq!(issued.lock().unwrap().get("tings.send"), Some(&2));
    assert_eq!(issued.lock().unwrap().get("types.manage"), Some(&1));
    ting.kind = "present.libraryChanged".into();
    ting.session_id = Some("finished-session".into());
    ting.key = "gone".into();
    assert!(!sender.send(&ting).await.unwrap_err().retryable);
    assert!(ting.body().get("for").is_none() && ting.body().get("from").is_none());
    ting.key = "unknown".into();
    assert!(sender.send(&ting).await.unwrap_err().retryable);
    server.abort();
}
