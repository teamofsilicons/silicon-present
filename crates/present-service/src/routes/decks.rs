//! Decks: list, create (blank, inside a folder, or from any version of another deck), read, rename, move, trash,
//! restore, permanently delete, read content at any version, and edit through ops.

use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::access::{self, Need, Role};
use crate::auth::{Caller, MaybeCaller};
use crate::error::{ApiError, ApiResult};
use crate::extract::{JsonBody, Q};
use crate::rooms::{self, CommitInfo};
use crate::state::AppState;
use crate::store::{self, DECK_COLUMNS, DeckRow};
use crate::views;

#[derive(Deserialize)]
pub struct ListQuery {
    scope: Option<String>,
    folder: Option<String>,
}

pub async fn list(State(st): State<AppState>, caller: Caller, Q(q): Q<ListQuery>) -> ApiResult<Json<Value>> {
    let me = caller.uuid;
    let rows: Vec<DeckRow> = if let Some(folder) = q.folder.as_deref().filter(|f| *f != "root") {
        access::folder_for(&st, folder, Some(me), Need::View).await?;
        sqlx::query_as(sql!("select {DECK_COLUMNS} from decks where folder = $1 and trashed_at is null order by updated_at desc"))
            .bind(folder)
            .fetch_all(&st.pool)
            .await?
    } else {
        match q.scope.as_deref().unwrap_or("mine") {
            "mine" => {
                let root_only = q.folder.as_deref() == Some("root");
                sqlx::query_as(sql!(
                    "select {DECK_COLUMNS} from decks where owner = $1 and trashed_at is null and ($2 = false or folder is null)
                     order by updated_at desc"
                ))
                .bind(me)
                .bind(root_only)
                .fetch_all(&st.pool)
                .await?
            }
            "shared" => sqlx::query_as(sql!(
                "with recursive shared_folders as (
                   select resource_id as id from access where account = $1 and resource_kind = 'folder'
                   union
                   select f.id from folders f join shared_folders s on f.parent = s.id)
                 select {DECK_COLUMNS} from decks
                 where owner <> $1 and trashed_at is null and (
                   id in (select resource_id from access where account = $1 and resource_kind = 'deck')
                   or folder in (select id from shared_folders))
                 order by updated_at desc"
            ))
            .bind(me)
            .fetch_all(&st.pool)
            .await?,
            "trash" => sqlx::query_as(sql!("select {DECK_COLUMNS} from decks where owner = $1 and trashed_at is not null order by trashed_at desc"))
                .bind(me)
                .fetch_all(&st.pool)
                .await?,
            other => {
                return Err(ApiError::bad_request(
                    "invalid_scope",
                    format!("`{other}` isn't a scope."),
                    "Use scope=mine, scope=shared or scope=trash (and folder=<id> or folder=root).",
                ));
            }
        }
    };
    let mut visible = Vec::new();
    for d in rows {
        let a = access::deck_access(&st, &d, Some(me)).await?;
        if a.role > Role::None {
            visible.push((d, a.role));
        }
    }
    let uuids: Vec<Uuid> = visible.iter().flat_map(|(d, _)| [d.owner, d.creator]).collect();
    let accounts = crate::accounts::accounts_json(&st, &uuids).await;
    let decks: Vec<Value> = visible.iter().map(|(d, r)| views::deck_json(&st, d, *r, &accounts)).collect();
    Ok(Json(json!({ "decks": decks })))
}

#[derive(Deserialize)]
pub struct FromVersion {
    deck: String,
    version: Option<i64>,
}

#[derive(Deserialize)]
pub struct CreateBody {
    title: Option<String>,
    folder: Option<String>,
    from: Option<FromVersion>,
    /// Decision: a deck can also start from deck JSON (what `present push` of a new folder sends).
    deck: Option<Value>,
}

/// Where a new deck goes: (owner, folder). Inside someone else's folder it belongs to that folder's owner.
pub async fn placement(st: &AppState, me: Uuid, folder: Option<&str>) -> ApiResult<(Uuid, Option<String>)> {
    match folder.filter(|f| !f.is_empty() && *f != "root") {
        None => Ok((me, None)),
        Some(f) => {
            let (folder, _) = access::folder_for(st, f, Some(me), Need::Edit).await?;
            Ok((folder.owner, Some(folder.id)))
        }
    }
}

