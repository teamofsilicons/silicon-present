//! Custom themes: an account's own themes, usable in any deck it can edit (`present theme`, the editor's Theme
//! panel). Saving from a deck (or adding a shared deck's theme, which needs editor access) snapshots the deck's
//! fonts and colours and copies its uploaded fonts, so a theme never depends on the deck it came from. Using a theme
//! copies those fonts into the target deck and hands back the deck-ready theme; the client applies it like any other
//! theme change, so it stays undoable.

use std::path::PathBuf;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::access::{self, Need};
use crate::auth::Caller;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::rooms;
use crate::state::AppState;
use crate::store;

/// The built-in themes' names (packages/deck THEMES); a custom theme can't take one.
const BUILT_IN: [&str; 7] = ["Paper", "Ivory", "Ink", "Slate", "Forest", "Coral", "Mono"];
/// How many themes one account can keep.
const MAX_THEMES: i64 = 200;

fn font_path(st: &AppState, id: &str) -> PathBuf {
    st.cfg.data_dir.join("theme-fonts").join(id)
}

fn not_found(id: &str) -> ApiError {
    ApiError::not_found("theme_not_found", format!("You have no theme `{id}`."), "List your themes with GET /v1/themes (`present theme --list`).")
}

#[derive(sqlx::FromRow)]
struct ThemeRow {
    id: String,
    name: String,
    theme: Value,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
}

fn theme_json(r: &ThemeRow) -> Value {
    json!({
        "id": r.id,
        "name": r.name,
        "fonts": r.theme["fonts"],
        "colors": r.theme["colors"],
        "customFonts": r.theme["customFonts"],
        "createdAt": store::ts(r.created_at),
        "updatedAt": store::ts(r.updated_at),
    })
}

async fn own_theme(st: &AppState, caller: &Caller, id: &str) -> ApiResult<ThemeRow> {
    sqlx::query_as("select id, name, theme, created_at, updated_at from themes where id = $1 and owner = $2")
        .bind(id)
        .bind(caller.uuid)
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(|| not_found(id))
}

fn clean_name(raw: &str) -> ApiResult<String> {
    let name = raw.trim().to_string();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::bad_request("invalid_theme_name", "A theme name must be 1 to 80 characters.", "Send a short name, e.g. { \"name\": \"Brand\" }."));
    }
    if BUILT_IN.iter().any(|b| b.eq_ignore_ascii_case(&name)) {
        return Err(ApiError::bad_request(
            "theme_name_builtin",
            format!("`{name}` is a built-in theme's name."),
            "Give your theme a name of its own, e.g. \"Brand\" or \"Ivory (team)\".",
        ));
    }
    Ok(name)
}

fn name_taken(name: &str) -> ApiError {
    ApiError::conflict("theme_name_taken", format!("You already have a theme called `{name}`."), "Pick another name, or rename or delete the existing theme first.")
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.code().as_deref() == Some("23505"))
}

/// A theme's shape, with `name` set, normalized the way a deck stores it.
fn checked_theme(mut theme: Value, name: &str) -> ApiResult<Value> {
    if let Some(m) = theme.as_object_mut() {
        m.insert("name".into(), json!(name));
    }
    present_deck::validate_theme(&theme)?;
    Ok(present_deck::normalize_theme(&theme))
}

fn custom_fonts(theme: &Value) -> Vec<(String, String)> {
    theme["customFonts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| Some((f.get("family")?.as_str()?.to_string(), f.get("src")?.as_str()?.to_string())))
        .collect()
}

async fn write_file(path: &std::path::Path, bytes: &[u8]) -> ApiResult<()> {
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| ApiError::internal(format!("creating the theme font directory: {e}")))?;
    }
    tokio::fs::write(path, bytes).await.map_err(|e| ApiError::internal(format!("writing a theme font: {e}")))
}

// ---------------------------------------------------------------- list, get

pub async fn list(State(st): State<AppState>, caller: Caller) -> ApiResult<Json<Value>> {
    let rows: Vec<ThemeRow> = sqlx::query_as("select id, name, theme, created_at, updated_at from themes where owner = $1 order by lower(name)")
        .bind(caller.uuid)
        .fetch_all(&st.pool)
        .await?;
    Ok(Json(json!({ "themes": rows.iter().map(theme_json).collect::<Vec<_>>() })))
}

pub async fn get(State(st): State<AppState>, caller: Caller, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(theme_json(&own_theme(&st, &caller, &id).await?)))
}

// ---------------------------------------------------------------- create

#[derive(Deserialize)]
pub struct CreateBody {
    name: Option<String>,
    /// Save this deck's current theme (needs editor access to the deck).
    deck: Option<String>,
    /// Or a theme given as JSON: name, fonts, colors, customFonts (https URLs only).
    theme: Option<Value>,
}

