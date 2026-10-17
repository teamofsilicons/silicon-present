//! Carbons and Silicons: looked up through Silicon Accounts and cached in the `accounts` table.
//!
//! Over app credentials Accounts returns an account's id and kind (`resolve`); its name, photo and email come from
//! `app.user(uuid)`, which answers 404 until that account has signed in to Present, so until then it is shown by
//! its id and the default photo `{IRIS}/pfp/{kind}?id=<uuid>`. Every verified token refreshes the cache.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{Value, json};
use silicon_accounts_client::AccountsClient;
use uuid::Uuid;

use crate::auth::VerifiedToken;
use crate::error::ApiError;
use crate::state::AppState;

/// An account as Accounts identifies it.
#[derive(Debug, Clone, PartialEq)]
pub struct DirAccount {
    pub uuid: Uuid,
    pub handle: String,
    pub kind: String,
}

/// How an account that has signed in to Present shows itself.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Profile {
    pub display_name: String,
    pub pfp_url: Option<String>,
    pub email: Option<String>,
}

#[async_trait]
pub trait AccountsDirectory: Send + Sync {
    /// A uuid, `c:id` or `si:id` → the account, or None when there is no such account.
    async fn lookup(&self, q: &str) -> Result<Option<DirAccount>, ApiError>;
    /// Name, photo and email of an account that has signed in to Present (None until it has).
    async fn profile(&self, uuid: Uuid) -> Result<Option<Profile>, ApiError>;
}

/// The real directory: Silicon Accounts over the `present` app's credentials.
pub struct AccountsAppDirectory {
    pub client: AccountsClient,
    pub app_id: String,
    pub app_secret: String,
}

fn accounts_down(e: silicon_accounts_client::Error) -> ApiError {
    ApiError::unavailable(
        "accounts_unreachable",
        format!("Silicon Present couldn't reach Silicon Accounts to look up an account: {}", e.message()),
        "Try again in a moment.",
    )
}

#[async_trait]
impl AccountsDirectory for AccountsAppDirectory {
    async fn lookup(&self, q: &str) -> Result<Option<DirAccount>, ApiError> {
        let app = self.client.as_app(self.app_id.clone(), self.app_secret.clone());
        match app.resolve(q).await {
            Ok(a) => {
                let Ok(uuid) = Uuid::parse_str(&a.uuid) else { return Ok(None) };
                if a.status == "deleted" {
                    return Ok(None);
                }
                Ok(Some(DirAccount { uuid, handle: a.id, kind: a.kind.as_str().to_string() }))
            }
            Err(e) if e.is_not_found() || e.status() == Some(400) || e.status() == Some(422) => Ok(None),
            Err(e) => Err(accounts_down(e)),
        }
    }

    async fn profile(&self, uuid: Uuid) -> Result<Option<Profile>, ApiError> {
        let app = self.client.as_app(self.app_id.clone(), self.app_secret.clone());
        match app.user(&uuid.to_string()).await {
            Ok(u) => Ok(Some(Profile {
                display_name: u.display_name,
                pfp_url: u.pfp_url.filter(|p| !p.is_empty()),
                email: u.email.map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()),
            })),
            Err(e) if e.is_not_found() => Ok(None),
            Err(e) => Err(accounts_down(e)),
        }
    }
}

/// True for `c:name` / `si:name`.
pub fn is_handle(s: &str) -> bool {
    let s = s.trim();
    (s.starts_with("c:") && s.len() > 2) || (s.starts_with("si:") && s.len() > 3)
}

pub fn is_email(s: &str) -> bool {
    let s = s.trim();
    match s.split_once('@') {
        Some((a, b)) => !a.is_empty() && b.contains('.') && !b.starts_with('.') && !b.ends_with('.') && !s.contains(' '),
        None => false,
    }
}

fn default_pfp(state: &AppState, kind: &str, uuid: Uuid) -> String {
    format!("{}/pfp/{}?id={}", state.cfg.iris_url, if kind == "silicon" { "silicon" } else { "carbon" }, uuid)
}

