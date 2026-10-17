//! What the service sends and accepts, typed.
//!
//! Every model keeps the fields this client does not know about in `extra`, so a newer service
//! never loses data on the way through (the CLI prints models back as JSON whole). Field names
//! are camelCase on the wire; snake_case spellings are accepted too.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Fields this client does not model, kept as they came.
pub type Extra = Map<String, Value>;

/// Reads a string that may be `null` (a deleted comment's body, an account without a name).
fn de_str<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

/// A Carbon or Silicon as Silicon Present shows them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Permanent Silicon Accounts uuid.
    #[serde(default, deserialize_with = "de_str")]
    pub uuid: String,
    /// Current public id: `c:ada` or `si:designer`.
    #[serde(default, deserialize_with = "de_str")]
    pub id: String,
    /// `carbon` or `silicon`.
    #[serde(default, deserialize_with = "de_str")]
    pub kind: String,
    /// Display name (may be empty).
    #[serde(default, deserialize_with = "de_str", alias = "display_name")]
    pub display_name: String,
    /// Profile photo URL.
    #[serde(default, alias = "pfp_url", skip_serializing_if = "Option::is_none")]
    pub pfp_url: Option<String>,
    /// Everything else.
    #[serde(flatten)]
    pub extra: Extra,
}

impl Account {
    /// `c:ada` when known, else the uuid.
    pub fn label(&self) -> &str {
        if self.id.is_empty() { &self.uuid } else { &self.id }
    }
}

/// A deck as listed: metadata, not content.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deck {
    /// 12-character id.
    pub id: String,
    /// Title.
    #[serde(default, deserialize_with = "de_str")]
    pub title: String,
    /// Who it belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<Account>,
    /// Who created it (differs from the owner inside someone else's folder).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator: Option<Account>,
    /// The folder it is in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Public mode: `off`, `view`, `comment` or `edit`.
    #[serde(default, alias = "public_mode", alias = "publicMode", skip_serializing_if = "Option::is_none")]
    pub public: Option<String>,
    /// The caller's role: `owner`, `editor`, `commenter` or `viewer`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// When it went to the trash (RFC 3339), if it is there.
    #[serde(default, alias = "trashed_at", skip_serializing_if = "Option::is_none")]
    pub trashed_at: Option<String>,
    /// Created (RFC 3339).
    #[serde(default, alias = "created_at", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Last changed (RFC 3339).
    #[serde(default, alias = "updated_at", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Current content version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
    /// Everything else.
    #[serde(flatten)]
    pub extra: Extra,
}

/// A folder.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    /// 12-character id.
    pub id: String,
    /// Name.
    #[serde(default, deserialize_with = "de_str")]
    pub name: String,
    /// Who it belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<Account>,
    /// Who created it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator: Option<Account>,
    /// The folder it is in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// The caller's role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// When it went to the trash.
    #[serde(default, alias = "trashed_at", skip_serializing_if = "Option::is_none")]
    pub trashed_at: Option<String>,
    /// Created.
    #[serde(default, alias = "created_at", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Everything else.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Which kind of thing is shared, moved or transferred.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceKind {
    /// A deck.
    Deck,
    /// A folder.
    Folder,
}

impl ResourceKind {
    /// The URL collection: `decks` or `folders`.
    pub fn collection(self) -> &'static str {
        match self {
            Self::Deck => "decks",
            Self::Folder => "folders",
        }
    }
}

/// A role someone is invited with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Can edit, comment and invite others.
    Editor,
    /// Can view and comment.
    Commenter,
    /// Can only view.
    Viewer,
}

impl Role {
    /// `editor`, `commenter` or `viewer`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Editor => "editor",
            Self::Commenter => "commenter",
            Self::Viewer => "viewer",
        }
    }
}

/// Public mode of a deck.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PublicMode {
    /// Private: the link stops working.
    Off,
    /// Anyone with the link can view, without signing in.
    View,
    /// Anyone signed in with the link can comment.
    Comment,
    /// Anyone signed in with the link can edit.
    Edit,
}

impl PublicMode {
    /// `off`, `view`, `comment` or `edit`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::View => "view",
            Self::Comment => "comment",
            Self::Edit => "edit",
        }
    }
}

/// One person with access to a deck or folder.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    /// The account (absent for a pending email invite).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<Account>,
    /// The invited email, for a pending invite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// `editor`, `commenter`, `viewer` (or `owner`).
    #[serde(default, deserialize_with = "de_str")]
    pub role: String,
    /// Who invited them.
    #[serde(default, alias = "invited_by", skip_serializing_if = "Option::is_none")]
    pub invited_by: Option<Account>,
    /// The member key to change or remove them with: an account uuid or `email:<address>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<String>,
    /// Everything else (for example the folder access comes through).
    #[serde(flatten)]
    pub extra: Extra,
}

