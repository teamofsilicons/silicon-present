//! Folders: the same shape as decks. Everything inside a folder belongs to the folder's owner.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::access::{self, Need, Role};
use crate::auth::{Caller, MaybeCaller};
use crate::error::{ApiError, ApiResult};
use crate::extract::{JsonBody, Q};
use crate::routes::decks::{clean_title, double_option, placement};
use crate::state::AppState;
use crate::store::{self, FOLDER_COLUMNS, FolderRow};
use crate::views;

#[derive(Deserialize)]
pub struct ListQuery {
    scope: Option<String>,
    parent: Option<String>,
}

pub async fn list(State(st): State<AppState>, caller: Caller, Q(q): Q<ListQuery>) -> ApiResult<Json<Value>> {
    let me = caller.uuid;
    let rows: Vec<FolderRow> = if let Some(parent) = q.parent.as_deref().filter(|p| *p != "root") {
        access::folder_for(&st, parent, Some(me), Need::View).await?;
        sqlx::query_as(sql!("select {FOLDER_COLUMNS} from folders where parent = $1 and trashed_at is null order by name"))
            .bind(parent)
            .fetch_all(&st.pool)
            .await?
    } else {
        match q.scope.as_deref().unwrap_or("mine") {
            "mine" => sqlx::query_as(sql!(
                "select {FOLDER_COLUMNS} from folders where owner = $1 and trashed_at is null and ($2 = false or parent is null) order by name"
            ))
            .bind(me)
            .bind(q.parent.as_deref() == Some("root"))
            .fetch_all(&st.pool)
            .await?,
            // Folders shared directly (what's inside them is reached by opening them).
            "shared" => sqlx::query_as(sql!(
                "select {FOLDER_COLUMNS} from folders where owner <> $1 and trashed_at is null and
                   id in (select resource_id from access where account = $1 and resource_kind = 'folder') order by name"
            ))
            .bind(me)
            .fetch_all(&st.pool)
            .await?,
            "trash" => sqlx::query_as(sql!("select {FOLDER_COLUMNS} from folders where owner = $1 and trashed_at is not null order by trashed_at desc"))
                .bind(me)
                .fetch_all(&st.pool)
                .await?,
            other => {
                return Err(ApiError::bad_request("invalid_scope", format!("`{other}` isn't a scope."), "Use scope=mine, scope=shared or scope=trash (and parent=<id> or parent=root)."));
            }
        }
    };
    let mut visible = Vec::new();
    for f in rows {
        let a = access::folder_access(&st, &f, Some(me)).await?;
        if a.role > Role::None {
            visible.push((f, a.role));
        }
    }
    let uuids: Vec<Uuid> = visible.iter().flat_map(|(f, _)| [f.owner, f.creator]).collect();
    let accounts = crate::accounts::accounts_json(&st, &uuids).await;
    let folders: Vec<Value> = visible.iter().map(|(f, r)| views::folder_json(&st, f, *r, &accounts)).collect();
    Ok(Json(json!({ "folders": folders })))
}

#[derive(Deserialize)]
pub struct CreateBody {
    name: Option<String>,
    parent: Option<String>,
}

pub async fn create(State(st): State<AppState>, caller: Caller, JsonBody(body): JsonBody<CreateBody>) -> ApiResult<Response> {
    let me = caller.uuid;
    let (owner, parent) = placement(&st, me, body.parent.as_deref()).await?;
    let name = clean_title(body.name.as_deref(), "Untitled folder")?;
    let id = crate::ids::new_id();
    let folder: FolderRow = sqlx::query_as(sql!("insert into folders (id, owner, creator, name, parent) values ($1, $2, $3, $4, $5) returning {FOLDER_COLUMNS}"))
        .bind(&id)
        .bind(owner)
        .bind(me)
        .bind(&name)
        .bind(&parent)
        .fetch_one(&st.pool)
        .await?;
    store::event(&st, None, Some(&id), me, "folder.created", json!({ "name": name, "parent": parent })).await?;
    let role = access::folder_access(&st, &folder, Some(me)).await?.role;
    Ok((StatusCode::CREATED, Json(views::folder_one(&st, &folder, role).await)).into_response())
}

pub async fn get(State(st): State<AppState>, caller: MaybeCaller, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (folder, a) = access::folder_for(&st, &id, caller.uuid(), Need::View).await?;
    Ok(Json(views::folder_one(&st, &folder, a.role).await))
}

#[derive(Deserialize)]
pub struct PatchBody {
    name: Option<String>,
    #[serde(default, with = "double_option")]
    parent: Option<Option<String>>,
}

