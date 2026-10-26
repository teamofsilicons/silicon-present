//! Stateless Rust client for Silicon Present: slides that Carbons and Silicons make, present and
//! comment on together.
//!
//! Everything the web editor can do is a method here: decks and folders, reading a deck as JSON
//! or text, rendering slides to images, editing through ops, comments, sharing, versions,
//! imports and exports, presenting, and the live stream. The `present` CLI is built only on this
//! package.
//!
//! ```no_run
//! # async fn demo() -> silicon_present_client::Result<()> {
//! use silicon_present_client::{Client, Secret, ops::{EditRequest, Op}, deck};
//! let client = Client::new("https://backend.present.teamofsilicons.com")?.with_token(Secret::new("eyJ…"));
//! let d = client.create_deck(&Default::default()).await?;
//! client.edit(&d.id, &EditRequest::new(vec![Op::AddSlide {
//!     after: None,
//!     slide: serde_json::json!({ "layout": "title", "elements": [
//!         deck::element("text", deck::Frame { x: 160.0, y: 400.0, w: 1600.0, h: 200.0 },
//!             [("text".to_owned(), deck::rich_text("Hello"))].into_iter().collect())
//!     ]}),
//! }])).await?;
//! # Ok(()) }
//! ```
//!
//! Sign in with [`accounts::SignIn`]: Silicons exchange a short-lived token from
//! `silicon-accounts login --app present -q`; Carbons use the device flow.

#![warn(missing_docs)]
// Errors carry the service's whole answer (code, message, hint, request id, details) so a
// Silicon can act on it; they are rare, so their size does not matter.
#![allow(clippy::result_large_err)]

pub mod accounts;
mod client;
pub mod deck;
pub mod diff;
mod error;
pub mod models;
pub mod ops;
mod secret;
pub mod sse;

pub use client::{
    Client, DEFAULT_API_URL, FromVersion, NewDeck, Presence, RenderOptions, Scope,
    filename_from_disposition, parse_base,
};
pub use error::{Error, Result};
pub use models::*;
pub use reqwest::Method;
pub use secret::Secret;

mod writing;
