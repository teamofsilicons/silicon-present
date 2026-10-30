//! The Silicon Present API client: immutable configuration, one request per call, no stored
//! session. Every method maps to one route in `docs/architecture.md`.

use crate::models::{
    Access, Account, Anchor, Asset, Comment, Deck, Download, EditOutcome, Folder, Member,
    Presentation, PublicMode, ResourceKind, Role, Thread, Transfer, Transfers, Version, list_from, one_from,
};
use crate::ops::EditRequest;
use crate::sse::EventStream;
use crate::{Error, Result, Secret};
use base64::Engine as _;
use reqwest::{Method, RequestBuilder};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::time::Duration;
use url::Url;

/// The public bearer-token API. The web's `/api` proxy requires a sealed browser session.
/// Routes are `{api}/v1/...`.
pub const DEFAULT_API_URL: &str = "https://backend.present.teamofsilicons.com";
const MAX_BODY: usize = 512 * 1024 * 1024;

/// How long ordinary calls may take.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// Renders, exports and imports run a browser or LibreOffice behind the service.
const FILE_TIMEOUT: Duration = Duration::from_secs(600);

/// A Silicon Present API client. `with_*` methods return a new client, so one base client can
/// serve many accounts.
#[derive(Clone, Debug)]
pub struct Client {
    http: reqwest::Client,
    base: Url,
    token: Option<Secret>,
    replace_em_dashes: bool,
}

/// Which decks to list.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Scope {
    /// Your own decks.
    #[default]
    Mine,
    /// Decks and folders shared with you.
    Shared,
    /// Your trash.
    Trash,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Mine => "mine",
            Self::Shared => "shared",
            Self::Trash => "trash",
        }
    }
}

/// How a new deck starts.
#[derive(Clone, Debug, Default, Serialize)]
pub struct NewDeck {
    /// Title (the service picks "Untitled deck" when empty).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The folder to create it in (yours or one shared with you as editor).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Start from another deck at a version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<FromVersion>,
}

/// A deck at a version, to start a new deck from.
#[derive(Clone, Debug, Serialize)]
pub struct FromVersion {
    /// The deck id.
    pub deck: String,
    /// The version (`None` = current).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
}

/// Presence: where someone is in a deck.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Presence {
    /// A session id the caller picks, stable while it stays.
    pub session: String,
    /// The slide they are on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slide: Option<String>,
    /// Selected element ids.
    pub selection: Vec<String>,
    /// Cursor in slide px.
    pub cursor: Option<Value>,
}

/// Options for a slide render.
#[derive(Clone, Debug, Default)]
pub struct RenderOptions {
    /// `png` (default) or `jpg`.
    pub format: Option<String>,
    /// Width in pixels (default 1920).
    pub width: Option<u32>,
    /// The version to render (default current).
    pub version: Option<u64>,
    /// How long HTML elements run before the picture is taken, in ms (default 1500).
    pub at: Option<u64>,
}

impl Client {
    /// A client for the API at `api_url` (the service itself, e.g. `http://127.0.0.1:4321`, or
    /// the public `https://backend.present.teamofsilicons.com`). HTTPS is required; plain HTTP only
    /// for this machine. No network call.
    pub fn new(api_url: &str) -> Result<Self> {
        let base = parse_base(api_url)?;
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent(concat!("silicon-present-client/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| Error::Invalid {
                message: format!("could not set up HTTP: {e}"),
                hint: None,
            })?;
        Ok(Self {
            http,
            base,
            token: None,
            replace_em_dashes: false,
        })
    }

    /// Opt in to replacing em dashes in outgoing authored text. The CLI enables this
    /// for Silicon accounts unless its explicit override is present; SDK default is off.
    pub fn with_em_dash_replacement(mut self, enabled: bool) -> Self {
        self.replace_em_dashes = enabled;
        self
    }

    /// Whether this client rewrites authored em dashes (useful for retry journals).
    pub fn replaces_em_dashes(&self) -> bool { self.replace_em_dashes }

    fn writing_body(&self, body: &impl Serialize) -> Value {
        let mut value = serde_json::to_value(body).expect("request bodies serialize");
        if self.replace_em_dashes { crate::writing::normalize(&mut value); }
        value
    }

    /// The API base this client calls, without a trailing slash.
    pub fn api_url(&self) -> &str {
        self.base.as_str().trim_end_matches('/')
    }

    /// Signs every request with a Silicon Accounts access token issued to `present`.
    #[must_use]
    pub fn with_token(&self, access_token: Secret) -> Self {
        let mut next = self.clone();
        let t = access_token.expose().trim().to_owned();
        next.token = (!t.is_empty()).then(|| Secret::new(t));
        next
    }

    /// The same client without a token (public decks).
    #[must_use]
    pub fn anonymous(&self) -> Self {
        let mut next = self.clone();
        next.token = None;
        next
    }

    /// True when requests carry a token.
    pub fn is_signed_in(&self) -> bool {
        self.token.is_some()
    }

