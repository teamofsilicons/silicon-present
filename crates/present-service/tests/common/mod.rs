//! Test harness: a throwaway database on the dev cluster (5490), a real token verifier against a JWKS served by
//! the test (Ed25519 key generated here), fake Accounts directory / Ting / converter, the service on a random port,
//! an HTTP helper and a Yjs live client speaking SSE + POST.
#![allow(dead_code)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::EncodePrivateKey;
use present_service::accounts::{AccountsDirectory, DirAccount, Profile};
use present_service::converter::{ConvertedFile, Converter};
use present_service::error::ApiError;
use present_service::tings::{OutgoingTing, SendFailure, TingSender};
use present_service::{AppState, Config, Deps};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

pub const ADMIN_URL: &str = "postgres://present@127.0.0.1:5490/postgres";
pub const ISSUER: &str = "http://accounts.test";

static COUNTER: AtomicUsize = AtomicUsize::new(0);

pub fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}
pub fn unb64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

// ---------------------------------------------------------------- fakes

#[derive(Default)]
pub struct FakeDirectory {
    pub accounts: Mutex<Vec<(DirAccount, Option<Profile>)>>,
}

impl FakeDirectory {
    pub fn add(&self, handle: &str, profile: Option<Profile>) -> Uuid {
        let uuid = Uuid::new_v4();
        let kind = if handle.starts_with("si:") {
            "silicon"
        } else {
            "carbon"
        };
        self.accounts.lock().unwrap().push((
            DirAccount {
                uuid,
                handle: handle.into(),
                kind: kind.into(),
            },
            profile,
        ));
        uuid
    }
    pub fn rename(&self, uuid: Uuid, handle: &str) {
        for (a, _) in self.accounts.lock().unwrap().iter_mut() {
            if a.uuid == uuid {
                a.handle = handle.to_string();
            }
        }
    }

    pub fn set_profile(&self, uuid: Uuid, profile: Profile) {
        for (a, p) in self.accounts.lock().unwrap().iter_mut() {
            if a.uuid == uuid {
                *p = Some(profile.clone());
            }
        }
    }
}

#[async_trait]
impl AccountsDirectory for FakeDirectory {
    async fn lookup(&self, q: &str) -> Result<Option<DirAccount>, ApiError> {
        let q = q.to_lowercase();
        Ok(self
            .accounts
            .lock()
            .unwrap()
            .iter()
            .find(|(a, _)| a.uuid.to_string() == q || a.handle == q)
            .map(|(a, _)| a.clone()))
    }
    async fn profile(&self, uuid: Uuid) -> Result<Option<Profile>, ApiError> {
        Ok(self
            .accounts
            .lock()
            .unwrap()
            .iter()
            .find(|(a, _)| a.uuid == uuid)
            .and_then(|(_, p)| p.clone()))
    }
}

#[derive(Default)]
pub struct FakeTing {
    pub sent: Mutex<Vec<OutgoingTing>>,
    pub enrolled: Mutex<Vec<Uuid>>,
    pub fail_next: AtomicUsize,
}

#[async_trait]
impl TingSender for FakeTing {
    async fn enrol(&self, account: Uuid, _token: &str) -> Result<(), SendFailure> {
        self.enrolled.lock().unwrap().push(account);
        Ok(())
    }
    async fn send(&self, ting: &OutgoingTing) -> Result<(), SendFailure> {
        if self.fail_next.load(Ordering::SeqCst) > 0 {
            self.fail_next.fetch_sub(1, Ordering::SeqCst);
            return Err(SendFailure {
                retryable: true,
                message: "fake outage".into(),
            });
        }
        self.sent.lock().unwrap().push(ting.clone());
        Ok(())
    }
}

#[derive(Default)]
pub struct FakeConverter {
    pub calls: Mutex<Vec<(String, Value)>>,
}

pub const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 13, 10, 26, 10, 0, 0, 0, 0];