pub async fn patch(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, JsonBody(body): JsonBody<PatchBody>) -> ApiResult<Json<Value>> {
    let me = caller.uuid;
    let (folder, a) = access::folder_for(&st, &id, Some(me), Need::Edit).await?;
    if let Some(name) = &body.name {
        let name = clean_title(Some(name), "")?;
        if name.is_empty() {
            return Err(ApiError::bad_request("name_empty", "A folder's name can't be empty.", "Send a name with at least one character."));
        }
        sqlx::query("update folders set name = $2, updated_at = now() where id = $1").bind(&id).bind(&name).execute(&st.pool).await?;
        store::event(&st, None, Some(&id), me, "folder.renamed", json!({ "from": folder.name, "to": name })).await?;
    }
    if let Some(parent) = &body.parent {
        access::check("folder", &id, a, Some(me), Need::Own)?;
        let target = parent.as_deref().filter(|p| !p.is_empty() && *p != "root");
        if let Some(p) = target {
            let (pf, _) = access::folder_for(&st, p, Some(me), Need::Edit).await?;
            if pf.owner != folder.owner {
                return Err(ApiError::forbidden(
                    "folder_owned_by_someone_else",
                    format!("Folder `{p}` belongs to someone else, and a folder inside a folder always belongs to its owner."),
                    "Transfer this folder to that owner first, or pick one of your own folders.",
                ));
            }
            let chain = store::folder_chain(&st, Some(p)).await?;
            if chain.iter().any(|f| f.id == id) {
                return Err(ApiError::bad_request("folder_cycle", "A folder can't be moved into itself or into a folder inside it.", "Pick a folder outside this one."));
            }
        }
        sqlx::query("update folders set parent = $2, updated_at = now() where id = $1").bind(&id).bind(target).execute(&st.pool).await?;
        store::event(&st, None, Some(&id), me, "folder.moved", json!({ "from": folder.parent, "to": target })).await?;
    }
    let folder = store::get_folder(&st, &id).await?;
    Ok(Json(views::folder_one(&st, &folder, a.role).await))
}

#[derive(Deserialize)]
pub struct DeleteQuery {
    permanent: Option<bool>,
    confirm: Option<String>,
}

pub async fn delete(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, Q(q): Q<DeleteQuery>) -> ApiResult<Response> {
    let me = caller.uuid;
    let folder = store::get_folder(&st, &id).await?;
    if folder.owner != me {
        let a = access::folder_access(&st, &folder, Some(me)).await?;
        access::check("folder", &id, access::Access { role: a.role, trashed: false }, Some(me), Need::Own)?;
    }
    if q.permanent.unwrap_or(false) {
        if folder.trashed_at.is_none() {
            return Err(ApiError::conflict(
                "not_in_trash",
                format!("Folder `{id}` isn't in the trash, and only folders in the trash can be permanently deleted."),
                "Move it to the trash first (DELETE /v1/folders/{id}), then delete it permanently.",
            ));
        }
        if q.confirm.as_deref() != Some(folder.name.as_str()) {
            return Err(ApiError::bad_request(
                "confirmation_required",
                format!("Permanently deleting folder “{}” and everything in it can't be undone, so it needs the folder's exact name as confirmation.", folder.name),
                format!("Send ?permanent=true&confirm={} (URL-encoded) to delete it for good.", folder.name),
            ));
        }
        // Every deck below goes too (with its assets on disk); folders cascade in the database.
        let decks: Vec<String> = sqlx::query_scalar(
            "with recursive below as (select id from folders where id = $1 union all select f.id from folders f join below b on f.parent = b.id)
             select d.id from decks d where d.folder in (select id from below)",
        )
        .bind(&id)
        .fetch_all(&st.pool)
        .await?;
        for d in decks {
            crate::routes::decks::permanently_delete_deck(&st, &d).await?;
        }
        sqlx::query("delete from access where resource_kind = 'folder' and resource_id = $1").bind(&id).execute(&st.pool).await?;
        sqlx::query("delete from folders where id = $1").bind(&id).execute(&st.pool).await?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    if folder.trashed_at.is_none() {
        sqlx::query("update folders set trashed_at = now(), trashed_by = $2 where id = $1").bind(&id).bind(me).execute(&st.pool).await?;
        store::event(&st, None, Some(&id), me, "folder.trashed", json!({})).await?;
    }
    let folder = store::get_folder(&st, &id).await?;
    Ok(Json(views::folder_one(&st, &folder, Role::Owner).await).into_response())
}

pub async fn untrash(State(st): State<AppState>, caller: Caller, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let me = caller.uuid;
    let folder = store::get_folder(&st, &id).await?;
    if folder.owner != me {
        return Err(ApiError::forbidden("owner_only", format!("Only the owner of folder `{id}` can restore it from the trash."), "Ask its owner to restore it."));
    }
    let chain = store::folder_chain(&st, folder.parent.as_deref()).await?;
    let parent_trashed = chain.iter().any(|f| f.trashed_at.is_some());
    sqlx::query("update folders set trashed_at = null, trashed_by = null, parent = case when $2 then null else parent end where id = $1")
        .bind(&id)
        .bind(parent_trashed)
        .execute(&st.pool)
        .await?;
    store::event(&st, None, Some(&id), me, "folder.restored", json!({})).await?;
    let folder = store::get_folder(&st, &id).await?;
    Ok(Json(views::folder_one(&st, &folder, Role::Owner).await))
}
