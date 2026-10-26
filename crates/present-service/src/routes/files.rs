//! Files: assets (stored under PRESENT_DATA_DIR/assets, served to viewers and, through signed URLs, to the
//! converter), opening files as decks (or on top of one), exporting to every format, and rendering slides.

use std::collections::HashMap;
use std::path::PathBuf;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::access::{self, Need};
use crate::auth::{Caller, MaybeCaller};
use crate::error::{ApiError, ApiResult};
use crate::extract::Q;
use crate::rooms::{self, CommitInfo};
use crate::state::AppState;
use crate::store::{self, DeckRow};

pub const MAX_UPLOAD: usize = 512 * 1024 * 1024;

pub fn asset_path(st: &AppState, id: &str) -> PathBuf {
    st.cfg.data_dir.join("assets").join(id)
}

fn filename_from(headers: &HeaderMap, default: &str) -> String {
    let raw = headers.get("x-filename").and_then(|v| v.to_str().ok()).unwrap_or("").trim().to_string();
    let decoded = percent_decode(&raw);
    let name = decoded.rsplit(['/', '\\']).next().unwrap_or("").trim().to_string();
    if name.is_empty() { default.to_string() } else { name.chars().take(255).collect() }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Some(b) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn content_type(headers: &HeaderMap) -> String {
    headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string()
}

/// Writes an asset's bytes and row.
async fn save_asset(st: &AppState, id: &str, deck: &DeckRow, uploader: Uuid, filename: &str, ctype: &str, bytes: &[u8]) -> ApiResult<Value> {
    let path = asset_path(st, id);
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| ApiError::internal(format!("creating the asset directory: {e}")))?;
    }
    tokio::fs::write(&path, bytes).await.map_err(|e| ApiError::internal(format!("writing the asset: {e}")))?;
    let sha = hex::encode(Sha256::digest(bytes));
    sqlx::query("insert into assets (id, deck, owner, uploaded_by, filename, content_type, size, sha256) values ($1, $2, $3, $4, $5, $6, $7, $8)")
        .bind(id)
        .bind(&deck.id)
        .bind(deck.owner)
        .bind(uploader)
        .bind(filename)
        .bind(ctype)
        .bind(bytes.len() as i64)
        .bind(&sha)
        .execute(&st.pool)
        .await?;
    Ok(asset_json(st, id, filename, ctype, bytes.len() as i64))
}

fn asset_json(st: &AppState, id: &str, filename: &str, ctype: &str, size: i64) -> Value {
    json!({
        "id": id,
        "ref": format!("asset:{id}"),
        "url": format!("{}/v1/assets/{id}", st.cfg.public_url),
        "filename": filename,
        "contentType": ctype,
        "size": size,
    })
}

pub async fn upload(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let (deck, _) = access::deck_for(&st, &id, Some(caller.uuid), Need::Edit).await?;
    if body.is_empty() {
        return Err(ApiError::bad_request("empty_upload", "The upload has no bytes.", "Send the file as the raw request body with its Content-Type and X-Filename."));
    }
    let asset_id = crate::ids::new_id();
    let filename = filename_from(&headers, "file");
    let out = save_asset(&st, &asset_id, &deck, caller.uuid, &filename, &content_type(&headers), &body).await?;
    Ok((StatusCode::CREATED, Json(out)).into_response())
}

#[derive(sqlx::FromRow)]
struct AssetRow {
    id: String,
    deck: String,
    filename: String,
    content_type: String,
}

