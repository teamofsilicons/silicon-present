//! What every command gets: settings, the signed-in client, and small shared helpers.

use crate::fail::{Fail, R};
use crate::state::{Home, StoredSignIn};
use serde_json::Value;
use silicon_present_client::accounts::{self, SignIn, now};
use silicon_present_client::{Client, DEFAULT_API_URL, Scope, deck};

/// Settings and helpers for one run.
pub struct Ctx {
    /// Explicit override, scoped to this process rather than saved sign-in state.
    pub dangerously_use_em_dash: bool,
    /// Lets one command take a slide past the word limit (cmd/edit.rs).
    pub dangerously_add_long_text: bool,
    /// Print JSON.
    pub json: bool,
    /// The API base.
    pub api_url: String,
    /// Where the API URL came from.
    pub api_source: &'static str,
    /// The Silicon Accounts origin.
    pub accounts_url: String,
    /// Where the Accounts URL came from.
    pub accounts_source: &'static str,
    /// Where state lives.
    pub home: Home,
}

impl Ctx {
    /// Settles the URLs: flag or environment, then `present config`, then the default.
    pub fn new(json: bool, api_url: Option<String>, accounts_url: Option<String>) -> R<Self> {
        let home = Home::locate()?;
        let state = home.read().unwrap_or_default();
        let (api_url, api_source) = match api_url.filter(|s| !s.trim().is_empty()) {
            Some(u) => (u, "--api-url / PRESENT_API_URL"),
            None => match state.api_url {
                Some(u) => (u, "present config api-url"),
                None => (DEFAULT_API_URL.to_owned(), "default"),
            },
        };
        let (accounts_url, accounts_source) = match accounts_url.filter(|s| !s.trim().is_empty()) {
            Some(u) => (u, "--accounts-url / ACCOUNTS_URL"),
            None => match state.accounts_url {
                Some(u) => (u, "present config accounts-url"),
                None => (accounts::DEFAULT_ACCOUNTS_URL.to_owned(), "default"),
            },
        };
        Ok(Self {
            dangerously_use_em_dash: false,
            dangerously_add_long_text: false,
            json,
            api_url: api_url.trim().trim_end_matches('/').to_owned(),
            api_source,
            accounts_url: accounts_url.trim().trim_end_matches('/').to_owned(),
            accounts_source,
            home,
        })
    }

    /// A client without a token (public decks).
    pub fn client(&self) -> R<Client> {
        Ok(Client::new(&self.api_url)?)
    }

    /// Signs in to Present at this Silicon Accounts.
    pub fn sign_in(&self) -> R<SignIn> {
        Ok(SignIn::new(&self.accounts_url, accounts::APP_ID)?)
    }

    /// The saved sign-in, refreshed when under a minute is left. `None` when nobody is signed in.
    pub async fn session(&self) -> R<Option<StoredSignIn>> {
        let state = self.home.read()?;
        let Some(saved) = state.sign_ins.get(&self.accounts_url).cloned() else {
            return Ok(None);
        };
        if saved.expires_at - now() >= 60 {
            return Ok(Some(saved));
        }
        // Refresh under the lock; someone else may have refreshed meanwhile.
        let _lock = self.home.lock()?;
        let state = self.home.read()?;
        let Some(saved) = state.sign_ins.get(&self.accounts_url).cloned() else {
            return Ok(None);
        };
        if saved.expires_at - now() >= 60 {
            return Ok(Some(saved));
        }
        if saved.refresh_expires_at.is_some_and(|t| t <= now()) {
            return Err(self.ended("The sign-in ended (it lasts up to 900 days and then needs a fresh sign-in)."));
        }
        let signin = self.sign_in()?;
        match signin.refresh(&saved.refresh_token).await {
            Ok(t) => {
                let next = StoredSignIn {
                    access_token: t.access_token,
                    refresh_token: t.refresh_token,
                    expires_at: t.expires_at,
                    refresh_expires_at: t.refresh_expires_at.or(saved.refresh_expires_at),
                    scope: t.scope,
                    account: t.account,
                    ..saved
                };
                let key = self.accounts_url.clone();
                let stored = next.clone();
                write_unlocked(&self.home, move |s| {
                    s.sign_ins.insert(key, stored);
                })?;
                Ok(Some(next))
            }
            Err(e) if e.is_code("sign_in_ended") => {
                let key = self.accounts_url.clone();
                write_unlocked(&self.home, move |s| {
                    s.sign_ins.remove(&key);
                })?;
                Err(self.ended(&e.message()))
            }
            Err(e) => Err(e.into()),
        }
    }

    fn ended(&self, why: &str) -> Fail {
        Fail::new(
            "sign_in_ended",
            format!("Your Silicon Present sign-in is no longer valid: {why}"),
            format!("Sign in again: `{}` (Silicons) or `present login` (Carbons).", accounts::SILICON_SIGN_IN),
        )
    }