pub fn clean_title(t: Option<&str>, default: &str) -> ApiResult<String> {
    let t = t.map(str::trim).filter(|t| !t.is_empty()).unwrap_or(default);
    if t.chars().count() > 300 {
        return Err(ApiError::bad_request("title_too_long", "A title can be at most 300 characters.", "Use a shorter title."));
    }
    Ok(t.to_string())
}

pub async fn create(State(st): State<AppState>, caller: Caller, JsonBody(body): JsonBody<CreateBody>) -> ApiResult<Response> {
    let me = caller.uuid;
    let (owner, folder) = placement(&st, me, body.folder.as_deref()).await?;
    let deck = if let Some(from) = &body.from {
        let (src, _) = access::deck_for(&st, &from.deck, Some(me), Need::Edit).await?;
        let version = from.version.unwrap_or(src.seq);
        let (live, _) = rooms::current_json(&st, &src.id).await?;
        let json = store::json_at(&st, &DeckRow { seq: live, ..src.clone() }, version).await?;
        let title = clean_title(body.title.as_deref(), &format!("Copy of {}", src.title))?;
        // The copy gets its own copies of the assets, so it never depends on the original.
        let map = crate::routes::files::plan_asset_copy(&st, &src.id).await?;
        let json = crate::routes::files::rewrite_asset_refs(&json, &map);
        let new = store::create_deck(&st, owner, me, &title, folder.as_deref(), &json, "create", &format!("made from version {version} of “{}”", src.title)).await?;
        crate::routes::files::finish_asset_copy(&st, &map, &new, me).await?;
        store::event(&st, Some(&new.id), None, me, "deck.created_from", json!({ "deck": src.id, "version": version })).await?;
        store::get_deck(&st, &new.id).await?
    } else {
        let json = match &body.deck {
            Some(v) => present_deck::normalize_deck(v)?,
            None => present_deck::default_deck(),
        };
        let title = clean_title(body.title.as_deref().or(body.deck.as_ref().and_then(|d| d["title"].as_str())), "Untitled deck")?;
        store::create_deck(&st, owner, me, &title, folder.as_deref(), &json, "create", "created the deck").await?
    };
    store::event(&st, Some(&deck.id), None, me, "deck.created", json!({ "title": deck.title, "folder": deck.folder })).await?;
    let role = access::deck_access(&st, &deck, Some(me)).await?.role;
    Ok((StatusCode::CREATED, Json(views::deck_one(&st, &deck, role).await)).into_response())
}

pub async fn get(State(st): State<AppState>, caller: MaybeCaller, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (deck, a) = access::deck_for(&st, &id, caller.uuid(), Need::View).await?;
    Ok(Json(views::deck_one(&st, &deck, a.role).await))
}

#[derive(Deserialize)]
pub struct PatchBody {
    title: Option<String>,
    /// A folder id, or null / "root" to move the deck out of any folder.
    #[serde(default, with = "double_option")]
    folder: Option<Option<String>>,
}

pub mod double_option {
    use serde::{Deserialize, Deserializer};
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
        Ok(Some(Option::<String>::deserialize(d)?))
    }
}