#[async_trait]
impl Converter for FakeConverter {
    async fn render(&self, body: Value) -> Result<ConvertedFile, ApiError> {
        self.calls.lock().unwrap().push(("render".into(), body));
        Ok(ConvertedFile {
            bytes: PNG.to_vec().into(),
            content_type: "image/png".into(),
            ext: None,
        })
    }
    async fn export(&self, body: Value) -> Result<ConvertedFile, ApiError> {
        let format = body["format"].as_str().unwrap_or("").to_string();
        let one_slide = body["slide"].is_string();
        self.calls.lock().unwrap().push(("export".into(), body));
        // Like the real converter: png/jpg of a whole deck is a zip, of one named slide the image itself.
        if one_slide && (format == "png" || format == "jpg") {
            return Ok(ConvertedFile {
                bytes: PNG.to_vec().into(),
                content_type: if format == "png" {
                    "image/png".into()
                } else {
                    "image/jpeg".into()
                },
                ext: None,
            });
        }
        let ct = match format.as_str() {
            "pdf" => "application/pdf",
            "txt" => "text/plain; charset=utf-8",
            "svg" => "image/svg+xml",
            "png" | "jpg" => "application/zip",
            _ => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        };
        Ok(ConvertedFile {
            bytes: format!("FILE:{format}").into_bytes().into(),
            content_type: ct.into(),
            ext: None,
        })
    }
    async fn import(&self, body: Value) -> Result<Value, ApiError> {
        self.calls
            .lock()
            .unwrap()
            .push(("import".into(), body.clone()));
        Ok(json!({
            "deck": { "title": "Imported deck", "slides": [
                { "layout": "title", "notes": "imported notes", "elements": [
                    { "kind": "text", "text": "From a file" },
                    { "kind": "image", "src": "asset:img1", "alt": "logo" } ] } ] },
            "assets": [ { "key": "img1", "filename": "logo.png", "contentType": "image/png", "data": b64(PNG) } ]
        }))
    }
}

// ---------------------------------------------------------------- tokens

pub struct Keys {
    pub encoding: jsonwebtoken::EncodingKey,
    pub jwks: Value,
}

pub fn keys() -> Keys {
    let mut secret = [0u8; 32];
    rand::Rng::fill(&mut rand::rng(), &mut secret);
    let sk = SigningKey::from_bytes(&secret);
    let der = sk.to_pkcs8_der().unwrap();
    let x = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sk.verifying_key().as_bytes());
    Keys {
        encoding: jsonwebtoken::EncodingKey::from_ed_der(der.as_bytes()),
        jwks: json!({ "keys": [ { "kty": "OKP", "crv": "Ed25519", "x": x, "kid": "test-key", "alg": "EdDSA", "use": "sig" } ] }),
    }
}

// ---------------------------------------------------------------- the stack

pub struct Person {
    pub uuid: Uuid,
    pub handle: String,
    pub token: String,
}

pub struct Stack {
    pub url: String,
    pub db_name: String,
    pub pool: sqlx::PgPool,
    pub state: AppState,
    pub directory: Arc<FakeDirectory>,
    pub ting: Arc<FakeTing>,
    pub converter: Arc<FakeConverter>,
    pub http: reqwest::Client,
    keys: Arc<Keys>,
    data_dir: std::path::PathBuf,
    server: tokio::task::JoinHandle<()>,
}

