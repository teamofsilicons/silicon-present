//! The converter sidecar (`renderer/`): slide → image, deck → file, file → deck JSON. Internal only, called with
//! `X-Converter-Secret`. Contract in docs/architecture.md ("Converter sidecar").

use async_trait::async_trait;
use axum::http::StatusCode;
use bytes::Bytes;
use serde_json::Value;

use crate::error::ApiError;

/// A file the converter produced.
#[derive(Debug, Clone)]
pub struct ConvertedFile {
    pub bytes: Bytes,
    pub content_type: String,
}

#[async_trait]
pub trait Converter: Send + Sync {
    /// `POST /render { deck, slide, width, format, at, assetBase }` → image.
    async fn render(&self, body: Value) -> Result<ConvertedFile, ApiError>;
    /// `POST /export { deck, format, assetBase }` → file.
    async fn export(&self, body: Value) -> Result<ConvertedFile, ApiError>;
    /// `POST /import { filename, contentType, data }` → `{ deck, assets: [{ key, filename, contentType, data }] }`.
    async fn import(&self, body: Value) -> Result<Value, ApiError>;
}

pub struct HttpConverter {
    pub http: reqwest::Client,
    pub url: String,
    pub secret: String,
}

impl HttpConverter {
    async fn post(&self, path: &str, body: &Value) -> Result<reqwest::Response, ApiError> {
        let resp = self
            .http
            .post(format!("{}{}", self.url, path))
            .header("X-Converter-Secret", &self.secret)
            .json(body)
            .send()
            .await
            .map_err(|e| {
                ApiError::unavailable(
                    "converter_unreachable",
                    format!("Silicon Present couldn't reach its converter: {e}."),
                    "Try again in a moment.",
                )
            })?;
        if resp.status().is_success() {
            return Ok(resp);
        }
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let parsed: Option<Value> = serde_json::from_str(&text).ok();
        let err = parsed.as_ref().map(|v| &v["error"]);
        let code = err.and_then(|e| e["code"].as_str()).unwrap_or("converter_failed").to_string();
        let message = err
            .and_then(|e| e["message"].as_str())
            .map(String::from)
            .unwrap_or_else(|| format!("The converter failed ({status}): {}", text.chars().take(300).collect::<String>()));
        let hint = err.and_then(|e| e["hint"].as_str()).unwrap_or("Try again; if it keeps failing, check the converter's log.").to_string();
        let status = if status.is_client_error() { StatusCode::UNPROCESSABLE_ENTITY } else { StatusCode::BAD_GATEWAY };
        Err(ApiError::new(status, &code, message, hint))
    }

    async fn file(&self, path: &str, body: Value) -> Result<ConvertedFile, ApiError> {
        let resp = self.post(path, &body).await?;
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let bytes = resp.bytes().await.map_err(|e| ApiError::internal(format!("reading the converter's answer: {e}")))?;
        Ok(ConvertedFile { bytes, content_type })
    }
}

#[async_trait]
impl Converter for HttpConverter {
    async fn render(&self, body: Value) -> Result<ConvertedFile, ApiError> {
        self.file("/render", body).await
    }

    async fn export(&self, body: Value) -> Result<ConvertedFile, ApiError> {
        self.file("/export", body).await
    }

    async fn import(&self, body: Value) -> Result<Value, ApiError> {
        let resp = self.post("/import", &body).await?;
        resp.json().await.map_err(|e| ApiError::internal(format!("the converter's import answer isn't JSON: {e}")))
    }
}

pub fn not_configured() -> ApiError {
    ApiError::unavailable(
        "converter_not_configured",
        "Opening files, exporting and rendering slides need the converter, and this service runs without one.",
        "Start the converter (renderer/) and set PRESENT_CONVERTER_URL and CONVERTER_SECRET for the service.",
    )
}