    /// The full URL for a path of segments under `v1/`.
    pub fn url(&self, segments: &[&str]) -> Url {
        let mut url = self.base.clone();
        {
            let mut p = url
                .path_segments_mut()
                .unwrap_or_else(|()| unreachable!("http(s) URLs always have a path"));
            p.pop_if_empty();
            p.push("v1");
            for s in segments {
                p.push(s);
            }
        }
        url
    }

    fn request(&self, method: Method, url: Url) -> RequestBuilder {
        let mut r = self
            .http
            .request(method, url)
            .header("accept", "application/json")
            .timeout(CALL_TIMEOUT);
        if let Some(t) = &self.token {
            r = r.bearer_auth(t.expose());
        }
        r
    }

    async fn send(&self, req: RequestBuilder, url: &Url) -> Result<reqwest::Response> {
        let resp = req.send().await.map_err(|e| transport(url, &e))?;
        let status = resp.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(resp);
        }
        let request_id = resp
            .headers()
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = resp.bytes().await.unwrap_or_default();
        Err(Error::from_response(status, &body, request_id))
    }

    async fn bytes(&self, req: RequestBuilder, url: &Url) -> Result<(Vec<u8>, reqwest::header::HeaderMap)> {
        let resp = self.send(req, url).await?;
        let headers = resp.headers().clone();
        if resp.content_length().is_some_and(|n| n as usize > MAX_BODY) {
            return Err(Error::Decode {
                message: format!("the answer from {url} is larger than {} MiB", MAX_BODY / 1024 / 1024),
                hint: "Ask for less (one slide, a smaller width).".into(),
            });
        }
        let body = resp.bytes().await.map_err(|e| transport(url, &e))?;
        Ok((body.to_vec(), headers))
    }

    async fn value(&self, req: RequestBuilder, url: &Url) -> Result<Value> {
        let (body, _) = self.bytes(req, url).await?;
        if body.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&body).map_err(|e| Error::Decode {
            message: format!(
                "Silicon Present at {url} answered with something that is not JSON ({e}): {}",
                String::from_utf8_lossy(&body).chars().take(160).collect::<String>()
            ),
            hint: "Check the API URL (--api-url / PRESENT_API_URL) points at Silicon Present.".into(),
        })
    }

    async fn typed<T: DeserializeOwned>(&self, req: RequestBuilder, url: &Url, key: &str) -> Result<T> {
        let v = one_from(self.value(req, url).await?, key);
        decode(v, url)
    }

    async fn typed_list<T: DeserializeOwned>(&self, req: RequestBuilder, url: &Url, keys: &[&str]) -> Result<Vec<T>> {
        let v = list_from(self.value(req, url).await?, keys);
        decode(v, url)
    }

    /// `GET` any `v1` path and return the JSON as it came (for routes newer than this client).
    pub async fn get_json(&self, segments: &[&str], query: &[(&str, String)]) -> Result<Value> {
        let url = self.url(segments);
        self.value(self.request(Method::GET, url.clone()).query(query), &url).await
    }

    /// Send any JSON body to any `v1` path and return the JSON as it came.
    pub async fn send_json(&self, method: Method, segments: &[&str], body: Option<&Value>) -> Result<Value> {
        let url = self.url(segments);
        let mut req = self.request(method, url.clone());
        if let Some(b) = body {
            req = req.json(&self.writing_body(b));
        }
        self.value(req, &url).await
    }

    // ---- accounts --------------------------------------------------------------------------

    /// `GET /v1/me`: who the token belongs to, as Silicon Present sees them.
    pub async fn me(&self) -> Result<Account> {
        let url = self.url(&["me"]);
        self.typed(self.request(Method::GET, url.clone()), &url, "account").await
    }

    /// `GET /v1/accounts/resolve?q=`: a Carbon or Silicon by `c:id`, `si:id`, uuid or email.
    pub async fn resolve_account(&self, q: &str) -> Result<Account> {
        let url = self.url(&["accounts", "resolve"]);
        self.typed(self.request(Method::GET, url.clone()).query(&[("q", q)]), &url, "account").await
    }

    /// `GET /v1/search?q=`: every deck you can view whose title, slide text, notes or tables match.
    pub async fn search(&self, q: &str) -> Result<Vec<Value>> {
        let url = self.url(&["search"]);
        let v = list_from(
            self.value(self.request(Method::GET, url.clone()).query(&[("q", q)]), &url).await?,
            &["results", "hits", "decks"],
        );
        decode(v, &url)
    }

    // ---- decks -----------------------------------------------------------------------------

    /// `GET /v1/decks?scope=&folder=`.
    pub async fn decks(&self, scope: Scope, folder: Option<&str>) -> Result<Vec<Deck>> {
        let url = self.url(&["decks"]);
        let mut q = vec![("scope", scope.as_str().to_owned())];
        if let Some(f) = folder {
            q.push(("folder", f.to_owned()));
        }
        self.typed_list(self.request(Method::GET, url.clone()).query(&q), &url, &["decks"]).await
    }

    /// `GET /v1/decks?scope=...` as raw JSON (decks and folders together when the service sends both).
    pub async fn decks_raw(&self, scope: Scope, folder: Option<&str>) -> Result<Value> {
        let mut q = vec![("scope", scope.as_str().to_owned())];
        if let Some(f) = folder {
            q.push(("folder", f.to_owned()));
        }
        self.get_json(&["decks"], &q).await
    }

    /// `POST /v1/decks`.
    pub async fn create_deck(&self, new: &NewDeck) -> Result<Deck> {
        let url = self.url(&["decks"]);
        self.typed(self.request(Method::POST, url.clone()).json(&self.writing_body(new)), &url, "deck").await
    }

    /// `GET /v1/decks/{id}`.
    pub async fn deck(&self, id: &str) -> Result<Deck> {
        let url = self.url(&["decks", id]);
        self.typed(self.request(Method::GET, url.clone()), &url, "deck").await
    }

    /// `PATCH /v1/decks/{id}` with `title` and/or `folder` (`Some(None)` moves it out of folders).
    pub async fn update_deck(&self, id: &str, title: Option<&str>, folder: Option<Option<&str>>) -> Result<Deck> {
        let url = self.url(&["decks", id]);
        let mut body = json!({});
        if let Some(t) = title {
            body["title"] = json!(t);
        }
        if let Some(f) = folder {
            body["folder"] = json!(f);
        }
        self.typed(self.request(Method::PATCH, url.clone()).json(&self.writing_body(&body)), &url, "deck").await
    }

    /// `DELETE /v1/decks/{id}`: to the trash, with its whole history.
    pub async fn trash_deck(&self, id: &str) -> Result<Value> {
        let url = self.url(&["decks", id]);
        self.value(self.request(Method::DELETE, url.clone()), &url).await
    }

    /// `POST /v1/decks/{id}/untrash`.
    pub async fn untrash_deck(&self, id: &str) -> Result<Value> {
        let url = self.url(&["decks", id, "untrash"]);
        self.value(self.request(Method::POST, url.clone()), &url).await
    }

    /// `DELETE /v1/decks/{id}?permanent=true&confirm=<title>`: gone for good. Only from the
    /// trash, owner only, and `confirm` must be the deck's exact title.
    pub async fn delete_deck_permanently(&self, id: &str, confirm_title: &str) -> Result<Value> {
        let url = self.url(&["decks", id]);
        let req = self
            .request(Method::DELETE, url.clone())
            .query(&[("permanent", "true"), ("confirm", confirm_title)]);
        self.value(req, &url).await
    }

    /// `GET /v1/decks/{id}/content?format=json&version=`: the deck JSON.
    pub async fn content(&self, id: &str, version: Option<u64>) -> Result<Value> {
        let url = self.url(&["decks", id, "content"]);
        let mut q = vec![("format", "json".to_owned())];
        if let Some(v) = version {
            q.push(("version", v.to_string()));
        }
        let v = self.value(self.request(Method::GET, url.clone()).query(&q), &url).await?;
        // Accept `{deck: {...}}` as well as the deck itself.
        Ok(match v {
            Value::Object(ref m) if !m.contains_key("slides") && m.get("deck").is_some_and(Value::is_object) => {
                m["deck"].clone()
            }
            v => v,
        })
    }

    /// `GET /v1/decks/{id}/content?format=text`: the deck as text to read (with `comments`,
    /// threads next to what they're on).
    pub async fn content_text(&self, id: &str, version: Option<u64>, comments: bool) -> Result<String> {
        let url = self.url(&["decks", id, "content"]);
        let mut q = vec![("format", "text".to_owned())];
        if let Some(v) = version {
            q.push(("version", v.to_string()));
        }
        q.push(("comments", comments.to_string()));
        let req = self.request(Method::GET, url.clone()).query(&q).header("accept", "text/plain");
        let (body, headers) = self.bytes(req, &url).await?;
        let ct = headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        if ct.contains("json")
            && let Ok(v) = serde_json::from_slice::<Value>(&body)
            && let Some(t) = v.get("text").and_then(Value::as_str)
        {
            return Ok(t.to_owned());
        }
        Ok(String::from_utf8_lossy(&body).into_owned())
    }

    /// `POST /v1/decks/{id}/edits`: one transaction of edit ops.
    pub async fn edit(&self, id: &str, request: &EditRequest) -> Result<EditOutcome> {
        let url = self.url(&["decks", id, "edits"]);
        self.typed(self.request(Method::POST, url.clone()).json(&self.writing_body(request)), &url, "edit").await
    }

    /// Retry one edit safely using the same key and identical request body.
    pub async fn edit_idempotent(&self, id: &str, request: &EditRequest, key: &str) -> Result<EditOutcome> {
        let url = self.url(&["decks", id, "edits"]);
        self.typed(self.request(Method::POST, url.clone()).header("Idempotency-Key", key).json(&self.writing_body(request)), &url, "edit").await
    }

    /// `POST /v1/decks/{id}/updates`: applies a raw Yjs update (editors only).
    pub async fn apply_update(&self, id: &str, update: &[u8], session: &str) -> Result<Value> {
        let url = self.url(&["decks", id, "updates"]);
        let body = json!({
            "update": base64::engine::general_purpose::STANDARD.encode(update),
            "session": session,
        });
        self.value(self.request(Method::POST, url.clone()).json(&self.writing_body(&body)), &url).await
    }

    /// `POST /v1/decks/{id}/presence`: shows you on a slide; expires after 30 s without another.
    pub async fn presence(&self, id: &str, presence: &Presence) -> Result<Value> {
        let url = self.url(&["decks", id, "presence"]);
        self.value(self.request(Method::POST, url.clone()).json(presence), &url).await
    }

    /// `GET /v1/decks/{id}/live?sv=`: the live stream of changes, presence and comments.
    /// `state_vector` is the Yjs state vector you already have (none = everything).
    /// `session` ties a presence heartbeat to the stream: it is removed when the stream ends.
    pub async fn live(&self, id: &str, state_vector: Option<&[u8]>, session: Option<&str>) -> Result<EventStream> {
        let url = self.url(&["decks", id, "live"]);
        let mut req = self
            .request(Method::GET, url.clone())
            .header("accept", "text/event-stream")
            .timeout(Duration::from_secs(24 * 3600));
        if let Some(sv) = state_vector {
            req = req.query(&[("sv", base64::engine::general_purpose::STANDARD.encode(sv))]);
        }
        if let Some(s) = session {
            req = req.query(&[("session", s)]);
        }
        let resp = self.send(req, &url).await?;
        Ok(EventStream::new(resp, url.to_string()))
    }

    /// `GET /v1/decks/{id}/events`: renames, moves, sharing changes, trash, restores, resolves.
    pub async fn events(&self, id: &str) -> Result<Vec<Value>> {
        let v = self.get_json(&["decks", id, "events"], &[]).await?;
        let url = self.url(&["decks", id, "events"]);
        decode(list_from(v, &["events"]), &url)
    }

    // ---- folders ---------------------------------------------------------------------------

    /// `GET /v1/folders?scope=&parent=`.
    pub async fn folders(&self, scope: Scope, parent: Option<&str>) -> Result<Vec<Folder>> {
        let url = self.url(&["folders"]);
        let mut q = vec![("scope", scope.as_str().to_owned())];
        if let Some(p) = parent {
            q.push(("parent", p.to_owned()));
        }
        self.typed_list(self.request(Method::GET, url.clone()).query(&q), &url, &["folders"]).await
    }

    /// `POST /v1/folders`.
    pub async fn create_folder(&self, name: &str, parent: Option<&str>) -> Result<Folder> {
        let url = self.url(&["folders"]);
        let body = json!({ "name": name, "parent": parent });
        self.typed(self.request(Method::POST, url.clone()).json(&self.writing_body(&body)), &url, "folder").await
    }

    /// `GET /v1/folders/{id}`.
    pub async fn folder(&self, id: &str) -> Result<Folder> {
        let url = self.url(&["folders", id]);
        self.typed(self.request(Method::GET, url.clone()), &url, "folder").await
    }

    /// `PATCH /v1/folders/{id}` with `name` and/or `parent` (`Some(None)` = top level).
    pub async fn update_folder(&self, id: &str, name: Option<&str>, parent: Option<Option<&str>>) -> Result<Folder> {
        let url = self.url(&["folders", id]);
        let mut body = json!({});
        if let Some(n) = name {
            body["name"] = json!(n);
        }
        if let Some(p) = parent {
            body["parent"] = json!(p);
        }
        self.typed(self.request(Method::PATCH, url.clone()).json(&self.writing_body(&body)), &url, "folder").await
    }

    /// `DELETE /v1/folders/{id}`: to the trash with everything in it.
    pub async fn trash_folder(&self, id: &str) -> Result<Value> {
        let url = self.url(&["folders", id]);
        self.value(self.request(Method::DELETE, url.clone()), &url).await
    }

    /// `POST /v1/folders/{id}/untrash`.
    pub async fn untrash_folder(&self, id: &str) -> Result<Value> {
        let url = self.url(&["folders", id, "untrash"]);
        self.value(self.request(Method::POST, url.clone()), &url).await
    }

    /// `DELETE /v1/folders/{id}?permanent=true&confirm=<name>`.
    pub async fn delete_folder_permanently(&self, id: &str, confirm_name: &str) -> Result<Value> {
        let url = self.url(&["folders", id]);
        let req = self
            .request(Method::DELETE, url.clone())
            .query(&[("permanent", "true"), ("confirm", confirm_name)]);
        self.value(req, &url).await
    }

    // ---- sharing ---------------------------------------------------------------------------

    /// `GET /v1/{decks|folders}/{id}/access`.
    pub async fn access(&self, kind: ResourceKind, id: &str) -> Result<Access> {
        let url = self.url(&[kind.collection(), id, "access"]);
        let v = self.value(self.request(Method::GET, url.clone()), &url).await?;
        let v = match v {
            Value::Array(_) => json!({ "members": v }),
            v => one_from(v, "access"),
        };
        decode(v, &url)
    }

    /// `POST /v1/{decks|folders}/{id}/access`: invite `c:id`, `si:id` or an email.
    pub async fn share(&self, kind: ResourceKind, id: &str, to: &str, role: Role) -> Result<Member> {
        let url = self.url(&[kind.collection(), id, "access"]);
        let body = json!({ "to": to, "role": role.as_str() });
        self.typed(self.request(Method::POST, url.clone()).json(&self.writing_body(&body)), &url, "member").await
    }

    /// `PATCH /v1/{decks|folders}/{id}/access/{member}`: change a role.
    pub async fn change_role(&self, kind: ResourceKind, id: &str, member: &str, role: Role) -> Result<Value> {
        let url = self.url(&[kind.collection(), id, "access", member]);
        let body = json!({ "role": role.as_str() });
        self.value(self.request(Method::PATCH, url.clone()).json(&self.writing_body(&body)), &url).await
    }

    /// `DELETE /v1/{decks|folders}/{id}/access/{member}`.
    pub async fn unshare(&self, kind: ResourceKind, id: &str, member: &str) -> Result<Value> {
        let url = self.url(&[kind.collection(), id, "access", member]);
        self.value(self.request(Method::DELETE, url.clone()), &url).await
    }

    /// `PUT /v1/decks/{id}/public`.
    pub async fn set_public(&self, id: &str, mode: PublicMode) -> Result<Value> {
        let url = self.url(&["decks", id, "public"]);
        let body = json!({ "mode": mode.as_str() });
        self.value(self.request(Method::PUT, url.clone()).json(&self.writing_body(&body)), &url).await
    }

    // ---- transfers -------------------------------------------------------------------------

    /// `POST /v1/{decks|folders}/{id}/transfer`: offer it to someone; they must accept.
    pub async fn transfer(&self, kind: ResourceKind, id: &str, to: &str) -> Result<Transfer> {
        let url = self.url(&[kind.collection(), id, "transfer"]);
        let body = json!({ "to": to });
        self.typed(self.request(Method::POST, url.clone()).json(&self.writing_body(&body)), &url, "transfer").await
    }

    /// `GET /v1/transfers?state=pending|all`: offered to you and by you.
    pub async fn transfers(&self, all: bool) -> Result<Transfers> {
        let url = self.url(&["transfers"]);
        let req = self.request(Method::GET, url.clone()).query(&[("state", if all { "all" } else { "pending" })]);
        let v = self.value(req, &url).await?;
        let v = match v {
            Value::Array(_) => json!({ "incoming": v }),
            v => v,
        };
        decode(v, &url)
    }

    /// `POST /v1/transfers/{id}/{accept|decline|cancel}`.
    pub async fn answer_transfer(&self, id: &str, action: &str) -> Result<Value> {
        if !matches!(action, "accept" | "decline" | "cancel") {
            return Err(Error::invalid(
                format!("`{action}` is not a transfer action"),
                "Use accept, decline or cancel.",
            ));
        }
        let url = self.url(&["transfers", id, action]);
        self.value(self.request(Method::POST, url.clone()), &url).await
    }

    // ---- versions --------------------------------------------------------------------------

    /// `GET /v1/decks/{id}/versions`: newest first.
    pub async fn versions(&self, id: &str) -> Result<Vec<Version>> {
        let url = self.url(&["decks", id, "versions"]);
        self.typed_list(self.request(Method::GET, url.clone()), &url, &["versions"]).await
    }

    /// `GET /v1/decks/{id}/versions` as raw JSON (versions and events as the service sends them).
    pub async fn versions_raw(&self, id: &str) -> Result<Value> {
        self.get_json(&["decks", id, "versions"], &[]).await
    }

    /// `POST /v1/decks/{id}/versions/{n}/name`.
    pub async fn name_version(&self, id: &str, version: u64, name: &str) -> Result<Value> {
        let v = version.to_string();
        let url = self.url(&["decks", id, "versions", &v, "name"]);
        let body = json!({ "name": name });
        self.value(self.request(Method::POST, url.clone()).json(&self.writing_body(&body)), &url).await
    }

    /// `GET /v1/decks/{id}/compare?from=&to=`: slides and elements added, removed and changed.
    pub async fn compare(&self, id: &str, from: u64, to: u64) -> Result<Value> {
        self.get_json(&["decks", id, "compare"], &[("from", from.to_string()), ("to", to.to_string())])
            .await
    }

    /// `POST /v1/decks/{id}/restore`: the whole deck, one slide, or one element as it was.
    pub async fn restore(&self, id: &str, version: u64, slide: Option<&str>, element: Option<&str>) -> Result<Value> {
        let url = self.url(&["decks", id, "restore"]);
        let mut body = json!({ "version": version });
        if let Some(s) = slide {
            body["slide"] = json!(s);
        }
        if let Some(e) = element {
            body["element"] = json!(e);
        }
        self.value(self.request(Method::POST, url.clone()).json(&self.writing_body(&body)), &url).await
    }

    /// `POST /v1/decks/{id}/undo-account`: undo everything one Carbon or Silicon changed since a version.
    pub async fn undo_account(&self, id: &str, account: &str, since: u64) -> Result<Value> {
        let url = self.url(&["decks", id, "undo-account"]);
        let body = json!({ "account": account, "since": since });
        self.value(self.request(Method::POST, url.clone()).json(&self.writing_body(&body)), &url).await
    }

    // ---- comments --------------------------------------------------------------------------

    /// `GET /v1/decks/{id}/threads?state=open|resolved|all`.
    pub async fn threads(&self, id: &str, state: &str) -> Result<Vec<Thread>> {
        let url = self.url(&["decks", id, "threads"]);
        self.typed_list(
            self.request(Method::GET, url.clone()).query(&[("state", state)]),
            &url,
            &["threads"],
        )
        .await
    }

    /// `POST /v1/decks/{id}/threads`: a new comment on the deck, a slide or part of one.
    pub async fn comment(&self, id: &str, anchor: &Anchor, body: &str) -> Result<Thread> {
        let url = self.url(&["decks", id, "threads"]);
        let req = json!({ "anchor": anchor, "body": body });
        self.typed(self.request(Method::POST, url.clone()).json(&self.writing_body(&req)), &url, "thread").await
    }

    /// `POST /v1/threads/{t}/replies`.
    pub async fn reply(&self, thread: &str, body: &str) -> Result<Comment> {
        let url = self.url(&["threads", thread, "replies"]);
        let req = json!({ "body": body });
        self.typed(self.request(Method::POST, url.clone()).json(&self.writing_body(&req)), &url, "comment").await
    }

    /// `POST /v1/threads/{t}/resolve`.
    pub async fn resolve(&self, thread: &str) -> Result<Value> {
        let url = self.url(&["threads", thread, "resolve"]);
        self.value(self.request(Method::POST, url.clone()), &url).await
    }

    /// `POST /v1/threads/{t}/reopen`.
    pub async fn reopen(&self, thread: &str) -> Result<Value> {
        let url = self.url(&["threads", thread, "reopen"]);
        self.value(self.request(Method::POST, url.clone()), &url).await
    }

    /// `PATCH /v1/comments/{c}`.
    pub async fn edit_comment(&self, comment: &str, body: &str) -> Result<Value> {
        let url = self.url(&["comments", comment]);
        let req = json!({ "body": body });
        self.value(self.request(Method::PATCH, url.clone()).json(&self.writing_body(&req)), &url).await
    }

    /// `DELETE /v1/comments/{c}` (kept in the history).
    pub async fn delete_comment(&self, comment: &str) -> Result<Value> {
        let url = self.url(&["comments", comment]);
        self.value(self.request(Method::DELETE, url.clone()), &url).await
    }

    /// `PUT /v1/comments/{c}/reactions/{emoji}` (or `DELETE` with `remove`).
    pub async fn react(&self, comment: &str, emoji: &str, remove: bool) -> Result<Value> {
        let url = self.url(&["comments", comment, "reactions", emoji]);
        let m = if remove { Method::DELETE } else { Method::PUT };
        self.value(self.request(m, url.clone()), &url).await
    }

    // ---- files -----------------------------------------------------------------------------

    /// `POST /v1/imports`: a new deck from any supported file (pptx, ppt, key, odp, pdf, html,
    /// images, video, audio).
    pub async fn import(&self, filename: &str, content_type: &str, bytes: Vec<u8>, folder: Option<&str>) -> Result<Deck> {
        let url = self.url(&["imports"]);
        let mut req = self.upload(url.clone(), filename, content_type, bytes);
        if let Some(f) = folder {
            req = req.query(&[("folder", f)]);
        }
        self.typed(req, &url, "deck").await
    }

    /// `POST /v1/decks/{id}/imports`: opens a file on top of a deck as its next version.
    pub async fn import_into(&self, id: &str, filename: &str, content_type: &str, bytes: Vec<u8>) -> Result<Value> {
        let url = self.url(&["decks", id, "imports"]);
        let req = self.upload(url.clone(), filename, content_type, bytes);
        self.value(req, &url).await
    }

    /// `POST /v1/decks/{id}/assets`: uploads an image, video, audio, font or other asset.
    pub async fn upload_asset(&self, id: &str, filename: &str, content_type: &str, bytes: Vec<u8>) -> Result<Asset> {
        let url = self.url(&["decks", id, "assets"]);
        let req = self.upload(url.clone(), filename, content_type, bytes);
        self.typed(req, &url, "asset").await
    }

    /// `GET /v1/assets/{id}`.
    pub async fn download_asset(&self, asset: &str) -> Result<Download> {
        let url = self.url(&["assets", asset]);
        self.download(self.request(Method::GET, url.clone()), &url).await
    }

    /// `GET /v1/decks/{id}/export?format=&version=&slide=`.
    pub async fn export(&self, id: &str, format: &str, version: Option<u64>, slide: Option<&str>) -> Result<Download> {
        let url = self.url(&["decks", id, "export"]);
        let mut q = vec![("format", format.to_owned())];
        if let Some(v) = version {
            q.push(("version", v.to_string()));
        }
        if let Some(s) = slide {
            q.push(("slide", s.to_owned()));
        }
        let req = self.request(Method::GET, url.clone()).query(&q).timeout(FILE_TIMEOUT);
        self.download(req, &url).await
    }

    /// `GET /v1/decks/{id}/slides/{slide}/render`: one slide as an image, as a Carbon sees it.
    pub async fn render(&self, id: &str, slide: &str, opts: &RenderOptions) -> Result<Download> {
        let url = self.url(&["decks", id, "slides", slide, "render"]);
        let mut q = vec![("format", opts.format.clone().unwrap_or_else(|| "png".into()))];
        if let Some(w) = opts.width {
            q.push(("width", w.to_string()));
        }
        if let Some(v) = opts.version {
            q.push(("version", v.to_string()));
        }
        if let Some(a) = opts.at {
            q.push(("at", a.to_string()));
        }
        let req = self.request(Method::GET, url.clone()).query(&q).timeout(FILE_TIMEOUT);
        self.download(req, &url).await
    }

    fn upload(&self, url: Url, filename: &str, content_type: &str, bytes: Vec<u8>) -> RequestBuilder {
        // X-Filename is percent-encoded so any file name survives the header.
        let name: String = url::form_urlencoded::byte_serialize(filename.as_bytes()).collect::<String>().replace('+', "%20");
        self.request(Method::POST, url)
            .header("content-type", content_type)
            .header("x-filename", name)
            .timeout(FILE_TIMEOUT)
            .body(bytes)
    }

    async fn download(&self, req: RequestBuilder, url: &Url) -> Result<Download> {
        let (bytes, headers) = self.bytes(req, url).await?;
        let content_type = headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_owned();
        let filename = headers
            .get("content-disposition")
            .and_then(|v| v.to_str().ok())
            .and_then(filename_from_disposition);
        Ok(Download {
            bytes,
            content_type,
            filename,
        })
    }

    // ---- presenting ------------------------------------------------------------------------

    /// `POST /v1/decks/{id}/presentations`: start presenting; share the `followUrl`.
    pub async fn start_presentation(&self, id: &str, slide: Option<&str>) -> Result<Presentation> {
        let url = self.url(&["decks", id, "presentations"]);
        let body = match slide {
            Some(s) => json!({ "slide": s }),
            None => json!({}),
        };
        self.typed(self.request(Method::POST, url.clone()).json(&self.writing_body(&body)), &url, "presentation").await
    }

    /// `GET /v1/decks/{id}/presentations`: presentations of a deck running now.
    pub async fn presentations(&self, id: &str) -> Result<Vec<Presentation>> {
        let url = self.url(&["decks", id, "presentations"]);
        self.typed_list(self.request(Method::GET, url.clone()), &url, &["presentations"]).await
    }

    /// `GET /v1/presentations/{p}`.
    pub async fn presentation(&self, id: &str) -> Result<Presentation> {
        let url = self.url(&["presentations", id]);
        self.typed(self.request(Method::GET, url.clone()), &url, "presentation").await
    }

    /// `PUT /v1/presentations/{p}`: move to a slide and step (presenter only).
    pub async fn move_presentation(&self, id: &str, slide: &Value, step: u64) -> Result<Presentation> {
        let url = self.url(&["presentations", id]);
        let body = json!({ "slide": slide, "step": step });
        self.typed(self.request(Method::PUT, url.clone()).json(&self.writing_body(&body)), &url, "presentation").await
    }

    /// `DELETE /v1/presentations/{p}`: stop.
    pub async fn stop_presentation(&self, id: &str) -> Result<Value> {
        let url = self.url(&["presentations", id]);
        self.value(self.request(Method::DELETE, url.clone()), &url).await
    }

    /// `GET /v1/presentations/{p}/live`: `state` events as the presenter moves, `ended` at the end.
    pub async fn follow_presentation(&self, id: &str) -> Result<EventStream> {
        let url = self.url(&["presentations", id, "live"]);
        let req = self
            .request(Method::GET, url.clone())
            .header("accept", "text/event-stream")
            .timeout(Duration::from_secs(24 * 3600));
        let resp = self.send(req, &url).await?;
        Ok(EventStream::new(resp, url.to_string()))
    }

    // ---- themes ----------------------------------------------------------------------------

    /// `GET /v1/themes`: your own themes, by name.
    pub async fn themes(&self) -> Result<Vec<Value>> {
        let v = self.get_json(&["themes"], &[]).await?;
        Ok(v["themes"].as_array().cloned().unwrap_or_default())
    }

    /// `POST /v1/themes`: save a deck's current theme (it needs editor access) as one of your themes.
    pub async fn save_theme(&self, deck: &str, name: Option<&str>) -> Result<Value> {
        self.send_json(Method::POST, &["themes"], Some(&json!({ "deck": deck, "name": name }))).await
    }

    /// `PATCH /v1/themes/{id}`: rename a theme, or change its fonts or colours (`changes` holds `name`, `fonts`, `colors`).
    pub async fn update_theme(&self, id: &str, changes: &Value) -> Result<Value> {
        self.send_json(Method::PATCH, &["themes", id], Some(changes)).await
    }

    /// `DELETE /v1/themes/{id}`.
    pub async fn delete_theme(&self, id: &str) -> Result<Value> {
        self.send_json(Method::DELETE, &["themes", id], None).await
    }

    /// `POST /v1/themes/{id}/use`: copies the theme's fonts into the deck and returns `{ theme }`, ready to set as the
    /// deck's theme with an `update_deck` op.
    pub async fn use_theme(&self, id: &str, deck: &str) -> Result<Value> {
        self.send_json(Method::POST, &["themes", id, "use"], Some(&json!({ "deck": deck }))).await
    }

    // ---- reports ---------------------------------------------------------------------------

    /// `POST /v1/reports`: a bug report to the Silicon Present team, with an optional pull request.
    pub async fn report(&self, message: &str, pr: Option<&str>, context: Value) -> Result<Value> {
        let url = self.url(&["reports"]);
        let body = json!({ "message": message, "pr": pr, "context": context });
        self.value(self.request(Method::POST, url.clone()).json(&self.writing_body(&body)), &url).await
    }
}