async fn serve_jwks(jwks: Value) -> String {
    let app = axum::Router::new().route(
        "/.well-known/jwks.json",
        axum::routing::get(move || {
            let j = jwks.clone();
            async move { axum::Json(j) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

impl Stack {
    pub async fn start() -> Stack {
        Self::start_with(true, true).await
    }

    pub async fn start_with(ting: bool, converter: bool) -> Stack {
        Self::start_full(ting, converter, None).await
    }

    /// `real_converter`: use this converter instead of the fake one.
    pub async fn start_full(
        ting: bool,
        converter: bool,
        real_converter: Option<Arc<dyn Converter>>,
    ) -> Stack {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let db_name = format!(
            "present_t_{}_{}_{}",
            std::process::id(),
            n,
            rand::random::<u32>()
        );
        let admin = sqlx::PgPool::connect(ADMIN_URL)
            .await
            .expect("the dev cluster on 5490 must be running (scripts/dev-db.sh start)");
        if n == 0 {
            sweep_stale_databases(&admin).await;
        }
        sqlx::query(sqlx::AssertSqlSafe(format!("create database {db_name}")))
            .execute(&admin)
            .await
            .unwrap();
        admin.close().await;
        let database_url = format!("postgres://present@127.0.0.1:5490/{db_name}");
        let pool = present_service::connect(&database_url).await.unwrap();
        let keys = Arc::new(keys());
        let accounts_url = serve_jwks(keys.jwks.clone()).await;
        let data_dir = std::env::temp_dir().join(format!("present-test-{db_name}"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let url = format!("http://{addr}");
        let env: HashMap<&str, String> = [
            ("PRESENT_DATABASE_URL", database_url.clone()),
            ("PRESENT_PUBLIC_URL", url.clone()),
            ("PRESENT_WEB_URL", "http://web.test".to_string()),
            ("PRESENT_DATA_DIR", data_dir.display().to_string()),
            ("ACCOUNTS_URL", ISSUER.to_string()),
            ("ACCOUNTS_API_URL", accounts_url.clone()),
            ("PRESENT_APP_SECRET", "sa_app_test".to_string()),
            ("PRESENT_IRIS_URL", "http://iris.test".to_string()),
            ("PRESENT_ACCOUNTS_WEBHOOK_SECRET", "whsec_test".to_string()),
        ]
        .into();
        let cfg = Config::from_lookup(|k| env.get(k).cloned()).unwrap();
        let client = silicon_accounts_client::AccountsClient::builder()
            .base_url(accounts_url)
            .allow_insecure_http(true)
            .build()
            .unwrap();
        let directory = Arc::new(FakeDirectory::default());
        let ting_fake = Arc::new(FakeTing::default());
        let converter_fake = Arc::new(FakeConverter::default());
        let deps = Deps {
            verifier: Arc::new(present_service::auth::AccountsTokenVerifier::new(
                client, "present", ISSUER,
            )),
            directory: directory.clone(),
            ting: if ting {
                Some(ting_fake.clone() as Arc<dyn TingSender>)
            } else {
                None
            },
            converter: match (real_converter, converter) {
                (Some(c), _) => Some(c),
                (None, true) => Some(converter_fake.clone() as Arc<dyn Converter>),
                (None, false) => None,
            },
        };
        let state = AppState::new(cfg, pool.clone(), deps);
        present_service::spawn_workers(&state);
        let st = state.clone();
        let server = tokio::spawn(async move {
            present_service::serve(listener, st).await.unwrap();
        });
        Stack {
            url,
            db_name,
            pool,
            state,
            directory,
            ting: ting_fake,
            converter: converter_fake,
            http: reqwest::Client::new(),
            keys,
            data_dir,
            server,
        }
    }

    /// A Carbon or Silicon known to Accounts, with a valid token.
    pub fn person(&self, handle: &str) -> Person {
        self.person_with(handle, None)
    }

    pub fn person_with(&self, handle: &str, email: Option<&str>) -> Person {
        let profile = Profile {
            display_name: handle
                .trim_start_matches("si:")
                .trim_start_matches("c:")
                .to_string(),
            pfp_url: None,
            email: email.map(String::from),
        };
        let uuid = self.directory.add(handle, Some(profile));
        Person {
            uuid,
            handle: handle.to_string(),
            token: self.token(uuid, handle, 600, "present"),
        }
    }

    pub fn token(&self, uuid: Uuid, handle: &str, ttl: i64, aud: &str) -> String {
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::EdDSA);
        header.kid = Some("test-key".into());
        let claims = json!({
            "iss": ISSUER, "sub": uuid.to_string(), "aud": aud, "exp": now + ttl, "iat": now,
            "kind": if handle.starts_with("si:") { "silicon" } else { "carbon" }, "id": handle, "mid": format!("present:{uuid}"),
        });
        jsonwebtoken::encode(&header, &claims, &self.keys.encoding).unwrap()
    }

    pub async fn req(
        &self,
        method: &str,
        path: &str,
        who: Option<&Person>,
        body: Option<Value>,
    ) -> (u16, Value) {
        self.req_h(method, path, who, body, &[]).await.0
    }

    pub async fn req_h(
        &self,
        method: &str,
        path: &str,
        who: Option<&Person>,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> ((u16, Value), reqwest::header::HeaderMap) {
        let m = reqwest::Method::from_bytes(method.as_bytes()).unwrap();
        let mut r = self.http.request(m, format!("{}{}", self.url, path));
        if let Some(p) = who {
            r = r.bearer_auth(&p.token);
        }
        for (k, v) in headers {
            r = r.header(*k, *v);
        }
        if let Some(b) = body {
            r = r.json(&b);
        }
        let resp = r.send().await.unwrap();
        let status = resp.status().as_u16();
        let h = resp.headers().clone();
        let text = resp.text().await.unwrap();
        let v = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        ((status, v), h)
    }

    pub async fn get(&self, path: &str, who: Option<&Person>) -> (u16, Value) {
        self.req("GET", path, who, None).await
    }
    pub async fn post(&self, path: &str, who: &Person, body: Value) -> (u16, Value) {
        self.req("POST", path, Some(who), Some(body)).await
    }

    /// Creates a deck and returns its id.
    pub async fn deck(&self, who: &Person, title: &str) -> String {
        let (s, d) = self.post("/v1/decks", who, json!({ "title": title })).await;
        assert_eq!(s, 201, "{d}");
        d["id"].as_str().unwrap().to_string()
    }

    pub async fn content(&self, deck: &str, who: &Person) -> Value {
        let (s, c) = self
            .get(&format!("/v1/decks/{deck}/content"), Some(who))
            .await;
        assert_eq!(s, 200, "{c}");
        c
    }

    pub async fn edits(&self, deck: &str, who: &Person, ops: Value) -> (u16, Value) {
        self.post(
            &format!("/v1/decks/{deck}/edits"),
            who,
            json!({ "ops": ops }),
        )
        .await
    }

    pub async fn share(&self, kind: &str, id: &str, owner: &Person, to: &str, role: &str) {
        let (s, b) = self
            .post(
                &format!("/v1/{kind}/{id}/access"),
                owner,
                json!({ "to": to, "role": role }),
            )
            .await;
        assert!(s == 201 || s == 200, "{s} {b}");
    }

    /// Waits until the outbox has delivered everything due (or 5 s pass).
    pub async fn outbox(&self) -> Vec<(String, Uuid, String, Value, String)> {
        sqlx::query_as::<_, (String, Uuid, String, Value, String)>(
            "select type, recipient, idempotency_key, payload, state from ting_outbox order by id",
        )
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }

    pub async fn wait_until<F: Fn() -> bool>(&self, what: &str, f: F) {
        for _ in 0..100 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("timed out waiting for {what}");
    }

    pub async fn stop(self) {
        self.server.abort();
        self.pool.close().await;
        // Drop (below) removes the database and the data dir.
    }
}

fn drop_database(name: String) {
    // Runs on its own thread and runtime, so it works from Drop and after a panic.
    let _ = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            if let Ok(admin) = sqlx::PgPool::connect(ADMIN_URL).await {
                let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
                    "drop database if exists {name} with (force)"
                )))
                .execute(&admin)
                .await;
                admin.close().await;
            }
        });
    })
    .join();
}

