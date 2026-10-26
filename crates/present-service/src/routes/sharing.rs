//! Sharing (roles, folder inheritance, public links, email invites) and transfers. Decks and folders are shared
//! the same way.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::access::{self, Access, Need, Role};
use crate::accounts::{self, is_email, is_handle};
use crate::auth::Caller;
use crate::error::{ApiError, ApiResult};
use crate::extract::{JsonBody, Q};
use crate::state::AppState;
use crate::store::{self, FolderRow, ts, ts_opt};

/// A deck or a folder, as sharing sees it.
pub struct Resource {
    pub kind: &'static str,
    pub id: String,
    pub name: String,
    pub owner: Uuid,
    /// The folder it sits in (a deck's folder, a folder's parent).
    pub parent: Option<String>,
    pub public_mode: String,
    pub require_email: bool,
    pub access: Access,
}

impl Resource {
    pub fn link(&self, st: &AppState) -> String {
        if self.kind == "deck" { st.deck_link(&self.id) } else { st.folder_link(&self.id) }
    }
}

pub async fn load(st: &AppState, kind: &str, id: &str, caller: Uuid, need: Need) -> ApiResult<Resource> {
    if kind == "deck" {
        let (d, a) = access::deck_for(st, id, Some(caller), need).await?;
        Ok(Resource { kind: "deck", id: d.id, name: d.title, owner: d.owner, parent: d.folder, public_mode: d.public_mode, require_email: d.public_require_email, access: a })
    } else {
        let (f, a) = access::folder_for(st, id, Some(caller), need).await?;
        Ok(Resource { kind: "folder", id: f.id, name: f.name, owner: f.owner, parent: f.parent, public_mode: f.public_mode, require_email: false, access: a })
    }
}

fn kind_of(plural: &str) -> ApiResult<&'static str> {
    match plural {
        "decks" => Ok("deck"),
        "folders" => Ok("folder"),
        _ => Err(ApiError::not_found("not_found", "There is no such endpoint.", "Use /v1/decks/{id}/… or /v1/folders/{id}/….")),
    }
}

#[derive(sqlx::FromRow)]
struct AccessRow {
    resource_kind: String,
    resource_id: String,
    account: Option<Uuid>,
    email: Option<String>,
    role: String,
    invited_by: Uuid,
    created_at: OffsetDateTime,
}

async fn member_json(st: &AppState, r: &AccessRow, via: Option<&FolderRow>) -> Value {
    let mut uuids = vec![r.invited_by];
    if let Some(a) = r.account {
        uuids.push(a);
    }
    let accounts = accounts::accounts_json(st, &uuids).await;
    json!({
        "member": r.account.map(|a| a.to_string()).unwrap_or_else(|| format!("email:{}", r.email.clone().unwrap_or_default())),
        "account": r.account.and_then(|a| accounts.get(&a).cloned()),
        "email": r.email,
        "pending": r.account.is_none(),
        "role": r.role,
        "invitedBy": accounts.get(&r.invited_by).cloned(),
        "createdAt": ts(r.created_at),
        "via": via.map(|f| json!({ "kind": "folder", "id": f.id, "name": f.name })),
        "resource": { "kind": r.resource_kind, "id": r.resource_id },
    })
}