    /// A client signed in as the saved account; fails with what to do when nobody is.
    pub async fn authed(&self) -> R<Client> {
        match self.session().await? {
            Some(s) => Ok(self.client()?.with_token(s.access_token)
                .with_em_dash_replacement(s.account.kind == "silicon" && !self.dangerously_use_em_dash)),
            None => {
                let state = self.home.read()?;
                let other = state.sign_ins.keys().next().cloned();
                let mut hint = format!(
                    "Sign in first: `{}` (Silicons) or `present login` (Carbons).",
                    accounts::SILICON_SIGN_IN
                );
                if let Some(o) = other {
                    hint.push_str(&format!(" (There is a sign-in for another Silicon Accounts here, {o}; pass --accounts-url {o} to use it.)"));
                }
                Err(Fail::new(
                    "not_signed_in",
                    format!("Nobody is signed in to Silicon Present here ({}).", self.home.dir.display()),
                    hint,
                ))
            }
        }
    }

    /// Signed in when possible, else anonymous (reading public decks needs no sign-in).
    pub async fn maybe_authed(&self) -> R<Client> {
        match self.session().await {
            Ok(Some(s)) => Ok(self.client()?.with_token(s.access_token)
                .with_em_dash_replacement(s.account.kind == "silicon" && !self.dangerously_use_em_dash)),
            _ => self.client(),
        }
    }

    /// Resolves `<deck>`: an id, a link containing `/decks/<id>` (or `/d/<id>`), or an exact title.
    pub async fn deck_id(&self, c: &Client, r: &str) -> R<String> {
        let r = r.trim();
        if deck::is_resource_id(r) {
            return Ok(r.to_owned());
        }
        if r.contains('/') {
            let parts: Vec<&str> = r.split(['/', '?', '#']).collect();
            for w in parts.windows(2) {
                if matches!(w[0], "decks" | "d" | "deck") && deck::is_resource_id(w[1]) {
                    return Ok(w[1].to_owned());
                }
            }
        }
        if !c.is_signed_in() {
            return Err(Fail::new(
                "deck_not_found",
                format!("`{r}` is not a deck id or link, and finding a deck by title needs a sign-in."),
                "Pass the 12-character deck id (see `present list`) or sign in.",
            ));
        }
        let mut found = Vec::new();
        for scope in [Scope::Mine, Scope::Shared] {
            for d in c.decks(scope, None).await? {
                if d.title == r || d.title.eq_ignore_ascii_case(r) {
                    found.push(d);
                }
            }
        }
        match found.len() {
            1 => Ok(found.remove(0).id),
            0 => Err(Fail::new(
                "deck_not_found",
                format!("No deck you can see has the id or title `{r}`."),
                "List your decks with `present list` (and `present list --shared`), then pass the id.",
            )),
            n => Err(Fail::new(
                "deck_ambiguous",
                format!(
                    "{n} decks are titled `{r}`: {}.",
                    found.iter().map(|d| d.id.as_str()).collect::<Vec<_>>().join(", ")
                ),
                "Pass the id of the one you mean.",
            )),
        }
    }

    /// Finds a slide in deck JSON by number or id, with an error that lists what exists.
    pub fn slide_id(&self, content: &Value, sel: &str) -> R<String> {
        deck::find_slide(content, sel).map(|(_, id)| id).ok_or_else(|| {
            let n = deck::slides(content).len();
            Fail::new(
                "slide_not_found",
                format!("The deck has no slide `{sel}` (it has {n} slide{}).", if n == 1 { "" } else { "s" }),
                "Name a slide by number (1 = first) or id (s_…); see them with `present read <deck>`.",
            )
        })
    }

    /// Finds an element on a slide by id, z position or kind:n.
    pub fn element<'a>(&self, content: &'a Value, slide_id: &str, sel: &str) -> R<&'a Value> {
        let slide = deck::slide_by_id(content, slide_id).ok_or_else(|| {
            Fail::new("slide_not_found", format!("The deck has no slide {slide_id}."), "")
        })?;
        deck::find_element(slide, sel).ok_or_else(|| {
            let ids: Vec<String> = deck::elements(slide)
                .iter()
                .map(|e| {
                    format!(
                        "{} ({})",
                        deck::str_field(e, "id").unwrap_or("?"),
                        deck::str_field(e, "kind").unwrap_or("?")
                    )
                })
                .collect();
            Fail::new(
                "element_not_found",
                format!(
                    "Slide {slide_id} has no element `{sel}`. Its elements, back to front: {}.",
                    if ids.is_empty() { "none".into() } else { ids.join(", ") }
                ),
                "Name an element by id (e_…), z position (1 = back) or kind:n (text:2).",
            )
        })
    }

    /// Prints a JSON value on one line (with --json) or pretty.
    pub fn print_json(&self, v: &Value) {
        if self.json {
            println!("{}", serde_json::to_string(v).unwrap_or_default());
        } else {
            println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
        }
    }

    /// Prints JSON with --json, else the human text.
    pub fn out(&self, v: &Value, human: impl FnOnce() -> String) {
        if self.json {
            println!("{}", serde_json::to_string(v).unwrap_or_default());
        } else {
            let text = human();
            if !text.is_empty() {
                println!("{text}");
            }
        }
    }
}

/// Writes state while the caller already holds the lock.
fn write_unlocked(home: &Home, f: impl FnOnce(&mut crate::state::State)) -> R<()> {
    let mut state = home.read()?;
    f(&mut state);
    state.version = 1;
    let bytes = serde_json::to_vec_pretty(&state).map_err(|e| Fail::new("state_unwritable", e.to_string(), ""))?;
    crate::state::write_atomic(&home.dir.join("state.json"), &bytes)
}

/// A value as JSON, never failing.
pub fn to_value<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}