/// Drops databases left by test processes that are gone (e.g. killed mid-run).
async fn sweep_stale_databases(admin: &sqlx::PgPool) {
    let names: Vec<String> =
        sqlx::query_scalar("select datname from pg_database where datname like 'present_t_%'")
            .fetch_all(admin)
            .await
            .unwrap_or_default();
    for name in names {
        let pid = name.split('_').nth(2).and_then(|p| p.parse::<u32>().ok());
        let alive = pid.is_some_and(|p| {
            std::process::Command::new("kill")
                .arg("-0")
                .arg(p.to_string())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        });
        if !alive {
            let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
                "drop database if exists {name} with (force)"
            )))
            .execute(admin)
            .await;
        }
    }
}

impl Drop for Stack {
    fn drop(&mut self) {
        self.server.abort();
        let _ = std::fs::remove_dir_all(&self.data_dir);
        drop_database(self.db_name.clone());
    }
}

// ---------------------------------------------------------------- a live client

/// One SSE event.
#[derive(Debug, Clone)]
pub struct Ev {
    pub event: String,
    pub data: Value,
}

pub struct Sse {
    pub rx: mpsc::UnboundedReceiver<Ev>,
    task: tokio::task::JoinHandle<()>,
}

impl Sse {
    pub async fn connect(url: &str, token: Option<&str>) -> Sse {
        let client = reqwest::Client::new();
        let mut r = client.get(url);
        if let Some(t) = token {
            r = r.bearer_auth(t);
        }
        let resp = r.send().await.unwrap();
        assert_eq!(
            resp.status().as_u16(),
            200,
            "SSE connect to {url} failed: {}",
            resp.text().await.unwrap_or_default()
        );
        let (tx, rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            use futures::StreamExt;
            let mut stream = resp.bytes_stream();
            let mut buf = String::new();
            while let Some(Ok(chunk)) = stream.next().await {
                buf.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(pos) = buf.find("\n\n") {
                    let block = buf[..pos].to_string();
                    buf = buf[pos + 2..].to_string();
                    let mut event = "message".to_string();
                    let mut data = String::new();
                    for line in block.lines() {
                        if let Some(e) = line.strip_prefix("event:") {
                            event = e.trim().to_string();
                        } else if let Some(d) = line.strip_prefix("data:") {
                            data.push_str(d.trim_start());
                        }
                    }
                    if data.is_empty() {
                        continue;
                    }
                    let v = serde_json::from_str(&data).unwrap_or(Value::String(data));
                    if tx.send(Ev { event, data: v }).is_err() {
                        return;
                    }
                }
            }
        });
        Sse { rx, task }
    }

    /// The next event with this name (skipping others), within 5 s.
    pub async fn next(&mut self, event: &str) -> Ev {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let ev = tokio::time::timeout_at(deadline, self.rx.recv())
                .await
                .unwrap_or_else(|_| panic!("no `{event}` event within 5 s"))
                .expect("stream ended");
            if ev.event == event {
                return ev;
            }
        }
    }

    pub fn close(self) {
        self.task.abort();
    }
}

