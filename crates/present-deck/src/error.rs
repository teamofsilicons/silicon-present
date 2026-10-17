//! Errors from applying ops or reading a deck. Every one says what happened, why, and what to do.

use std::fmt;

/// An error with a stable code, a message saying what happened and why, and a hint saying what to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeckError {
    /// A stable snake_case code, e.g. `text_not_found`.
    pub code: &'static str,
    /// What happened and why.
    pub message: String,
    /// What to do about it.
    pub hint: String,
    /// The index of the op that failed, when it came from `apply_ops`.
    pub op_index: Option<usize>,
}

impl DeckError {
    pub fn new(code: &'static str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self { code, message: message.into(), hint: hint.into(), op_index: None }
    }

    pub(crate) fn at(mut self, index: usize) -> Self {
        self.op_index = Some(index);
        self.message = format!("Op {} failed: {}", index, self.message);
        self
    }

    pub(crate) fn slide_not_found(slide: &str) -> Self {
        Self::new(
            "slide_not_found",
            format!("There is no slide `{slide}` in this deck."),
            "Read the deck again (`present read`) to see the current slide ids; it may have been deleted.",
        )
    }

    pub(crate) fn element_not_found(slide: &str, element: &str) -> Self {
        Self::new(
            "element_not_found",
            format!("There is no element `{element}` on slide `{slide}`."),
            "Read the deck again (`present read`) to see the current element ids; it may have been deleted or moved.",
        )
    }

    pub(crate) fn invalid(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new("invalid_op", message, hint)
    }
}

impl fmt::Display for DeckError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message, self.hint)
    }
}

impl std::error::Error for DeckError {}