pub async fn patch(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, JsonBody(body): JsonBody<PatchBody>) -> ApiResult<Json<Value>> {
    let me = caller.uuid;
    let (deck, a) = access::deck_for(&st, &id, Some(me), Need::Edit).await?;
    if let Some(title) = &body.title {
        let title = clean_title(Some(title), "")?;
        if title.is_empty() {
            return Err(ApiError::bad_request("title_empty", "A deck's title can't be empty.", "Send a title with at least one character."));
        }
        if title != deck.title {
            sqlx::query("update decks set title = $2, updated_at = now() where id = $1").bind(&id).bind(&title).execute(&st.pool).await?;
            store::event(&st, Some(&id), None, me, "deck.renamed", json!({ "from": deck.title, "to": title })).await?;
        }
    }
    if let Some(folder) = &body.folder {
        let target = folder.as_deref().filter(|f| !f.is_empty() && *f != "root");
        access::check("deck", &id, a, Some(me), Need::Own)?;
        if let Some(f) = target {
            let (folder, _) = access::folder_for(&st, f, Some(me), Need::Edit).await?;
            if folder.owner != deck.owner {
                return Err(ApiError::forbidden(
                    "folder_owned_by_someone_else",
                    format!("Folder `{f}` belongs to someone else, and a deck inside a folder always belongs to the folder's owner."),
                    "Transfer the deck to the folder's owner first (POST /v1/decks/{id}/transfer), or pick one of your own folders.",
                ));
            }
        }
        if target.map(String::from) != deck.folder {
            sqlx::query("update decks set folder = $2, updated_at = now() where id = $1").bind(&id).bind(target).execute(&st.pool).await?;
            store::event(&st, Some(&id), None, me, "deck.moved", json!({ "from": deck.folder, "to": target })).await?;
        }
    }
    let deck = store::get_deck(&st, &id).await?;
    if let Some(room) = st.rooms.loaded(&id).await {
        room.send("deck", json!({ "title": deck.title, "folder": deck.folder, "publicMode": deck.public_mode }));
    }
    Ok(Json(views::deck_one(&st, &deck, a.role).await))
}

#[derive(Deserialize)]
pub struct DeleteQuery {
    permanent: Option<bool>,
    confirm: Option<String>,
}