impl Drop for Sse {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A Yjs client: its own document, synced over GET /live and POST /updates.
pub struct LiveClient {
    pub doc: Doc,
    pub sse: Sse,
    pub session: String,
    pub base: String,
    pub deck: String,
    pub token: String,
}

impl LiveClient {
    pub async fn connect(stack: &Stack, deck: &str, who: &Person) -> LiveClient {
        Self::connect_with_doc(stack, deck, who, present_deck::new_doc()).await
    }

    pub async fn connect_with_doc(stack: &Stack, deck: &str, who: &Person, doc: Doc) -> LiveClient {
        let session = Uuid::new_v4().to_string();
        let sv = doc.transact().state_vector().encode_v1();
        let url = format!(
            "{}/v1/decks/{deck}/live?sv={}&session={session}",
            stack.url,
            urlencode(&b64(&sv))
        );
        let mut sse = Sse::connect(&url, Some(&who.token)).await;
        let sync = sse.next("sync").await;
        let update = unb64(sync.data["update"].as_str().unwrap());
        doc.transact_mut()
            .apply_update(Update::decode_v1(&update).unwrap())
            .unwrap();
        // Send what the server lacks (changes made while offline).
        let server_sv = StateVector::decode_v1(&unb64(sync.data["sv"].as_str().unwrap())).unwrap();
        let missing = doc.transact().encode_state_as_update_v1(&server_sv);
        let client = LiveClient {
            doc,
            sse,
            session,
            base: stack.url.clone(),
            deck: deck.to_string(),
            token: who.token.clone(),
        };
        if Update::decode_v1(&missing)
            .map(|u| !u.is_empty())
            .unwrap_or(false)
        {
            client.send(missing).await;
        }
        client
    }

    pub async fn send(&self, update: Vec<u8>) -> Value {
        let resp = reqwest::Client::new()
            .post(format!("{}/v1/decks/{}/updates", self.base, self.deck))
            .bearer_auth(&self.token)
            .json(&json!({ "update": b64(&update), "session": self.session }))
            .send()
            .await
            .unwrap();
        let status = resp.status().as_u16();
        let v: Value = resp.json().await.unwrap();
        assert_eq!(status, 200, "{v}");
        v
    }

    /// Applies ops locally (like an editor would) and sends the resulting update.
    pub async fn edit(&self, ops: Value) -> Value {
        let (update, _) =
            present_deck::apply_ops_update(&self.doc, &present_deck::parse_ops(&ops).unwrap())
                .unwrap();
        self.doc
            .transact_mut()
            .apply_update(Update::decode_v1(&update).unwrap())
            .unwrap();
        self.send(update).await
    }

    /// Applies the next `update` event from others into the local doc; returns the event.
    pub async fn receive(&mut self) -> Ev {
        let ev = self.sse.next("update").await;
        let u = unb64(ev.data["update"].as_str().unwrap());
        self.doc
            .transact_mut()
            .apply_update(Update::decode_v1(&u).unwrap())
            .unwrap();
        ev
    }

    pub fn json(&self) -> Value {
        present_deck::doc_to_json(&self.doc)
    }
}

pub fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn first_slide(deck: &Value) -> String {
    deck["slides"][0]["id"].as_str().unwrap().to_string()
}
