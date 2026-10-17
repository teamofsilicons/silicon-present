//! Live rooms: one in-memory Yjs document per open deck, loaded from the latest snapshot plus the updates after
//! it. Every change goes through `commit_with`, which applies it under the room's lock, appends it to the log
//! (snapshotting every 200 updates) and broadcasts it with its author and the slides it touched.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{Value, json};
use tokio::sync::{Mutex, OnceCell, broadcast};
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, Transact, Update};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub const SNAPSHOT_EVERY: i64 = 200;
pub const PRESENCE_TTL: Duration = Duration::from_secs(30);

/// One server-sent event: its name and JSON data.
#[derive(Debug, Clone)]
pub struct LiveMsg {
    pub event: &'static str,
    pub data: Value,
}

#[derive(Debug, Clone)]
pub struct Presence {
    pub account: Uuid,
    pub data: Value,
    pub seen: Instant,
}

pub struct RoomState {
    pub doc: Doc,
    pub seq: i64,
    pub json: Value,
    pub presence: HashMap<String, Presence>,
}

pub struct Room {
    pub deck: String,
    pub state: Mutex<RoomState>,
    pub tx: broadcast::Sender<LiveMsg>,
    pub last_used: std::sync::Mutex<Instant>,
}

impl Room {
    pub fn send(&self, event: &'static str, data: Value) {
        let _ = self.tx.send(LiveMsg { event, data });
    }

    fn touch(&self) {
        if let Ok(mut t) = self.last_used.lock() {
            *t = Instant::now();
        }
    }
}

#[derive(Default)]
pub struct Rooms {
    map: Mutex<HashMap<String, Arc<OnceCell<Arc<Room>>>>>,
}

async fn load(st: &AppState, deck: &str) -> ApiResult<Arc<Room>> {
    let seq: i64 = sqlx::query_scalar("select seq from decks where id = $1")
        .bind(deck)
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(|| crate::store::deck_not_found(deck))?;
    let doc = crate::store::doc_at(st, deck, seq).await?;
    let json = present_deck::doc_to_json(&doc);
    let (tx, _) = broadcast::channel(1024);
    Ok(Arc::new(Room {
        deck: deck.to_string(),
        state: Mutex::new(RoomState { doc, seq, json, presence: HashMap::new() }),
        tx,
        last_used: std::sync::Mutex::new(Instant::now()),
    }))
}

impl Rooms {
    pub async fn get(&self, st: &AppState, deck: &str) -> ApiResult<Arc<Room>> {
        let cell = {
            let mut map = self.map.lock().await;
            map.entry(deck.to_string()).or_insert_with(|| Arc::new(OnceCell::new())).clone()
        };
        let room = cell.get_or_try_init(|| load(st, deck)).await;
        match room {
            Ok(r) => {
                r.touch();
                Ok(r.clone())
            }
            Err(e) => {
                self.map.lock().await.remove(deck);
                Err(e)
            }
        }
    }

    /// The room if it is loaded (to broadcast without loading a deck nobody has open).
    pub async fn loaded(&self, deck: &str) -> Option<Arc<Room>> {
        let map = self.map.lock().await;
        map.get(deck).and_then(|c| c.get().cloned())
    }

    pub async fn evict(&self, deck: &str) {
        self.map.lock().await.remove(deck);
    }

    /// Drops rooms nobody is connected to and nobody used for `idle`.
    pub async fn sweep(&self, idle: Duration) {
        let mut map = self.map.lock().await;
        map.retain(|_, cell| match cell.get() {
            Some(room) => room.tx.receiver_count() > 0 || room.last_used.lock().map(|t| t.elapsed() < idle).unwrap_or(true),
            None => true,
        });
    }

    pub async fn all(&self) -> Vec<Arc<Room>> {
        self.map.lock().await.values().filter_map(|c| c.get().cloned()).collect()
    }
}

/// The deck's current version and JSON (without id/title/version).
pub async fn current_json(st: &AppState, deck: &str) -> ApiResult<(i64, Value)> {
    let room = st.rooms.get(st, deck).await?;
    let s = room.state.lock().await;
    Ok((s.seq, s.json.clone()))
}

/// The result of a commit.
#[derive(Debug, Clone)]
pub struct Commit {
    pub version: i64,
    /// False when the update changed nothing (a retry of something already applied): nothing was logged.
    pub changed: bool,
    pub touched: Vec<String>,
    pub summary: String,
}

pub struct CommitInfo<'a> {
    pub author: Uuid,
    pub origin: &'a str,
    /// An explicit summary (ops); None = summarize the diff.
    pub summary: Option<String>,
    pub session: Option<String>,
}

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn unb64(s: &str, what: &str) -> ApiResult<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s.trim()).map_err(|_| {
        ApiError::bad_request("invalid_base64", format!("`{what}` isn't valid base64."), format!("Send `{what}` as standard base64 (with padding)."))
    })
}

fn has_pending(doc: &Doc) -> bool {
    let txn = doc.transact();
    let store = txn.store();
    store.pending_update().is_some() || store.pending_ds().is_some()
}

