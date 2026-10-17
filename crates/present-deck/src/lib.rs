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
mod textview;

pub use anyconv::{any_to_json, json_to_any};
pub use convert::{
    decode_doc, doc_from_updates, doc_to_json, encode_doc, json_to_doc, new_doc, write_deck, DeckMeta,
    MASTER_KEY,
};
pub use diff::{diff, summarize, DeckDiff, ElementChange, SlideChange, SlideRef};
pub use error::DeckError;
pub use ids::{element_id, slide_id};
pub use normalize::{default_deck, default_theme, normalize_deck, normalize_element, normalize_slide, normalize_theme};
pub use ops::{apply_ops, apply_ops_update, parse_ops, Op, OpsOutcome};
pub use reconcile::{reconcile, reconcile_update, Scope};
pub use richtext::{plain_text, rich_from_plain, rich_to_markdownish};
pub use textview::to_text;

/// Clones a document by encoding its state into a fresh one (with a new client id).
pub fn clone_doc(doc: &yrs::Doc) -> yrs::Doc {
    let bytes = encode_doc(doc);
    decode_doc(&bytes).expect("a document's own state always decodes")
}
