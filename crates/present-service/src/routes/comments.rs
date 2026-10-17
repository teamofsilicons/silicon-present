//! Comments: threads anchored to the deck, a slide, a point, an area, an element or some text; replies,
//! reactions, edits, resolve/reopen, soft delete (kept in history), mentions, and the tings they cause.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::access::{self, Need, Role};
use crate::accounts;
use crate::auth::{Caller, MaybeCaller};
use crate::error::{ApiError, ApiResult};
use crate::extract::{JsonBody, Q};
use crate::state::AppState;
use crate::store::{self, DeckRow, ts, ts_opt};

#[derive(sqlx::FromRow, Clone)]
struct ThreadRow {
    id: String,
    deck: String,
    anchor: Value,
    snapshot: Value,
    state: String,
    created_by: Uuid,
    resolved_by: Option<Uuid>,
    resolved_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
}

const THREAD_COLUMNS: &str = "id, deck, anchor, snapshot, state, created_by, resolved_by, resolved_at, created_at, updated_at";

#[derive(sqlx::FromRow, Clone)]
struct CommentRow {
    id: String,
    thread: String,
    author: Uuid,
    body: String,
    mentions: Vec<Uuid>,
    created_at: OffsetDateTime,
    edited_at: Option<OffsetDateTime>,
    deleted_at: Option<OffsetDateTime>,
}

const COMMENT_COLUMNS: &str = "id, thread, author, body, mentions, created_at, edited_at, deleted_at";

fn slide_number(deck: &Value, slide: &str) -> Option<usize> {
    deck["slides"].as_array()?.iter().position(|s| s["id"] == slide).map(|i| i + 1)
}

fn find_element<'a>(deck: &'a Value, slide: &str, element: &str) -> Option<&'a Value> {
    let s = if slide == "master" { &deck["master"] } else { deck["slides"].as_array()?.iter().find(|s| s["id"] == slide)? };
    s["elements"].as_array()?.iter().find(|e| e["id"] == element)
}

fn excerpt(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > n { format!("{}…", s.chars().take(n).collect::<String>()) } else { s }
}

fn element_label(e: &Value) -> String {
    let kind = e["kind"].as_str().unwrap_or("element");
    let text = match kind {
        "text" | "shape" => excerpt(&present_deck::plain_text(&e["text"]), 40),
        "chart" => e["chart"]["title"].as_str().map(|t| excerpt(t, 40)).unwrap_or_default(),
        "image" | "video" | "audio" => e["alt"].as_str().map(|t| excerpt(t, 40)).unwrap_or_default(),
        _ => String::new(),
    };
    let kind = if kind == "html" { "HTML element" } else { kind };
    if text.is_empty() { kind.to_string() } else { format!("{kind} “{text}”") }
}

fn num(v: &Value, field: &str) -> ApiResult<f64> {
    v.get(field).and_then(Value::as_f64).ok_or_else(|| {
        ApiError::bad_request("invalid_anchor", format!("This anchor needs `{field}` (a number in slide pixels)."), "See docs/architecture.md (Comments) for each anchor's fields.")
    })
}

