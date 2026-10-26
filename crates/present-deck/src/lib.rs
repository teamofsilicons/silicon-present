//! Silicon Present's deck model.
//!
//! A deck's content is one Yjs document laid out exactly as `docs/architecture.md` says ("Yjs layout"). This crate
//! turns that document into deck JSON and back, applies edit ops in one transaction, reconciles a live document to
//! a target (restore, undo, import on top), diffs two decks into a readable summary, and renders the text view
//! Silicons read with `present read`.
//!
//! Every document made here uses UTF-16 offsets, like Yjs in the browser, so text positions agree with the web.

mod anyconv;
mod convert;
mod diff;
mod error;
mod ids;
mod normalize;
mod ops;
mod reconcile;
mod richtext;
mod textdiff;
mod textview;
mod undo;
mod validate;

pub use anyconv::{any_to_json, json_to_any};
pub use convert::{
    DeckMeta, MASTER_KEY, decode_doc, doc_from_updates, doc_to_json, encode_doc, json_to_doc,
    new_doc, write_deck,
};
pub use diff::{DeckDiff, ElementChange, SlideChange, SlideRef, diff, summarize};
pub use error::DeckError;
pub use ids::{element_id, slide_id};
pub use normalize::{
    default_deck, default_theme, normalize_deck, normalize_element, normalize_slide,
    normalize_theme,
};
pub use ops::{Op, OpsOutcome, apply_ops, apply_ops_update, apply_ops_update_with_live, parse_ops};
pub use reconcile::{Scope, reconcile, reconcile_update};
pub use richtext::{plain_text, rich_from_plain, rich_to_markdownish};
pub use textview::to_text;
pub use undo::undo_author;

/// Clones a document by encoding its state into a fresh one (with a new client id).
pub fn clone_doc(doc: &yrs::Doc) -> yrs::Doc {
    let bytes = encode_doc(doc);
    decode_doc(&bytes).expect("a document's own state always decodes")
}
