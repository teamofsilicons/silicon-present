//! Roles. Effective role = max(owner, direct access, access through every folder above, the public mode for
//! signed-in callers). Signed-out callers can only view, and only public decks. Anything in the trash (or inside a
//! trashed folder) is visible to its owner alone, and nobody can change it until it is restored.

use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::store::{self, DeckRow, FolderRow};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    None,
    Viewer,
    Commenter,
    Editor,
    Owner,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::None => "none",
            Role::Viewer => "viewer",
            Role::Commenter => "commenter",
            Role::Editor => "editor",
            Role::Owner => "owner",
        }
    }

    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "viewer" => Some(Role::Viewer),
            "commenter" => Some(Role::Commenter),
            "editor" => Some(Role::Editor),
            _ => None,
        }
    }

    pub fn from_public_mode(mode: &str) -> Role {
        match mode {
            "view" => Role::Viewer,
            "comment" => Role::Commenter,
            "edit" => Role::Editor,
            _ => Role::None,
        }
    }
}

/// A resource's effective role for a caller, and whether it is in the trash.
#[derive(Debug, Clone, Copy)]
pub struct Access {
    pub role: Role,
    pub trashed: bool,
}

#[allow(clippy::too_many_arguments)]
async fn compute(
    st: &AppState,
    kind: &str,
    id: &str,
    owner: Uuid,
    own_public: &str,
    own_trashed: bool,
    chain: &[FolderRow],
    caller: Option<Uuid>,
) -> ApiResult<Access> {
    let trashed = own_trashed || chain.iter().any(|f| f.trashed_at.is_some());
    if caller == Some(owner) {
        return Ok(Access { role: Role::Owner, trashed });
    }
    if trashed {
        return Ok(Access { role: Role::None, trashed });
    }
    let public = std::iter::once(own_public).chain(chain.iter().map(|f| f.public_mode.as_str())).map(Role::from_public_mode).max().unwrap_or(Role::None);
    let Some(uuid) = caller else {
        return Ok(Access { role: if public > Role::None { Role::Viewer } else { Role::None }, trashed });
    };
    let folder_ids: Vec<String> = chain.iter().map(|f| f.id.clone()).collect();
    let roles: Vec<String> = sqlx::query_scalar(
        "select role from access where account = $1 and
           ((resource_kind = $2 and resource_id = $3) or (resource_kind = 'folder' and resource_id = any($4)))",
    )
    .bind(uuid)
    .bind(kind)
    .bind(id)
    .bind(&folder_ids)
    .fetch_all(&st.pool)
    .await?;
    let shared = roles.iter().filter_map(|r| Role::parse(r)).max().unwrap_or(Role::None);
    // Being the owner of a folder above means you own what's inside (it was created there for you).
    let folder_owner = chain.iter().any(|f| f.owner == uuid);
    let role = shared.max(public).max(if folder_owner { Role::Editor } else { Role::None });
    Ok(Access { role, trashed })
}

pub async fn deck_access(st: &AppState, deck: &DeckRow, caller: Option<Uuid>) -> ApiResult<Access> {
    let chain = store::folder_chain(st, deck.folder.as_deref()).await?;
    compute(st, "deck", &deck.id, deck.owner, &deck.public_mode, deck.trashed_at.is_some(), &chain, caller).await
}

pub async fn folder_access(st: &AppState, folder: &FolderRow, caller: Option<Uuid>) -> ApiResult<Access> {
    let chain = store::folder_chain(st, folder.parent.as_deref()).await?;
    compute(st, "folder", &folder.id, folder.owner, &folder.public_mode, folder.trashed_at.is_some(), &chain, caller).await
}

/// What a caller wants to do, for the error when they can't.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Need {
    View,
    Comment,
    Edit,
    Own,
}

fn need_role(need: Need) -> Role {
    match need {
        Need::View => Role::Viewer,
        Need::Comment => Role::Commenter,
        Need::Edit => Role::Editor,
        Need::Own => Role::Owner,
    }
}

/// Checks a caller's access to a resource (`what` = "deck" or "folder", for messages).
pub fn check(what: &str, id: &str, access: Access, caller: Option<Uuid>, need: Need) -> ApiResult<()> {
    if access.role == Role::None {
        if access.trashed {
            return Err(ApiError::not_found(
                &format!("{what}_in_trash"),
                format!("The {what} `{id}` is in its owner's trash."),
                "Only its owner can see it there; ask them to restore it.",
            ));
        }
        return Err(match caller {
            None => ApiError::unauthorized(
                "sign_in_required",
                format!("The {what} `{id}` is private, and this request isn't signed in."),
                "Sign in (`present login`, or send `Authorization: Bearer <token>`); if it was shared with you, you'll have access then.",
            ),
            Some(_) => ApiError::forbidden(
                "no_access",
                format!("The {what} `{id}` hasn't been shared with you."),
                format!("Ask its owner or an editor to share the {what} with your c:id or si:id."),
            ),
        });
    }
    if access.trashed && need != Need::View {
        return Err(ApiError::conflict(
            &format!("{what}_in_trash"),
            format!("The {what} `{id}` is in the trash, so it can't be changed."),
            format!("Restore it first (POST /v1/{what}s/{id}/untrash, or `present untrash {id}`)."),
        ));
    }
    if access.role >= need_role(need) {
        return Ok(());
    }
    let have = access.role.as_str();
    Err(match need {
        Need::View => unreachable!("every role above none can view"),
        Need::Comment => ApiError::forbidden(
            "comment_not_allowed",
            format!("You are a {have} on {what} `{id}`, and viewers can't comment."),
            "Ask the owner or an editor to make you a commenter or editor.",
        ),
        Need::Edit => ApiError::forbidden(
            "edit_not_allowed",
            format!("You are a {have} on {what} `{id}`, and only editors can change it."),
            "Comment instead, or ask the owner or an editor to make you an editor.",
        ),
        Need::Own => ApiError::forbidden(
            "owner_only",
            format!("Only the owner of {what} `{id}` can do this, and you are a {have}."),
            "Ask its owner to do it.",
        ),
    })
}

/// Loads a deck and checks the caller may do `need` with it.
pub async fn deck_for(st: &AppState, id: &str, caller: Option<Uuid>, need: Need) -> ApiResult<(DeckRow, Access)> {
    let deck = store::get_deck(st, id).await?;
    let access = deck_access(st, &deck, caller).await?;
    check("deck", id, access, caller, need)?;
    Ok((deck, access))
}

pub async fn folder_for(st: &AppState, id: &str, caller: Option<Uuid>, need: Need) -> ApiResult<(FolderRow, Access)> {
    let folder = store::get_folder(st, id).await?;
    let access = folder_access(st, &folder, caller).await?;
    check("folder", id, access, caller, need)?;
    Ok((folder, access))
}
