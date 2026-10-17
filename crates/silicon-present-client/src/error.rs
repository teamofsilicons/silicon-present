//! Typed failures. Every error says what went wrong and why, and most say what to do next.

use serde_json::Value;

/// Result alias used throughout the crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Everything that can go wrong talking to Silicon Present or signing in with Silicon Accounts.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// Silicon Present answered with its error body `{"error":{"code","message","hint"}}`.
    #[error("{message} ({code}, HTTP {status}){}", hint_suffix(.hint.as_deref()))]
    Api {
        /// HTTP status.
        status: u16,
        /// Stable machine-readable code, e.g. `deck_not_found`, `text_not_found`.
        code: String,
        /// What went wrong and why.
        message: String,
        /// What to do next, when the service said.
        hint: Option<String>,
        /// The service's request id, to quote in a report.
        request_id: Option<String>,
        /// Anything else the error body carried.
        details: Option<Value>,
    },
    /// Silicon Accounts answered with an error, refused a sign-in, or could not be reached.
    #[error("{message}{}", hint_suffix(.hint.as_deref()))]
    Accounts {
        /// HTTP status, when Silicon Accounts answered.
        status: Option<u16>,
        /// Silicon Accounts' code (`invalid_grant`, `slt_already_used`, `connection_failed`, ...).
        code: String,
        /// What went wrong and why.
        message: String,
        /// What to do next.
        hint: Option<String>,
    },
    /// Silicon Present could not be reached (connection, DNS, TLS or timeout).
    #[error("Could not reach Silicon Present at {url}: {message}.{}", hint_suffix(Some(.hint)))]
    Transport {
        /// The URL that was called.
        url: String,
        /// What the network layer said.
        message: String,
        /// What to do next.
        hint: String,
        /// True when the request timed out.
        timeout: bool,
    },
    /// The service answered with something that is not what this client expects.
    #[error("{message}{}", hint_suffix(Some(.hint)))]
    Decode {
        /// What was wrong with the answer.
        message: String,
        /// What to do next.
        hint: String,
    },
    /// Input rejected before anything was sent.
    #[error("{message}{}", hint_suffix(.hint.as_deref()))]
    Invalid {
        /// What is wrong with the input.
        message: String,
        /// How to fix it.
        hint: Option<String>,
    },
}

fn hint_suffix(hint: Option<&str>) -> String {
    hint.filter(|h| !h.trim().is_empty())
        .map(|h| format!(" Hint: {h}"))
        .unwrap_or_default()
}

impl Error {
    /// Input rejected before anything was sent.
    pub fn invalid(message: impl Into<String>, hint: impl Into<String>) -> Self {
        let hint = hint.into();
        Self::Invalid {
            message: message.into(),
            hint: (!hint.is_empty()).then_some(hint),
        }
    }

    /// Stable machine-readable code.
    pub fn code(&self) -> &str {
        match self {
            Self::Api { code, .. } | Self::Accounts { code, .. } => code,
            Self::Transport { timeout: true, .. } => "request_timeout",
            Self::Transport { .. } => "connection_failed",
            Self::Decode { .. } => "unexpected_response",
            Self::Invalid { .. } => "invalid_input",
        }
    }

    /// What went wrong and why, without the hint.
    pub fn message(&self) -> String {
        match self {
            Self::Api { message, .. }
            | Self::Accounts { message, .. }
            | Self::Decode { message, .. }
            | Self::Invalid { message, .. } => message.clone(),
            Self::Transport { url, message, .. } => {
                format!("Could not reach Silicon Present at {url}: {message}.")
            }
        }
    }

    /// What to do next, when known.
    pub fn hint(&self) -> Option<&str> {
        match self {
            Self::Api { hint, .. } | Self::Accounts { hint, .. } | Self::Invalid { hint, .. } => {
                hint.as_deref()
            }
            Self::Transport { hint, .. } | Self::Decode { hint, .. } => Some(hint),
        }
    }

