//! `POST /v1/reports`: any signed-in Carbon or Silicon reports a problem or an idea (`present report`). Each report
//! is kept in `reports` and mailed to the team, like the other Silicon apps' report commands.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::accounts;
use crate::auth::Caller;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::state::AppState;

/// Where reports go (the same destinations as the other Silicon apps' `report` commands).
pub const REPORT_RECIPIENTS: [&str; 3] = ["saketdev12@gmail.com", "shubhastro2@gmail.com", "bugs@teamofsilicons.com"];

#[derive(Deserialize)]
pub struct ReportBody {
    message: Option<String>,
    pr: Option<String>,
    context: Option<Value>,
}

pub async fn create(State(st): State<AppState>, caller: Caller, headers: HeaderMap, JsonBody(body): JsonBody<ReportBody>) -> ApiResult<Response> {
    let message = body.message.as_deref().map(str::trim).unwrap_or("").to_string();
    if message.is_empty() {
        return Err(ApiError::bad_request("message_required", "A report needs `message`: what happened, or what you'd like.", "Send { \"message\": \"…\" }."));
    }
    if message.chars().count() > 10_000 {
        return Err(ApiError::bad_request("message_too_long", "A report's message can be at most 10,000 characters.", "Shorten it, or put the details in `context`."));
    }
    let pr = body.pr.as_deref().map(str::trim).filter(|p| !p.is_empty()).map(String::from);
    if let Some(p) = &pr
        && (!(p.starts_with("https://") || p.starts_with("http://")) || p.len() > 2000 || p.contains(char::is_whitespace))
    {
        return Err(ApiError::bad_request("invalid_pr", format!("`pr` must be a URL (http or https), and `{p}` isn't one."), "Send the pull request's URL, or leave `pr` out."));
    }
    let context = match body.context {
        None | Some(Value::Null) => json!({}),
        Some(v @ Value::Object(_)) => v,
        Some(_) => return Err(ApiError::bad_request("invalid_context", "`context` must be a JSON object.", "Send { \"context\": { … } }, or leave it out.")),
    };
    if context.to_string().len() > 64 * 1024 {
        return Err(ApiError::bad_request("context_too_large", "`context` can be at most 64 KB of JSON.", "Send less context."));
    }
    let client = headers.get(axum::http::header::USER_AGENT).and_then(|v| v.to_str().ok()).map(|s| s.chars().take(300).collect::<String>());
    let version = env!("CARGO_PKG_VERSION");
    let id = crate::ids::new_id();
    let created: time::OffsetDateTime = sqlx::query_scalar(
        "insert into reports (id, account, message, pr, context, app_version, client) values ($1, $2, $3, $4, $5, $6, $7) returning created_at",
    )
    .bind(&id)
    .bind(caller.uuid)
    .bind(&message)
    .bind(&pr)
    .bind(&context)
    .bind(version)
    .bind(&client)
    .fetch_one(&st.pool)
    .await?;
    let who = accounts::account_json(&st, caller.uuid).await;
    let handle = who["id"].as_str().filter(|h| !h.is_empty()).map(String::from).or(caller.handle.clone()).unwrap_or_else(|| caller.uuid.to_string());
    let first_line: String = message.lines().next().unwrap_or("").chars().take(60).collect();
    let subject = format!("Silicon Present report from {handle}: {first_line}");
    let text = format!(
        "Silicon Present report {id}\n\nFrom: {handle} ({}, {}) {}\nWhen: {}\nService version: {version}\nClient: {}\nPR: {}\n\n{message}\n\nContext:\n{}\n",
        who["displayName"].as_str().unwrap_or(""),
        who["kind"].as_str().unwrap_or(""),
        caller.uuid,
        crate::store::ts(created),
        client.as_deref().unwrap_or("unknown"),
        pr.as_deref().unwrap_or("none"),
        serde_json::to_string_pretty(&context).unwrap_or_default(),
    );
    for to in REPORT_RECIPIENTS {
        crate::mail::queue_email(&st, &format!("report:{id}:{to}"), to, &subject, &text).await?;
    }
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))).into_response())
}
