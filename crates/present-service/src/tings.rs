//! Notifications, through Silicon Ting only.
//!
//! Every ting is queued in `ting_outbox` under a stable idempotency key (so it is sent at most once, even when the
//! request that caused it is retried) and a worker hands it to Ting, retrying with backoff. With no
//! `PRESENT_TING_URL` tings stay in the outbox marked `ting_not_configured`.
//!
//! Ting's contract (0.3): each recipient is enrolled once with a User verification proof (scope
//! `subscriptions.register`) → `POST {TING}/v1/subscriptions {app_id, for}`; tings are sent with an App
//! verification proof (scope `tings.send`) → `POST {TING}/v1/tings {type, for, key, data, metadata}`.

use std::time::Duration;

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
}

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
    async fn send(&self, ting: &OutgoingTing) -> Result<(), SendFailure>;
}

/// The real sender.
pub struct HttpTingSender {
    pub http: reqwest::Client,
    pub ting_url: String,
    pub accounts: AccountsClient,
    pub app_id: String,
    pub app_secret: String,
    pub ting_app_id: String,
    proof: Mutex<Option<(String, OffsetDateTime)>>,
}

impl HttpTingSender {
    pub fn new(http: reqwest::Client, ting_url: String, accounts: AccountsClient, app_id: String, app_secret: String, ting_app_id: String) -> Self {
        Self { http, ting_url, accounts, app_id, app_secret, ting_app_id, proof: Mutex::new(None) }
    }

    async fn app_proof(&self) -> Result<String, SendFailure> {
        let mut cached = self.proof.lock().await;
        if let Some((token, exp)) = cached.as_ref()
            && *exp - time::Duration::seconds(60) > OffsetDateTime::now_utc()
        {
            return Ok(token.clone());
        }
        let app = self.accounts.as_app(self.app_id.clone(), self.app_secret.clone());
        let issued = app
            .issue_app_verification(
                &IssueAppVerification { receiving_app: self.ting_app_id.clone(), scopes: vec!["tings.send".into()], access_ttl_seconds: None },
                None,
            )
            .await
            .map_err(|e| SendFailure { retryable: true, message: format!("issuing the App verification proof failed: {}", e.message()) })?;
        let token = issued.proof_token.expose().to_string();
        let exp = issued.expires_at.unwrap_or_else(|| OffsetDateTime::now_utc() + time::Duration::minutes(5));
        *cached = Some((token.clone(), exp));
        Ok(token)
    }

    async fn forget_proof(&self) {
        *self.proof.lock().await = None;
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
                Some(&format!("present-ting-enrol-{account}")),
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
        if resp.status().is_success() || resp.status().as_u16() == 409 {
            return Ok(());
        }
        let (status, code, body) = error_code(resp).await;
        Err(SendFailure { retryable: status >= 500, message: format!("Ting refused the subscription ({status} {code}): {body}") })
    }

    async fn send(&self, ting: &OutgoingTing) -> Result<(), SendFailure> {
        let proof = self.app_proof().await?;
        let resp = self
            .http
            .post(format!("{}/v1/tings", self.ting_url))
            .bearer_auth(&proof)
            .json(&json!({ "type": ting.kind, "for": ting.recipient, "key": ting.key, "data": ting.data, "metadata": {} }))
            .send()
            .await
            .map_err(|e| SendFailure { retryable: true, message: format!("Ting is unreachable: {e}") })?;
        if resp.status().is_success() {
            return Ok(());
        }
        let (status, code, body) = error_code(resp).await;
        if matches!(code.as_str(), "invalid_proof" | "unauthorized" | "proof_expired") || status == 401 {
            self.forget_proof().await;
            return Err(SendFailure { retryable: true, message: format!("Ting refused the proof ({status} {code}); a new one will be used") });
        }
        // A recipient that hasn't been enrolled yet may be enrolled later (on their next request), so keep trying.
        let retryable = status >= 500 || status == 429 || status == 404 || code.contains("subscri");
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
        "insert into ting_outbox (idempotency_key, type, recipient, payload, state) values ($1, $2, $3, $4, $5)
         on conflict (idempotency_key) do nothing",
    )
    .bind(&key)
    .bind(kind)
    .bind(recipient)
    .bind(&data)
    .bind(initial)
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
    let rows: Vec<(i64, String, String, Uuid, Value, i32)> = sqlx::query_as(
        "update ting_outbox set next_attempt_at = now() + interval '120 seconds'
         where id in (select id from ting_outbox where state = 'pending' and next_attempt_at <= now()
                      order by id limit 25 for update skip locked)
         returning id, idempotency_key, type, recipient, payload, attempts",
    )
    .fetch_all(&state.pool)
    .await?;
    let mut sent = 0;
    for (id, key, kind, recipient, payload, attempts) in rows {
        let ting = OutgoingTing { kind, recipient, key, data: payload };
        match sender.send(&ting).await {
            Ok(()) => {
                sqlx::query("update ting_outbox set state = 'sent', sent_at = now(), attempts = attempts + 1, last_error = null where id = $1")
                    .bind(id)
                    .execute(&state.pool)
                    .await?;
                sent += 1;
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