pub async fn delete(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, Q(q): Q<DeleteQuery>) -> ApiResult<Response> {
    let me = caller.uuid;
    let deck = store::get_deck(&st, &id).await?;
    let a = access::deck_access(&st, &deck, Some(me)).await?;
    if a.role < Role::Owner {
        access::check("deck", &id, access::Access { role: a.role, trashed: false }, Some(me), Need::Own)?;
    }
    if q.permanent.unwrap_or(false) {
        if deck.trashed_at.is_none() {
            return Err(ApiError::conflict(
                "not_in_trash",
                format!("Deck `{id}` isn't in the trash, and only decks in the trash can be permanently deleted."),
                "Move it to the trash first (DELETE /v1/decks/{id}), then delete it permanently.",
            ));
        }
        if q.confirm.as_deref() != Some(deck.title.as_str()) {
            return Err(ApiError::bad_request(
                "confirmation_required",
                format!("Permanently deleting “{}” can't be undone, so it needs the deck's exact title as confirmation.", deck.title),
                format!("Send ?permanent=true&confirm={} (URL-encoded) to delete it for good.", deck.title),
            ));
        }
        permanently_delete_deck(&st, &id).await?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    if deck.trashed_at.is_none() {
        sqlx::query("update decks set trashed_at = now(), trashed_by = $2 where id = $1").bind(&id).bind(me).execute(&st.pool).await?;
        store::event(&st, Some(&id), None, me, "deck.trashed", json!({})).await?;
    }
    let deck = store::get_deck(&st, &id).await?;
    Ok(Json(views::deck_one(&st, &deck, Role::Owner).await).into_response())
}

pub async fn permanently_delete_deck(st: &AppState, id: &str) -> ApiResult<()> {
    let assets: Vec<String> = sqlx::query_scalar("select id from assets where deck = $1").bind(id).fetch_all(&st.pool).await?;
    sqlx::query("delete from access where resource_kind = 'deck' and resource_id = $1").bind(id).execute(&st.pool).await?;
    sqlx::query("delete from transfers where resource_kind = 'deck' and resource_id = $1").bind(id).execute(&st.pool).await?;
    sqlx::query("delete from decks where id = $1").bind(id).execute(&st.pool).await?;
    for a in assets {
        let _ = tokio::fs::remove_file(crate::routes::files::asset_path(st, &a)).await;
    }
    st.rooms.evict(id).await;
    Ok(())
}

pub async fn untrash(State(st): State<AppState>, caller: Caller, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let me = caller.uuid;
    let deck = store::get_deck(&st, &id).await?;
    if deck.owner != me {
        return Err(ApiError::forbidden("owner_only", format!("Only the owner of deck `{id}` can restore it from the trash."), "Ask its owner to restore it."));
    }
    // A deck whose folder is still in the trash comes back to the top level, so it can be seen again.
    let chain = store::folder_chain(&st, deck.folder.as_deref()).await?;
    let folder_trashed = chain.iter().any(|f| f.trashed_at.is_some());
    sqlx::query("update decks set trashed_at = null, trashed_by = null, folder = case when $2 then null else folder end where id = $1")
        .bind(&id)
        .bind(folder_trashed)
        .execute(&st.pool)
        .await?;
    store::event(&st, Some(&id), None, me, "deck.restored", json!({})).await?;
    let deck = store::get_deck(&st, &id).await?;
    Ok(Json(views::deck_one(&st, &deck, Role::Owner).await))
}

#[derive(Deserialize)]
pub struct ContentQuery {
    version: Option<i64>,
    format: Option<String>,
    comments: Option<bool>,
}

pub async fn content(State(st): State<AppState>, caller: MaybeCaller, Path(id): Path<String>, Q(q): Q<ContentQuery>) -> ApiResult<Response> {
    let (deck, _) = access::deck_for(&st, &id, caller.uuid(), Need::View).await?;
    let (live_seq, live_json) = rooms::current_json(&st, &id).await?;
    let version = q.version.unwrap_or(live_seq);
    if version != live_seq {
        // Opening an older version is for those who can edit (UNDERSTANDING: Versions).
        let a = access::deck_access(&st, &deck, caller.uuid()).await?;
        access::check("deck", &id, a, caller.uuid(), Need::Edit)?;
    }
    let json = if version == live_seq {
        present_deck::DeckMeta { id: deck.id.clone(), title: deck.title.clone(), version }.attach(live_json)
    } else {
        store::json_at(&st, &DeckRow { seq: live_seq, ..deck.clone() }, version).await?
    };
    match q.format.as_deref().unwrap_or("json") {
        "json" => Ok(Json(json).into_response()),
        "text" => {
            let threads = if q.comments.unwrap_or(true) { crate::routes::comments::threads_json(&st, &id, "open").await? } else { vec![] };
            let text = present_deck::to_text(&json, Some(&threads));
            Ok(([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response())
        }
        other => Err(ApiError::bad_request("invalid_format", format!("`{other}` isn't a content format."), "Use format=json or format=text.")),
    }
}

#[derive(Deserialize)]
pub struct EditsBody {
    base: Option<i64>,
    summary: Option<String>,
    ops: Value,
}

pub async fn edits(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, JsonBody(body): JsonBody<EditsBody>) -> ApiResult<Json<Value>> {
    let me = caller.uuid;
    let (deck, _) = access::deck_for(&st, &id, Some(me), Need::Edit).await?;
    let ops = present_deck::parse_ops(&body.ops)?;
    if ops.is_empty() {
        return Err(ApiError::bad_request("no_ops", "The request has no ops, so there is nothing to change.", "Send \"ops\": [ … ] with at least one op."));
    }
    let (live_seq, _) = rooms::current_json(&st, &id).await?;
    let base_doc = match body.base {
        Some(b) if b != live_seq => {
            store::check_version(&DeckRow { seq: live_seq, ..deck.clone() }, b)?;
            Some(store::doc_at(&st, &id, b).await?)
        }
        _ => None,
    };
    let info = CommitInfo { author: me, origin: "ops", summary: body.summary.clone(), session: None };
    let (commit, outcome) = rooms::commit_with(&st, &id, info, move |live| {
        let doc = base_doc.as_ref().unwrap_or(live);
        let (update, outcome) = present_deck::apply_ops_update(doc, &ops)?;
        Ok((update, outcome))
    })
    .await?;
    let elements: Vec<Value> = outcome.elements_added.iter().map(|(s, e)| json!({ "slide": s, "element": e })).collect();
    Ok(Json(json!({
        "version": commit.version,
        "changed": commit.changed,
        "summary": commit.summary,
        "touched": commit.touched,
        "slidesAdded": outcome.slides_added,
        "elementsAdded": elements,
        "replacements": outcome.replacements,
    })))
}
