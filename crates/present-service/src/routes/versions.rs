//! Versions: grouped automatically (a run of updates by the same author with no gap over 5 minutes), summarized
//! from the deck JSON before and after, nameable, comparable, restorable (whole, one slide, one element), and
//! one Carbon's or Silicon's changes can be undone. Going back is always a new version; nothing is deleted.

use std::collections::{BTreeSet, HashMap};

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Transact, Update};

use crate::access::{self, Need};
use crate::accounts;
use crate::auth::Caller;
use crate::error::{ApiError, ApiResult};
use crate::extract::{JsonBody, Q};
use crate::rooms::{self, CommitInfo};
use crate::state::AppState;
use crate::store::{self, DeckRow, ts};

const GAP: time::Duration = time::Duration::minutes(5);

#[derive(sqlx::FromRow, Clone)]
struct UpdateMeta {
    seq: i64,
    author: Uuid,
    origin: String,
    summary: Option<String>,
    created_at: OffsetDateTime,
}

struct Group {
    from: i64,
    to: i64,
    author: Uuid,
    started: OffsetDateTime,
    ended: OffsetDateTime,
    origins: BTreeSet<String>,
    explicit: Vec<String>,
}

fn standalone(origin: &str) -> bool {
    matches!(origin, "restore" | "undo" | "import" | "create")
}

fn group(updates: &[UpdateMeta], names: &HashMap<i64, (String, Uuid)>) -> Vec<Group> {
    let mut groups: Vec<Group> = Vec::new();
    for u in updates {
        let start_new = match groups.last() {
            None => true,
            Some(g) => {
                g.author != u.author
                    || u.created_at - g.ended > GAP
                    || names.contains_key(&g.to)
                    || standalone(&u.origin)
                    || g.origins.iter().any(|o| standalone(o))
            }
        };
        if start_new {
            groups.push(Group { from: u.seq, to: u.seq, author: u.author, started: u.created_at, ended: u.created_at, origins: BTreeSet::new(), explicit: vec![] });
        }
        let g = groups.last_mut().expect("just pushed");
        g.to = u.seq;
        g.ended = u.created_at;
        g.origins.insert(u.origin.clone());
        if (u.origin == "ops" || standalone(&u.origin))
            && let Some(s) = u.summary.as_ref().filter(|s| !s.trim().is_empty())
            && !g.explicit.contains(s)
        {
            g.explicit.push(s.clone());
        }
    }
    groups
}

