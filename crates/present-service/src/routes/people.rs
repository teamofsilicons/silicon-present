//! Present keeps consent and collaboration history. The represented account's address book belongs to Contacts.
use crate::{
    accounts,
    auth::Caller,
    error::{ApiError, ApiResult},
    extract::{JsonBody, Q},
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use serde_json::{Value, json};
use silicon_accounts_client::{IssueUserVerification, Secret};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/people", get(people))
        .route("/v1/contacts", get(contacts).post(save))
        .route("/v1/contacts/{id}", axum::routing::delete(remove))
        .route(
            "/v1/contacts/connection",
            get(connection).put(set_connection),
        )
        .route("/v1/contacts/photos/{photo}", get(photo))
}

fn unavailable() -> ApiError {
    ApiError::unavailable(
        "contacts_unavailable",
        "Silicon Contacts could not complete this request.",
        "Try again shortly.",
    )
}

pub(super) async fn connected(st: &AppState, owner: Uuid) -> ApiResult<bool> {
    Ok(
        sqlx::query_scalar("select exists(select 1 from contacts_connections where account=$1)")
            .bind(owner)
            .fetch_one(&st.pool)
            .await?,
    )
}

struct Book<'a> {
    st: &'a AppState,
    proof: Secret,
}

impl<'a> Book<'a> {
    async fn new(st: &'a AppState, caller: &Caller, write: bool) -> ApiResult<Self> {
        let mut scopes = vec!["contacts.read".to_owned()];
        if write {
            scopes.push("contacts.write".into());
        }
        let issued = st
            .accounts_client
            .as_app(&st.cfg.app_id, &st.cfg.app_secret)
            .issue_user_verification(
                &IssueUserVerification {
                    receiving_app: "silicon-contacts".into(),
                    scopes,
                    subject_token: caller.token.expose().to_owned(),
                    access_ttl_seconds: Some(120),
                },
                None,
            )
            .await
            .map_err(|e| match e.status() {
                Some(401 | 403) => ApiError::forbidden(
                    "contacts_access_denied",
                    "Accounts declined access to Silicon Contacts.",
                    "Check the current sign-in and app permissions.",
                ),
                _ => unavailable(),
            })?;
        Ok(Self {
            st,
            proof: issued.proof_token,
        })
    }
    async fn request(
        &self,
        method: Method,
        path: &[&str],
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> ApiResult<Vec<u8>> {
        let mut url = self.st.cfg.contacts_url.clone();
        url.path_segments_mut()
            .map_err(|_| unavailable())?
            .extend(["v1"])
            .extend(path);
        let mut req = self
            .st
            .http
            .request(method, url)
            .timeout(Duration::from_secs(20))
            .query(query)
            .header("Authorization", format!("Proof {}", self.proof.expose()));
        if let Some(b) = body {
            req = req.json(b);
        }
        let mut resp = req.send().await.map_err(|_| unavailable())?;
        let status = resp.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|_| unavailable())? {
            if bytes.len() + chunk.len() > 5 * 1024 * 1024 {
                return Err(unavailable());
            }
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let v: Value = serde_json::from_slice(&bytes).unwrap_or_default();
            if matches!(status.as_u16(), 400 | 403 | 404 | 409 | 422 | 429) {
                return Err(ApiError::new(
                    status,
                    v["error"]["code"].as_str().unwrap_or("contacts_error"),
                    v["error"]["message"]
                        .as_str()
                        .unwrap_or("Contacts declined this request."),
                    "Check the contact details and try again.",
                ));
            }
            return Err(unavailable());
        }
        Ok(bytes)
    }
    async fn json(
        &self,
        method: Method,
        path: &[&str],
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> ApiResult<Value> {
        serde_json::from_slice(&self.request(method, path, query, body).await?)
            .map_err(|_| unavailable())
    }
    async fn saved(&self, uuid: Uuid) -> ApiResult<Option<Value>> {
        match self
            .json(Method::GET, &["contacts", &uuid.to_string()], &[], None)
            .await
        {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.code == "contact_not_found" => Ok(None),
            Err(e) => Err(e),
        }
    }
}

fn profile(st: &AppState, a: &Value, saved: Option<&Value>) -> ApiResult<Value> {
    let uuid: Uuid = a["uuid"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(unavailable)?;
    let id = a["id"].as_str().ok_or_else(unavailable)?;
    let kind = a["kind"].as_str().ok_or_else(unavailable)?;
    let saved = saved.unwrap_or(&Value::Null);
    let name = saved["name"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| a["display_name"].as_str().filter(|s| !s.is_empty()))
        .unwrap_or(id);
    let pfp = if let Some(photo) = saved["photo_id"]
        .as_str()
        .and_then(|s| s.parse::<Uuid>().ok())
    {
        format!("/v1/contacts/photos/{photo}")
    } else {
        a["pfp_url"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| accounts::default_pfp(st, kind, uuid))
    };
    Ok(json!({"uuid":uuid,"id":id,"kind":kind,"displayName":name,"pfp":pfp,"trust":saved["trust"]}))
}

pub async fn resolved(st: &AppState, caller: &Caller, q: &str) -> ApiResult<Option<Value>> {
    if connected(st, caller.uuid).await? {
        let book = Book::new(st, caller, false).await?;
        let a = match book
            .json(Method::GET, &["lookup"], &[("q", q.into())], None)
            .await
        {
            Ok(v) => v,
            Err(e)
                if matches!(
                    e.status,
                    StatusCode::BAD_REQUEST
                        | StatusCode::NOT_FOUND
                        | StatusCode::UNPROCESSABLE_ENTITY
                ) =>
            {
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        let uuid = a["uuid"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .ok_or_else(unavailable)?;
        return Ok(Some(profile(st, &a, book.saved(uuid).await?.as_ref())?));
    }
    Ok(accounts::resolve(st, q).await?.map(|(_, a)| a))
}

#[derive(Deserialize, Default)]
pub struct Search {
    q: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}

fn fuzzy(needle: &str, value: &str) -> bool {
    let lower = value.to_lowercase();
    let mut chars = lower.chars();
    needle
        .chars()
        .filter(|c| !c.is_whitespace())
        .all(|c| chars.by_ref().any(|v| c == v))
}

async fn page(
    st: &AppState,
    caller: &Caller,
    q: Search,
    include_peers: bool,
) -> ApiResult<Json<Value>> {
    let query = q.q.unwrap_or_default().trim().to_lowercase();
    if query.len() > 320 {
        return Err(ApiError::bad_request(
            "invalid_query",
            "Search text is too long.",
            "Use at most 320 bytes.",
        ));
    }
    let limit = q.limit.unwrap_or(30).clamp(1, 200);
    let offset = q.offset.unwrap_or(0);
    let consent = connected(st, caller.uuid).await?;
    let mut people = HashMap::new();
    let mut blocked = HashSet::new();
    if consent {
        let book = Book::new(st, caller, false).await?;
        if include_peers {
            let relationships = book
                .json(Method::GET, &["relationships"], &[], None)
                .await?;
            for row in relationships["items"].as_array().ok_or_else(unavailable)? {
                if row["blocked"] == true {
                    blocked.insert(
                        row["uuid"]
                            .as_str()
                            .and_then(|v| v.parse::<Uuid>().ok())
                            .ok_or_else(unavailable)?,
                    );
                }
            }
        }
        let mut start = 0;
        loop {
            let res = book
                .json(
                    Method::GET,
                    &["contacts"],
                    &[("limit", "200".into()), ("offset", start.to_string())],
                    None,
                )
                .await?;
            let list = res["items"].as_array().ok_or_else(unavailable)?;
            let total = res["total"].as_u64().ok_or_else(unavailable)?;
            for saved in list {
                let uuid = saved["uuid"]
                    .as_str()
                    .and_then(|s| s.parse::<Uuid>().ok())
                    .ok_or_else(unavailable)?;
                if saved["blocked"] == true || blocked.contains(&uuid) {
                    blocked.insert(uuid);
                } else {
                    people.insert(uuid, profile(st, &saved["account"], Some(saved))?);
                }
            }
            start += list.len() as u64;
            if start >= total {
                break;
            }
            if list.is_empty() {
                return Err(unavailable());
            }
        }
    }
    if include_peers {
        let peers: Vec<Uuid> = sqlx::query_scalar("select account from access where invited_by=$1 and account is not null
            union select invited_by from access where account=$1 and invited_by is not null
            union select to_account from transfers where from_account=$1 union select from_account from transfers where to_account=$1")
            .bind(caller.uuid).fetch_all(&st.pool).await?;
        let missing: Vec<_> = peers
            .into_iter()
            .filter(|k| !people.contains_key(k) && !blocked.contains(k) && *k != caller.uuid)
            .collect();
        people.extend(accounts::accounts_json(st, &missing).await);
        if (accounts::is_handle(&query) || Uuid::parse_str(&query).is_ok())
            && !people
                .values()
                .any(|v| v["id"] == query || v["uuid"] == query)
            && let Some(a) = resolved(st, caller, &query).await?
            && let Some(uuid) = a["uuid"].as_str().and_then(|s| s.parse::<Uuid>().ok())
            && !blocked.contains(&uuid)
        {
            people.insert(uuid, a);
        }
    }
    people.remove(&caller.uuid);
    let mut items: Vec<_> = people
        .into_values()
        .filter(|a| {
            a["uuid"] == query
                || ["displayName", "id"]
                    .iter()
                    .any(|k| fuzzy(&query, a[*k].as_str().unwrap_or("")))
        })
        .collect();
    items.sort_by_cached_key(|a| {
        (
            std::cmp::Reverse(a["trust"].as_u64().unwrap_or(0)),
            a["displayName"].as_str().unwrap_or("").to_lowercase(),
            a["id"].as_str().unwrap_or("").to_owned(),
        )
    });
    let total = items.len();
    Ok(Json(
        json!({"connected":consent,"total":total,"offset":offset,"limit":limit,"items":items.into_iter().skip(offset).take(limit).collect::<Vec<_>>() }),
    ))
}

async fn people(State(st): State<AppState>, c: Caller, Q(q): Q<Search>) -> ApiResult<Json<Value>> {
    page(&st, &c, q, true).await
}
async fn contacts(
    State(st): State<AppState>,
    c: Caller,
    Q(q): Q<Search>,
) -> ApiResult<Json<Value>> {
    page(&st, &c, q, false).await
}
async fn connection(State(st): State<AppState>, c: Caller) -> ApiResult<Json<Value>> {
    Ok(Json(json!({"connected":connected(&st,c.uuid).await?})))
}

#[derive(Deserialize)]
struct Connection {
    connected: bool,
}
async fn set_connection(
    State(st): State<AppState>,
    c: Caller,
    JsonBody(b): JsonBody<Connection>,
) -> ApiResult<Json<Value>> {
    if b.connected {
        Book::new(&st, &c, false)
            .await?
            .json(Method::GET, &["me"], &[], None)
            .await?;
        sqlx::query("insert into contacts_connections(account) values($1) on conflict do nothing")
            .bind(c.uuid)
            .execute(&st.pool)
            .await?;
    } else {
        sqlx::query("delete from contacts_connections where account=$1")
            .bind(c.uuid)
            .execute(&st.pool)
            .await?;
    }
    Ok(Json(json!({"connected":b.connected})))
}

pub(super) fn consent_required() -> ApiError {
    ApiError::forbidden(
        "contacts_not_connected",
        "Connect Silicon Contacts to use your address book.",
        "Open Contacts in Present and select Connect.",
    )
}

async fn lock_connection(
    st: &AppState,
    owner: Uuid,
) -> ApiResult<sqlx::Transaction<'_, sqlx::Postgres>> {
    let mut tx = st.pool.begin().await?;
    let connected: Option<Uuid> =
        sqlx::query_scalar("select account from contacts_connections where account=$1 for update")
            .bind(owner)
            .fetch_optional(&mut *tx)
            .await?;
    if connected.is_none() {
        return Err(consent_required());
    }
    Ok(tx)
}

async fn remove(
    State(st): State<AppState>,
    c: Caller,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let tx = lock_connection(&st, c.uuid).await?;
    let removed = Book::new(&st, &c, true)
        .await?
        .json(Method::DELETE, &["contacts", &id.to_string()], &[], None)
        .await?;
    tx.commit().await?;
    Ok(Json(removed))
}

#[derive(Deserialize)]
struct Save {
    id: String,
    name: String,
    trust: u8,
}
async fn save(
    State(st): State<AppState>,
    c: Caller,
    JsonBody(b): JsonBody<Save>,
) -> ApiResult<Json<Value>> {
    if b.trust == 0 || b.name.trim().is_empty() || b.name.len() > 200 {
        return Err(ApiError::bad_request(
            "invalid_contact",
            "Enter a name and a trust level from 1 to 255.",
            "Use up to 200 bytes for the name.",
        ));
    }
    let tx = lock_connection(&st, c.uuid).await?;
    let book = Book::new(&st, &c, true).await?;
    let a = book
        .json(Method::GET, &["lookup"], &[("q", b.id)], None)
        .await?;
    let uuid = a["uuid"]
        .as_str()
        .and_then(|v| v.parse::<Uuid>().ok())
        .ok_or_else(unavailable)?;
    let previous = book.saved(uuid).await?.unwrap_or_default();
    let mut body = json!({"id":uuid,"name":b.name.trim(),"trust":b.trust});
    for key in [
        "note",
        "phone",
        "email",
        "photo_id",
        "birthday_day",
        "birthday_month",
        "birthday_year",
    ] {
        if let Some(v) = previous.get(key) {
            body[key] = v.clone();
        }
    }
    let saved = book
        .json(Method::POST, &["contacts"], &[], Some(&body))
        .await?;
    tx.commit().await?;
    Ok(Json(profile(&st, &a, Some(&saved))?))
}

async fn photo(
    State(st): State<AppState>,
    c: Caller,
    Path(photo): Path<Uuid>,
) -> ApiResult<Response> {
    if !connected(&st, c.uuid).await? {
        return Err(consent_required());
    }
    let bytes = Book::new(&st, &c, false)
        .await?
        .request(Method::GET, &["photos", &photo.to_string()], &[], None)
        .await?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(unavailable());
    }
    Ok((
        [
            ("Content-Type", "image/png"),
            ("Cache-Control", "private, no-store"),
            ("X-Content-Type-Options", "nosniff"),
        ],
        bytes,
    )
        .into_response())
}

/// Changes only the represented viewer's response. Saved names and photos must never enter shared decks or Tings.
pub async fn personalize_access(st: &AppState, c: &Caller, access: &mut Value) -> ApiResult<()> {
    if !connected(st, c.uuid).await? {
        return Ok(());
    }
    let book = Book::new(st, c, false).await?;
    let mut ids = HashSet::new();
    if let Some(id) = access["owner"]["uuid"].as_str() {
        ids.insert(id.to_owned());
    }
    if let Some(members) = access["members"].as_array() {
        for m in members {
            if let Some(id) = m["account"]["uuid"].as_str() {
                ids.insert(id.to_owned());
            }
        }
    }
    let mut saved = HashMap::new();
    for id in ids {
        if let Ok(uuid) = id.parse()
            && let Some(contact) = book.saved(uuid).await?
        {
            saved.insert(id, profile(st, &contact["account"], Some(&contact))?);
        }
    }
    let overlay = |a: &mut Value| {
        if let Some(v) = a["uuid"].as_str().and_then(|id| saved.get(id)) {
            *a = v.clone();
        }
    };
    overlay(&mut access["owner"]);
    if let Some(members) = access["members"].as_array_mut() {
        for m in members {
            overlay(&mut m["account"]);
        }
    }
    Ok(())
}