fn decode<T: DeserializeOwned>(v: Value, url: &Url) -> Result<T> {
    serde_json::from_value(v.clone()).map_err(|e| Error::Decode {
        message: format!(
            "Silicon Present at {url} answered with JSON this client does not understand ({e}): {}",
            v.to_string().chars().take(200).collect::<String>()
        ),
        hint: "Update the present CLI, or report it with `present report`.".into(),
    })
}

fn transport(url: &Url, e: &reqwest::Error) -> Error {
    let mut message = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        message = format!("{message}: {s}");
        source = s.source();
    }
    Error::Transport {
        url: url.to_string(),
        message,
        hint: "Check the network and the API URL (--api-url / PRESENT_API_URL), then retry.".into(),
        timeout: e.is_timeout(),
    }
}

/// `attachment; filename="Q4 review.pptx"; filename*=UTF-8''Q4%20review.pptx` → `Q4 review.pptx`.
pub fn filename_from_disposition(v: &str) -> Option<String> {
    let mut plain = None;
    for part in v.split(';').map(str::trim) {
        if let Some(rest) = part.strip_prefix("filename*=") {
            let encoded = rest.split("''").nth(1).unwrap_or(rest);
            let decoded: String = url::form_urlencoded::parse(format!("x={}", encoded.replace('+', "%2B")).as_bytes())
                .next()
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            if !decoded.is_empty() {
                return Some(decoded);
            }
        } else if let Some(rest) = part.strip_prefix("filename=") {
            plain = Some(rest.trim_matches('"').to_owned());
        }
    }
    plain.filter(|s| !s.is_empty())
}

