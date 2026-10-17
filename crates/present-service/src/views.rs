//! How resources are shown in API answers (camelCase JSON).

use std::collections::HashMap;

use serde_json::{Value, json};
use uuid::Uuid;

use crate::access::Role;
use crate::state::AppState;
use crate::store::{DeckRow, FolderRow, ts, ts_opt};

pub fn deck_json(st: &AppState, d: &DeckRow, role: Role, accounts: &HashMap<Uuid, Value>) -> Value {
    json!({
        "id": d.id,
        "title": d.title,
        "owner": accounts.get(&d.owner).cloned().unwrap_or(Value::Null),
        "creator": accounts.get(&d.creator).cloned().unwrap_or(Value::Null),
        "folder": d.folder,
        "publicMode": d.public_mode,
        "role": role.as_str(),
        "version": d.seq,
        "trashedAt": ts_opt(d.trashed_at),
        "createdAt": ts(d.created_at),
        "updatedAt": ts(d.updated_at),
        "link": st.deck_link(&d.id),
    })
}

pub fn folder_json(st: &AppState, f: &FolderRow, role: Role, accounts: &HashMap<Uuid, Value>) -> Value {
    json!({
        "id": f.id,
        "name": f.name,
        "owner": accounts.get(&f.owner).cloned().unwrap_or(Value::Null),
        "creator": accounts.get(&f.creator).cloned().unwrap_or(Value::Null),
        "parent": f.parent,
        "publicMode": f.public_mode,
        "role": role.as_str(),
        "trashedAt": ts_opt(f.trashed_at),
        "createdAt": ts(f.created_at),
        "updatedAt": ts(f.updated_at),
        "link": st.folder_link(&f.id),
    })
}

pub async fn deck_one(st: &AppState, d: &DeckRow, role: Role) -> Value {
    let accounts = crate::accounts::accounts_json(st, &[d.owner, d.creator]).await;
    deck_json(st, d, role, &accounts)
}

pub async fn folder_one(st: &AppState, f: &FolderRow, role: Role) -> Value {
    let accounts = crate::accounts::accounts_json(st, &[f.owner, f.creator]).await;
    folder_json(st, f, role, &accounts)
}