/// JSON of the deck after each of `seqs` (0 = before anything), replaying the log once.
async fn jsons_at(st: &AppState, deck: &str, seqs: &BTreeSet<i64>) -> ApiResult<HashMap<i64, Value>> {
    let mut out = HashMap::new();
    let Some(&max) = seqs.iter().next_back() else { return Ok(out) };
    if seqs.contains(&0) {
        out.insert(0, json!({ "slides": [], "master": { "elements": [] } }));
    }
    let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as("select seq, data from deck_updates where deck = $1 and seq <= $2 order by seq")
        .bind(deck)
        .bind(max)
        .fetch_all(&st.pool)
        .await?;
    let doc = present_deck::new_doc();
    for (seq, data) in rows {
        if let Ok(u) = Update::decode_v1(&data) {
            let _ = doc.transact_mut().apply_update(u);
        }
        if seqs.contains(&seq) {
            out.insert(seq, present_deck::doc_to_json(&doc));
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct VersionsQuery {
    limit: Option<usize>,
}

pub async fn list(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, Q(q): Q<VersionsQuery>) -> ApiResult<Json<Value>> {
    access::deck_for(&st, &id, Some(caller.uuid), Need::Edit).await?;
    let updates: Vec<UpdateMeta> = sqlx::query_as("select seq, author, origin, summary, created_at from deck_updates where deck = $1 order by seq")
        .bind(&id)
        .fetch_all(&st.pool)
        .await?;
    let names: HashMap<i64, (String, Uuid)> = sqlx::query_as::<_, (i64, String, Uuid)>("select seq, name, named_by from version_names where deck = $1")
        .bind(&id)
        .fetch_all(&st.pool)
        .await?
        .into_iter()
        .map(|(s, n, b)| (s, (n, b)))
        .collect();
    let mut groups = group(&updates, &names);
    groups.reverse();
    groups.truncate(q.limit.unwrap_or(100).clamp(1, 1000));
    // Automatic summaries for groups without explicit ones (cached by range).
    let mut summaries: HashMap<(i64, i64), String> = HashMap::new();
    let mut need = BTreeSet::new();
    {
        let cache = st.summaries.lock().await;
        for g in &groups {
            if !g.explicit.is_empty() {
                continue;
            }
            match cache.get(&(id.clone(), g.from, g.to)) {
                Some(s) => {
                    summaries.insert((g.from, g.to), s.clone());
                }
                None => {
                    need.insert(g.from - 1);
                    need.insert(g.to);
                }
            }
        }
    }
    if !need.is_empty() {
        let jsons = jsons_at(&st, &id, &need).await?;
        let mut cache = st.summaries.lock().await;
        if cache.len() > 20_000 {
            cache.clear();
        }
        for g in &groups {
            if !g.explicit.is_empty() || summaries.contains_key(&(g.from, g.to)) {
                continue;
            }
            if let (Some(a), Some(b)) = (jsons.get(&(g.from - 1)), jsons.get(&g.to)) {
                let s = present_deck::summarize(&present_deck::diff(a, b));
                cache.insert((id.clone(), g.from, g.to), s.clone());
                summaries.insert((g.from, g.to), s);
            }
        }
    }
    let mut uuids: Vec<Uuid> = groups.iter().map(|g| g.author).collect();
    uuids.extend(names.values().map(|(_, b)| *b));
    let accts = accounts::accounts_json(&st, &uuids).await;
    let versions: Vec<Value> = groups
        .iter()
        .map(|g| {
            let author = accts.get(&g.author).cloned().unwrap_or(Value::Null);
            let who = author["id"].as_str().filter(|s| !s.is_empty()).unwrap_or("someone").to_string();
            let change = if g.explicit.is_empty() { summaries.get(&(g.from, g.to)).cloned().unwrap_or_default() } else { g.explicit.join("; ") };
            let name = names.get(&g.to);
            json!({
                "version": g.to,
                "from": g.from,
                "author": author,
                "startedAt": ts(g.started),
                "endedAt": ts(g.ended),
                "origins": g.origins,
                "change": change,
                "summary": format!("{who} {}", lowercase_first(&change)),
                "name": name.map(|n| n.0.clone()),
                "namedBy": name.and_then(|n| accts.get(&n.1).cloned()),
            })
        })
        .collect();
    let events = events_json(&st, &id, 200).await?;
    Ok(Json(json!({ "versions": versions, "events": events })))
}

fn lowercase_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) if c.clone().next().is_some_and(|n| n.is_lowercase()) => f.to_lowercase().chain(c).collect(),
        Some(f) => std::iter::once(f).chain(c).collect(),
        None => String::new(),
    }
}

async fn events_json(st: &AppState, deck: &str, limit: i64) -> ApiResult<Vec<Value>> {
    let rows: Vec<(i64, Option<Uuid>, String, Value, OffsetDateTime)> =
        sqlx::query_as("select id, actor, kind, data, created_at from events where deck = $1 order by created_at desc, id desc limit $2")
            .bind(deck)
            .bind(limit)
            .fetch_all(&st.pool)
            .await?;
    let uuids: Vec<Uuid> = rows.iter().filter_map(|r| r.1).collect();
    let accts = accounts::accounts_json(st, &uuids).await;
    Ok(rows
        .into_iter()
        .map(|(id, actor, kind, data, at)| {
            json!({ "id": id, "kind": kind, "actor": actor.and_then(|a| accts.get(&a).cloned()), "data": data, "createdAt": ts(at) })
        })
        .collect())
}

pub async fn events(State(st): State<AppState>, caller: Caller, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    access::deck_for(&st, &id, Some(caller.uuid), Need::View).await?;
    Ok(Json(json!({ "events": events_json(&st, &id, 500).await? })))
}

