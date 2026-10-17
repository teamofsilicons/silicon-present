//! The docs, bundled in the binary: `present docs [topic]`.

use crate::ctx::Ctx;
use crate::fail::{Fail, R};
use serde_json::json;

/// (topic, one line, text)
pub const TOPICS: &[(&str, &str, &str)] = &[
    ("getting-started", "Sign in, make a deck, look at it, change it, share it: the whole tour", include_str!("../docs/getting-started.md")),
    ("decks", "Decks, folders, trash, transfers and opening files", include_str!("../docs/decks.md")),
    ("reading", "Reading a deck as text or JSON, and rendering slides to images", include_str!("../docs/reading.md")),
    ("editing", "Changing exactly the slide or element you mean: add, set, replace, delete, slide ...", include_str!("../docs/editing.md")),
    ("html", "Live HTML elements: files, sandbox, rendering them", include_str!("../docs/html.md")),
    ("ops", "Raw edit ops (present edit): every op and its fields", include_str!("../docs/ops.md")),
    ("deck-json", "The deck JSON format: slides, elements, rich text, themes", include_str!("../docs/deck-json.md")),
    ("pull", "Working in a folder: pull, status, push, and how merging works", include_str!("../docs/pull.md")),
    ("comments", "Reading and writing comments, anchors, mentions and tings", include_str!("../docs/comments.md")),
    ("sharing", "Roles, folders, public links", include_str!("../docs/sharing.md")),
    ("versions", "History, compare, restore, undo one account", include_str!("../docs/versions.md")),
    ("export", "Formats in and out", include_str!("../docs/export.md")),
    ("presenting", "Presenting and following along; watching a deck live", include_str!("../docs/presenting.md")),
    ("sign-in", "How the CLI signs in, where it keeps state, URLs and settings", include_str!("../docs/sign-in.md")),
    ("errors", "How errors look and what the common codes mean", include_str!("../docs/errors.md")),
];

pub fn show(ctx: &Ctx, topic: Option<&str>) -> R<()> {
    match topic {
        None => {
            let v = json!({ "topics": TOPICS.iter().map(|(t, d, _)| json!({ "topic": t, "about": d })).collect::<Vec<_>>() });
            ctx.out(&v, || {
                let mut s = String::from("present docs <topic>\n\n");
                for (t, d, _) in TOPICS {
                    s.push_str(&format!("  {t:<16} {d}\n"));
                }
                s.push_str("\nNew here? present docs getting-started");
                s
            });
            Ok(())
        }
        Some(t) => {
            let t = t.trim().to_ascii_lowercase();
            let found = TOPICS.iter().find(|(name, _, _)| *name == t || name.starts_with(&t));
            match found {
                Some((name, about, text)) => {
                    ctx.out(&json!({ "topic": name, "about": about, "text": text }), || (*text).to_owned());
                    Ok(())
                }
                None => Err(Fail::new(
                    "unknown_topic",
                    format!("There is no docs topic `{t}`."),
                    format!("Topics: {}.", TOPICS.iter().map(|(n, _, _)| *n).collect::<Vec<_>>().join(", ")),
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_topic_has_text_and_uses_the_right_words() {
        for (name, _, text) in super::TOPICS {
            assert!(text.len() > 200, "{name} is too short");
            let lower = text.to_ascii_lowercase();
            for banned in ["human", "ai agent", "user account", "frontend", "backend", " org "] {
                assert!(!lower.contains(banned), "{name} says `{banned}`");
            }
        }
    }
}
