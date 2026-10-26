//! Optional public-link email collection. Email labels never participate in access control.

use std::collections::HashMap;

use axum::extract::{FromRequestParts, MatchedPath, Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::access::{self, Access, Need, Role};
use crate::auth::Caller;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::store::{DeckRow, ts};

#[derive(Clone, Debug, Default)]
pub struct ViewerIdentity {
    pub email: Option<String>,
    pub source: Option<&'static str>,
}

/// A bounded dot-atom email address. This validates syntax, not ownership or delivery.
pub fn normalize_email(value: &str) -> Option<String> {
    let value = value.trim();
    if value.len() > 254 || !value.is_ascii() { return None; }
    let (local, domain) = value.split_once('@')?;
    if local.is_empty() || local.len() > 64 || local.starts_with('.') || local.ends_with('.') || local.contains("..")
        || !local.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-/=?^_`{|}~.".contains(&b)) {
        return None;
    }
    let labels: Vec<_> = domain.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|label| label.is_empty() || label.len() > 63
        || label.starts_with('-') || label.ends_with('-')
        || !label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')) {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

async fn identity(st: &AppState, account: Option<Uuid>, headers: &HeaderMap) -> ApiResult<ViewerIdentity> {
    if let Some(account) = account {
        let cached: Option<(Option<String>, bool)> = sqlx::query_as(
            "select email, refreshed_at > now() - interval '10 minutes' from accounts where uuid = $1",
        ).bind(account).fetch_optional(&st.pool).await?;
        // A first sign-in's background refresh may not have run yet. Resolve the
        // profile synchronously before considering an unverified entered address.
        let email = match &cached {
            Some((email, true)) => email.as_deref().and_then(normalize_email),
            _ => match st.directory.profile(account).await {
                Ok(Some(profile)) => {
                    let email = profile.email.as_deref().and_then(normalize_email);
                    sqlx::query("insert into accounts (uuid, display_name, pfp_url, email, refreshed_at) values ($1, $2, $3, $4, now())
                        on conflict (uuid) do update set display_name = excluded.display_name, pfp_url = excluded.pfp_url,
                          email = excluded.email, refreshed_at = now()")
                        .bind(account).bind(&profile.display_name).bind(profile.pfp_url.as_deref().unwrap_or_default())
                        .bind(&email).execute(&st.pool).await?;
                    if let Some(email) = &email { crate::accounts::claim_email_invites(st, account, email).await?; }
                    email
                }
                _ => cached.as_ref().and_then(|(email, _)| email.as_deref()).and_then(normalize_email),
            },
        };
        if let Some(email) = email { return Ok(ViewerIdentity { email: Some(email), source: Some("account") }); }
    }
    let email = headers.get("x-present-viewer-email").and_then(|v| v.to_str().ok()).and_then(normalize_email);
    Ok(ViewerIdentity { source: email.as_ref().map(|_| "entered"), email })
}

pub async fn gated(st: &AppState, deck: &DeckRow, account: Option<Uuid>) -> ApiResult<bool> {
    Ok(deck.public_require_email && account != Some(deck.owner)
        && access::deck_access(st, deck, None).await?.role > Role::None)
}

pub async fn check(st: &AppState, deck: &DeckRow, account: Option<Uuid>, viewer: &ViewerIdentity) -> ApiResult<()> {
    if gated(st, deck, account).await? && viewer.email.is_none() {
        return Err(ApiError::forbidden("email_required", "This public deck requires your email address before viewing.",
            "Enter an email address, or sign in to an account that shares its email. Entered addresses are not verified."));
    }
    Ok(())
}

pub async fn deck_for(st: &AppState, id: &str, account: Option<Uuid>, need: Need, viewer: &ViewerIdentity) -> ApiResult<(DeckRow, Access)> {
    let (deck, access) = access::deck_for(st, id, account, need).await?;
    check(st, &deck, account, viewer).await?;
    Ok((deck, access))
}

/// Call only after successful content delivery (never metadata, search, or assets).
/// Concurrent requests count one visit, and another visit at most every 30 minutes.
pub async fn record(st: &AppState, deck: &str, account: Option<Uuid>, viewer: &ViewerIdentity) -> ApiResult<()> {
    let Some(email) = &viewer.email else { return Ok(()) };
    let (deck, _) = access::deck_for(st, deck, account, Need::View).await?;
    if !gated(st, &deck, account).await? { return Ok(()); }
    sqlx::query("insert into deck_viewers (deck, email, source) values ($1, $2, $3)
        on conflict (deck, email, source) do update set
          last_viewed_at = now(),
          views = deck_viewers.views + case when deck_viewers.last_counted_at <= now() - interval '30 minutes' then 1 else 0 end,
          last_counted_at = case when deck_viewers.last_counted_at <= now() - interval '30 minutes' then now() else deck_viewers.last_counted_at end")
        .bind(&deck.id).bind(email).bind(viewer.source.unwrap_or("entered")).execute(&st.pool).await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct ViewerRow { email: String, source: String, first_viewed_at: OffsetDateTime, last_viewed_at: OffsetDateTime, views: i64 }

pub async fn list(State(st): State<AppState>, caller: Caller, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    access::deck_for(&st, &id, Some(caller.uuid), Need::Own).await?;
    let rows: Vec<ViewerRow> = sqlx::query_as("select email, source, first_viewed_at, last_viewed_at, views from deck_viewers where deck = $1 order by last_viewed_at desc, email")
        .bind(&id).fetch_all(&st.pool).await?;
    Ok(Json(json!({ "viewers": rows.into_iter().map(|r| json!({ "email": r.email, "source": r.source,
        "firstViewedAt": ts(r.first_viewed_at), "lastViewedAt": ts(r.last_viewed_at), "views": r.views })).collect::<Vec<_>>() })))
}

/// Gate direct and alternate resource routes before invoking their handlers.
/// Asset handlers validate their signed converter capability before applying the gate.
pub async fn middleware(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let matched = req.extensions().get::<MatchedPath>().map(|p| p.as_str().to_string()).unwrap_or_default();
    if !matched.starts_with("/v1/") || matched.starts_with("/v1/signed/") { return next.run(req).await; }
    let (mut parts, body) = req.into_parts();
    let caller = match crate::auth::caller_from_parts(&parts, &st).await {
        Ok(caller) => caller,
        Err(error) => return error.into_response(),
    };
    if let Some(caller) = &caller { parts.extensions.insert(caller.clone()); }
    let account = caller.as_ref().map(|c| c.uuid);
    let viewer = match identity(&st, account, &parts.headers).await {
        Ok(viewer) => viewer,
        Err(error) => return error.into_response(),
    };
    parts.extensions.insert(viewer.clone());
    let result: ApiResult<Option<String>> = async {
        if !matched.contains("{id}") { return Ok(None); }
        let Path(params) = Path::<HashMap<String, String>>::from_request_parts(&mut parts, &st).await
            .map_err(|_| ApiError::bad_request("invalid_path", "The resource path is invalid.", "Check the URL."))?;
        let Some(id) = params.get("id") else { return Ok(None); };
        if matched.starts_with("/v1/decks/{id}") { return Ok(Some(id.clone())); }
        let query = if matched.starts_with("/v1/presentations/{id}") {
            "select deck from presentations where id = $1"
        } else if matched.starts_with("/v1/threads/{id}") {
            "select deck from threads where id = $1"
        } else if matched.starts_with("/v1/comments/{id}") {
            "select t.deck from comments c join threads t on t.id = c.thread where c.id = $1"
        } else { return Ok(None); };
        Ok(sqlx::query_scalar(query).bind(id).fetch_optional(&st.pool).await?)
    }.await;
    let deck = match result { Ok(deck) => deck, Err(error) => return error.into_response() };
    if let Some(id) = &deck {
        if let Err(error) = deck_for(&st, id, account, Need::View, &viewer).await { return error.into_response(); }
    }
    let count = parts.method == Method::GET && (matched.ends_with("/content") || matched.ends_with("/export")
        || matched.ends_with("/render") || matched == "/v1/presentations/{id}");
    let mut response = next.run(Request::from_parts(parts, body)).await;
    if response.status().is_success() && count {
        if let Some(deck) = &deck {
            if let Err(error) = record(&st, deck, account, &viewer).await { return error.into_response(); }
        }
    }
    if deck.is_some() { response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store")); }
    response
}

#[cfg(test)]
mod tests {
    use super::normalize_email;
    #[test]
    fn email_labels_are_bounded_and_cannot_contain_controls_or_multiple_addresses() {
        assert_eq!(normalize_email(" Example+deck@EXAMPLE.com ").as_deref(), Some("example+deck@example.com"));
        for value in ["", "no-at-sign", "a@b", "a@@b.com", "a\tb@example.com", "a\nb@example.com", "a@-bad.com", ".a@example.com", "a..b@example.com", "a@example.com,b@example.com"] {
            assert!(normalize_email(value).is_none(), "{value:?}");
        }
        assert!(normalize_email(&format!("{}@example.com", "a".repeat(65))).is_none());
    }
}
