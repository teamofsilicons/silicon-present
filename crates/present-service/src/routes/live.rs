//! Live editing over server-sent events + POST (no websockets): `GET /live` streams `sync`, `update`, `presence`,
//! `presence_left`, `comments`, `deck` and a `ping` every 2 s; `POST /updates` applies a client's Yjs update;
//! `POST /presence` is the heartbeat (expires after 30 s).

use std::convert::Infallible;
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::{Extension, Json};
use futures::stream::{self, Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_stream::wrappers::{BroadcastStream, IntervalStream};
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, StateVector, Transact};
use yrs::updates::encoder::Encode;

use crate::access::{self, Need, Role};
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
    account: Option<uuid::Uuid>,
}

impl Drop for PresenceGuard {
    fn drop(&mut self) {
        let Some(session) = self.session.take() else { return };
        let st = self.st.clone();
        let deck = std::mem::take(&mut self.deck);
        let account = self.account;
        tokio::spawn(async move {
            if let Some(room) = st.rooms.loaded(&deck).await {
                let mut state = room.state.lock().await;
                let removed = state.presence.get(&session).is_some_and(|p| Some(p.account) == account);
                if removed { state.presence.remove(&session); }
                drop(state);
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
    Extension(viewer): Extension<crate::viewers::ViewerIdentity>,
    Path(id): Path<String>,
    Q(q): Q<LiveQuery>,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let (_, initial_access) = crate::viewers::deck_for(&st, &id, caller.uuid(), Need::View, &viewer).await?;
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
    let guard = PresenceGuard { st: st.clone(), deck: id.clone(), session: q.session.clone(), account: caller.uuid() };
    let updates = BroadcastStream::new(rx)
        .take_while(|m| futures::future::ready(m.is_ok())) // a lagging client reconnects with its state vector
        .filter_map(|m| futures::future::ready(m.ok()));
    // Recheck even an idle stream, and before every content-bearing event (including initial sync).
    // This covers direct and inherited sharing, moves, trash, transfers and permanent deletion.
    let pings = IntervalStream::new(tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(2), Duration::from_secs(2)))
        .map(|_| LiveMsg { event: "ping", data: json!({}) });
    let source = stream::iter(first).chain(stream::select(updates, pings)).boxed();
    let account = caller.uuid();
    let state = (source, initial_access.role, None::<LiveMsg>, false, guard);
    let stream = stream::unfold(state, move |(mut source, mut role, mut pending, closed, guard)| {
        let st = st.clone();
        let id = id.clone();
        let viewer = viewer.clone();
        async move {
            if closed { return None; }
            let msg = match pending.take() { Some(m) => m, None => source.next().await? };
            let next_role = crate::viewers::deck_for(&st, &id, account, Need::View, &viewer).await.map(|(_, a)| a.role).unwrap_or(Role::None);
            if next_role != role {
                role = next_role;
                let data = if role == Role::None { json!({ "role": null }) } else { json!({ "role": role.as_str() }) };
                let ev = event(&LiveMsg { event: "deck", data });
                return Some((Ok::<_, Infallible>(ev), (source, role, Some(msg), role == Role::None, guard)));
            }
            if msg.event == "sync" && crate::viewers::record(&st, &id, account, &viewer).await.is_err() { return None; }
            Some((Ok::<_, Infallible>(event(&msg)), (source, role, None, false, guard)))
        }
    }).take_until(tokio::time::sleep(Duration::from_secs(300)));
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
    cursor: Option<Cursor>,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor { x: f64, y: f64 }

fn validate_presence(body: &PresenceBody) -> ApiResult<()> {
    if body.session.trim().is_empty() || body.session.len() > 100 {
        return Err(ApiError::bad_request("invalid_session", "`session` must be a non-empty id of at most 100 bytes.", "Generate one random id per open editor tab or CLI session."));
    }
    if body.slide.as_ref().is_some_and(|s| s.len() > 200) || body.selection.len() > 100 || body.selection.iter().any(|s| s.len() > 200)
        || body.cursor.as_ref().is_some_and(|c| !c.x.is_finite() || !c.y.is_finite() || c.x.abs() > 1_000_000.0 || c.y.abs() > 1_000_000.0)
    {
        return Err(ApiError::bad_request("invalid_presence", "Presence exceeds the selection, id or cursor limits.", "Send at most 100 selected ids of 200 bytes, and a cursor with finite x/y coordinates."));
    }
    Ok(())
}

pub async fn presence(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, JsonBody(body): JsonBody<PresenceBody>) -> ApiResult<Json<Value>> {
    access::deck_for(&st, &id, Some(caller.uuid), Need::View).await?;
    validate_presence(&body)?;
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
        if !s.presence.contains_key(&body.session) && (s.presence.len() >= 256 || s.presence.values().filter(|p| p.account == caller.uuid).count() >= 8) {
            return Err(ApiError::new(axum::http::StatusCode::TOO_MANY_REQUESTS, "presence_limit", "There are too many active presence sessions.", "Reuse your tab's session id, or wait for old sessions to expire."));
        }
        s.presence.insert(body.session.clone(), Presence { account: caller.uuid, data: data.clone(), seen: Instant::now() });
    }
    room.send("presence", data);
    Ok(Json(json!({ "ok": true, "expiresIn": rooms::PRESENCE_TTL.as_secs() })))
}