/// Checks an anchor against the deck as it is now and returns (clean anchor, snapshot).
fn validate_anchor(deck: &Value, anchor: &Value) -> ApiResult<(Value, Value)> {
    let kind = anchor["kind"].as_str().unwrap_or("");
    let mut clean = Map::new();
    clean.insert("kind".into(), json!(kind));
    if kind == "deck" {
        return Ok((Value::Object(clean), json!({ "slideNumber": null, "label": "the deck" })));
    }
    if !["slide", "point", "area", "element", "text"].contains(&kind) {
        return Err(ApiError::bad_request("invalid_anchor", format!("`{kind}` isn't an anchor kind."), "Use deck, slide, point, area, element or text."));
    }
    let slide = anchor["slide"].as_str().unwrap_or("");
    let number = slide_number(deck, slide);
    if number.is_none() && slide != "master" {
        return Err(ApiError::not_found("slide_not_found", format!("There is no slide `{slide}` in this deck to comment on."), "Read the deck again to get its current slide ids."));
    }
    clean.insert("slide".into(), json!(slide));
    let where_ = number.map(|n| format!("slide {n}")).unwrap_or_else(|| "the master".into());
    let el = match anchor.get("element").and_then(Value::as_str) {
        Some(e) => Some(find_element(deck, slide, e).ok_or_else(|| {
            ApiError::not_found("element_not_found", format!("There is no element `{e}` on slide `{slide}` to comment on."), "Read the deck again to get its current element ids.")
        })?),
        None => None,
    };
    if let Some(e) = el {
        clean.insert("element".into(), e["id"].clone());
    }
    let on_el = el.map(|e| format!(" on {}", element_label(e))).unwrap_or_default();
    let label = match kind {
        "slide" => where_.clone(),
        "point" | "area" => {
            for f in ["x", "y"] {
                clean.insert(f.into(), json!(num(anchor, f)?));
            }
            if kind == "area" {
                for f in ["w", "h"] {
                    clean.insert(f.into(), json!(num(anchor, f)?));
                }
            }
            for f in ["ex", "ey", "ew", "eh"] {
                if let Some(v) = anchor.get(f).and_then(Value::as_f64) {
                    clean.insert(f.into(), json!(v));
                }
            }
            format!("{} on {where_}{on_el}", if kind == "point" { "a point" } else { "an area" })
        }
        "element" => {
            let e = el.ok_or_else(|| ApiError::bad_request("invalid_anchor", "An element anchor needs `element`.", "Send { kind: \"element\", slide, element }."))?;
            format!("{} on {where_}", element_label(e))
        }
        "text" => {
            let field = anchor["field"].as_str().unwrap_or("text");
            if !(field == "text" || field == "notes" || field.starts_with("cell:")) {
                return Err(ApiError::bad_request("invalid_anchor", format!("`{field}` isn't a text field."), "Use text, notes or cell:r:c."));
            }
            if field != "notes" && el.is_none() {
                return Err(ApiError::bad_request("invalid_anchor", "A text anchor needs `element` (except on notes).", "Send { kind: \"text\", slide, element, field, quote }."));
            }
            let quote = anchor["quote"].as_str().unwrap_or("").to_string();
            if quote.trim().is_empty() {
                return Err(ApiError::bad_request("invalid_anchor", "A text anchor needs `quote`: the text the comment is on.", "Send the selected text as quote."));
            }
            clean.insert("field".into(), json!(field));
            clean.insert("quote".into(), json!(quote));
            for f in ["start", "end"] {
                if let Some(v) = anchor.get(f).and_then(Value::as_str) {
                    clean.insert(f.into(), json!(v));
                }
            }
            let inside = if field == "notes" { format!("the notes of {where_}") } else { format!("{}{}", el.map(element_label).unwrap_or_default(), format_args!(" on {where_}")) };
            format!("“{}” in {inside}", excerpt(&quote, 60))
        }
        _ => unreachable!(),
    };
    let snapshot = json!({
        "slideNumber": number,
        "elementKind": el.map(|e| e["kind"].clone()),
        "label": label,
    });
    Ok((Value::Object(clean), snapshot))
}

/// `@c:name` / `@si:name` in a body, lowercased, in order, without duplicates.
pub fn parse_mentions(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let chars: Vec<char> = body.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' && (i == 0 || !chars[i - 1].is_alphanumeric()) {
            let rest: String = chars[i + 1..].iter().collect();
            let lower = rest.to_lowercase();
            let prefix = if lower.starts_with("si:") { Some(3) } else if lower.starts_with("c:") { Some(2) } else { None };
            if let Some(p) = prefix {
                let name: String = rest[p..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.').collect();
                let name = name.trim_end_matches('.').to_string();
                if !name.is_empty() {
                    let handle = format!("{}{}", &lower[..p], name.to_lowercase());
                    if !out.contains(&handle) {
                        out.push(handle);
                    }
                }
            }
        }
        i += 1;
    }
    out
}

fn check_body(body: &str) -> ApiResult<String> {
    let b = body.trim();
    if b.is_empty() {
        return Err(ApiError::bad_request("empty_comment", "A comment can't be empty.", "Write something in `body`."));
    }
    if b.chars().count() > 10_000 {
        return Err(ApiError::bad_request("comment_too_long", "A comment can be at most 10,000 characters.", "Split it into replies."));
    }
    Ok(b.to_string())
}

async fn comments_for(st: &AppState, thread_ids: &[String]) -> ApiResult<Vec<CommentRow>> {
    Ok(sqlx::query_as(sql!("select {COMMENT_COLUMNS} from comments where thread = any($1) order by created_at, id"))
        .bind(thread_ids)
        .fetch_all(&st.pool)
        .await?)
}

