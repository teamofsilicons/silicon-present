//! Search every deck the caller can view by title, slide text, notes and table text; plus `/v1/me`,
//! `/v1/accounts/resolve` and `/health`.

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::access::{self, Role};
use crate::accounts;
use crate::auth::Caller;
use crate::error::{ApiError, ApiResult};
use crate::extract::Q;
use crate::state::AppState;
use crate::store::{DECK_COLUMNS, DeckRow};

#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
}

fn snippet(text: &str, q: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let pos = lower.find(&q.to_lowercase())?;
    let chars: Vec<char> = text.chars().collect();
    let start_char = lower[..pos].chars().count();
    let from = start_char.saturating_sub(40);
    let to = (start_char + q.chars().count() + 40).min(chars.len());
    let mut s: String = chars[from..to].iter().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    if from > 0 {
        s = format!("…{s}");
    }
    if to < chars.len() {
        s.push('…');
    }
    Some(s)
}

pub async fn search(State(st): State<AppState>, caller: Caller, Q(params): Q<SearchQuery>) -> ApiResult<Json<Value>> {
    let q = params.q.unwrap_or_default().trim().to_string();
    if q.is_empty() {
        return Err(ApiError::bad_request("empty_query", "Search needs something to look for.", "Send ?q=<words>."));
    }
    let me = caller.uuid;
    let pattern = format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    // Candidates: decks the caller owns, was shared directly, or through a folder; then the role check decides.
    let rows: Vec<DeckRow> = sqlx::query_as(sql!(
        "with recursive shared_folders as (
           select resource_id as id from access where account = $1 and resource_kind = 'folder'
           union select f.id from folders f join shared_folders s on f.parent = s.id)
         select {DECK_COLUMNS} from decks
         where trashed_at is null and (title ilike $2 or search_text ilike $2) and (
           owner = $1 or id in (select resource_id from access where account = $1 and resource_kind = 'deck')
           or folder in (select id from shared_folders))
         order by updated_at desc limit 50"
    ))
    .bind(me)
    .bind(&pattern)
    .fetch_all(&st.pool)
    .await?;
    let mut results = Vec::new();
    for d in rows {
        let a = access::deck_access(&st, &d, Some(me)).await?;
        if a.role == Role::None {
            continue;
        }
        let mut matches = Vec::new();
        if let Some(s) = snippet(&d.title, &q) {
            matches.push(json!({ "where": "title", "text": s }));
        }
        if let Ok((_, live)) = crate::rooms::current_json(&st, &d.id).await {
            for (i, slide) in live["slides"].as_array().into_iter().flatten().enumerate() {
                let sid = slide["id"].clone();
                for e in slide["elements"].as_array().into_iter().flatten() {
                    let (kind, text) = match e["kind"].as_str() {
                        Some("text") | Some("shape") => ("slide", present_deck::plain_text(&e["text"])),
                        Some("table") => (
                            "table",
                            e["cells"].as_array().into_iter().flatten().flat_map(|r| r.as_array().cloned().unwrap_or_default()).map(|c| present_deck::plain_text(&c["text"])).collect::<Vec<_>>().join(" "),
                        ),
                        Some("chart") => ("slide", e["chart"]["title"].as_str().unwrap_or("").to_string()),
                        _ => continue,
                    };
                    if let Some(s) = snippet(&text, &q) {
                        matches.push(json!({ "where": kind, "slide": sid, "slideNumber": i + 1, "element": e["id"], "text": s }));
                    }
                }
                if let Some(s) = slide["notes"].as_str().and_then(|n| snippet(n, &q)) {
                    matches.push(json!({ "where": "notes", "slide": sid, "slideNumber": i + 1, "text": s }));
                }
            }
        }
        let deck = crate::views::deck_one(&st, &d, a.role).await;
        results.push(json!({ "deck": deck, "matches": matches }));
    }
    Ok(Json(json!({ "results": results })))
}

pub async fn me(State(st): State<AppState>, caller: Caller) -> ApiResult<Json<Value>> {
    let mut a = accounts::account_json(&st, caller.uuid).await;
    if a["id"].as_str().unwrap_or("").is_empty()
        && let Some(h) = &caller.handle
    {
        a["id"] = json!(h);
    }
    Ok(Json(a))
}

#[derive(Deserialize)]
pub struct ResolveQuery {
    q: Option<String>,
}

pub async fn resolve(State(st): State<AppState>, _caller: Caller, Q(params): Q<ResolveQuery>) -> ApiResult<Json<Value>> {
    let q = params.q.unwrap_or_default().trim().to_string();
    if accounts::is_email(&q) {
        let email = q.to_lowercase();
        let account = match accounts::find_by_email(&st, &email).await? {
            Some(uuid) => Some(accounts::account_json(&st, uuid).await),
            None => None,
        };
        return Ok(Json(json!({ "query": q, "email": email, "account": account })));
    }
    if !accounts::is_handle(&q) && uuid::Uuid::parse_str(&q).is_err() {
        return Err(ApiError::bad_request("invalid_query", format!("`{q}` isn't a c:id, si:id, uuid or email address."), "Send ?q=c:name, ?q=si:name or ?q=name@example.com."));
    }
    match accounts::resolve(&st, &q).await? {
        Some((_, a)) => Ok(Json(json!({ "query": q, "account": a }))),
        None => Err(ApiError::not_found("account_not_found", format!("There is no Carbon or Silicon `{q}` on Silicon Accounts."), "Check the spelling of the c:id or si:id.")),
    }
}

pub async fn health(State(st): State<AppState>) -> Json<Value> {
    let db = sqlx::query_scalar::<_, i32>("select 1").fetch_one(&st.pool).await.is_ok();
    Json(json!({
        "ok": db,
        "service": "present",
        "version": env!("CARGO_PKG_VERSION"),
        "database": if db { "ok" } else { "unreachable" },
        "converter": st.converter.is_some(),
        "ting": st.ting.is_some(),
    }))
}
