//! Extractors whose rejections use the API's error shape.

use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::request::Parts;
use serde::de::DeserializeOwned;

use crate::error::ApiError;

/// A JSON body; an empty body reads as `{}`.
pub struct JsonBody<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for JsonBody<T> {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = axum::body::Bytes::from_request(req, state).await.map_err(|e| {
            ApiError::new(e.status(), "body_unreadable", format!("The request body couldn't be read: {e}."), "Send a JSON body within this endpoint's size limit.")
        })?;
        let slice: &[u8] = if bytes.iter().all(|b| b.is_ascii_whitespace()) { b"{}" } else { &bytes };
        serde_json::from_slice(slice).map(JsonBody).map_err(ApiError::invalid_json)
    }
}

/// Query parameters.
pub struct Q<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequestParts<S> for Q<T> {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let query = parts.uri.query().unwrap_or("");
        serde_urlencoded_parse(query).map(Q)
    }
}

fn serde_urlencoded_parse<T: DeserializeOwned>(query: &str) -> Result<T, ApiError> {
    axum::extract::Query::<T>::try_from_uri(&format!("/?{query}").parse().expect("a path with a query is a valid uri"))
        .map(|q| q.0)
        .map_err(|e| ApiError::bad_request("invalid_query", format!("The query string isn't valid here: {}.", e.body_text()), "Check the parameter names and values in docs/architecture.md."))
}