impl Member {
    /// The key for `PATCH|DELETE .../access/{member}`.
    pub fn key(&self) -> Option<String> {
        if let Some(m) = &self.member {
            return Some(m.clone());
        }
        if let Some(a) = &self.account
            && !a.uuid.is_empty()
        {
            return Some(a.uuid.clone());
        }
        self.email.as_ref().map(|e| format!("email:{e}"))
    }
}

/// Who can reach a deck or folder.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    /// The owner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<Account>,
    /// Everyone invited, directly or through a folder.
    #[serde(default)]
    pub members: Vec<Member>,
    /// Public mode (decks).
    #[serde(default, alias = "public_mode", alias = "publicMode", skip_serializing_if = "Option::is_none")]
    pub public: Option<String>,
    /// Everything else.
    #[serde(flatten)]
    pub extra: Extra,
}

/// A transfer of a deck or folder, waiting for the receiver to accept.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    /// 12-character id.
    pub id: String,
    /// What moves: `{ "kind": "deck"|"folder", "id", "name" }`.
    #[serde(default)]
    pub resource: Value,
    /// Who is giving it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<Account>,
    /// Who is asked to take it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<Account>,
    /// `pending`, `accepted`, `declined` or `cancelled`.
    #[serde(default, deserialize_with = "de_str", alias = "status")]
    pub state: String,
    /// Everything else.
    #[serde(flatten)]
    pub extra: Extra,
}

impl Transfer {
    fn resource_field(&self, key: &str) -> String {
        match &self.resource {
            Value::Object(o) => o.get(key).and_then(Value::as_str).unwrap_or_default().to_owned(),
            Value::String(s) if key == "id" => s.clone(),
            _ => String::new(),
        }
    }
    /// `deck` or `folder`.
    pub fn kind(&self) -> String {
        self.resource_field("kind")
    }
    /// The deck or folder id.
    pub fn resource_id(&self) -> String {
        self.resource_field("id")
    }
    /// Its title or name.
    pub fn name(&self) -> String {
        self.resource_field("name")
    }
}

/// Transfers offered to you and by you.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Transfers {
    /// Offered to you.
    #[serde(default)]
    pub incoming: Vec<Transfer>,
    /// Offered by you.
    #[serde(default)]
    pub outgoing: Vec<Transfer>,
}

/// One version: a run of changes by the same Carbon or Silicon.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    /// The version number (the last update in the run); open the deck at it with `version=N`.
    #[serde(default, alias = "seq", alias = "to")]
    pub version: u64,
    /// The first update in the run.
    #[serde(default, alias = "from_version", alias = "fromVersion", skip_serializing_if = "Option::is_none")]
    pub from: Option<u64>,
    /// Who made it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<Account>,
    /// When the run started.
    #[serde(default, alias = "started_at", skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// When the run ended.
    #[serde(default, alias = "ended_at", skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    /// What changed, e.g. "si:designer changed slide 4".
    #[serde(default, deserialize_with = "de_str")]
    pub summary: String,
    /// The name someone gave it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// What changed, without the author ("changed slide 4").
    #[serde(default, deserialize_with = "de_str", skip_serializing_if = "String::is_empty")]
    pub change: String,
    /// Everything else.
    #[serde(flatten)]
    pub extra: Extra,
}

/// One comment in a thread.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    /// 12-character id.
    pub id: String,
    /// Who wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<Account>,
    /// Plain text with `@c:id` / `@si:id` mentions.
    #[serde(default, deserialize_with = "de_str")]
    pub body: String,
    /// Written (RFC 3339).
    #[serde(default, alias = "created_at", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Last edited.
    #[serde(default, alias = "edited_at", skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<String>,
    /// Deleted comments stay in the history.
    #[serde(default)]
    pub deleted: bool,
    /// Reactions, as the service sends them.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub reactions: Value,
    /// Everything else.
    #[serde(flatten)]
    pub extra: Extra,
}

/// A comment thread and where it is anchored.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    /// 12-character id.
    pub id: String,
    /// What it is on (see [`Anchor`]), plus the `snapshot` taken when it was made.
    #[serde(default)]
    pub anchor: Value,
    /// `open` or `resolved`.
    #[serde(default, deserialize_with = "de_str", alias = "status")]
    pub state: String,
    /// Who resolved it.
    #[serde(default, alias = "resolved_by", skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<Account>,
    /// The comments, first to last.
    #[serde(default)]
    pub comments: Vec<Comment>,
    /// Everything else.
    #[serde(flatten)]
    pub extra: Extra,
}

