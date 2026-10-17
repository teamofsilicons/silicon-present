//! Live editing over server-sent events + POST (no websockets): `GET /live` streams `sync`, `update`, `presence`,
//! `presence_left`, `comments`, `deck` and a `ping` every 20 s; `POST /updates` applies a client's Yjs update;
//! `POST /presence` is the heartbeat (expires after 30 s).

use std::convert::Infallible;
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures::stream::{self, Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_stream::wrappers::{BroadcastStream, IntervalStream};
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, StateVector, Transact};
use yrs::updates::encoder::Encode;

use crate::access::{self, Need};
use crate::auth::{Caller, MaybeCaller};
use crate::error::{ApiError, ApiResult};
use crate::extract::{JsonBody, Q};
use crate::rooms::{self, CommitInfo, LiveMsg, Presence, b64, unb64};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct LiveQuery {
    sv: Option<String>,
    session: Option<String>,
}

/// Removes a session's presence when its stream ends.
struct PresenceGuard {
    st: AppState,
    deck: String,
    session: Option<String>,
}

impl Drop for PresenceGuard {
    fn drop(&mut self) {
        let Some(session) = self.session.take() else { return };
        let st = self.st.clone();
        let deck = std::mem::take(&mut self.deck);
        tokio::spawn(async move {
            if let Some(room) = st.rooms.loaded(&deck).await {
                let removed = room.state.lock().await.presence.remove(&session).is_some();
                if removed {
                    room.send("presence_left", json!({ "session": session }));
                }
            }
        });
    }
}

fn event(msg: &LiveMsg) -> Event {
    Event::default().event(msg.event).data(msg.data.to_string())
}

pub async fn live(
    State(st): State<AppState>,
    caller: MaybeCaller,
    Path(id): Path<String>,
    Q(q): Q<LiveQuery>,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    access::deck_for(&st, &id, caller.uuid(), Need::View).await?;
    let client_sv = match q.sv.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => StateVector::decode_v1(&unb64(s, "sv")?).map_err(|_| {
            ApiError::bad_request("invalid_state_vector", "`sv` isn't a Yjs state vector.", "Send base64 of Y.encodeStateVector(doc), or leave sv out to get the whole deck.")
        })?,
        None => StateVector::default(),
    };
    let room = st.rooms.get(&st, &id).await?;
    let (first, rx) = {
        let s = room.state.lock().await;
        let txn = s.doc.transact();
        let update = txn.encode_state_as_update_v1(&client_sv);
        let sv = txn.state_vector().encode_v1();
        drop(txn);
        let mut first = vec![LiveMsg { event: "sync", data: json!({ "update": b64(&update), "sv": b64(&sv), "version": s.seq }) }];
        for (session, p) in &s.presence {
            if p.seen.elapsed() <= rooms::PRESENCE_TTL {
                let mut data = p.data.clone();
                data["session"] = json!(session);
                first.push(LiveMsg { event: "presence", data });
            }
        }
        (first, room.tx.subscribe())
    };
    let guard = PresenceGuard { st: st.clone(), deck: id.clone(), session: q.session.clone() };
    let updates = BroadcastStream::new(rx)
        .take_while(|m| futures::future::ready(m.is_ok())) // a lagging client reconnects with its state vector
        .filter_map(|m| futures::future::ready(m.ok()));
    let pings = IntervalStream::new(tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(20), Duration::from_secs(20)))
        .map(|_| LiveMsg { event: "ping", data: json!({}) });
    let stream = stream::iter(first).chain(stream::select(updates, pings)).map(move |m| {
        let _keep = &guard;
        Ok::<_, Infallible>(event(&m))
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(60))))
}

#[derive(Deserialize)]
pub struct UpdateBody {
    update: String,
    session: Option<String>,
}

pub async fn post_update(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, JsonBody(body): JsonBody<UpdateBody>) -> ApiResult<Json<Value>> {
    access::deck_for(&st, &id, Some(caller.uuid), Need::Edit).await?;
    let update = unb64(&body.update, "update")?;
    let commit = rooms::commit_update(&st, &id, update, CommitInfo { author: caller.uuid, origin: "edit", summary: None, session: body.session }).await?;
    Ok(Json(json!({ "version": commit.version, "changed": commit.changed, "touched": commit.touched })))
}

#[derive(Deserialize)]
pub struct PresenceBody {
    session: String,
    slide: Option<String>,
    #[serde(default)]
    selection: Vec<String>,
    cursor: Option<Value>,
}

pub async fn presence(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, JsonBody(body): JsonBody<PresenceBody>) -> ApiResult<Json<Value>> {
    access::deck_for(&st, &id, Some(caller.uuid), Need::View).await?;
    if body.session.trim().is_empty() || body.session.len() > 100 {
        return Err(ApiError::bad_request("invalid_session", "`session` must be a non-empty id of at most 100 characters.", "Generate one random id per open editor tab or CLI session."));
    }
    let account = crate::accounts::account_json(&st, caller.uuid).await;
    let room = st.rooms.get(&st, &id).await?;
    let data = json!({
        "session": body.session,
        "account": account,
        "slide": body.slide,
        "selection": body.selection,
        "cursor": body.cursor,
        "color": rooms::presence_color(caller.uuid),
    });
    {
        let mut s = room.state.lock().await;
        if let Some(existing) = s.presence.get(&body.session)
            && existing.account != caller.uuid
        {
            return Err(ApiError::forbidden("session_taken", "That presence session belongs to someone else.", "Use your own random session id."));
        }
        s.presence.insert(body.session.clone(), Presence { account: caller.uuid, data: data.clone(), seen: Instant::now() });
    }
    room.send("presence", data);
    Ok(Json(json!({ "ok": true, "expiresIn": rooms::PRESENCE_TTL.as_secs() })))
}