pub async fn create(State(st): State<AppState>, caller: Caller, JsonBody(body): JsonBody<CreateBody>) -> ApiResult<Response> {
    let (base, deck) = match (body.deck, body.theme) {
        (Some(d), None) => {
            let (deck, _) = access::deck_for(&st, &d, Some(caller.uuid), Need::Edit).await?;
            let (_, content) = rooms::current_json(&st, &deck.id).await?;
            (content["theme"].clone(), Some(deck))
        }
        (None, Some(t)) => {
            if !t.is_object() {
                return Err(ApiError::bad_request("invalid_theme", "`theme` must be a JSON object.", "Send { \"theme\": { \"fonts\": {…}, \"colors\": {…} } }."));
            }
            (t, None)
        }
        _ => {
            return Err(ApiError::bad_request(
                "theme_source_required",
                "Say where the theme comes from: `deck` (save that deck's theme) or `theme` (fonts and colours as JSON), not both.",
                "Send { \"deck\": \"<deck id>\", \"name\": \"Brand\" }.",
            ));
        }
    };
    let name = clean_name(body.name.as_deref().or(base["name"].as_str()).unwrap_or(""))?;
    let count: i64 = sqlx::query_scalar("select count(*) from themes where owner = $1").bind(caller.uuid).fetch_one(&st.pool).await?;
    if count >= MAX_THEMES {
        return Err(ApiError::conflict("too_many_themes", format!("You already have {MAX_THEMES} themes, the most an account can keep."), "Delete themes you no longer use first."));
    }
    let mut theme = base;
    let fonts = custom_fonts(&theme);
    if deck.is_none()
        && let Some((family, _)) = fonts.iter().find(|(_, src)| !src.starts_with("https://"))
    {
        return Err(ApiError::bad_request(
            "invalid_custom_font",
            format!("Custom font `{family}` must be an https URL here."),
            "To keep an uploaded font, upload it to a deck, set the deck's theme, then save the theme from that deck.",
        ));
    }
    let id = crate::ids::new_id();
    // Uploaded fonts are copied from the deck (only that deck's own assets); everything else is kept as is.
    let mut kept = Vec::new();
    let mut copies: Vec<(String, String, String, String, Vec<u8>)> = Vec::new();
    for (family, src) in fonts {
        match (src.strip_prefix("asset:"), &deck) {
            (Some(asset), Some(deck)) => {
                let row: Option<(String, String)> = sqlx::query_as("select filename, content_type from assets where id = $1 and deck = $2")
                    .bind(asset)
                    .bind(&deck.id)
                    .fetch_optional(&st.pool)
                    .await?;
                let Some((filename, ctype)) = row else { continue };
                let Ok(bytes) = tokio::fs::read(crate::routes::files::asset_path(&st, asset)).await else { continue };
                let fid = crate::ids::new_id();
                kept.push(json!({ "family": family, "src": format!("theme-font:{fid}") }));
                copies.push((fid, family, filename, ctype, bytes));
            }
            (None, _) if src.starts_with("https://") => kept.push(json!({ "family": family, "src": src })),
            _ => {}
        }
    }
    if let Some(m) = theme.as_object_mut() {
        m.insert("customFonts".into(), Value::Array(kept));
    }
    let theme = checked_theme(theme, &name)?;
    let mut tx = st.pool.begin().await?;
    let row: ThemeRow = match sqlx::query_as("insert into themes (id, owner, name, theme) values ($1, $2, $3, $4) returning id, name, theme, created_at, updated_at")
        .bind(&id)
        .bind(caller.uuid)
        .bind(&name)
        .bind(&theme)
        .fetch_one(&mut *tx)
        .await
    {
        Ok(r) => r,
        Err(e) if is_unique_violation(&e) => return Err(name_taken(&name)),
        Err(e) => return Err(e.into()),
    };
    for (fid, family, filename, ctype, bytes) in &copies {
        write_file(&font_path(&st, fid), bytes).await?;
        sqlx::query("insert into theme_fonts (id, theme, family, filename, content_type, size, sha256) values ($1, $2, $3, $4, $5, $6, $7)")
            .bind(fid)
            .bind(&id)
            .bind(family)
            .bind(filename)
            .bind(ctype)
            .bind(bytes.len() as i64)
            .bind(hex::encode(Sha256::digest(bytes)))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(theme_json(&row))).into_response())
}

// ---------------------------------------------------------------- update, delete