#[derive(Deserialize)]
pub struct NameBody {
    name: String,
}

pub async fn name(State(st): State<AppState>, caller: Caller, Path((id, version)): Path<(String, i64)>, JsonBody(body): JsonBody<NameBody>) -> ApiResult<Json<Value>> {
    let (deck, _) = access::deck_for(&st, &id, Some(caller.uuid), Need::Edit).await?;
    let (live, _) = rooms::current_json(&st, &id).await?;
    store::check_version(&DeckRow { seq: live, ..deck }, version)?;
    let name = body.name.trim();
    if name.chars().count() > 200 {
        return Err(ApiError::bad_request("name_too_long", "A version name can be at most 200 characters.", "Use a shorter name."));
    }
    if name.is_empty() {
        sqlx::query("delete from version_names where deck = $1 and seq = $2").bind(&id).bind(version).execute(&st.pool).await?;
    } else {
        sqlx::query(
            "insert into version_names (deck, seq, name, named_by) values ($1, $2, $3, $4)
             on conflict (deck, seq) do update set name = excluded.name, named_by = excluded.named_by, created_at = now()",
        )
        .bind(&id)
        .bind(version)
        .bind(name)
        .bind(caller.uuid)
        .execute(&st.pool)
        .await?;
    }
    store::event(&st, Some(&id), None, caller.uuid, "version.named", json!({ "version": version, "name": name })).await?;
    Ok(Json(json!({ "version": version, "name": if name.is_empty() { Value::Null } else { json!(name) } })))
}

#[derive(Deserialize)]
pub struct CompareQuery {
    from: i64,
    to: Option<i64>,
}

pub async fn compare(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, Q(q): Q<CompareQuery>) -> ApiResult<Json<Value>> {
    let (deck, _) = access::deck_for(&st, &id, Some(caller.uuid), Need::Edit).await?;
    let (live, _) = rooms::current_json(&st, &id).await?;
    let deck = DeckRow { seq: live, ..deck };
    let to = q.to.unwrap_or(live);
    let a = store::json_at(&st, &deck, q.from).await?;
    let b = store::json_at(&st, &deck, to).await?;
    let d = present_deck::diff(&a, &b);
    let (lo, hi) = (q.from.min(to), q.from.max(to));
    let rows: Vec<(Uuid, Vec<String>)> = sqlx::query_as("select author, touched from deck_updates where deck = $1 and seq > $2 and seq <= $3")
        .bind(&id)
        .bind(lo)
        .bind(hi)
        .fetch_all(&st.pool)
        .await?;
    let mut by_slide: HashMap<String, Vec<Uuid>> = HashMap::new();
    for (author, touched) in &rows {
        for s in touched {
            let v = by_slide.entry(s.clone()).or_default();
            if !v.contains(author) {
                v.push(*author);
            }
        }
    }
    let accts = accounts::accounts_json(&st, &rows.iter().map(|r| r.0).collect::<Vec<_>>()).await;
    let touched = d.touched();
    let authors: serde_json::Map<String, Value> = touched
        .iter()
        .map(|s| (s.clone(), Value::Array(by_slide.get(s).into_iter().flatten().filter_map(|u| accts.get(u).cloned()).collect())))
        .collect();
    Ok(Json(json!({ "from": q.from, "to": to, "summary": present_deck::summarize(&d), "diff": d, "authors": authors })))
}

#[derive(Deserialize)]
pub struct RestoreBody {
    version: i64,
    slide: Option<String>,
    element: Option<String>,
}