async fn render_threads(st: &AppState, threads: &[ThreadRow]) -> ApiResult<Vec<Value>> {
    if threads.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<String> = threads.iter().map(|t| t.id.clone()).collect();
    let comments = comments_for(st, &ids).await?;
    let comment_ids: Vec<String> = comments.iter().map(|c| c.id.clone()).collect();
    let reactions: Vec<(String, Uuid, String)> = sqlx::query_as("select comment, account, emoji from reactions where comment = any($1) order by created_at")
        .bind(&comment_ids)
        .fetch_all(&st.pool)
        .await?;
    let mut uuids: Vec<Uuid> = threads.iter().flat_map(|t| [Some(t.created_by), t.resolved_by]).flatten().collect();
    uuids.extend(comments.iter().map(|c| c.author));
    uuids.extend(comments.iter().flat_map(|c| c.mentions.iter().copied()));
    uuids.extend(reactions.iter().map(|r| r.1));
    let accts = accounts::accounts_json(st, &uuids).await;
    let deck_ids: Vec<String> = threads.iter().map(|t| t.deck.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    let mut decks: HashMap<String, Value> = HashMap::new();
    for d in deck_ids {
        if let Ok((_, j)) = crate::rooms::current_json(st, &d).await {
            decks.insert(d, j);
        }
    }
    let mut by_thread: HashMap<String, Vec<Value>> = HashMap::new();
    for c in &comments {
        let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
        for (_, who, emoji) in reactions.iter().filter(|r| r.0 == c.id) {
            let a = accts.get(who).cloned().unwrap_or(Value::Null);
            match groups.iter_mut().find(|g| &g.0 == emoji) {
                Some(g) => g.1.push(a),
                None => groups.push((emoji.clone(), vec![a])),
            }
        }
        let reactions: Vec<Value> = groups.into_iter().map(|(e, a)| json!({ "emoji": e, "count": a.len(), "accounts": a })).collect();
        let deleted = c.deleted_at.is_some();
        by_thread.entry(c.thread.clone()).or_default().push(json!({
            "id": c.id,
            "thread": c.thread,
            "author": accts.get(&c.author),
            "body": if deleted { Value::Null } else { json!(c.body) },
            "mentions": c.mentions.iter().filter_map(|m| accts.get(m).cloned()).collect::<Vec<_>>(),
            "createdAt": ts(c.created_at),
            "editedAt": ts_opt(c.edited_at),
            "deleted": deleted,
            "deletedAt": ts_opt(c.deleted_at),
            "reactions": reactions,
        }));
    }
    Ok(threads
        .iter()
        .map(|t| {
            let deck = decks.get(&t.deck);
            let slide = t.anchor["slide"].as_str();
            let number = match (deck, slide) {
                (Some(d), Some(s)) => slide_number(d, s),
                _ => None,
            };
            let exists = match (deck, slide, t.anchor["element"].as_str()) {
                (_, None, _) => true,
                (Some(d), Some(s), Some(e)) => find_element(d, s, e).is_some(),
                (Some(_), Some(s), None) => number.is_some() || s == "master",
                _ => true,
            };
            json!({
                "id": t.id,
                "deck": t.deck,
                "anchor": t.anchor,
                "snapshot": t.snapshot,
                "current": { "slideNumber": number, "exists": exists },
                "state": t.state,
                "createdBy": accts.get(&t.created_by),
                "createdAt": ts(t.created_at),
                "updatedAt": ts(t.updated_at),
                "resolvedBy": t.resolved_by.and_then(|r| accts.get(&r).cloned()),
                "resolvedAt": ts_opt(t.resolved_at),
                "comments": by_thread.remove(&t.id).unwrap_or_default(),
            })
        })
        .collect())
}

/// Threads of a deck (`state` = open, resolved or all), oldest first.
pub async fn threads_json(st: &AppState, deck: &str, state: &str) -> ApiResult<Vec<Value>> {
    let rows: Vec<ThreadRow> = sqlx::query_as(sql!("select {THREAD_COLUMNS} from threads where deck = $1 and ($2 = 'all' or state = $2) order by created_at, id"))
        .bind(deck)
        .bind(state)
        .fetch_all(&st.pool)
        .await?;
    render_threads(st, &rows).await
}

async fn thread_one(st: &AppState, id: &str) -> ApiResult<Value> {
    let row: ThreadRow = sqlx::query_as(sql!("select {THREAD_COLUMNS} from threads where id = $1")).bind(id).fetch_one(&st.pool).await?;
    Ok(render_threads(st, &[row]).await?.remove(0))
}

async fn broadcast(st: &AppState, deck: &str, thread: &Value) {
    if let Some(room) = st.rooms.loaded(deck).await {
        room.send("comments", json!({ "thread": thread }));
    }
}

#[derive(Deserialize)]
pub struct ListQuery {
    state: Option<String>,
}

pub async fn list(State(st): State<AppState>, caller: MaybeCaller, Path(id): Path<String>, Q(q): Q<ListQuery>) -> ApiResult<Json<Value>> {
    access::deck_for(&st, &id, caller.uuid(), Need::View).await?;
    let state = q.state.as_deref().unwrap_or("all");
    if !["open", "resolved", "all"].contains(&state) {
        return Err(ApiError::bad_request("invalid_state", format!("`{state}` isn't a thread state."), "Use state=open, state=resolved or state=all."));
    }
    Ok(Json(json!({ "threads": threads_json(&st, &id, state).await? })))
}

/// Resolves mentions in a body: (uuids that exist, handles that don't).
async fn resolve_mentions(st: &AppState, body: &str) -> ApiResult<(Vec<Uuid>, Vec<String>)> {
    let mut found = Vec::new();
    let mut unknown = Vec::new();
    for handle in parse_mentions(body).into_iter().take(20) {
        match accounts::resolve(st, &handle).await? {
            Some((uuid, _)) if !found.contains(&uuid) => found.push(uuid),
            Some(_) => {}
            None => unknown.push(handle),
        }
    }
    Ok((found, unknown))
}

struct TingContext {
    deck: Value,
    slide: Value,
    on: Value,
    thread: Value,
}

fn ting_context(st: &AppState, deck: &DeckRow, t: &ThreadRow, live: &Value) -> TingContext {
    let slide = t.anchor["slide"].as_str().map(|s| json!({ "id": s, "number": slide_number(live, s) })).unwrap_or(Value::Null);
    TingContext {
        deck: json!({ "id": deck.id, "title": deck.title, "link": st.deck_link(&deck.id) }),
        slide,
        on: json!({ "anchor": t.anchor, "label": t.snapshot["label"], "quote": t.anchor.get("quote") }),
        thread: json!({ "id": t.id, "state": t.state, "link": format!("{}?thread={}", st.deck_link(&deck.id), t.id) }),
    }
}

/// Queues the tings a new comment causes. Returns the mentioned accounts that can't see the deck.
async fn notify_comment(st: &AppState, deck: &DeckRow, t: &ThreadRow, c: &CommentRow, mentions: &[Uuid], new_thread: bool) -> ApiResult<Vec<Value>> {
    let actor = c.author;
    let (_, live) = crate::rooms::current_json(st, &deck.id).await?;
    let ctx = ting_context(st, deck, t, &live);
    let actor_json = accounts::account_json(st, actor).await;
    let data = json!({
        "deck": ctx.deck, "slide": ctx.slide, "on": ctx.on, "thread": ctx.thread,
        "comment": { "id": c.id, "body": c.body, "author": actor_json, "createdAt": ts(c.created_at),
                     "link": format!("{}?thread={}&comment={}", st.deck_link(&deck.id), t.id, c.id) },
        "actor": actor_json,
    });
    let mut notified: Vec<Uuid> = vec![actor];
    let mut without_access = Vec::new();
    for m in mentions {
        if notified.contains(m) {
            continue;
        }
        let a = access::deck_access(st, deck, Some(*m)).await?;
        if a.role == Role::None {
            without_access.push(accounts::account_json(st, *m).await);
            continue;
        }
        crate::tings::enqueue(st, "present.mention.received", *m, Some(actor), &format!("present.mention.received:{}:{m}", c.id), data.clone()).await?;
        notified.push(*m);
    }
    if !new_thread {
        let mut participants: Vec<Uuid> = sqlx::query_scalar("select distinct author from comments where thread = $1 and deleted_at is null")
            .bind(&t.id)
            .fetch_all(&st.pool)
            .await?;
        participants.push(t.created_by);
        for p in participants {
            if notified.contains(&p) {
                continue;
            }
            crate::tings::enqueue(st, "present.comment.replied", p, Some(actor), &format!("present.comment.replied:{}:{p}", c.id), data.clone()).await?;
            notified.push(p);
        }
    }
    if !notified.contains(&deck.owner) {
        crate::tings::enqueue(st, "present.comment.created", deck.owner, Some(actor), &format!("present.comment.created:{}:{}", c.id, deck.owner), data).await?;
    }
    Ok(without_access)
}

#[derive(Deserialize)]
pub struct CreateBody {
    anchor: Value,
    body: String,
}

pub async fn create(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, JsonBody(body): JsonBody<CreateBody>) -> ApiResult<Response> {
    let me = caller.uuid;
    let (deck, _) = access::deck_for(&st, &id, Some(me), Need::Comment).await?;
    let text = check_body(&body.body)?;
    let (_, live) = crate::rooms::current_json(&st, &id).await?;
    let (anchor, snapshot) = validate_anchor(&live, &body.anchor)?;
    let (mentions, unknown) = resolve_mentions(&st, &text).await?;
    let tid = crate::ids::new_id();
    let cid = crate::ids::new_id();
    let mut tx = st.pool.begin().await?;
    let t: ThreadRow = sqlx::query_as(sql!("insert into threads (id, deck, anchor, snapshot, created_by) values ($1, $2, $3, $4, $5) returning {THREAD_COLUMNS}"))
        .bind(&tid)
        .bind(&id)
        .bind(&anchor)
        .bind(&snapshot)
        .bind(me)
        .fetch_one(&mut *tx)
        .await?;
    let c: CommentRow = sqlx::query_as(sql!("insert into comments (id, thread, author, body, mentions) values ($1, $2, $3, $4, $5) returning {COMMENT_COLUMNS}"))
        .bind(&cid)
        .bind(&tid)
        .bind(me)
        .bind(&text)
        .bind(&mentions)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    let without_access = notify_comment(&st, &deck, &t, &c, &mentions, true).await?;
    let thread = thread_one(&st, &tid).await?;
    broadcast(&st, &id, &thread).await;
    let mut out = thread;
    out["mentionedWithoutAccess"] = json!(without_access);
    out["unknownMentions"] = json!(unknown);
    Ok((StatusCode::CREATED, Json(out)).into_response())
}

async fn thread_for(st: &AppState, tid: &str, caller: Uuid, need: Need) -> ApiResult<(ThreadRow, DeckRow)> {
    let t: ThreadRow = sqlx::query_as(sql!("select {THREAD_COLUMNS} from threads where id = $1"))
        .bind(tid)
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("thread_not_found", format!("There is no comment thread `{tid}`."), "List a deck's threads with GET /v1/decks/{id}/threads."))?;
    let (deck, _) = access::deck_for(st, &t.deck, Some(caller), need).await?;
    Ok((t, deck))
}

