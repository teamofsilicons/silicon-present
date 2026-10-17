//! The HTTP API (docs/architecture.md, "The service").

pub mod comments;
pub mod decks;
pub mod files;
pub mod folders;
pub mod live;
pub mod presentations;
pub mod search;
pub mod sharing;
pub mod versions;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{HeaderValue, Method};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::Router;


use crate::auth::Caller;
use crate::error::ApiError;
use crate::extract::JsonBody;
use crate::state::AppState;

async fn not_found() -> ApiError {
    ApiError::not_found("not_found", "There is no such endpoint.", "Check the method and path against docs/architecture.md (The service).")
}

async fn method_not_allowed() -> ApiError {
    ApiError::new(axum::http::StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", "This endpoint exists but doesn't take that method.", "Check the method against docs/architecture.md (The service).")
}

/// Requests with an `Idempotency-Key` (and a signed-in caller) act once: a retry gets the first answer back with
/// `Idempotent-Replayed: true`.
async fn idempotency(State(st): State<AppState>, req: Request, next: Next) -> Response {
    if matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        return next.run(req).await;
    }
    let Some(key) = req.headers().get("idempotency-key").and_then(|v| v.to_str().ok()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
        return next.run(req).await;
    };
    if key.len() > 200 {
        return ApiError::bad_request("idempotency_key_too_long", "An Idempotency-Key can be at most 200 characters.", "Use a shorter key, e.g. a uuid.").into_response();
    }
    let (mut parts, body) = req.into_parts();
    let caller = match crate::auth::caller_from_parts(&parts, &st).await {
        Ok(Some(c)) => c,
        Ok(None) => return next.run(Request::from_parts(parts, body)).await,
        Err(e) => return e.into_response(),
    };
    parts.extensions.insert(caller.clone());
    let method = parts.method.to_string();
    let path = parts.uri.path_and_query().map(|p| p.to_string()).unwrap_or_default();
    let stored: Option<(String, String, i32, Vec<u8>, String)> =
        sqlx::query_as("select method, path, status, body, content_type from idempotency_keys where account = $1 and key = $2")
            .bind(caller.uuid)
            .bind(&key)
            .fetch_optional(&st.pool)
            .await
            .unwrap_or(None);
    if let Some((m, p, status, bytes, ctype)) = stored {
        if m != method || p != path {
            return ApiError::conflict(
                "idempotency_key_reused",
                format!("This Idempotency-Key was already used for {m} {p}."),
                "Use a new key for every different request; reuse a key only to retry the same request.",
            )
            .into_response();
        }
        let mut resp = Response::new(Body::from(bytes));
        *resp.status_mut() = axum::http::StatusCode::from_u16(status as u16).unwrap_or(axum::http::StatusCode::OK);
        if let Ok(v) = HeaderValue::from_str(&ctype) {
            resp.headers_mut().insert(axum::http::header::CONTENT_TYPE, v);
        }
        resp.headers_mut().insert("idempotent-replayed", HeaderValue::from_static("true"));
        return resp;
    }
    let resp = next.run(Request::from_parts(parts, body)).await;
    if resp.status().is_server_error() {
        return resp;
    }
    let (rparts, rbody) = resp.into_parts();
    let Ok(bytes) = axum::body::to_bytes(rbody, 16 * 1024 * 1024).await else {
        return ApiError::internal("the response was too large to keep for its Idempotency-Key").into_response();
    };
    let ctype = rparts.headers.get(axum::http::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/json").to_string();
    let _ = sqlx::query(
        "insert into idempotency_keys (account, key, method, path, status, body, content_type) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict do nothing",
    )
    .bind(caller.uuid)
    .bind(&key)
    .bind(&method)
    .bind(&path)
    .bind(rparts.status.as_u16() as i32)
    .bind(bytes.to_vec())
    .bind(&ctype)
    .execute(&st.pool)
    .await;
    Response::from_parts(rparts, Body::from(bytes))
}

/// Sharing routes exist for decks and folders alike; these wrap them with the resource kind.
macro_rules! both {
    ($router:expr, $prefix:literal, $plural:literal) => {
        $router
            .route(
                concat!($prefix, "/{id}/access"),
                get(|st: State<AppState>, c: Caller, Path(id): Path<String>| sharing::list(st, c, Path(($plural.to_string(), id))))
                    .post(|st: State<AppState>, c: Caller, Path(id): Path<String>, b: JsonBody<sharing::InviteBody>| sharing::invite(st, c, Path(($plural.to_string(), id)), b)),
            )
            .route(
                concat!($prefix, "/{id}/access/{member}"),
                axum::routing::patch(|st: State<AppState>, c: Caller, Path((id, m)): Path<(String, String)>, b: JsonBody<sharing::RoleBody>| {
                    sharing::change(st, c, Path(($plural.to_string(), id, m)), b)
                })
                .delete(|st: State<AppState>, c: Caller, Path((id, m)): Path<(String, String)>| sharing::remove(st, c, Path(($plural.to_string(), id, m)))),
            )
            .route(
                concat!($prefix, "/{id}/public"),
                put(|st: State<AppState>, c: Caller, Path(id): Path<String>, b: JsonBody<sharing::PublicBody>| sharing::set_public(st, c, Path(($plural.to_string(), id)), b)),
            )
            .route(
                concat!($prefix, "/{id}/transfer"),
                post(|st: State<AppState>, c: Caller, Path(id): Path<String>, b: JsonBody<sharing::TransferBody>| {
                    sharing::start_transfer(st, c, Path(($plural.to_string(), id)), b)
                }),
            )
    };
}

pub fn router(st: AppState) -> Router {
    let r = Router::new()
        .route("/health", get(search::health))
        .route("/v1/me", get(search::me))
        .route("/v1/accounts/resolve", get(search::resolve))
        .route("/v1/search", get(search::search))
        .route("/v1/decks", get(decks::list).post(decks::create))
        .route("/v1/decks/{id}", get(decks::get).patch(decks::patch).delete(decks::delete))
        .route("/v1/decks/{id}/untrash", post(decks::untrash))
        .route("/v1/decks/{id}/content", get(decks::content))
        .route("/v1/decks/{id}/edits", post(decks::edits))
        .route("/v1/decks/{id}/live", get(live::live))
        .route("/v1/decks/{id}/updates", post(live::post_update))
        .route("/v1/decks/{id}/presence", post(live::presence))
        .route("/v1/decks/{id}/versions", get(versions::list))
        .route("/v1/decks/{id}/versions/{version}/name", post(versions::name))
        .route("/v1/decks/{id}/compare", get(versions::compare))
        .route("/v1/decks/{id}/restore", post(versions::restore))
        .route("/v1/decks/{id}/undo-account", post(versions::undo_account))
        .route("/v1/decks/{id}/events", get(versions::events))
        .route("/v1/decks/{id}/threads", get(comments::list).post(comments::create))
        .route("/v1/threads/{id}/replies", post(comments::reply))
        .route("/v1/threads/{id}/resolve", post(comments::resolve))
        .route("/v1/threads/{id}/reopen", post(comments::reopen))
        .route("/v1/comments/{id}", axum::routing::patch(comments::edit).delete(comments::delete))
        .route("/v1/comments/{id}/reactions/{emoji}", put(comments::react).delete(comments::unreact))
        .route("/v1/transfers", get(sharing::list_transfers))
        .route("/v1/transfers/{id}/{action}", post(sharing::decide_transfer))
        .route("/v1/folders", get(folders::list).post(folders::create))
        .route("/v1/folders/{id}", get(folders::get).patch(folders::patch).delete(folders::delete))
        .route("/v1/folders/{id}/untrash", post(folders::untrash))
        .route("/v1/imports", post(files::import_new))
        .route("/v1/decks/{id}/imports", post(files::import_onto))
        .route("/v1/decks/{id}/export", get(files::export))
        .route("/v1/decks/{id}/slides/{slide}/render", get(files::render))
        .route("/v1/decks/{id}/assets", post(files::upload))
        .route("/v1/assets/{id}", get(files::get_asset))
        .route("/v1/signed/{deck}/{exp}/{sig}/assets/{id}", get(files::get_signed_asset))
        .route("/v1/decks/{id}/presentations", post(presentations::start).get(presentations::list_for_deck))
        .route("/v1/presentations/{id}", get(presentations::get).put(presentations::update).delete(presentations::stop))
        .route("/v1/presentations/{id}/live", get(presentations::live));
    let r = both!(r, "/v1/decks", "decks");
    let r = both!(r, "/v1/folders", "folders");
    r.fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn_with_state(st.clone(), idempotency))
        .layer(DefaultBodyLimit::max(files::MAX_UPLOAD))
        .with_state(st)
}

/// Collapses `//` in paths before routing, so `assetBase + "/" + id` works as well as `assetBase + id`.
pub fn collapse_slashes(mut req: Request) -> Request {
    let path = req.uri().path();
    if path.contains("//") {
        let mut clean = String::with_capacity(path.len());
        for c in path.chars() {
            if !(c == '/' && clean.ends_with('/')) {
                clean.push(c);
            }
        }
        let pq = match req.uri().query() {
            Some(q) => format!("{clean}?{q}"),
            None => clean,
        };
        if let Ok(uri) = pq.parse() {
            *req.uri_mut() = uri;
        }
    }
    req
}

pub type Service = tower::util::MapRequest<Router, fn(Request) -> Request>;

pub fn service(st: AppState) -> Service {
    tower::ServiceExt::map_request(router(st), collapse_slashes as fn(Request) -> Request)
}