pub async fn restore(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, JsonBody(body): JsonBody<RestoreBody>) -> ApiResult<Json<Value>> {
    let (deck, _) = access::deck_for(&st, &id, Some(caller.uuid), Need::Edit).await?;
    let (live, live_json) = rooms::current_json(&st, &id).await?;
    let target = store::json_at(&st, &DeckRow { seq: live, ..deck }, body.version).await?;
    let number = |json: &Value, slide: &str| -> Option<usize> { json["slides"].as_array()?.iter().position(|s| s["id"] == slide).map(|i| i + 1) };
    let (scope, summary) = match (&body.slide, &body.element) {
        (None, None) => (present_deck::Scope::Deck, format!("restored version {}", body.version)),
        (Some(s), None) => (
            present_deck::Scope::Slide(s.clone()),
            format!("brought back slide {} from version {}", number(&target, s).or(number(&live_json, s)).map(|n| n.to_string()).unwrap_or_else(|| s.clone()), body.version),
        ),
        (Some(s), Some(e)) => (present_deck::Scope::Element { slide: s.clone(), element: e.clone() }, format!("brought back element {e} on slide {} from version {}", number(&target, s).map(|n| n.to_string()).unwrap_or_else(|| s.clone()), body.version)),
        (None, Some(_)) => {
            return Err(ApiError::bad_request("slide_required", "Restoring an element needs the slide it is on.", "Send { version, slide, element }."));
        }
    };
    let info = CommitInfo { author: caller.uuid, origin: "restore", summary: Some(summary.clone()), session: None };
    let (commit, ()) = rooms::commit_with(&st, &id, info, |doc| Ok((present_deck::reconcile_update(doc, &target, &scope)?, ()))).await?;
    store::event(&st, Some(&id), None, caller.uuid, "version.restored", json!({ "version": body.version, "slide": body.slide, "element": body.element, "as": commit.version })).await?;
    Ok(Json(json!({ "version": commit.version, "changed": commit.changed, "summary": summary, "touched": commit.touched })))
}

#[derive(Deserialize)]
pub struct UndoBody {
    account: String,
    since: i64,
}

pub async fn undo_account(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, JsonBody(body): JsonBody<UndoBody>) -> ApiResult<Json<Value>> {
    let (deck, _) = access::deck_for(&st, &id, Some(caller.uuid), Need::Edit).await?;
    let (live, _) = rooms::current_json(&st, &id).await?;
    store::check_version(&DeckRow { seq: live, ..deck }, body.since)?;
    let (who, who_json) = accounts::resolve(&st, &body.account).await?.ok_or_else(|| {
        ApiError::not_found("account_not_found", format!("There is no Carbon or Silicon `{}`.", body.account), "Name them by c:id, si:id or uuid.")
    })?;
    // Replay from `since` with their transactions tagged and undo exactly those (see present_deck::undo_author):
    // a plain replay without their updates would still carry their deletions inside everyone else's updates.
    let base: Vec<(Vec<u8>,)> = sqlx::query_as("select data from deck_updates where deck = $1 and seq <= $2 order by seq")
        .bind(&id)
        .bind(body.since)
        .fetch_all(&st.pool)
        .await?;
    let rows: Vec<(Uuid, Vec<u8>)> = sqlx::query_as("select author, data from deck_updates where deck = $1 and seq > $2 order by seq")
        .bind(&id)
        .bind(body.since)
        .fetch_all(&st.pool)
        .await?;
    let skipped = rows.iter().filter(|r| r.0 == who).count();
    let base_refs: Vec<&[u8]> = base.iter().map(|b| b.0.as_slice()).collect();
    let later: Vec<(bool, &[u8])> = rows.iter().map(|(a, d)| (*a == who, d.as_slice())).collect();
    let target = present_deck::undo_author(&base_refs, &later)?;
    let handle = who_json["id"].as_str().unwrap_or("someone").to_string();
    let summary = format!("undid {handle}'s changes since version {}", body.since);
    let info = CommitInfo { author: caller.uuid, origin: "undo", summary: Some(summary.clone()), session: None };
    let (commit, ()) = rooms::commit_with(&st, &id, info, |live| Ok((present_deck::reconcile_update(live, &target, &present_deck::Scope::Deck)?, ()))).await?;
    store::event(&st, Some(&id), None, caller.uuid, "account.undone", json!({ "account": who, "since": body.since, "updates": skipped, "as": commit.version })).await?;
    Ok(Json(json!({ "version": commit.version, "changed": commit.changed, "summary": summary, "updatesUndone": skipped, "touched": commit.touched })))
}