#[derive(Deserialize)]
pub struct ReplyBody {
    body: String,
}

pub async fn reply(State(st): State<AppState>, caller: Caller, Path(tid): Path<String>, JsonBody(body): JsonBody<ReplyBody>) -> ApiResult<Response> {
    let me = caller.uuid;
    let (t, deck) = thread_for(&st, &tid, me, Need::Comment).await?;
    let text = check_body(&body.body)?;
    let (mentions, unknown) = resolve_mentions(&st, &text).await?;
    let c: CommentRow = sqlx::query_as(sql!("insert into comments (id, thread, author, body, mentions) values ($1, $2, $3, $4, $5) returning {COMMENT_COLUMNS}"))
        .bind(crate::ids::new_id())
        .bind(&tid)
        .bind(me)
        .bind(&text)
        .bind(&mentions)
        .fetch_one(&st.pool)
        .await?;
    sqlx::query("update threads set updated_at = now() where id = $1").bind(&tid).execute(&st.pool).await?;
    let without_access = notify_comment(&st, &deck, &t, &c, &mentions, false).await?;
    let thread = thread_one(&st, &tid).await?;
    broadcast(&st, &deck.id, &thread).await;
    let comment = thread["comments"].as_array().and_then(|cs| cs.iter().find(|x| x["id"] == c.id.as_str()).cloned()).unwrap_or(Value::Null);
    Ok((StatusCode::CREATED, Json(json!({ "thread": thread, "comment": comment, "mentionedWithoutAccess": without_access, "unknownMentions": unknown }))).into_response())
}