/// Runs `f` on the live document under the room's lock; `f` returns a Yjs update (relative to that document),
/// which is then applied, logged and broadcast as one change.
pub async fn commit_with<T>(
    st: &AppState,
    deck: &str,
    info: CommitInfo<'_>,
    f: impl FnOnce(&Doc) -> ApiResult<(Vec<u8>, T)>,
) -> ApiResult<(Commit, T)> {
    let author_json = crate::accounts::account_json(st, info.author).await;
    let room = st.rooms.get(st, deck).await?;
    let mut s = room.state.lock().await;
    let (update, extra) = f(&s.doc)?;
    let decoded = Update::decode_v1(&update).map_err(|e| {
        ApiError::bad_request("invalid_update", format!("The Yjs update couldn't be decoded: {e}."), "Send a Yjs v1 update (Y.encodeStateAsUpdate), base64 encoded.")
    })?;
    let before_sv = s.doc.transact().state_vector();
    let applied = s.doc.transact_mut().apply_update(decoded);
    if let Err(e) = applied {
        drop(s);
        st.rooms.evict(deck).await;
        return Err(ApiError::bad_request("invalid_update", format!("The Yjs update couldn't be applied: {e}."), "Resync: reconnect to /live and resend."));
    }
    if has_pending(&s.doc) {
        drop(s);
        st.rooms.evict(deck).await;
        return Err(ApiError::conflict(
            "update_needs_history",
            "The update builds on changes this deck doesn't have, so it wasn't applied.",
            "Reconnect to GET /v1/decks/{id}/live with your state vector, then send Y.encodeStateAsUpdate(doc, serverStateVector).",
        ));
    }
    let after_sv = s.doc.transact().state_vector();
    let after = present_deck::doc_to_json(&s.doc);
    if after_sv == before_sv && after == s.json {
        return Ok((Commit { version: s.seq, changed: false, touched: vec![], summary: String::new() }, extra));
    }
    let d = present_deck::diff(&s.json, &after);
    let touched = d.touched();
    let summary = info.summary.clone().filter(|x| !x.trim().is_empty()).unwrap_or_else(|| present_deck::summarize(&d));
    let seq = s.seq + 1;
    let snapshot = (seq % SNAPSHOT_EVERY == 0).then(|| present_deck::encode_doc(&s.doc));
    let write = async {
        let mut tx = st.pool.begin().await?;
        sqlx::query("insert into deck_updates (deck, seq, data, author, origin, summary, touched) values ($1, $2, $3, $4, $5, $6, $7)")
            .bind(deck)
            .bind(seq)
            .bind(&update)
            .bind(info.author)
            .bind(info.origin)
            .bind(&summary)
            .bind(&touched)
            .execute(&mut *tx)
            .await?;
        sqlx::query("update decks set seq = $2, updated_at = now(), search_text = $3 where id = $1")
            .bind(deck)
            .bind(seq)
            .bind(crate::store::search_text(&after))
            .execute(&mut *tx)
            .await?;
        if let Some(data) = &snapshot {
            sqlx::query("insert into deck_snapshots (deck, seq, data) values ($1, $2, $3) on conflict do nothing")
                .bind(deck)
                .bind(seq)
                .bind(data)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await
    };
    if let Err(e) = write.await {
        drop(s);
        st.rooms.evict(deck).await;
        return Err(ApiError::internal(format!("saving the change failed: {e}")));
    }
    s.seq = seq;
    s.json = after;
    room.send(
        "update",
        json!({
            "update": b64(&update),
            "author": author_json,
            "version": seq,
            "origin": info.origin,
            "summary": summary,
            "touched": touched,
            "session": info.session,
        }),
    );
    Ok((Commit { version: seq, changed: true, touched, summary }, extra))
}

/// Applies a client's Yjs update.
pub async fn commit_update(st: &AppState, deck: &str, update: Vec<u8>, info: CommitInfo<'_>) -> ApiResult<Commit> {
    Ok(commit_with(st, deck, info, |_| Ok((update, ()))).await?.0)
}

/// The colour a Carbon or Silicon shows up in, stable per account.
pub fn presence_color(uuid: Uuid) -> &'static str {
    const COLORS: [&str; 10] = ["#e5484d", "#2f5bea", "#12a594", "#e8743b", "#8e4ec6", "#d6409f", "#0091ff", "#46a758", "#f76b15", "#6e56cf"];
    let b = uuid.as_bytes();
    COLORS[(b[0] as usize + b[15] as usize) % COLORS.len()]
}

/// Removes presence that hasn't had a heartbeat for 30 s, telling everyone in the room.
pub async fn expire_presence(st: &AppState) {
    for room in st.rooms.all().await {
        let mut s = room.state.lock().await;
        let gone: Vec<String> = s.presence.iter().filter(|(_, p)| p.seen.elapsed() > PRESENCE_TTL).map(|(k, _)| k.clone()).collect();
        for session in gone {
            s.presence.remove(&session);
            room.send("presence_left", json!({ "session": session }));
        }
    }
}

/// Background upkeep: presence expiry every 5 s, idle rooms dropped after 10 minutes.
pub async fn run_upkeep(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    let mut n: u64 = 0;
    loop {
        tick.tick().await;
        expire_presence(&st).await;
        n += 1;
        if n.is_multiple_of(12) {
            st.rooms.sweep(Duration::from_secs(600)).await;
        }
    }
}
