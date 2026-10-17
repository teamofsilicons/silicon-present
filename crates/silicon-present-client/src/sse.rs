//! Server-sent event streams: a deck's live changes (`/v1/decks/{id}/live`) and a
//! presentation (`/v1/presentations/{p}/live`).

use crate::{Error, Result};
use serde_json::Value;

/// One server-sent event.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    /// The event name (`sync`, `update`, `presence`, `presence_left`, `comments`, `deck`, `ping`,
    /// `state`, `ended`); `message` when the service sent none.
    pub event: String,
    /// The data lines, joined with newlines.
    pub data: String,
    /// The event id, if any.
    pub id: Option<String>,
}

impl Event {
    /// The data parsed as JSON (`Value::Null` when it is empty, a string when it is not JSON).
    pub fn json(&self) -> Value {
        if self.data.trim().is_empty() {
            return Value::Null;
        }
        serde_json::from_str(&self.data).unwrap_or_else(|_| Value::String(self.data.clone()))
    }
}

/// Splits a byte stream into events. Feed it chunks; it hands back complete events.
#[derive(Debug, Default)]
pub struct Parser {
    buf: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
    id: Option<String>,
}

impl Parser {
    /// Adds bytes and returns every event they complete.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<Event> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=nl).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line).into_owned();
            if line.is_empty() {
                if !self.data.is_empty() || self.event.is_some() {
                    out.push(Event {
                        event: self.event.take().unwrap_or_else(|| "message".into()),
                        data: std::mem::take(&mut self.data).join("\n"),
                        id: self.id.clone(),
                    });
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f.to_owned(), v.strip_prefix(' ').unwrap_or(v).to_owned()),
                None => (line.clone(), String::new()),
            };
            match field.as_str() {
                "event" => self.event = Some(value),
                "data" => self.data.push(value),
                "id" => self.id = Some(value),
                _ => {}
            }
        }
        out
    }
}

/// A live stream from the service. Read it with [`EventStream::next`]; `None` means the
/// service ended the stream (reconnect to continue: a proxy ends streams after 5 minutes).
#[derive(Debug)]
pub struct EventStream {
    response: reqwest::Response,
    parser: Parser,
    pending: std::collections::VecDeque<Event>,
    url: String,
}

impl EventStream {
    pub(crate) fn new(response: reqwest::Response, url: String) -> Self {
        Self {
            response,
            parser: Parser::default(),
            pending: std::collections::VecDeque::new(),
            url,
        }
    }

    /// The next event, or `None` when the stream ended.
    pub async fn next(&mut self) -> Result<Option<Event>> {
        loop {
            if let Some(e) = self.pending.pop_front() {
                return Ok(Some(e));
            }
            match self.response.chunk().await {
                Ok(Some(bytes)) => self.pending.extend(self.parser.feed(&bytes)),
                Ok(None) => return Ok(None),
                Err(e) => {
                    return Err(Error::Transport {
                        url: self.url.clone(),
                        message: format!("the live stream broke: {e}"),
                        hint: "Reconnect; nothing is lost, the first event after reconnecting catches up.".into(),
                        timeout: e.is_timeout(),
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_split_across_chunks_come_out_whole() {
        let mut p = Parser::default();
        assert!(p.feed(b"event: sync\ndata: {\"ver").is_empty());
        let out = p.feed(b"sion\":3}\n\n: keepalive\n\nevent: ping\ndata:\r\n\r\ndata: a\ndata: b\n\n");
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].event, "sync");
        assert_eq!(out[0].json()["version"], 3);
        assert_eq!(out[1].event, "ping");
        assert_eq!(out[2].event, "message");
        assert_eq!(out[2].data, "a\nb");
    }
}