pub async fn resolve(State(st): State<AppState>, caller: Caller, Path(tid): Path<String>) -> ApiResult<Json<Value>> {
    let me = caller.uuid;
    let (t, deck) = thread_for(&st, &tid, me, Need::Comment).await?;
    if t.state != "resolved" {
        let t: ThreadRow = sqlx::query_as(sql!(
            "update threads set state = 'resolved', resolved_by = $2, resolved_at = now(), updated_at = now() where id = $1 returning {THREAD_COLUMNS}"
        ))
        .bind(&tid)
        .bind(me)
        .fetch_one(&st.pool)
        .await?;
        store::event(&st, Some(&deck.id), None, me, "thread.resolved", json!({ "thread": tid })).await?;
        let (_, live) = crate::rooms::current_json(&st, &deck.id).await?;
        let ctx = ting_context(&st, &deck, &t, &live);
        let first: Option<(String, String)> = sqlx::query_as("select id, body from comments where thread = $1 order by created_at limit 1").bind(&tid).fetch_optional(&st.pool).await?;
        let at = t.resolved_at.map(|x| x.unix_timestamp_nanos() / 1_000_000).unwrap_or_default();
        crate::tings::enqueue(
            &st,
            "present.thread.resolved",
            t.created_by,
            Some(me),
            &format!("present.thread.resolved:{tid}:{at}"),
            json!({
                "deck": ctx.deck, "slide": ctx.slide, "on": ctx.on, "thread": ctx.thread,
                "comment": first.map(|(id, body)| json!({ "id": id, "body": body })),
                "actor": accounts::account_json(&st, me).await,
            }),
        )
        .await?;
    }
    let thread = thread_one(&st, &tid).await?;
    broadcast(&st, &deck.id, &thread).await;
    Ok(Json(thread))
}

