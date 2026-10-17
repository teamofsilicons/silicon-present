//! Undo one Carbon's or Silicon's changes since a version, keeping everyone else's.
//!
//! Yjs updates carry their whole delete set, so simply leaving someone's updates out of a replay doesn't work:
//! later updates by others would still carry that person's deletions. Instead the log is replayed with every
//! transaction tagged by whether that person made it, and a Yjs undo manager tracking only their transactions
//! undoes them all (their insertions are deleted, their deletions come back). Content that only existed inside
//! what they inserted goes with it.

use serde_json::Value;
use yrs::undo::Options as UndoOptions;
use yrs::updates::decoder::Decode;
use yrs::{Doc, OffsetKind, Options, Transact, UndoManager, Update};

use crate::convert::{doc_to_json, roots};
use crate::error::DeckError;

const THEIRS: &str = "present:undo-target";
const OTHERS: &str = "present:undo-others";

fn decode(bytes: &[u8]) -> Result<Update, DeckError> {
    Update::decode_v1(bytes).map_err(|e| DeckError::new("invalid_update", format!("A Yjs update in the log could not be decoded: {e}."), "This deck's history is damaged; restore a version instead."))
}

/// `base`: the updates that make the deck as it was at the starting version (a snapshot and/or updates, in order).
/// `later`: every later update in order, with `true` when it was made by the account being undone.
/// Returns the deck JSON with that account's later changes undone.
pub fn undo_author(base: &[&[u8]], later: &[(bool, &[u8])]) -> Result<Value, DeckError> {
    let doc = Doc::with_options(Options { offset_kind: OffsetKind::Utf16, skip_gc: true, ..Options::default() });
    let r = roots(&doc);
    {
        let mut txn = doc.transact_mut();
        for b in base {
            txn.apply_update(decode(b)?).map_err(|e| DeckError::new("invalid_update", format!("A Yjs update could not be applied: {e}."), "Restore a version instead."))?;
        }
    }
    let mut um: UndoManager = UndoManager::with_options(UndoOptions { capture_timeout_millis: 0, ..UndoOptions::default() });
    um.expand_scope(&doc, &r.deck);
    um.expand_scope(&doc, &r.order);
    um.expand_scope(&doc, &r.slides);
    um.include_origin(THEIRS);
    for (theirs, bytes) in later {
        let u = decode(bytes)?;
        let mut txn = doc.transact_mut_with(if *theirs { THEIRS } else { OTHERS });
        // An update that can't integrate is skipped; the rest of the history still applies.
        let _ = txn.apply_update(u);
    }
    while um.undo_blocking() {}
    Ok(doc_to_json(&doc))
}
