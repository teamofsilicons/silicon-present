//! The one error shape: `{"error": {"code", "message", "hint"}}` with the right status.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// An API error. `message` says what happened and why; `hint` says what to do.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub hint: String,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self { status, code: code.to_string(), message: message.into(), hint: hint.into() }
    }

    pub fn bad_request(code: &str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message, hint)
    }

    pub fn forbidden(code: &str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message, hint)
    }

    pub fn not_found(code: &str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message, hint)
    }

    pub fn conflict(code: &str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message, hint)
    }

    pub fn unauthorized(code: &str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, code, message, hint)
    }

    pub fn sign_in_required() -> Self {
        Self::unauthorized(
            "sign_in_required",
            "This needs a signed-in Carbon or Silicon, and the request carried no access token.",
            "Send `Authorization: Bearer <Silicon Accounts access token for present>`; with the CLI, run `present login` first.",
        )
    }

    pub fn internal(what: impl std::fmt::Display) -> Self {
        tracing::error!("internal error: {what}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            format!("Silicon Present failed while handling this request: {what}."),
            "Try again in a moment; if it keeps failing, the service log has the details.",
        )
    }

    pub fn unavailable(code: &str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, code, message, hint)
    }

    pub fn invalid_json(detail: impl std::fmt::Display) -> Self {
        Self::bad_request(
            "invalid_json",
            format!("The request body isn't the JSON this endpoint takes: {detail}."),
            "Check the body against docs/architecture.md (The service).",
        )
    }
}

impl From<present_deck::DeckError> for ApiError {
    fn from(e: present_deck::DeckError) -> Self {
        let status = match e.code {
            "slide_not_found" | "element_not_found" => StatusCode::NOT_FOUND,
            "text_not_found" | "text_ambiguous" | "slide_exists" | "element_exists" => StatusCode::CONFLICT,
            _ => StatusCode::BAD_REQUEST,
        };
        Self::new(status, e.code, e.message, e.hint)
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        Self::internal(format!("database error: {e}"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": { "code": self.code, "message": self.message, "hint": self.hint } }))).into_response()
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {} ({})", self.code, self.message, self.hint)
    }
}
