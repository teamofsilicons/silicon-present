//! The CLI's one error type: what went wrong, why, and what to do. Never "something went wrong".

use serde_json::{Value, json};
use silicon_present_client::Error;

/// Result alias for commands.
pub type R<T> = Result<T, Fail>;

/// A failure the CLI reports and exits 1 on.
#[derive(Debug)]
pub struct Fail {
    /// Stable code (the service's when it came from the service).
    pub code: String,
    /// What happened and why.
    pub message: String,
    /// What to do next.
    pub hint: Option<String>,
    /// HTTP status, when the service answered.
    pub status: Option<u16>,
    /// The service's request id.
    pub request_id: Option<String>,
    /// Extra details from the service.
    pub details: Option<Value>,
}

impl Fail {
    /// A failure with a code, a message and a hint (empty hint = none).
    pub fn new(code: &str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        let hint = hint.into();
        Self {
            code: code.into(),
            message: message.into(),
            hint: (!hint.is_empty()).then_some(hint),
            status: None,
            request_id: None,
            details: None,
        }
    }

    /// A file system failure while doing `what`.
    pub fn io(what: &str, e: &std::io::Error) -> Self {
        let hint = match e.kind() {
            std::io::ErrorKind::NotFound => "Check the path exists.",
            std::io::ErrorKind::PermissionDenied => "Check you may read and write there.",
            _ => "",
        };
        Self::new("io_error", format!("Could not {what}: {e}."), hint)
    }

    /// Adds context in front of the message.
    #[must_use]
    pub fn context(mut self, what: &str) -> Self {
        self.message = format!("{what}: {}", self.message);
        self
    }

    /// The error as JSON: `{"error": {...}}`.
    pub fn to_json(&self) -> Value {
        let mut e = json!({ "code": self.code, "message": self.message });
        if let Some(h) = &self.hint {
            e["hint"] = json!(h);
        }
        if let Some(s) = self.status {
            e["status"] = json!(s);
        }
        if let Some(r) = &self.request_id {
            e["request_id"] = json!(r);
        }
        if let Some(d) = &self.details {
            e["details"] = d.clone();
        }
        json!({ "error": e })
    }

    /// The error for a terminal:
    /// ```text
    /// error[text_not_found]: No passage "Helo" on slide 2.
    ///   hint: Did you mean "Hello"?
    /// ```
    pub fn render(&self) -> String {
        let mut s = format!("error[{}]: {}", self.code, self.message);
        if let Some(st) = self.status {
            s.push_str(&format!(" (HTTP {st})"));
        }
        if let Some(d) = &self.details
            && let Some(obj) = d.as_object()
        {
            for (k, v) in obj {
                let v = v.as_str().map_or_else(|| v.to_string(), str::to_owned);
                s.push_str(&format!("\n  {k}: {v}"));
            }
        }
        if let Some(h) = &self.hint {
            s.push_str(&format!("\n  hint: {h}"));
        }
        if let Some(r) = &self.request_id {
            s.push_str(&format!("\n  request id: {r} (quote it in `present report`)"));
        }
        s
    }
}

impl From<Error> for Fail {
    fn from(e: Error) -> Self {
        let details = match &e {
            Error::Api { details, .. } => details.clone(),
            _ => None,
        };
        Self {
            code: e.code().to_owned(),
            message: e.message(),
            hint: e.hint().map(str::to_owned),
            status: e.status(),
            request_id: e.request_id().map(str::to_owned),
            details,
        }
    }
}
