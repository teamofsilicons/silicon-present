//! Shared state: config, database, the Accounts/Ting/converter adapters, live rooms and presentations.

use std::collections::{HashMap, HashSet};
use std::ops::Deref;
use std::sync::Arc;
use std::time::Instant;

use sqlx::PgPool;
use tokio::sync::{Mutex, Notify, broadcast};
use uuid::Uuid;

use crate::accounts::AccountsDirectory;
use crate::auth::TokenVerifier;
use crate::config::Config;
use crate::converter::Converter;
use crate::rooms::{LiveMsg, Rooms};
use crate::tings::TingSender;

/// The adapters the service talks to the outside world through (fakes in tests).
pub struct Deps {
    pub verifier: Arc<dyn TokenVerifier>,
    pub directory: Arc<dyn AccountsDirectory>,
    pub ting: Option<Arc<dyn TingSender>>,
    pub converter: Option<Arc<dyn Converter>>,
}

pub struct Inner {
    pub cfg: Config,
    pub pool: PgPool,
    pub http: reqwest::Client,
    pub verifier: Arc<dyn TokenVerifier>,
    pub directory: Arc<dyn AccountsDirectory>,
    pub ting: Option<Arc<dyn TingSender>>,
    pub converter: Option<Arc<dyn Converter>>,
    pub rooms: Rooms,
    /// Live followers of each running presentation.
    pub presentations: Mutex<HashMap<String, broadcast::Sender<LiveMsg>>>,
    /// Automatic version summaries, by (deck, first seq, last seq).
    pub summaries: Mutex<HashMap<(String, i64, i64), String>>,
    /// When each account's token was last seen (to refresh the cache at most once a minute).
    pub seen: Mutex<HashMap<Uuid, Instant>>,
    pub refreshing: Mutex<HashSet<Uuid>>,
    pub enrolling: Mutex<HashSet<Uuid>>,
    pub ting_notify: Notify,
    /// Key for signed asset URLs handed to the converter.
    pub asset_key: Vec<u8>,
}

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

impl Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(cfg: Config, pool: PgPool, deps: Deps) -> Self {
        use hmac::{Hmac, Mac};
        let mut mac = Hmac::<sha2::Sha256>::new_from_slice(cfg.app_secret.as_bytes()).expect("any key length works");
        mac.update(b"silicon-present asset urls");
        let asset_key = mac.finalize().into_bytes().to_vec();
        AppState(Arc::new(Inner {
            cfg,
            pool,
            http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build().expect("http client"),
            verifier: deps.verifier,
            directory: deps.directory,
            ting: deps.ting,
            converter: deps.converter,
            rooms: Rooms::default(),
            presentations: Mutex::new(HashMap::new()),
            summaries: Mutex::new(HashMap::new()),
            seen: Mutex::new(HashMap::new()),
            refreshing: Mutex::new(HashSet::new()),
            enrolling: Mutex::new(HashSet::new()),
            ting_notify: Notify::new(),
            asset_key,
        }))
    }

    pub fn deck_link(&self, deck: &str) -> String {
        format!("{}/decks/{}", self.cfg.web_url, deck)
    }

    pub fn folder_link(&self, folder: &str) -> String {
        format!("{}/decks?folder={}", self.cfg.web_url, folder)
    }
}