pub async fn list(State(st): State<AppState>, caller: Caller, Path((plural, id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let kind = kind_of(&plural)?;
    let res = load(&st, kind, &id, caller.uuid, Need::View).await?;
    let rows: Vec<AccessRow> = sqlx::query_as(
        "select resource_kind, resource_id, account, email, role, invited_by, created_at from access
         where resource_kind = $1 and resource_id = $2 order by created_at",
    )
    .bind(kind)
    .bind(&id)
    .fetch_all(&st.pool)
    .await?;
    let mut members = Vec::new();
    for r in &rows {
        members.push(member_json(&st, r, None).await);
    }
    let chain = store::folder_chain(&st, res.parent.as_deref()).await?;
    for f in &chain {
        let rows: Vec<AccessRow> = sqlx::query_as(
            "select resource_kind, resource_id, account, email, role, invited_by, created_at from access
             where resource_kind = 'folder' and resource_id = $1 order by created_at",
        )
        .bind(&f.id)
        .fetch_all(&st.pool)
        .await?;
        for r in &rows {
            members.push(member_json(&st, r, Some(f)).await);
        }
    }
    Ok(Json(json!({
        "owner": accounts::account_json(&st, res.owner).await,
        "publicMode": res.public_mode,
        "requireEmail": res.require_email,
        "role": res.access.role.as_str(),
        "members": members,
    })))
}

#[derive(Deserialize)]
pub struct InviteBody {
    to: String,
    role: String,
}

fn parse_role(role: &str) -> ApiResult<Role> {
    Role::parse(role).ok_or_else(|| {
        ApiError::bad_request(
            "invalid_role",
            format!("`{role}` isn't a role you can give."),
            "Use editor, commenter or viewer; ownership moves only by transfer (POST …/transfer).",
        )
    })
}

pub async fn invite(State(st): State<AppState>, caller: Caller, Path((plural, id)): Path<(String, String)>, JsonBody(body): JsonBody<InviteBody>) -> ApiResult<Response> {
    let kind = kind_of(&plural)?;
    let me = caller.uuid;
    let res = load(&st, kind, &id, me, Need::Edit).await?;
    let role = parse_role(&body.role)?;
    let to = body.to.trim();
    let (account, email): (Option<Uuid>, Option<String>) = if is_handle(to) || Uuid::parse_str(to).is_ok() {
        match accounts::resolve(&st, to).await? {
            Some((uuid, _)) => (Some(uuid), None),
            None => {
                return Err(ApiError::not_found(
                    "account_not_found",
                    format!("There is no Carbon or Silicon `{to}` on Silicon Accounts."),
                    "Check the c:id or si:id (GET /v1/accounts/resolve?q=…), or invite them by email.",
                ));
            }
        }
    } else if is_email(to) {
        let email = to.to_lowercase();
        match accounts::find_by_email(&st, &email).await? {
            Some(uuid) => (Some(uuid), None),
            None => (None, Some(email)),
        }
    } else {
        return Err(ApiError::bad_request("invalid_invitee", format!("`{to}` isn't a c:id, si:id or email address."), "Invite someone as c:name, si:name or name@example.com."));
    };
    if account == Some(res.owner) {
        return Err(ApiError::conflict("already_owner", format!("`{to}` owns this {kind}, so it already has every right."), "Invite someone else."));
    }
    let row: (i64, bool) = if let Some(a) = account {
        sqlx::query_as(
            "insert into access (resource_kind, resource_id, account, role, invited_by) values ($1, $2, $3, $4, $5)
             on conflict (resource_kind, resource_id, account) where account is not null do update set role = excluded.role
             returning id, (xmax = 0)",
        )
        .bind(kind)
        .bind(&id)
        .bind(a)
        .bind(role.as_str())
        .bind(me)
        .fetch_one(&st.pool)
        .await?
    } else {
        sqlx::query_as(
            "insert into access (resource_kind, resource_id, email, role, invited_by) values ($1, $2, $3, $4, $5)
             on conflict (resource_kind, resource_id, email) where email is not null do update set role = excluded.role
             returning id, (xmax = 0)",
        )
        .bind(kind)
        .bind(&id)
        .bind(&email)
        .bind(role.as_str())
        .bind(me)
        .fetch_one(&st.pool)
        .await?
    };
    let (row_id, inserted) = row;
    let (deck_ev, folder_ev) = if kind == "deck" { (Some(id.as_str()), None) } else { (None, Some(id.as_str())) };
    store::event(&st, deck_ev, folder_ev, me, if inserted { "shared" } else { "role_changed" }, json!({ "to": account.map(|a| a.to_string()).or(email.clone()), "role": role.as_str() })).await?;
    let by = accounts::account_json(&st, me).await;
    if inserted {
        if let Some(a) = account {
            crate::tings::enqueue(
                &st,
                "present.deck.shared",
                a,
                Some(me),
                &format!("present.deck.shared:{kind}:{id}:{row_id}"),
                json!({
                    "resource": { "kind": kind, "id": id, "name": res.name, "link": res.link(&st) },
                    "deck": if kind == "deck" { json!({ "id": id, "title": res.name, "link": res.link(&st) }) } else { Value::Null },
                    "role": role.as_str(),
                    "by": by,
                }),
            )
            .await?;
        } else if let Some(e) = &email {
            let who = by["id"].as_str().unwrap_or("Someone").to_string();
            crate::mail::queue_email(
                &st,
                &format!("invite:{kind}:{id}:{row_id}"),
                e,
                &format!("{who} shared “{}” with you on Silicon Present", res.name),
                &format!(
                    "{who} invited you to {} the {kind} “{}” on Silicon Present.\n\nOpen it here: {}\n\nSign in with Silicon Accounts using this email address ({e}) and it will be waiting for you.\n",
                    match role { Role::Editor => "edit", Role::Commenter => "comment on", _ => "view" },
                    res.name,
                    res.link(&st)
                ),
            )
            .await?;
        }
    }
    let r: AccessRow = sqlx::query_as("select resource_kind, resource_id, account, email, role, invited_by, created_at from access where id = $1")
        .bind(row_id)
        .fetch_one(&st.pool)
        .await?;
    Ok((if inserted { StatusCode::CREATED } else { StatusCode::OK }, Json(member_json(&st, &r, None).await)).into_response())
}

fn member_filter(member: &str) -> ApiResult<(Option<Uuid>, Option<String>)> {
    if let Some(e) = member.strip_prefix("email:") {
        return Ok((None, Some(e.trim().to_lowercase())));
    }
    Uuid::parse_str(member).map(|u| (Some(u), None)).map_err(|_| {
        ApiError::bad_request("invalid_member", format!("`{member}` isn't a member."), "Name a member by account uuid or as email:<address> (as GET …/access lists them).")
    })
}

#[derive(Deserialize)]
pub struct RoleBody {
    role: String,
}

pub async fn change(State(st): State<AppState>, caller: Caller, Path((plural, id, member)): Path<(String, String, String)>, JsonBody(body): JsonBody<RoleBody>) -> ApiResult<Json<Value>> {
    let kind = kind_of(&plural)?;
    load(&st, kind, &id, caller.uuid, Need::Edit).await?;
    let role = parse_role(&body.role)?;
    let (account, email) = member_filter(&member)?;
    let row: Option<AccessRow> = sqlx::query_as(
        "update access set role = $5 where resource_kind = $1 and resource_id = $2 and (account = $3 or email = $4)
         returning resource_kind, resource_id, account, email, role, invited_by, created_at",
    )
    .bind(kind)
    .bind(&id)
    .bind(account)
    .bind(&email)
    .bind(role.as_str())
    .fetch_optional(&st.pool)
    .await?;
    let row = row.ok_or_else(|| not_a_member(&member, kind, &id))?;
    let (d, f) = if kind == "deck" { (Some(id.as_str()), None) } else { (None, Some(id.as_str())) };
    store::event(&st, d, f, caller.uuid, "role_changed", json!({ "member": member, "role": role.as_str() })).await?;
    Ok(Json(member_json(&st, &row, None).await))
}

fn not_a_member(member: &str, kind: &str, id: &str) -> ApiError {
    ApiError::not_found(
        "member_not_found",
        format!("`{member}` has no direct access to {kind} `{id}`."),
        "List the members with GET …/access; access through a folder is changed on that folder.",
    )
}

pub async fn remove(State(st): State<AppState>, caller: Caller, Path((plural, id, member)): Path<(String, String, String)>) -> ApiResult<Response> {
    let kind = kind_of(&plural)?;
    let (account, email) = member_filter(&member)?;
    // Anyone may leave; removing someone else needs edit rights.
    let need = if account == Some(caller.uuid) { Need::View } else { Need::Edit };
    load(&st, kind, &id, caller.uuid, need).await?;
    let n = sqlx::query("delete from access where resource_kind = $1 and resource_id = $2 and (account = $3 or email = $4)")
        .bind(kind)
        .bind(&id)
        .bind(account)
        .bind(&email)
        .execute(&st.pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(not_a_member(&member, kind, &id));
    }
    let (d, f) = if kind == "deck" { (Some(id.as_str()), None) } else { (None, Some(id.as_str())) };
    store::event(&st, d, f, caller.uuid, "unshared", json!({ "member": member })).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicBody {
    mode: String,
    require_email: Option<bool>,
}

pub async fn set_public(State(st): State<AppState>, caller: Caller, Path((plural, id)): Path<(String, String)>, JsonBody(body): JsonBody<PublicBody>) -> ApiResult<Json<Value>> {
    let kind = kind_of(&plural)?;
    let res = load(&st, kind, &id, caller.uuid, Need::Own).await?;
    if !["off", "view", "comment", "edit"].contains(&body.mode.as_str()) {
        return Err(ApiError::bad_request("invalid_mode", format!("`{}` isn't a public mode.", body.mode), "Use off, view, comment or edit."));
    }
    if kind != "deck" && body.require_email.is_some() {
        return Err(ApiError::bad_request("unsupported_option", "Email collection is available on decks, not folders.", "Set requireEmail on the deck's public settings."));
    }
    let require_email = body.require_email.unwrap_or(res.require_email);
    if kind == "deck" {
        sqlx::query("update decks set public_mode = $2, public_require_email = $3, updated_at = now() where id = $1")
            .bind(&id).bind(&body.mode).bind(require_email).execute(&st.pool).await?;
    } else {
        sqlx::query("update folders set public_mode = $2, updated_at = now() where id = $1")
            .bind(&id).bind(&body.mode).execute(&st.pool).await?;
    }
    let (d, f) = if kind == "deck" { (Some(id.as_str()), None) } else { (None, Some(id.as_str())) };
    store::event(&st, d, f, caller.uuid, "public_changed", json!({ "from": res.public_mode, "to": body.mode,
        "requireEmailFrom": res.require_email, "requireEmail": require_email })).await?;
    if kind == "deck"
        && let Some(room) = st.rooms.loaded(&id).await
    {
        room.send("deck", json!({ "publicMode": body.mode, "requireEmail": require_email }));
    }
    Ok(Json(json!({ "publicMode": body.mode, "requireEmail": require_email, "link": res.link(&st) })))
}

// ---------------------------------------------------------------- transfers

#[derive(sqlx::FromRow)]
struct TransferRow {
    id: String,
    resource_kind: String,
    resource_id: String,
    from_account: Uuid,
    to_account: Uuid,
    state: String,
    created_at: OffsetDateTime,
    decided_at: Option<OffsetDateTime>,
}

const TRANSFER_COLUMNS: &str = "id, resource_kind, resource_id, from_account, to_account, state, created_at, decided_at";

async fn transfer_json(st: &AppState, t: &TransferRow) -> Value {
    let accounts = accounts::accounts_json(st, &[t.from_account, t.to_account]).await;
    let name: Option<String> = if t.resource_kind == "deck" {
        sqlx::query_scalar("select title from decks where id = $1").bind(&t.resource_id).fetch_optional(&st.pool).await.ok().flatten()
    } else {
        sqlx::query_scalar("select name from folders where id = $1").bind(&t.resource_id).fetch_optional(&st.pool).await.ok().flatten()
    };
    json!({
        "id": t.id,
        "resource": { "kind": t.resource_kind, "id": t.resource_id, "name": name },
        "from": accounts.get(&t.from_account),
        "to": accounts.get(&t.to_account),
        "state": t.state,
        "createdAt": ts(t.created_at),
        "decidedAt": ts_opt(t.decided_at),
    })
}

#[derive(Deserialize)]
pub struct TransferBody {
    to: String,
}

pub async fn start_transfer(State(st): State<AppState>, caller: Caller, Path((plural, id)): Path<(String, String)>, JsonBody(body): JsonBody<TransferBody>) -> ApiResult<Response> {
    let kind = kind_of(&plural)?;
    let me = caller.uuid;
    load(&st, kind, &id, me, Need::Own).await?;
    let to = body.to.trim();
    let (to_uuid, _) = accounts::resolve(&st, to).await?.ok_or_else(|| {
        ApiError::not_found("account_not_found", format!("There is no Carbon or Silicon `{to}` on Silicon Accounts."), "Transfer to a c:id or si:id that exists.")
    })?;
    if to_uuid == me {
        return Err(ApiError::bad_request("transfer_to_self", format!("You already own this {kind}."), "Transfer it to someone else."));
    }
    let tid = crate::ids::new_id();
    let row: Option<TransferRow> = sqlx::query_as(sql!(
        "insert into transfers (id, resource_kind, resource_id, from_account, to_account) values ($1, $2, $3, $4, $5)
         on conflict (resource_kind, resource_id) where state = 'pending' do nothing returning {TRANSFER_COLUMNS}"
    ))
    .bind(&tid)
    .bind(kind)
    .bind(&id)
    .bind(me)
    .bind(to_uuid)
    .fetch_optional(&st.pool)
    .await?;
    let Some(row) = row else {
        return Err(ApiError::conflict(
            "transfer_pending",
            format!("This {kind} already has a transfer waiting to be accepted."),
            "Cancel it first (POST /v1/transfers/{id}/cancel), then start a new one.",
        ));
    };
    let (d, f) = if kind == "deck" { (Some(id.as_str()), None) } else { (None, Some(id.as_str())) };
    store::event(&st, d, f, me, "transfer.started", json!({ "transfer": tid, "to": to_uuid })).await?;
    Ok((StatusCode::CREATED, Json(transfer_json(&st, &row).await)).into_response())
}

#[derive(Deserialize)]
pub struct TransfersQuery {
    state: Option<String>,
}

pub async fn list_transfers(State(st): State<AppState>, caller: Caller, Q(q): Q<TransfersQuery>) -> ApiResult<Json<Value>> {
    let all = q.state.as_deref() == Some("all");
    let rows: Vec<TransferRow> = sqlx::query_as(sql!(
        "select {TRANSFER_COLUMNS} from transfers where (from_account = $1 or to_account = $1) and ($2 or state = 'pending') order by created_at desc"
    ))
    .bind(caller.uuid)
    .bind(all)
    .fetch_all(&st.pool)
    .await?;
    let (mut incoming, mut outgoing) = (Vec::new(), Vec::new());
    for r in &rows {
        let j = transfer_json(&st, r).await;
        if r.to_account == caller.uuid { incoming.push(j) } else { outgoing.push(j) }
    }
    Ok(Json(json!({ "incoming": incoming, "outgoing": outgoing })))
}

pub async fn decide_transfer(State(st): State<AppState>, caller: Caller, Path((tid, action)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let me = caller.uuid;
    let t: TransferRow = sqlx::query_as::<_, TransferRow>(sql!("select {TRANSFER_COLUMNS} from transfers where id = $1"))
        .bind(&tid)
        .fetch_optional(&st.pool)
        .await?
        .filter(|t| t.from_account == me || t.to_account == me)
        .ok_or_else(|| ApiError::not_found("transfer_not_found", format!("There is no transfer `{tid}` to or from you."), "List yours with GET /v1/transfers."))?;
    if t.state != "pending" {
        return Err(ApiError::conflict("transfer_decided", format!("Transfer `{tid}` was already {}.", t.state), "Start a new transfer if one is still needed."));
    }
    let new_state = match action.as_str() {
        "accept" | "decline" if t.to_account != me => {
            return Err(ApiError::forbidden("not_the_recipient", "Only the Carbon or Silicon a transfer is to can accept or decline it.", "Cancel it instead if you started it."));
        }
        "cancel" if t.from_account != me => {
            return Err(ApiError::forbidden("not_the_sender", "Only whoever started a transfer can cancel it.", "Decline it instead if it is to you."));
        }
        "accept" => "accepted",
        "decline" => "declined",
        "cancel" => "cancelled",
        _ => return Err(ApiError::not_found("not_found", format!("`{action}` isn't something you can do with a transfer."), "Use accept, decline or cancel.")),
    };
    let mut tx = st.pool.begin().await?;
    if new_state == "accepted" {
        // Decision: the previous owner keeps editor access, so handing a deck over never locks its maker out.
        if t.resource_kind == "deck" {
            let owner: Option<Uuid> = sqlx::query_scalar("select owner from decks where id = $1").bind(&t.resource_id).fetch_optional(&mut *tx).await?;
            if owner != Some(t.from_account) {
                return Err(ApiError::conflict("transfer_stale", "The deck changed owner since this transfer started.", "Ask its current owner to transfer it again."));
            }
            sqlx::query("update decks set owner = $2, folder = null, updated_at = now() where id = $1").bind(&t.resource_id).bind(me).execute(&mut *tx).await?;
        } else {
            let owner: Option<Uuid> = sqlx::query_scalar("select owner from folders where id = $1").bind(&t.resource_id).fetch_optional(&mut *tx).await?;
            if owner != Some(t.from_account) {
                return Err(ApiError::conflict("transfer_stale", "The folder changed owner since this transfer started.", "Ask its current owner to transfer it again."));
            }
            let below = "with recursive below as (select id from folders where id = $1 union all select f.id from folders f join below b on f.parent = b.id)";
            sqlx::query(sql!("{below} update folders set owner = $2, updated_at = now() where id in (select id from below)")).bind(&t.resource_id).bind(me).execute(&mut *tx).await?;
            sqlx::query(sql!("{below} update decks set owner = $2, updated_at = now() where folder in (select id from below)")).bind(&t.resource_id).bind(me).execute(&mut *tx).await?;
            sqlx::query("update folders set parent = null where id = $1").bind(&t.resource_id).execute(&mut *tx).await?;
        }
        sqlx::query("delete from access where resource_kind = $1 and resource_id = $2 and account = $3").bind(&t.resource_kind).bind(&t.resource_id).bind(me).execute(&mut *tx).await?;
        sqlx::query(
            "insert into access (resource_kind, resource_id, account, role, invited_by) values ($1, $2, $3, 'editor', $4)
             on conflict (resource_kind, resource_id, account) where account is not null do update set role = 'editor'",
        )
        .bind(&t.resource_kind)
        .bind(&t.resource_id)
        .bind(t.from_account)
        .bind(me)
        .execute(&mut *tx)
        .await?;
    }
    let row: TransferRow = sqlx::query_as(sql!("update transfers set state = $2, decided_at = now() where id = $1 returning {TRANSFER_COLUMNS}"))
        .bind(&tid)
        .bind(new_state)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    let (d, f) = if t.resource_kind == "deck" { (Some(t.resource_id.as_str()), None) } else { (None, Some(t.resource_id.as_str())) };
    store::event(&st, d, f, me, &format!("transfer.{new_state}"), json!({ "transfer": tid, "from": t.from_account, "to": t.to_account })).await?;
    Ok(Json(transfer_json(&st, &row).await))
}