pub async fn reopen(State(st): State<AppState>, caller: Caller, Path(tid): Path<String>) -> ApiResult<Json<Value>> {
    let me = caller.uuid;
    let (t, deck) = thread_for(&st, &tid, me, Need::Comment).await?;
    if t.state != "open" {
        sqlx::query("update threads set state = 'open', resolved_by = null, resolved_at = null, updated_at = now() where id = $1").bind(&tid).execute(&st.pool).await?;
        store::event(&st, Some(&deck.id), None, me, "thread.reopened", json!({ "thread": tid })).await?;
    }
    let thread = thread_one(&st, &tid).await?;
    broadcast(&st, &deck.id, &thread).await;
    Ok(Json(thread))
}

async fn comment_for(st: &AppState, cid: &str, caller: Uuid, need: Need) -> ApiResult<(CommentRow, ThreadRow, DeckRow, Role)> {
    let c: CommentRow = sqlx::query_as(sql!("select {COMMENT_COLUMNS} from comments where id = $1"))
        .bind(cid)
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("comment_not_found", format!("There is no comment `{cid}`."), "List a deck's threads with GET /v1/decks/{id}/threads."))?;
    let (t, deck) = thread_for(st, &c.thread, caller, need).await?;
    let role = access::deck_access(st, &deck, Some(caller)).await?.role;
    Ok((c, t, deck, role))
}

#[derive(Deserialize)]
pub struct EditBody {
    body: String,
}

pub async fn edit(State(st): State<AppState>, caller: Caller, Path(cid): Path<String>, JsonBody(body): JsonBody<EditBody>) -> ApiResult<Json<Value>> {
    let me = caller.uuid;
    let (c, t, deck, _) = comment_for(&st, &cid, me, Need::Comment).await?;
    if c.author != me {
        return Err(ApiError::forbidden("not_your_comment", "Only whoever wrote a comment can edit it.", "Reply instead."));
    }
    if c.deleted_at.is_some() {
        return Err(ApiError::conflict("comment_deleted", "This comment was deleted, so it can't be edited.", "Write a new reply instead."));
    }
    let text = check_body(&body.body)?;
    let (mentions, _) = resolve_mentions(&st, &text).await?;
    let mut tx = st.pool.begin().await?;
    sqlx::query("insert into comment_revisions (comment, body, replaced_by, reason) values ($1, $2, $3, 'edit')").bind(&cid).bind(&c.body).bind(me).execute(&mut *tx).await?;
    let updated: CommentRow = sqlx::query_as(sql!("update comments set body = $2, mentions = $3, edited_at = now() where id = $1 returning {COMMENT_COLUMNS}"))
        .bind(&cid)
        .bind(&text)
        .bind(&mentions)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    // Only people newly mentioned by the edit hear about it.
    let new: Vec<Uuid> = mentions.iter().filter(|m| !c.mentions.contains(m)).copied().collect();
    if !new.is_empty() {
        let (_, live) = crate::rooms::current_json(&st, &deck.id).await?;
        let ctx = ting_context(&st, &deck, &t, &live);
        let actor = accounts::account_json(&st, me).await;
        for m in new {
            if access::deck_access(&st, &deck, Some(m)).await?.role == Role::None {
                continue;
            }
            crate::tings::enqueue(
                &st,
                "present.mention.received",
                m,
                Some(me),
                &format!("present.mention.received:{cid}:{m}"),
                json!({ "deck": ctx.deck, "slide": ctx.slide, "on": ctx.on, "thread": ctx.thread,
                        "comment": { "id": cid, "body": updated.body, "author": actor, "createdAt": ts(updated.created_at) }, "actor": actor }),
            )
            .await?;
        }
    }
    let thread = thread_one(&st, &t.id).await?;
    broadcast(&st, &deck.id, &thread).await;
    Ok(Json(thread))
}