#[derive(Deserialize)]
pub struct PatchBody {
    name: Option<String>,
    /// Heading and/or body font; missing keys stay.
    fonts: Option<Map<String, Value>>,
    /// Any of the six colours; missing keys stay.
    colors: Option<Map<String, Value>>,
}

pub async fn patch(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, JsonBody(body): JsonBody<PatchBody>) -> ApiResult<Json<Value>> {
    let current = own_theme(&st, &caller, &id).await?;
    let name = match &body.name {
        Some(n) => clean_name(n)?,
        None => current.name.clone(),
    };
    let mut theme = current.theme.clone();
    for (key, patch) in [("fonts", &body.fonts), ("colors", &body.colors)] {
        if let (Some(patch), Some(m)) = (patch, theme[key].as_object_mut()) {
            for (k, v) in patch {
                if !m.contains_key(k) {
                    return Err(ApiError::bad_request("invalid_theme", format!("`{key}.{k}` is not part of a theme."), "Fonts are heading and body; colours are background, text, accent, accent2, accent3 and muted."));
                }
                m.insert(k.clone(), v.clone());
            }
        }
    }
    let theme = checked_theme(theme, &name)?;
    let row: ThemeRow = match sqlx::query_as("update themes set name = $3, theme = $4, updated_at = now() where id = $1 and owner = $2 returning id, name, theme, created_at, updated_at")
        .bind(&id)
        .bind(caller.uuid)
        .bind(&name)
        .bind(&theme)
        .fetch_one(&st.pool)
        .await
    {
        Ok(r) => r,
        Err(e) if is_unique_violation(&e) => return Err(name_taken(&name)),
        Err(e) => return Err(e.into()),
    };
    Ok(Json(theme_json(&row)))
}

pub async fn delete(State(st): State<AppState>, caller: Caller, Path(id): Path<String>) -> ApiResult<StatusCode> {
    own_theme(&st, &caller, &id).await?;
    let fonts: Vec<String> = sqlx::query_scalar("select id from theme_fonts where theme = $1").bind(&id).fetch_all(&st.pool).await?;
    sqlx::query("delete from themes where id = $1 and owner = $2").bind(&id).bind(caller.uuid).execute(&st.pool).await?;
    for f in fonts {
        let _ = tokio::fs::remove_file(font_path(&st, &f)).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- use

#[derive(Deserialize)]
pub struct UseBody {
    deck: Option<String>,
}

/// Copies the theme's uploaded fonts into the deck (reusing an identical copy already there) and returns the theme
/// as the deck should store it. It doesn't change the deck: the client sets it as the deck's theme.
pub async fn use_theme(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, JsonBody(body): JsonBody<UseBody>) -> ApiResult<Json<Value>> {
    let row = own_theme(&st, &caller, &id).await?;
    let Some(deck_id) = body.deck.filter(|d| !d.trim().is_empty()) else {
        return Err(ApiError::bad_request("deck_required", "Say which deck the theme is for.", "Send { \"deck\": \"<deck id>\" }."));
    };
    let (deck, _) = access::deck_for(&st, &deck_id, Some(caller.uuid), Need::Edit).await?;
    let mut fonts = Vec::new();
    for (family, src) in custom_fonts(&row.theme) {
        let Some(fid) = src.strip_prefix("theme-font:") else {
            fonts.push(json!({ "family": family, "src": src }));
            continue;
        };
        let font: Option<(String, String, String)> = sqlx::query_as("select filename, content_type, sha256 from theme_fonts where id = $1 and theme = $2")
            .bind(fid)
            .bind(&row.id)
            .fetch_optional(&st.pool)
            .await?;
        let Some((filename, ctype, sha)) = font else { continue };
        let existing: Option<String> = sqlx::query_scalar("select id from assets where deck = $1 and sha256 = $2 order by created_at limit 1")
            .bind(&deck.id)
            .bind(&sha)
            .fetch_optional(&st.pool)
            .await?;
        let asset = match existing {
            Some(a) => a,
            None => {
                let bytes = tokio::fs::read(font_path(&st, fid)).await.map_err(|_| {
                    ApiError::not_found("theme_font_missing", format!("Font `{family}` of theme `{}` is missing from storage.", row.name), "Save the theme again from a deck that has the font.")
                })?;
                let a = crate::ids::new_id();
                crate::routes::files::save_asset(&st, &a, &deck, caller.uuid, &filename, &ctype, &bytes).await?;
                a
            }
        };
        fonts.push(json!({ "family": family, "src": format!("asset:{asset}") }));
    }
    let mut theme = row.theme.clone();
    theme["customFonts"] = Value::Array(fonts);
    theme["name"] = json!(row.name);
    Ok(Json(json!({ "theme": theme, "deck": deck.id })))
}

