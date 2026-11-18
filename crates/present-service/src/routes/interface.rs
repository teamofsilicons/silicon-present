//! The downloadable reference and the guide share an origin with the API.
use crate::state::AppState;
use axum::{Router, response::Html, routing::get};
const ARCHITECTURE: &str = include_str!("../../../../docs/architecture.md");
fn section(start: &str, end: &str) -> &'static str {
    let slice = &ARCHITECTURE[ARCHITECTURE.find(start).expect("documented section")..];
    &slice[..slice.find(end).expect("section boundary")]
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/interface-api",
            get(|| async { Html(include_str!("../../../../docs/interface-api.html")) }),
        )
        .route(
            "/openapi.json",
            get(|| async {
                (
                    [("content-type", "application/json")],
                    include_str!("../../../../docs/openapi.json"),
                )
            }),
        )
        .route(
            "/interface-api/deck-format",
            get(|| async {
                (
                    [("content-type", "text/markdown; charset=utf-8")],
                    section("## The deck document", "## The service"),
                )
            }),
        )
        .route(
            "/interface-api/protocol",
            get(|| async {
                (
                    [("content-type", "text/markdown; charset=utf-8")],
                    section("## The service", "## Converter sidecar"),
                )
            }),
        )
}
