//! Notifications, through Silicon Ting only.
//!
//! Every ting is queued in `ting_outbox` under a stable idempotency key (so it is sent at most once, even when the
//! request that caused it is retried) and a worker hands it to Ting, retrying with backoff. With no
//! `PRESENT_TING_URL` tings stay in the outbox marked `ting_not_configured`.
//!
//! Ting 0.4: schema-validated two-part types, account notifications with verified
//! actor attribution, and content-free hints addressed to ephemeral receiver sessions.

use std::{collections::HashMap, time::Duration};

use async_trait::async_trait;
use serde_json::{Value, json};
use silicon_accounts_client::{AccountsClient, IssueAppVerification, IssueUserVerification};
use time::OffsetDateTime;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::state::AppState;

/// A ting ready to hand to Silicon Ting.
#[derive(Debug, Clone, PartialEq)]
pub struct OutgoingTing {
    pub kind: String,
    pub recipient: Uuid,
    pub key: String,
    pub data: Value,
    pub actor: Option<Uuid>,
    /// Ephemeral delivery address; never used for account-wide collaboration notifications.
    pub session_id: Option<String>,
}

impl OutgoingTing {
    pub fn body(&self) -> Value {
        let mut body = json!({"type": self.kind, "key": self.key, "data": self.data, "metadata": {}});
        if let Some(session) = &self.session_id {
            body["session_id"] = json!(session);
        } else {
            body["for"] = json!(self.recipient);
            if let Some(actor) = self.actor { body["from"] = json!(actor); }
        }
        body
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendOutcome { Accepted, Blocked }

/// Why a send failed, and whether trying again later can help.
#[derive(Debug, Clone)]
pub struct SendFailure {
    pub retryable: bool,
    pub message: String,
}

#[async_trait]
pub trait TingSender: Send + Sync {
    /// Enrols an account with Ting so it can receive Present's tings. `access_token` is its Present token.
    async fn enrol(&self, account: Uuid, access_token: &str) -> Result<(), SendFailure>;
    async fn send(&self, ting: &OutgoingTing) -> Result<SendOutcome, SendFailure>;
}

/// The real sender.
pub struct HttpTingSender {
    pub http: reqwest::Client,
    pub ting_url: String,
    pub accounts: AccountsClient,
    pub app_id: String,
    pub app_secret: String,
    pub ting_app_id: String,
    proofs: Mutex<HashMap<String, (String, OffsetDateTime)>>,
    registered: Mutex<bool>,
}

impl HttpTingSender {
    pub fn new(http: reqwest::Client, ting_url: String, accounts: AccountsClient, app_id: String, app_secret: String, ting_app_id: String) -> Self {
        Self { http, ting_url, accounts, app_id, app_secret, ting_app_id, proofs: Mutex::new(HashMap::new()), registered: Mutex::new(false) }
    }

    async fn app_proof(&self, scope: &str) -> Result<String, SendFailure> {
        let mut cached = self.proofs.lock().await;
        if let Some((token, exp)) = cached.get(scope)
            && *exp - time::Duration::seconds(60) > OffsetDateTime::now_utc()
        {
            return Ok(token.clone());
        }
        let app = self.accounts.as_app(self.app_id.clone(), self.app_secret.clone());
        let issued = app
            .issue_app_verification(
                &IssueAppVerification { receiving_app: self.ting_app_id.clone(), scopes: vec![scope.into()], access_ttl_seconds: None },
                None,
            )
            .await
            .map_err(|e| SendFailure { retryable: true, message: format!("issuing the App verification proof failed: {}", e.message()) })?;
        let token = issued.proof_token.expose().to_string();
        let exp = issued.expires_at.unwrap_or_else(|| OffsetDateTime::now_utc() + time::Duration::minutes(5));
        cached.insert(scope.to_string(), (token.clone(), exp));
        Ok(token)
    }

    async fn forget_proof(&self, scope: &str, rejected: &str) {
        let mut proofs = self.proofs.lock().await;
        if proofs.get(scope).is_some_and(|(token, _)| token == rejected) { proofs.remove(scope); }
    }

    /// Register replacements before sending. Separate proof scope from ordinary publishing.
    async fn ensure_types(&self) -> Result<(), SendFailure> {
        let mut registered = self.registered.lock().await;
        if *registered { return Ok(()); }
        let proof = self.app_proof("types.manage").await?;
        let types: Vec<Value> = serde_json::from_str(include_str!("../../../deploy/ting-types.json")).expect("bundled Ting catalog");
        for kind in types {
            let response = self.http.post(format!("{}/v1/apps/{}/types", self.ting_url, self.app_id))
                .bearer_auth(&proof).json(&kind).send().await
                .map_err(|_| SendFailure { retryable: true, message: "Ting type registration is unreachable".into() })?;
            if response.status().is_success() { continue; }
            let (status, code, _) = error_code(response).await;
            if status == 409 && code == "type_exists" { continue; }
            if status == 401 { self.forget_proof("types.manage", &proof).await; }
            return Err(SendFailure { retryable: status >= 500 || status == 429 || status == 401,
                message: format!("Ting refused type registration ({status} {code})") });
        }
        *registered = true;
        Ok(())
    }
}

async fn error_code(resp: reqwest::Response) -> (u16, String, String) {
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    let code = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v["error"]["code"].as_str().or(v["code"].as_str()).or(v["error"].as_str()).map(String::from))
        .unwrap_or_default();
    (status, code, body.chars().take(500).collect())
}

#[async_trait]
impl TingSender for HttpTingSender {
    async fn enrol(&self, account: Uuid, access_token: &str) -> Result<(), SendFailure> {
        let app = self.accounts.as_app(self.app_id.clone(), self.app_secret.clone());
        let proof = app
            .issue_user_verification(
                &IssueUserVerification {
                    subject_token: access_token.to_string(),
                    receiving_app: self.ting_app_id.clone(),
                    scopes: vec!["subscriptions.register".into()],
                    access_ttl_seconds: None,
                },
                // A fresh proof issuance is a new operation; an account-stable key can replay an expired proof forever.
                Some(&format!("present-ting-enrol-{account}-{}", Uuid::new_v4())),
            )
            .await
            .map_err(|e| SendFailure { retryable: true, message: format!("issuing the User verification proof failed: {}", e.message()) })?;
        let resp = self
            .http
            .post(format!("{}/v1/subscriptions", self.ting_url))
            .bearer_auth(proof.proof_token.expose())
            .json(&json!({ "app_id": self.app_id, "for": account }))
            .send()
            .await
            .map_err(|e| SendFailure { retryable: true, message: format!("Ting is unreachable: {e}") })?;
        if resp.status().is_success() {
            return Ok(());
        }
        let (status, code, body) = error_code(resp).await;
        Err(SendFailure { retryable: status >= 500, message: format!("Ting refused the subscription ({status} {code}): {body}") })
    }

