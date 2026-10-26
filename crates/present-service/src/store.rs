//! Decks, folders and the content log in Postgres.

use serde_json::Value;
use sqlx::FromRow;
use time::OffsetDateTime;
use uuid::Uuid;
use yrs::Doc;

use crate::error::{ApiError, ApiResult};
use crate::ids::{looks_like_id, new_id};
use crate::state::AppState;

#[derive(Debug, Clone, FromRow)]
pub struct DeckRow {
    pub id: String,
    pub owner: Uuid,
    pub creator: Uuid,
    pub title: String,
    pub folder: Option<String>,
    pub public_mode: String,
    pub public_require_email: bool,
    pub trashed_at: Option<OffsetDateTime>,
    pub seq: i64,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

pub const DECK_COLUMNS: &str = "id, owner, creator, title, folder, public_mode, public_require_email, trashed_at, seq, created_at, updated_at";

#[derive(Debug, Clone, FromRow)]
pub struct FolderRow {
    pub id: String,
    pub owner: Uuid,
    pub creator: Uuid,
    pub name: String,
    pub parent: Option<String>,
    pub public_mode: String,
    pub trashed_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

pub const FOLDER_COLUMNS: &str = "id, owner, creator, name, parent, public_mode, trashed_at, created_at, updated_at";

pub fn deck_not_found(id: &str) -> ApiError {
    ApiError::not_found(
        "deck_not_found",
        format!("There is no deck `{id}`; it may have been permanently deleted."),
        "Check the id; `present ls` lists your decks and the ones shared with you.",
    )
}

pub fn folder_not_found(id: &str) -> ApiError {
    ApiError::not_found(
        "folder_not_found",
        format!("There is no folder `{id}`; it may have been permanently deleted."),
        "Check the id; `present ls` lists your folders and the ones shared with you.",
    )
}

pub async fn get_deck(st: &AppState, id: &str) -> ApiResult<DeckRow> {
    if !looks_like_id(id) {
        return Err(deck_not_found(id));
    }
    sqlx::query_as::<_, DeckRow>(sql!("select {DECK_COLUMNS} from decks where id = $1"))
        .bind(id)
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(|| deck_not_found(id))
}

pub async fn get_folder(st: &AppState, id: &str) -> ApiResult<FolderRow> {
    if !looks_like_id(id) {
        return Err(folder_not_found(id));
    }
    sqlx::query_as::<_, FolderRow>(sql!("select {FOLDER_COLUMNS} from folders where id = $1"))
        .bind(id)
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(|| folder_not_found(id))
}

/// The folder and every folder above it, nearest first.
pub async fn folder_chain(st: &AppState, folder: Option<&str>) -> ApiResult<Vec<FolderRow>> {
    let Some(folder) = folder else { return Ok(Vec::new()) };
    Ok(sqlx::query_as::<_, FolderRow>(sql!(
        "with recursive chain as (
           select {FOLDER_COLUMNS}, 0 as depth from folders where id = $1
           union all
           select f.id, f.owner, f.creator, f.name, f.parent, f.public_mode, f.trashed_at, f.created_at, f.updated_at, c.depth + 1
           from folders f join chain c on f.id = c.parent where c.depth < 64)
         select {FOLDER_COLUMNS} from chain order by depth"
    ))
    .bind(folder)
    .fetch_all(&st.pool)
    .await?)
}

/// The document as it was at version `seq`: the nearest snapshot plus the updates after it.
pub async fn doc_at(st: &AppState, deck: &str, seq: i64) -> ApiResult<Doc> {
    let snapshot: Option<(i64, Vec<u8>)> =
        sqlx::query_as("select seq, data from deck_snapshots where deck = $1 and seq <= $2 order by seq desc limit 1")
            .bind(deck)
            .bind(seq)
            .fetch_optional(&st.pool)
            .await?;
    let from = snapshot.as_ref().map(|s| s.0).unwrap_or(0);
    let updates: Vec<(Vec<u8>,)> = sqlx::query_as("select data from deck_updates where deck = $1 and seq > $2 and seq <= $3 order by seq")
        .bind(deck)
        .bind(from)
        .bind(seq)
        .fetch_all(&st.pool)
        .await?;
    let mut all: Vec<&[u8]> = Vec::with_capacity(updates.len() + 1);
    if let Some((_, data)) = &snapshot {
        all.push(data);
    }
    for (u,) in &updates {
        all.push(u);
    }
    present_deck::doc_from_updates(all).map_err(|e| ApiError::internal(format!("deck {deck} could not be rebuilt at version {seq}: {e}")))
}

pub fn check_version(deck: &DeckRow, version: i64) -> ApiResult<()> {
    if version < 1 || version > deck.seq {
        return Err(ApiError::bad_request(
            "version_not_found",
            format!("Deck `{}` has versions 1 to {}, so there is no version {version}.", deck.id, deck.seq),
            "List the versions with GET /v1/decks/{id}/versions (`present versions`).",
        ));
    }
    Ok(())
}

/// The deck JSON at a version, with id, title and version.
pub async fn json_at(st: &AppState, deck: &DeckRow, seq: i64) -> ApiResult<Value> {
    check_version(deck, seq)?;
    let json = if seq == deck.seq {
        crate::rooms::current_json(st, &deck.id).await?.1
    } else {
        present_deck::doc_to_json(&doc_at(st, &deck.id, seq).await?)
    };
    Ok(present_deck::DeckMeta { id: deck.id.clone(), title: deck.title.clone(), version: seq }.attach(json))
}

/// Everything searchable in a deck's content: slide text, notes and table text, one line per piece.
pub fn search_text(json: &Value) -> String {
    let mut out = Vec::new();
    let mut element = |e: &Value| match e["kind"].as_str() {
        Some("text") | Some("shape") => out.push(present_deck::plain_text(&e["text"])),
        Some("table") => {
            for row in e["cells"].as_array().into_iter().flatten() {
                for c in row.as_array().into_iter().flatten() {
                    out.push(present_deck::plain_text(&c["text"]));
                }
            }
        }
        Some("chart") => {
            if let Some(t) = e["chart"]["title"].as_str() {
                out.push(t.to_string());
            }
        }
        _ => {}
    };
    for s in json["slides"].as_array().into_iter().flatten() {
        for e in s["elements"].as_array().into_iter().flatten() {
            element(e);
        }
    }
    let mut out2 = out;
    for s in json["slides"].as_array().into_iter().flatten() {
        if let Some(n) = s["notes"].as_str() {
            out2.push(n.to_string());
        }
    }
    out2.join("\n")
}

/// Creates a deck from deck JSON as version 1.
#[allow(clippy::too_many_arguments)]
pub async fn create_deck(
    st: &AppState,
    owner: Uuid,
    creator: Uuid,
    title: &str,
    folder: Option<&str>,
    json: &Value,
    origin: &str,
    summary: &str,
) -> ApiResult<DeckRow> {
    let doc = present_deck::json_to_doc(json)?;
    let update = present_deck::encode_doc(&doc);
    let content = present_deck::doc_to_json(&doc);
    let touched: Vec<String> = content["slides"].as_array().into_iter().flatten().filter_map(|s| s["id"].as_str().map(String::from)).collect();
    let id = new_id();
    let mut tx = st.pool.begin().await?;
    let row = sqlx::query_as::<_, DeckRow>(sql!(
        "insert into decks (id, owner, creator, title, folder, seq, search_text) values ($1, $2, $3, $4, $5, 1, $6) returning {DECK_COLUMNS}"
    ))
    .bind(&id)
    .bind(owner)
    .bind(creator)
    .bind(title)
    .bind(folder)
    .bind(search_text(&content))
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("insert into deck_updates (deck, seq, data, author, origin, summary, touched) values ($1, 1, $2, $3, $4, $5, $6)")
        .bind(&id)
        .bind(&update)
        .bind(creator)
        .bind(origin)
        .bind(summary)
        .bind(&touched)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(row)
}

/// Records an event for the history (renames, moves, sharing, trash, comment deletes, …).
pub async fn event(st: &AppState, deck: Option<&str>, folder: Option<&str>, actor: Uuid, kind: &str, data: Value) -> ApiResult<()> {
    sqlx::query("insert into events (deck, folder, actor, kind, data) values ($1, $2, $3, $4, $5)")
        .bind(deck)
        .bind(folder)
        .bind(actor)
        .bind(kind)
        .bind(data)
        .execute(&st.pool)
        .await?;
    Ok(())
}

pub fn ts(t: OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339).unwrap_or_default()
}

pub fn ts_opt(t: Option<OffsetDateTime>) -> Value {
    t.map(|t| Value::String(ts(t))).unwrap_or(Value::Null)
}