fn sign(st: &AppState, deck: &str, exp: i64) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(&st.asset_key).expect("any key length works");
    mac.update(format!("{deck}:{exp}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn sig_ok(st: &AppState, deck: &str, exp: i64, sig: &str) -> bool {
    exp > time::OffsetDateTime::now_utc().unix_timestamp() && constant_eq(sign(st, deck, exp).as_bytes(), sig.as_bytes())
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The base URL the converter resolves `asset:<id>` against: `assetBase + id` (a trailing slash too many is fine,
/// the service collapses `//`). Valid for an hour.
pub fn asset_base(st: &AppState, deck: &str) -> String {
    let exp = time::OffsetDateTime::now_utc().unix_timestamp() + 3600;
    format!("{}/v1/signed/{deck}/{exp}/{}/assets/", st.cfg.public_url, sign(st, deck, exp))
}

// Raster/media/font formats remain embeddable; uploaded documents and code download.
// SVG is safe as an image, but a navigation still needs an opaque, scriptless sandbox.
fn asset_inline_type(content_type: &str) -> bool {
    matches!(content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" | "image/svg+xml" |
        "video/mp4" | "video/webm" | "video/ogg" | "audio/mpeg" | "audio/mp4" | "audio/ogg" |
        "audio/wav" | "audio/webm" | "font/woff" | "font/woff2" | "font/ttf" | "font/otf")
}

async fn serve_asset(st: &AppState, a: &AssetRow) -> ApiResult<Response> {
    let bytes = tokio::fs::read(asset_path(st, &a.id)).await.map_err(|_| {
        ApiError::not_found("asset_missing", format!("Asset `{}`'s file is missing from the service's storage.", a.id), "Upload it again.")
    })?;
    let mut resp = bytes.into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&a.content_type).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"));
    if let Ok(v) = HeaderValue::from_str(&format!("{}; filename*=UTF-8''{}", if asset_inline_type(&a.content_type) { "inline" } else { "attachment" }, encode_rfc5987(&a.filename))) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    Ok(resp)
}

async fn asset_row(st: &AppState, id: &str) -> ApiResult<AssetRow> {
    sqlx::query_as("select id, deck, filename, content_type from assets where id = $1")
        .bind(id)
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("asset_not_found", format!("There is no asset `{id}`."), "Check the id in the deck's \"asset:<id>\" reference."))
}

#[derive(Deserialize)]
pub struct AssetQuery {
    deck: Option<String>,
    exp: Option<i64>,
    sig: Option<String>,
}

pub async fn get_asset(State(st): State<AppState>, caller: MaybeCaller, Extension(viewer): Extension<crate::viewers::ViewerIdentity>, Path(id): Path<String>, Q(q): Q<AssetQuery>) -> ApiResult<Response> {
    let a = asset_row(&st, &id).await?;
    let signed = matches!((&q.deck, q.exp, &q.sig), (Some(d), Some(exp), Some(sig)) if *d == a.deck && sig_ok(&st, d, exp, sig));
    if !signed {
        crate::viewers::deck_for(&st, &a.deck, caller.uuid(), Need::View, &viewer).await?;
    }
    serve_asset(&st, &a).await
}

pub async fn get_signed_asset(State(st): State<AppState>, Path((deck, exp, sig, id)): Path<(String, i64, String, String)>) -> ApiResult<Response> {
    if !sig_ok(&st, &deck, exp, &sig) {
        return Err(ApiError::forbidden("bad_signature", "This asset link's signature is wrong or has expired.", "Ask the service for a fresh link."));
    }
    let a = asset_row(&st, &id).await?;
    if a.deck != deck {
        return Err(ApiError::not_found("asset_not_found", format!("There is no asset `{id}` in deck `{deck}`."), "Check the id."));
    }
    serve_asset(&st, &a).await
}

/// Replaces `asset:<old>` references in deck JSON (anywhere: element fields, backgrounds, fonts, HTML code).
pub fn rewrite_asset_refs(json: &Value, map: &HashMap<String, String>) -> Value {
    if map.is_empty() {
        return json.clone();
    }
    let s = json.to_string();
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(pos) = rest.find("asset:") {
        out.push_str(&rest[..pos + 6]);
        rest = &rest[pos + 6..];
        let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')).unwrap_or(rest.len());
        let key = &rest[..end];
        match map.get(key) {
            Some(new) => out.push_str(new),
            None => out.push_str(key),
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    serde_json::from_str(&out).unwrap_or_else(|_| json.clone())
}

/// New ids for every asset of `src`, so a copied deck owns its own copies.
pub async fn plan_asset_copy(st: &AppState, src: &str) -> ApiResult<HashMap<String, String>> {
    let ids: Vec<String> = sqlx::query_scalar("select id from assets where deck = $1").bind(src).fetch_all(&st.pool).await?;
    Ok(ids.into_iter().map(|id| (id, crate::ids::new_id())).collect())
}

pub async fn finish_asset_copy(st: &AppState, map: &HashMap<String, String>, new: &DeckRow, me: Uuid) -> ApiResult<()> {
    for (old, newid) in map {
        let row: Option<(String, String)> = sqlx::query_as("select filename, content_type from assets where id = $1").bind(old).fetch_optional(&st.pool).await?;
        let Some((filename, ctype)) = row else { continue };
        let Ok(bytes) = tokio::fs::read(asset_path(st, old)).await else { continue };
        save_asset(st, newid, new, me, &filename, &ctype, &bytes).await?;
    }
    Ok(())
}

fn b64d(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s.trim()).ok()
}

/// Calls the converter's import and returns (deck JSON with assets saved under new ids, the assets to save).
async fn convert_import(st: &AppState, headers: &HeaderMap, body: &Bytes) -> ApiResult<(Value, Vec<(String, String, String, Vec<u8>)>, String)> {
    let converter = st.converter.clone().ok_or_else(crate::converter::not_configured)?;
    if body.is_empty() {
        return Err(ApiError::bad_request("empty_upload", "The file has no bytes.", "Send the file as the raw request body with its Content-Type and X-Filename."));
    }
    let filename = filename_from(headers, "file");
    let out = converter
        .import(json!({
            "filename": filename,
            "contentType": content_type(headers),
            "data": base64::engine::general_purpose::STANDARD.encode(body),
        }))
        .await?;
    let deck = out.get("deck").cloned().ok_or_else(|| ApiError::internal("the converter's import answer has no deck"))?;
    let mut map = HashMap::new();
    let mut assets = Vec::new();
    for a in out["assets"].as_array().into_iter().flatten() {
        let key = a["key"].as_str().unwrap_or_default().to_string();
        let Some(bytes) = a["data"].as_str().and_then(b64d) else { continue };
        let id = crate::ids::new_id();
        map.insert(key, id.clone());
        assets.push((
            id,
            a["filename"].as_str().unwrap_or("asset").to_string(),
            a["contentType"].as_str().unwrap_or("application/octet-stream").to_string(),
            bytes,
        ));
    }
    Ok((rewrite_asset_refs(&deck, &map), assets, filename))
}

#[derive(Deserialize)]
pub struct ImportQuery {
    folder: Option<String>,
}

pub async fn import_new(State(st): State<AppState>, caller: Caller, Q(q): Q<ImportQuery>, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let me = caller.uuid;
    let (owner, folder) = crate::routes::decks::placement(&st, me, q.folder.as_deref()).await?;
    let (deck_json, assets, filename) = convert_import(&st, &headers, &body).await?;
    let stem = filename.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or_else(|| filename.clone());
    let title = crate::routes::decks::clean_title(deck_json["title"].as_str().filter(|t| !t.trim().is_empty()).or(Some(&stem)), "Untitled deck")?;
    let normalized = present_deck::normalize_deck(&deck_json)?;
    let deck = store::create_deck(&st, owner, me, &title, folder.as_deref(), &normalized, "import", &format!("opened {filename}")).await?;
    for (id, name, ctype, bytes) in assets {
        save_asset(&st, &id, &deck, me, &name, &ctype, &bytes).await?;
    }
    store::event(&st, Some(&deck.id), None, me, "deck.imported", json!({ "filename": filename })).await?;
    let role = access::deck_access(&st, &deck, Some(me)).await?.role;
    Ok((StatusCode::CREATED, Json(crate::views::deck_one(&st, &deck, role).await)).into_response())
}

pub async fn import_onto(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> ApiResult<Json<Value>> {
    let me = caller.uuid;
    let (deck, _) = access::deck_for(&st, &id, Some(me), Need::Edit).await?;
    let (deck_json, assets, filename) = convert_import(&st, &headers, &body).await?;
    for (aid, name, ctype, bytes) in assets {
        save_asset(&st, &aid, &deck, me, &name, &ctype, &bytes).await?;
    }
    let target = present_deck::normalize_deck(&deck_json)?;
    let summary = format!("opened {filename} on top of the deck");
    let info = CommitInfo { author: me, origin: "import", summary: Some(summary.clone()), session: None };
    let (commit, ()) = rooms::commit_with(&st, &id, info, |doc| Ok((present_deck::reconcile_update(doc, &target, &present_deck::Scope::Deck)?, ()))).await?;
    store::event(&st, Some(&id), None, me, "deck.imported", json!({ "filename": filename, "as": commit.version })).await?;
    Ok(Json(json!({ "version": commit.version, "changed": commit.changed, "summary": summary })))
}

fn encode_rfc5987(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn attachment(name: &str) -> String {
    let ascii: String = name.chars().map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' { c } else { '_' }).collect();
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{}", encode_rfc5987(name))
}

async fn deck_json_for(st: &AppState, deck: &DeckRow, version: Option<i64>, slide: Option<&str>, caller: Option<Uuid>, access: access::Access) -> ApiResult<Value> {
    let (live, _) = rooms::current_json(st, &deck.id).await?;
    if version.is_some_and(|v| v != live) {
        access::check("deck", &deck.id, access, caller, Need::Edit)?;
    }
    let mut json = store::json_at(st, &DeckRow { seq: live, ..deck.clone() }, version.unwrap_or(live)).await?;
    if let Some(s) = slide {
        let slides = json["slides"].as_array().cloned().unwrap_or_default();
        let one: Vec<Value> = slides.into_iter().filter(|x| x["id"] == s).collect();
        if one.is_empty() {
            return Err(ApiError::not_found("slide_not_found", format!("There is no slide `{s}` in this deck."), "Read the deck to get its slide ids."));
        }
        json["slides"] = Value::Array(one);
    }
    Ok(json)
}

#[derive(Deserialize)]
pub struct ExportQuery {
    format: Option<String>,
    version: Option<i64>,
    slide: Option<String>,
    width: Option<u32>,
    at: Option<u32>,
}

const FORMATS: [&str; 7] = ["pptx", "odp", "pdf", "txt", "png", "jpg", "svg"];

pub async fn export(State(st): State<AppState>, caller: MaybeCaller, Path(id): Path<String>, Q(q): Q<ExportQuery>) -> ApiResult<Response> {
    let (deck, access) = access::deck_for(&st, &id, caller.uuid(), Need::View).await?;
    let format = q.format.as_deref().unwrap_or("pptx").to_lowercase();
    if !FORMATS.contains(&format.as_str()) {
        return Err(ApiError::bad_request("invalid_format", format!("`{format}` isn't an export format."), format!("Use one of: {}.", FORMATS.join(", "))));
    }
    let converter = st.converter.clone().ok_or_else(crate::converter::not_configured)?;
    let json = deck_json_for(&st, &deck, q.version, q.slide.as_deref(), caller.uuid(), access).await?;
    // The deck is trimmed to the slide, and the converter is told which slide too: with `slide`, png/jpg come back as
    // one image instead of a zip of one.
    let mut body = json!({ "deck": json, "format": format, "assetBase": asset_base(&st, &id) });
    if let Some(slide) = &q.slide {
        body["slide"] = json!(slide);
    }
    if let Some(w) = q.width {
        body["width"] = json!(w.clamp(16, 7680));
    }
    if let Some(at) = q.at {
        body["at"] = json!(at);
    }
    let file = converter.export(body).await?;
    let ext = file.ext.clone().unwrap_or_else(|| if file.content_type.contains("zip") { "zip".to_string() } else { format.clone() });
    let name = format!("{}.{ext}", deck.title.replace(['/', '\\'], "-"));
    Ok((
        [(header::CONTENT_TYPE, file.content_type.clone()), (header::CONTENT_DISPOSITION, attachment(&name))],
        file.bytes,
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct RenderQuery {
    format: Option<String>,
    width: Option<u32>,
    version: Option<i64>,
    at: Option<u32>,
}

pub async fn render(State(st): State<AppState>, caller: MaybeCaller, Path((id, slide)): Path<(String, String)>, Q(q): Q<RenderQuery>) -> ApiResult<Response> {
    let (deck, access) = access::deck_for(&st, &id, caller.uuid(), Need::View).await?;
    let format = q.format.as_deref().unwrap_or("png").to_lowercase();
    if format != "png" && format != "jpg" {
        return Err(ApiError::bad_request("invalid_format", format!("`{format}` isn't an image format for rendering."), "Use format=png or format=jpg."));
    }
    let width = q.width.unwrap_or(1920).clamp(16, 7680);
    let converter = st.converter.clone().ok_or_else(crate::converter::not_configured)?;
    let json = deck_json_for(&st, &deck, q.version, None, caller.uuid(), access).await?;
    if slide != "master" && !json["slides"].as_array().into_iter().flatten().any(|s| s["id"] == slide.as_str()) {
        return Err(ApiError::not_found("slide_not_found", format!("There is no slide `{slide}` in this deck."), "Read the deck to get its slide ids."));
    }
    let file = converter
        .render(json!({ "deck": json, "slide": slide, "width": width, "format": format, "at": q.at.unwrap_or(1500), "assetBase": asset_base(&st, &id) }))
        .await?;
    Ok(([(header::CONTENT_TYPE, file.content_type.clone()), (header::CACHE_CONTROL, "private, no-store".to_string())], file.bytes).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_only_whole_asset_ids() {
        let map: HashMap<String, String> = [("a1".to_string(), "NEW1".to_string())].into();
        let v = json!({ "src": "asset:a1", "other": "asset:a10", "css": "url(asset:a1)" });
        let out = rewrite_asset_refs(&v, &map);
        assert_eq!(out["src"], "asset:NEW1");
        assert_eq!(out["other"], "asset:a10");
        assert_eq!(out["css"], "url(asset:NEW1)");
    }

    #[test]
    fn decodes_percent_encoded_names() {
        assert_eq!(percent_decode("Q4%20review.pptx"), "Q4 review.pptx");
        assert_eq!(percent_decode("100%"), "100%");
    }
}