    /// HTTP status of the failed response, when there was one.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Api { status, .. } => Some(*status),
            Self::Accounts { status, .. } => *status,
            _ => None,
        }
    }

    /// The request id of the failed response, when there was one.
    pub fn request_id(&self) -> Option<&str> {
        match self {
            Self::Api { request_id, .. } => request_id.as_deref(),
            _ => None,
        }
    }

    /// True when the service answered with this code.
    pub fn is_code(&self, code: &str) -> bool {
        self.code() == code
    }

    /// True when the access token was missing, expired or refused (HTTP 401).
    pub fn is_unauthenticated(&self) -> bool {
        self.status() == Some(401)
    }

    /// True when the failure is passing (no answer, 5xx, 429) and a later retry may work.
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Transport { .. } => true,
            Self::Api { status, .. } => *status >= 500 || *status == 429,
            Self::Accounts { status, .. } => status.is_none_or(|s| s >= 500 || s == 429),
            _ => false,
        }
    }

    /// The error as one JSON object: `{"code","message","hint","status","request_id"}`.
    pub fn to_json(&self) -> Value {
        let mut out = serde_json::json!({
            "code": self.code(),
            "message": self.message(),
        });
        if let Some(hint) = self.hint() {
            out["hint"] = Value::String(hint.to_owned());
        }
        if let Some(status) = self.status() {
            out["status"] = Value::from(status);
        }
        if let Some(id) = self.request_id() {
            out["request_id"] = Value::String(id.to_owned());
        }
        if let Self::Api {
            details: Some(details),
            ..
        } = self
        {
            out["details"] = details.clone();
        }
        out
    }

    pub(crate) fn accounts(error: &silicon_accounts_client::Error) -> Self {
        Self::Accounts {
            status: error.status(),
            code: error.code().to_owned(),
            message: error.message(),
            hint: error.hint(),
        }
    }

    /// Builds the error for a non-2xx answer from its status and body.
    pub(crate) fn from_response(status: u16, body: &[u8], request_id: Option<String>) -> Self {
        let value: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
        if let Some(error) = value.get("error").and_then(Value::as_object) {
            let text = |k: &str| error.get(k).and_then(Value::as_str).map(str::to_owned);
            let mut details = error.clone();
            for k in ["code", "message", "hint", "request_id"] {
                details.remove(k);
            }
            return Self::Api {
                status,
                code: text("code").unwrap_or_else(|| default_code(status).to_owned()),
                message: text("message").unwrap_or_else(|| {
                    format!("Silicon Present answered HTTP {status} without saying why.")
                }),
                hint: text("hint").filter(|h| !h.is_empty()),
                request_id: request_id.or_else(|| text("request_id")),
                details: (!details.is_empty()).then_some(Value::Object(details)),
            };
        }
        let snippet: String = String::from_utf8_lossy(body)
            .chars()
            .take(200)
            .collect::<String>()
            .replace('\n', " ");
        Self::Api {
            status,
            code: default_code(status).to_owned(),
            message: if snippet.trim().is_empty() {
                format!("Silicon Present answered HTTP {status} with an empty body.")
            } else {
                format!(
                    "Silicon Present answered HTTP {status} with a body that is not its error format: {snippet}"
                )
            },
            hint: Some(match status {
                404 => "Check the API URL (--api-url / PRESENT_API_URL) points at Silicon Present, and that the id is right.".into(),
                502..=504 => "The service or a proxy in front of it is down or restarting; retry in a moment.".into(),
                _ => "Check the API URL (--api-url / PRESENT_API_URL) points at Silicon Present.".into(),
            }),
            request_id,
            details: None,
        }
    }
}

fn default_code(status: u16) -> &'static str {
    match status {
        400 => "bad_request",
        401 => "unauthenticated",
        403 => "forbidden",
        404 => "not_found",
        409 => "conflict",
        413 => "payload_too_large",
        422 => "invalid_input",
        429 => "rate_limited",
        500..=599 => "service_error",
        _ => "unexpected_response",
    }
}

#[cfg(test)]
mod tests {
    use super::Error;

    #[test]
    fn service_error_bodies_keep_code_message_and_hint() {
        let body = br#"{"error":{"code":"text_not_found","message":"No passage 'Helo' on slide 2.","hint":"Did you mean 'Hello'?","closest":"Hello"}}"#;
        let err = Error::from_response(422, body, Some("req_1".into()));
        assert_eq!(err.code(), "text_not_found");
        assert_eq!(err.message(), "No passage 'Helo' on slide 2.");
        assert_eq!(err.hint(), Some("Did you mean 'Hello'?"));
        assert_eq!(err.request_id(), Some("req_1"));
        assert_eq!(err.to_json()["details"]["closest"], "Hello");
        assert!(err.to_string().contains("Hint: Did you mean"));
    }

    #[test]
    fn foreign_bodies_still_say_what_came_back() {
        let err = Error::from_response(502, b"<html>Bad Gateway</html>", None);
        assert_eq!(err.code(), "service_error");
        assert!(err.message().contains("Bad Gateway"));
        assert!(err.is_transient());
    }
}