    async fn send(&self, ting: &OutgoingTing) -> Result<SendOutcome, SendFailure> {
        self.ensure_types().await?;
        let proof = self.app_proof("tings.send").await?;
        let resp = self
            .http
            .post(format!("{}/v1/tings", self.ting_url))
            .bearer_auth(&proof)
            .json(&ting.body())
            .send()
            .await
            .map_err(|e| SendFailure { retryable: true, message: format!("Ting is unreachable: {e}") })?;
        if resp.status().is_success() {
            let receipt: Value = resp.json().await.map_err(|_| SendFailure { retryable: true, message: "Ting returned an unreadable receipt; retry the original key".into() })?;
            if receipt["status"] == "blocked" { return Ok(SendOutcome::Blocked); }
            if receipt["id"].as_str().is_some_and(|s| !s.is_empty()) && (receipt.get("status").is_none() || receipt["status"] == "accepted") {
                return Ok(SendOutcome::Accepted);
            }
            return Err(SendFailure { retryable: true, message: "Ting returned an unrecognized receipt; retry the original key".into() });
        }
        let (status, code, body) = error_code(resp).await;
        if matches!(code.as_str(), "invalid_proof" | "unauthorized" | "proof_expired") || status == 401 {
            self.forget_proof("tings.send", &proof).await;
            return Err(SendFailure { retryable: true, message: format!("Ting refused the proof ({status} {code}); a new one will be used") });
        }
        // A recipient that hasn't been enrolled yet may be enrolled later (on their next request), so keep trying.
        let retryable = code != "session_gone" && (status >= 500 || status == 429 || (ting.session_id.is_none() && (status == 404 || code == "recipient_not_registered" || code.contains("subscri"))));
        Err(SendFailure { retryable, message: format!("Ting refused the ting ({status} {code}): {body}") })
    }
}

/// Queues a ting. Never for the person who caused it; the key makes a retried request queue it once.
pub async fn enqueue(state: &AppState, kind: &str, recipient: Uuid, actor: Option<Uuid>, key: &str, data: Value) -> Result<(), sqlx::Error> {
    if Some(recipient) == actor {
        return Ok(());
    }
    let initial = if state.ting.is_some() { "pending" } else { "ting_not_configured" };
    let key: String = key.chars().take(200).collect();
    sqlx::query(
        "insert into ting_outbox (idempotency_key, type, recipient, payload, state, actor) values ($1, $2, $3, $4, $5, $6)
         on conflict (idempotency_key) do nothing",
    )
    .bind(&key)
    .bind(kind)
    .bind(recipient)
    .bind(&data)
    .bind(initial)
    .bind(actor)
    .execute(&state.pool)
    .await?;
    state.ting_notify.notify_one();
    Ok(())
}

const MAX_ATTEMPTS: i32 = 12;

fn backoff(attempts: i32) -> i64 {
    (2i64.pow(attempts.clamp(0, 12) as u32)).min(3600)
}

/// Sends every due ting once. Returns how many were sent.
pub async fn deliver_due(state: &AppState) -> Result<usize, sqlx::Error> {
    let Some(sender) = state.ting.clone() else { return Ok(0) };
    sqlx::query("delete from ting_library_sessions where expires_at<=now()").execute(&state.pool).await?;
    // A late retry outside Ting's deduplication window could send twice.
    sqlx::query("update ting_outbox set state='failed', last_error='Ting idempotency window elapsed; reconcile sent history before resending' where state='pending' and created_at < now() - interval '13 days'")
        .execute(&state.pool).await?;
    // A dead session is terminal. Never fall back to the account or a replacement session.
    sqlx::query("update ting_outbox o set state='failed', last_error='Ting receiver session ended' where state='pending' and session_id is not null and not exists(select 1 from ting_library_sessions s where s.session_id=o.session_id and s.expires_at>now())")
        .execute(&state.pool).await?;
    let mut sent = 0;
    for _ in 0..25 {
        // Claim immediately before sending; a slow catalog/send must not let a
        // later row's lease expire before this worker even reaches it.
        let row: Option<(i64, String, String, Uuid, Value, i32, Option<Uuid>, Option<String>)> = sqlx::query_as(
            "update ting_outbox set next_attempt_at = now() + interval '120 seconds'
             where id in (select id from ting_outbox where state = 'pending' and next_attempt_at <= now()
                          order by id limit 1 for update skip locked)
             returning id, idempotency_key, type, recipient, payload, attempts, actor, session_id",
        ).fetch_optional(&state.pool).await?;
        let Some((id, key, kind, recipient, payload, attempts, actor, session_id)) = row else { break };
        let ting = OutgoingTing { kind, recipient, key, data: payload, actor, session_id };
        match sender.send(&ting).await {
            Ok(outcome) => {
                sqlx::query("update ting_outbox set state = $2, sent_at = case when $2 = 'sent' then now() else null end, attempts = attempts + 1, last_error = null where id = $1")
                    .bind(id)
                    .bind(if outcome == SendOutcome::Blocked { "blocked" } else { "sent" })
                    .execute(&state.pool)
                    .await?;
                sent += usize::from(outcome == SendOutcome::Accepted);
            }
            Err(f) => {
                let attempts = attempts + 1;
                let give_up = !f.retryable || attempts >= MAX_ATTEMPTS;
                tracing::warn!("ting {} to {} failed (attempt {attempts}): {}", ting.kind, ting.recipient, f.message);
                sqlx::query(
                    "update ting_outbox set attempts = $2, last_error = $3, state = $4,
                       next_attempt_at = now() + make_interval(secs => $5) where id = $1",
                )
                .bind(id)
                .bind(attempts)
                .bind(&f.message)
                .bind(if give_up { "failed" } else { "pending" })
                .bind(backoff(attempts) as f64)
                .execute(&state.pool)
                .await?;
            }
        }
    }
    Ok(sent)
}

/// The outbox worker: wakes on every queued ting and at least once a second.
pub async fn run_worker(state: AppState) {
    loop {
        match deliver_due(&state).await {
            Ok(n) if n > 0 => continue,
            Ok(_) => {}
            Err(e) => tracing::warn!("ting outbox: {e}"),
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), state.ting_notify.notified()).await;
    }
}