#[derive(sqlx::FromRow)]
struct Row {
    uuid: Uuid,
    handle: String,
    kind: String,
    display_name: String,
    pfp_url: String,
    refreshed_at: time::OffsetDateTime,
}

fn row_json(state: &AppState, r: &Row) -> Value {
    json!({
        "uuid": r.uuid,
        "id": r.handle,
        "kind": r.kind,
        "displayName": if r.display_name.is_empty() { r.handle.clone() } else { r.display_name.clone() },
        "pfp": if r.pfp_url.is_empty() { default_pfp(state, &r.kind, r.uuid) } else { r.pfp_url.clone() },
    })
}

/// How an unknown account is shown when Accounts can't be reached.
fn unknown_json(state: &AppState, uuid: Uuid) -> Value {
    json!({ "uuid": uuid, "id": "", "kind": "carbon", "displayName": "", "pfp": default_pfp(state, "carbon", uuid) })
}

async fn upsert_identity(state: &AppState, a: &DirAccount) -> Result<(), ApiError> {
    sqlx::query(
        "insert into accounts (uuid, handle, kind) values ($1, $2, $3)
         on conflict (uuid) do update set handle = excluded.handle, kind = excluded.kind",
    )
    .bind(a.uuid)
    .bind(&a.handle)
    .bind(&a.kind)
    .execute(&state.pool)
    .await?;
    Ok(())
}

/// Refreshes one account from Accounts (identity and, when it has signed in to Present, its profile).
pub async fn refresh(state: &AppState, uuid: Uuid) -> Result<(), ApiError> {
    if let Some(a) = state.directory.lookup(&uuid.to_string()).await? {
        upsert_identity(state, &a).await?;
    }
    let profile = state.directory.profile(uuid).await?;
    if let Some(p) = &profile {
        sqlx::query(
            "insert into accounts (uuid, display_name, pfp_url, email, refreshed_at) values ($1, $2, $3, $4, now())
             on conflict (uuid) do update set display_name = excluded.display_name, pfp_url = excluded.pfp_url,
               email = excluded.email, refreshed_at = now()",
        )
        .bind(uuid)
        .bind(&p.display_name)
        .bind(p.pfp_url.clone().unwrap_or_default())
        .bind(&p.email)
        .execute(&state.pool)
        .await?;
        if let Some(email) = &p.email {
            claim_email_invites(state, uuid, email).await?;
        }
    } else {
        sqlx::query("update accounts set refreshed_at = now() where uuid = $1").bind(uuid).execute(&state.pool).await?;
    }
    Ok(())
}

/// Turns pending email invites for `email` into real access for `uuid`.
pub async fn claim_email_invites(state: &AppState, uuid: Uuid, email: &str) -> Result<(), ApiError> {
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "update access a set account = $2, email = null
         where a.email = $1 and not exists (
           select 1 from access b where b.resource_kind = a.resource_kind and b.resource_id = a.resource_id and b.account = $2)",
    )
    .bind(email)
    .bind(uuid)
    .execute(&mut *tx)
    .await?;
    sqlx::query("delete from access where email = $1").bind(email).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// Called for every verified token: keeps the cache fresh, claims email invites, and enrols the account with Ting.
pub async fn on_signed_in(state: &AppState, t: VerifiedToken) {
    let now = Instant::now();
    {
        let mut seen = state.seen.lock().await;
        if let Some(last) = seen.get(&t.uuid)
            && now.duration_since(*last) < Duration::from_secs(60)
        {
            return;
        }
        seen.insert(t.uuid, now);
    }
    // The token's id is the one at issue time and can be stale, so it only seeds an account we don't know yet;
    // Accounts (refresh, webhooks) stays the source of truth.
    if let (Some(handle), Some(kind)) = (&t.handle, &t.kind) {
        let _ = sqlx::query("insert into accounts (uuid, handle, kind) values ($1, $2, $3) on conflict (uuid) do nothing")
            .bind(t.uuid)
            .bind(handle)
            .bind(kind)
            .execute(&state.pool)
            .await;
    }
    let st = state.clone();
    let uuid = t.uuid;
    tokio::spawn(async move {
        let stale: bool = sqlx::query_scalar("select refreshed_at < now() - interval '10 minutes' from accounts where uuid = $1")
            .bind(uuid)
            .fetch_optional(&st.pool)
            .await
            .ok()
            .flatten()
            .unwrap_or(true);
        if stale && let Err(e) = refresh(&st, uuid).await {
            tracing::warn!("refreshing account {uuid} failed: {e}");
        }
    });
    if state.ting.is_some() {
        crate::tings::enrol_in_background(state, t.uuid, t.token.clone()).await;
    }
}

