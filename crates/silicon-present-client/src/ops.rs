//! Edit ops: how Silicons change a deck (`POST /v1/decks/{id}/edits`).
//!
//! All ops in one [`EditRequest`] are one transaction, so the whole change appears at once. With
//! `base` set, the service applies them to the deck as it was at that version and merges the
//! result into the live deck, so an edit made on an older copy merges with everything since.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// One edit request.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EditRequest {
    /// The version the ops were written against (after `present pull`); `None` = the live deck.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<u64>,
    /// A short description shown in the history ("Rebuilt slide 4").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// The ops, applied in order.
    pub ops: Vec<Op>,
}

impl EditRequest {
    /// Ops against the live deck.
    pub fn new(ops: Vec<Op>) -> Self {
        Self {
            base: None,
            summary: None,
            ops,
        }
    }

    /// Writes the ops against `version`.
    #[must_use]
    pub fn on(mut self, version: u64) -> Self {
        self.base = Some(version);
        self
    }

    /// Names the change in the history.
    #[must_use]
    pub fn summary(mut self, summary: impl Into<String>) -> Self {
        let s = summary.into();
        self.summary = (!s.trim().is_empty()).then_some(s);
        self
    }
}

/// Where `reorder_element` moves an element.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ZTarget {
    /// `front`, `back`, `forward` or `backward`.
    Named(String),
    /// A position, 0 = back.
    Index(u64),
}

/// One edit. Field names follow `docs/architecture.md` exactly.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// Change the deck's size or theme.
    UpdateDeck {
        /// `size` and/or `theme`.
        set: Map<String, Value>,
    },
    /// Add a slide after another (`None` = first).
    AddSlide {
        /// The slide to add it after.
        after: Option<String>,
        /// Partial slide JSON, elements included; missing fields get defaults.
        slide: Value,
    },
    /// Change slide fields: `layout`, `background`, `skipped`, `section`, `hideMaster`,
    /// `transition`, `notes`.
    UpdateSlide {
        /// Slide id.
        slide: String,
        /// The fields to change.
        set: Map<String, Value>,
    },
    /// Move a slide after another (`None` = first).
    MoveSlide {
        /// Slide id.
        slide: String,
        /// The slide to move it after.
        after: Option<String>,
    },
    /// Delete a slide.
    DeleteSlide {
        /// Slide id.
        slide: String,
    },
    /// Add an element to a slide (or `master`).
    AddElement {
        /// Slide id or `master`.
        slide: String,
        /// Element JSON; the id is optional.
        element: Value,
        /// Position in the z order, 0 = back; `None` = front.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        z: Option<u64>,
    },
    /// Change element fields. Text, html, css, js and cells are replaced through a minimal
    /// diff so concurrent typing survives.
    UpdateElement {
        /// Slide id or `master`.
        slide: String,
        /// Element id.
        element: String,
        /// The fields to change.
        set: Map<String, Value>,
    },
    /// Replace an exact passage.
    ReplaceText {
        /// Slide id or `master`.
        slide: String,
        /// Element id; `None` searches the whole slide (or the notes).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        element: Option<String>,
        /// `text`, `notes`, `html`, `css`, `js` or `cell:r:c`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field: Option<String>,
        /// The exact passage.
        find: String,
        /// What replaces it.
        replace: String,
        /// Replace every occurrence instead of failing when there are several.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        all: bool,
    },
    /// Move an element in the z order.
    ReorderElement {
        /// Slide id or `master`.
        slide: String,
        /// Element id.
        element: String,
        /// Where to.
        to: ZTarget,
    },
    /// Delete an element.
    DeleteElement {
        /// Slide id or `master`.
        slide: String,
        /// Element id.
        element: String,
    },
}

impl Op {
    /// One line saying what the op does, for `present push` and `present status`.
    pub fn describe(&self) -> String {
        match self {
            Self::UpdateDeck { set } => format!("change deck {}", keys(set)),
            Self::AddSlide { after, slide } => {
                let id = slide.get("id").and_then(Value::as_str).unwrap_or("new slide");
                let n = slide
                    .get("elements")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                match after {
                    Some(a) => format!("add slide {id} after {a} ({n} elements)"),
                    None => format!("add slide {id} first ({n} elements)"),
                }
            }
            Self::UpdateSlide { slide, set } => format!("change slide {slide} {}", keys(set)),
            Self::MoveSlide { slide, after } => match after {
                Some(a) => format!("move slide {slide} after {a}"),
                None => format!("move slide {slide} first"),
            },
            Self::DeleteSlide { slide } => format!("delete slide {slide}"),
            Self::AddElement { slide, element, .. } => {
                let kind = element.get("kind").and_then(Value::as_str).unwrap_or("element");
                let id = element.get("id").and_then(Value::as_str).unwrap_or("new");
                format!("add {kind} {id} to {slide}")
            }
            Self::UpdateElement {
                slide,
                element,
                set,
            } => format!("change {element} on {slide} {}", keys(set)),
            Self::ReplaceText {
                slide,
                element,
                find,
                replace,
                ..
            } => format!(
                "replace {find:?} with {replace:?} on {slide}{}",
                element.as_ref().map(|e| format!(" in {e}")).unwrap_or_default()
            ),
            Self::ReorderElement { slide, element, to } => {
                let to = match to {
                    ZTarget::Named(s) => s.clone(),
                    ZTarget::Index(i) => format!("position {i}"),
                };
                format!("move {element} on {slide} to {to}")
            }
            Self::DeleteElement { slide, element } => format!("delete {element} from {slide}"),
        }
    }
}

fn keys(set: &Map<String, Value>) -> String {
    let k: Vec<&str> = set.keys().map(String::as_str).collect();
    format!("({})", k.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ops_serialize_exactly_as_the_architecture_says() {
        let req = EditRequest::new(vec![
            Op::AddSlide {
                after: None,
                slide: json!({"layout": "title"}),
            },
            Op::ReplaceText {
                slide: "s_abc123".into(),
                element: Some("e_123456".into()),
                field: None,
                find: "Helo".into(),
                replace: "Hello".into(),
                all: false,
            },
            Op::ReorderElement {
                slide: "s_abc123".into(),
                element: "e_123456".into(),
                to: ZTarget::Named("front".into()),
            },
        ])
        .on(41)
        .summary("Fix typo");
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(
            v,
            json!({"base": 41, "summary": "Fix typo", "ops": [
                {"op": "add_slide", "after": null, "slide": {"layout": "title"}},
                {"op": "replace_text", "slide": "s_abc123", "element": "e_123456", "find": "Helo", "replace": "Hello"},
                {"op": "reorder_element", "slide": "s_abc123", "element": "e_123456", "to": "front"}
            ]})
        );
        let back: EditRequest = serde_json::from_value(v).unwrap();
        assert_eq!(back, req);
    }
}