/// What a new comment is on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Anchor {
    /// The whole deck.
    Deck,
    /// A whole slide.
    Slide {
        /// Slide id.
        slide: String,
    },
    /// A point on a slide (slide px), optionally inside an element so it follows it.
    Point {
        /// Slide id.
        slide: String,
        /// x in slide px.
        x: f64,
        /// y in slide px.
        y: f64,
        /// The element under the point.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        element: Option<String>,
        /// 0..1 across the element.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ex: Option<f64>,
        /// 0..1 down the element.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ey: Option<f64>,
    },
    /// An area of a slide.
    Area {
        /// Slide id.
        slide: String,
        /// Left in slide px.
        x: f64,
        /// Top in slide px.
        y: f64,
        /// Width in slide px.
        w: f64,
        /// Height in slide px.
        h: f64,
        /// The element the area is on.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        element: Option<String>,
        /// 0..1 inside the element.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ex: Option<f64>,
        /// 0..1 inside the element.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ey: Option<f64>,
        /// 0..1 of the element's width.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ew: Option<f64>,
        /// 0..1 of the element's height.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        eh: Option<f64>,
    },
    /// An element (including an HTML element).
    Element {
        /// Slide id.
        slide: String,
        /// Element id.
        element: String,
    },
    /// Some text inside an element, a table cell or the notes.
    Text {
        /// Slide id.
        slide: String,
        /// Element id (ignored for notes).
        element: String,
        /// `text`, `cell:r:c` or `notes`.
        field: String,
        /// The exact passage.
        quote: String,
    },
}

/// An uploaded asset.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    /// 12-character id; reference it as `asset:<id>`.
    pub id: String,
    /// Where to download it.
    #[serde(default, deserialize_with = "de_str")]
    pub url: String,
    /// MIME type.
    #[serde(default, deserialize_with = "de_str", alias = "content_type")]
    pub content_type: String,
    /// Bytes.
    #[serde(default)]
    pub size: u64,
    /// Everything else.
    #[serde(flatten)]
    pub extra: Extra,
}

impl Asset {
    /// `asset:<id>`, the value for an element's `src`.
    pub fn reference(&self) -> String {
        format!("asset:{}", self.id)
    }
}

/// A presentation that can be followed live.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    /// 12-character id.
    pub id: String,
    /// The deck being presented.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deck: Option<Value>,
    /// The link to follow along.
    #[serde(default, deserialize_with = "de_str", alias = "follow_url")]
    pub follow_url: String,
    /// The slide being shown (id or number, as the service says).
    #[serde(default)]
    pub slide: Value,
    /// The animation step on that slide.
    #[serde(default)]
    pub step: u64,
    /// Who presents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presenter: Option<Account>,
    /// When it ended, if it did.
    #[serde(default, alias = "ended_at", skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    /// Everything else.
    #[serde(flatten)]
    pub extra: Extra,
}

impl Presentation {
    /// The deck id, whichever way the service sent it.
    pub fn deck_id(&self) -> Option<String> {
        match &self.deck {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Object(o)) => o.get("id").and_then(Value::as_str).map(str::to_owned),
            _ => self
                .extra
                .get("deckId")
                .or_else(|| self.extra.get("deck_id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    }
}

/// The result of an edit (`POST /v1/decks/{id}/edits`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    /// The deck's version after the edit.
    #[serde(default)]
    pub version: u64,
    /// Slides the edit touched.
    #[serde(default)]
    pub touched: Vec<String>,
    /// The history line for this change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Slides the edit added.
    #[serde(default, alias = "slides_added", skip_serializing_if = "Vec::is_empty")]
    pub slides_added: Vec<Value>,
    /// Elements the edit added: `{ slide, element }`.
    #[serde(default, alias = "elements_added", skip_serializing_if = "Vec::is_empty")]
    pub elements_added: Vec<Value>,
    /// How many passages `replace_text` ops replaced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacements: Option<Value>,
    /// Everything else.
    #[serde(flatten)]
    pub extra: Extra,
}

/// A file downloaded from the service: an export or a render.
#[derive(Clone, Debug)]
pub struct Download {
    /// The bytes.
    pub bytes: Vec<u8>,
    /// MIME type the service sent.
    pub content_type: String,
    /// The file name from `Content-Disposition`, if any.
    pub filename: Option<String>,
}

/// Pulls a list out of an answer that is either a bare array or an object holding one.
pub(crate) fn list_from(value: Value, keys: &[&str]) -> Value {
    match value {
        Value::Array(_) => value,
        Value::Object(mut map) => {
            for k in keys.iter().chain(["items", "results", "data"].iter()) {
                if let Some(v @ Value::Array(_)) = map.remove(*k) {
                    return v;
                }
            }
            map.into_iter()
                .find_map(|(_, v)| v.is_array().then_some(v))
                .unwrap_or(Value::Array(vec![]))
        }
        _ => Value::Array(vec![]),
    }
}

/// Pulls one object out of an answer that is either the object or `{key: object}`.
pub(crate) fn one_from(value: Value, key: &str) -> Value {
    match value {
        Value::Object(mut map) if !map.contains_key("id") && map.get(key).is_some_and(Value::is_object) => {
            map.remove(key).unwrap_or(Value::Null)
        }
        v => v,
    }
}