/// Enrols an account with Ting once (in the background, on its first request to Present).
pub async fn enrol_in_background(state: &AppState, account: Uuid, token: String) {
    let Some(sender) = state.ting.clone() else { return };
    {
        let mut tried = state.enrolling.lock().await;
        if !tried.insert(account) {
            return;
        }
    }
    let st = state.clone();
    tokio::spawn(async move {
        let done: bool = sqlx::query_scalar("select ting_enrolled_at is not null from accounts where uuid = $1")
            .bind(account)
            .fetch_optional(&st.pool)
            .await
            .ok()
            .flatten()
            .unwrap_or(false);
        if done {
            return;
        }
        match sender.enrol(account, &token).await {
            Ok(()) => {
                let _ = sqlx::query(
                    "insert into accounts (uuid, ting_enrolled_at) values ($1, now())
                     on conflict (uuid) do update set ting_enrolled_at = now()",
                )
                .bind(account)
                .execute(&st.pool)
                .await;
                // Tings that waited for this enrolment can go now.
                let _ = sqlx::query("update ting_outbox set next_attempt_at = now() where recipient = $1 and state = 'pending'")
                    .bind(account)
                    .execute(&st.pool)
                    .await;
                st.ting_notify.notify_one();
            }
            Err(f) => {
                tracing::warn!("enrolling {account} with Ting failed: {}", f.message);
                st.enrolling.lock().await.remove(&account);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, http::{HeaderMap, StatusCode}, routing::post};
    use std::{collections::HashMap, sync::Arc};

    #[tokio::test]
    async fn enrolment_retry_requests_a_new_proof_instead_of_replaying_an_expired_one() {
        // Accounts honours idempotency; Ting regards the first issued proof as expired.
        let issued = Arc::new(std::sync::Mutex::new(HashMap::<String, String>::new()));
        let seen = issued.clone();
        let app = Router::new()
            .route("/v1/proofs/user-verification", post(move |headers: HeaderMap| {
                let seen = seen.clone();
                async move {
                    let key = headers["idempotency-key"].to_str().unwrap().to_string();
                    let mut proofs = seen.lock().unwrap();
                    let number = proofs.len() + 1;
                    let proof = proofs.entry(key).or_insert_with(|| format!("sap_test_{number}"));
                    Json(json!({ "proof_token": proof }))
                }
            }))
            .route("/v1/subscriptions", post(|headers: HeaderMap| async move {
                if headers["authorization"] == "Bearer sap_test_1" {
                    (StatusCode::UNAUTHORIZED, Json(json!({"error":{"code":"proof_expired"}})))
                } else {
                    (StatusCode::CREATED, Json(json!({"ok":true})))
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        let accounts = AccountsClient::builder().base_url(&url).allow_insecure_http(true).build().unwrap();
        let sender = HttpTingSender::new(reqwest::Client::new(), url, accounts, "present".into(), "sa_app_test".into(), "ting".into());
        let account = Uuid::new_v4();
        assert!(sender.enrol(account, "local_test_access_token").await.is_err());
        sender.enrol(account, "local_test_access_token").await.unwrap();
        assert_eq!(issued.lock().unwrap().len(), 2);
        server.abort();
    }
}