/// Parses an API base: https anywhere, http only on this machine.
pub fn parse_base(raw: &str) -> Result<Url> {
    let bad = || {
        Error::invalid(
            format!("the API URL `{raw}` is not usable"),
            format!("Use an https URL such as {DEFAULT_API_URL} (plain http only for localhost, 127.0.0.1 or ::1), e.g. --api-url http://127.0.0.1:4321."),
        )
    };
    let url = Url::parse(raw.trim()).map_err(|_| bad())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        _ => return Err(bad()),
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(bad());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_keep_the_base_path_and_encode_segments() {
        let c = Client::new("https://api.example.test/present").unwrap();
        assert_eq!(
            c.url(&["comments", "abc", "reactions", "👍"]).as_str(),
            "https://api.example.test/present/v1/comments/abc/reactions/%F0%9F%91%8D"
        );
        let c = Client::new("http://127.0.0.1:4351/").unwrap();
        assert_eq!(c.url(&["decks"]).as_str(), "http://127.0.0.1:4351/v1/decks");
        assert!(Client::new("http://example.com").is_err());
    }

    #[test]
    fn public_default_calls_the_bearer_api_directly() {
        let client = Client::new(DEFAULT_API_URL).unwrap();
        assert_eq!(client.url(&["decks"]).as_str(), "https://backend.present.teamofsilicons.com/v1/decks");
    }

    #[test]
    fn content_disposition_names_are_read() {
        assert_eq!(
            filename_from_disposition("attachment; filename=\"Q4.pptx\"; filename*=UTF-8''Q4%20review.pptx").as_deref(),
            Some("Q4 review.pptx")
        );
        assert_eq!(filename_from_disposition("attachment; filename=\"a.pdf\"").as_deref(), Some("a.pdf"));
        assert_eq!(filename_from_disposition("inline"), None);
    }
}