/// How each account is shown (`{uuid, id, kind, displayName, pfp}`), from the cache; unknown ones are looked up.
pub async fn accounts_json(state: &AppState, uuids: &[Uuid]) -> HashMap<Uuid, Value> {
    let unique: Vec<Uuid> = uuids.iter().copied().collect::<HashSet<_>>().into_iter().collect();
    let mut out = HashMap::new();
    if unique.is_empty() {
        return out;
    }
    let rows: Vec<Row> = sqlx::query_as("select uuid, handle, kind, display_name, pfp_url,
                case when isfinite(refreshed_at) then refreshed_at else 'epoch' end as refreshed_at
         from accounts where uuid = any($1)")
        .bind(&unique)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();
    let stale_before = time::OffsetDateTime::now_utc() - time::Duration::hours(1);
    for r in &rows {
        out.insert(r.uuid, row_json(state, r));
        if r.refreshed_at < stale_before || r.handle.is_empty() {
            let st = state.clone();
            let uuid = r.uuid;
            let mut refreshing = state.refreshing.lock().await;
            if refreshing.insert(uuid) {
                tokio::spawn(async move {
                    let _ = refresh(&st, uuid).await;
                    st.refreshing.lock().await.remove(&uuid);
                });
            }
        }
    }
    for uuid in unique {
        if out.contains_key(&uuid) {
            continue;
        }
        let v = match state.directory.lookup(&uuid.to_string()).await {
            Ok(Some(a)) => {
                let _ = upsert_identity(state, &a).await;
                let st = state.clone();
                tokio::spawn(async move {
                    let _ = refresh(&st, uuid).await;
                });
                json!({ "uuid": uuid, "id": a.handle, "kind": a.kind, "displayName": a.handle, "pfp": default_pfp(state, &a.kind, uuid) })
            }
            _ => unknown_json(state, uuid),
        };
        out.insert(uuid, v);
    }
    out
}

pub async fn account_json(state: &AppState, uuid: Uuid) -> Value {
    accounts_json(state, &[uuid]).await.remove(&uuid).unwrap_or_else(|| unknown_json(state, uuid))
}

/// `c:ada` / `si:writer` / uuid → the account and how it's shown. None when Accounts has no such account.
pub async fn resolve(state: &AppState, q: &str) -> Result<Option<(Uuid, Value)>, ApiError> {
    let q = q.trim();
    if !is_handle(q) && Uuid::parse_str(q).is_err() {
        return Ok(None);
    }
    // A known handle answers from the cache first, so a burst of mentions doesn't hit Accounts.
    if is_handle(q) {
        let cached: Option<Uuid> = sqlx::query_scalar(
            "select uuid from accounts where lower(handle) = lower($1) and refreshed_at > now() - interval '10 minutes'",
        )
        .bind(q)
        .fetch_optional(&state.pool)
        .await?;
        if let Some(uuid) = cached {
            return Ok(Some((uuid, account_json(state, uuid).await)));
        }
    }
    match state.directory.lookup(q).await? {
        Some(a) => {
            upsert_identity(state, &a).await?;
            Ok(Some((a.uuid, account_json(state, a.uuid).await)))
        }
        None => Ok(None),
    }
}

/// The account with this email, when it has signed in to Present and shares its email.
pub async fn find_by_email(state: &AppState, email: &str) -> Result<Option<Uuid>, ApiError> {
    Ok(sqlx::query_scalar("select uuid from accounts where email = $1 limit 1").bind(email.trim().to_lowercase()).fetch_optional(&state.pool).await?)
}