pub async fn delete(State(st): State<AppState>, caller: Caller, Path(cid): Path<String>) -> ApiResult<Response> {
    let me = caller.uuid;
    let (c, t, deck, role) = comment_for(&st, &cid, me, Need::Comment).await?;
    if c.author != me && role < Role::Owner {
        return Err(ApiError::forbidden("not_your_comment", "Only whoever wrote a comment, or the deck's owner, can delete it.", "Resolve the thread instead."));
    }
    if c.deleted_at.is_none() {
        let mut tx = st.pool.begin().await?;
        sqlx::query("insert into comment_revisions (comment, body, replaced_by, reason) values ($1, $2, $3, 'delete')").bind(&cid).bind(&c.body).bind(me).execute(&mut *tx).await?;
        sqlx::query("update comments set deleted_at = now(), deleted_by = $2 where id = $1").bind(&cid).bind(me).execute(&mut *tx).await?;
        tx.commit().await?;
        store::event(&st, Some(&deck.id), None, me, "comment.deleted", json!({ "thread": t.id, "comment": cid, "author": c.author })).await?;
    }
    let thread = thread_one(&st, &t.id).await?;
    broadcast(&st, &deck.id, &thread).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn react(State(st): State<AppState>, caller: Caller, Path((cid, emoji)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let me = caller.uuid;
    let (c, t, deck, _) = comment_for(&st, &cid, me, Need::Comment).await?;
    let emoji = emoji.trim();
    if emoji.is_empty() || emoji.chars().count() > 16 {
        return Err(ApiError::bad_request("invalid_emoji", "A reaction is one emoji (at most 16 characters).", "Send it URL-encoded in the path, e.g. /reactions/%F0%9F%91%8D."));
    }
    if c.deleted_at.is_some() {
        return Err(ApiError::conflict("comment_deleted", "This comment was deleted, so it can't be reacted to.", "React to another comment."));
    }
    sqlx::query("insert into reactions (comment, account, emoji) values ($1, $2, $3) on conflict do nothing").bind(&cid).bind(me).bind(emoji).execute(&st.pool).await?;
    let thread = thread_one(&st, &t.id).await?;
    broadcast(&st, &deck.id, &thread).await;
    Ok(Json(thread))
}

pub async fn unreact(State(st): State<AppState>, caller: Caller, Path((cid, emoji)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let me = caller.uuid;
    let (_, t, deck, _) = comment_for(&st, &cid, me, Need::Comment).await?;
    sqlx::query("delete from reactions where comment = $1 and account = $2 and emoji = $3").bind(&cid).bind(me).bind(emoji.trim()).execute(&st.pool).await?;
    let thread = thread_one(&st, &t.id).await?;
    broadcast(&st, &deck.id, &thread).await;
    Ok(Json(thread))
}

#[cfg(test)]
mod tests {
    use super::parse_mentions;

    #[test]
    fn finds_mentions() {
        assert_eq!(parse_mentions("@si:designer make this simpler, cc @c:Ada."), vec!["si:designer", "c:ada"]);
        assert_eq!(parse_mentions("mail me@c:x.com"), Vec::<String>::new());
        assert_eq!(parse_mentions("@si:a @si:a @c:"), vec!["si:a"]);
    }
}
