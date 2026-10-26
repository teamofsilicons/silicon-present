//! Presenting: anyone who can view a deck can present it; followers (view access, or a public deck) see the
//! presenter's slide live over SSE (`state`, then `ended`).

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use futures::stream::{self, Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use tokio::sync::broadcast;
use tokio_stream::wrappers::{BroadcastStream, IntervalStream};
use uuid::Uuid;

use crate::access::{self, Need, Role};
use crate::auth::{Caller, MaybeCaller};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::rooms::LiveMsg;
use crate::state::AppState;
use crate::store::{ts, ts_opt};

#[derive(sqlx::FromRow, Clone)]
struct PresRow {
    id: String,
    deck: String,
    presenter: Uuid,
    slide: Option<String>,
    step: i32,
    started_at: OffsetDateTime,
    updated_at: OffsetDateTime,
    ended_at: Option<OffsetDateTime>,
}

const COLUMNS: &str = "id, deck, presenter, slide, step, started_at, updated_at, ended_at";

async fn pres_json(st: &AppState, p: &PresRow) -> Value {
    let (_, live) = crate::rooms::current_json(st, &p.deck).await.unwrap_or((0, Value::Null));
    let number = p.slide.as_ref().and_then(|s| live["slides"].as_array()?.iter().position(|x| x["id"] == s.as_str()).map(|i| i + 1));
    json!({
        "id": p.id,
        "deck": p.deck,
        "presenter": crate::accounts::account_json(st, p.presenter).await,
        "slide": p.slide,
        "slideNumber": number,
        "step": p.step,
        "startedAt": ts(p.started_at),
        "updatedAt": ts(p.updated_at),
        "endedAt": ts_opt(p.ended_at),
        "followUrl": format!("{}/p/{}", st.cfg.web_url, p.id),
    })
}

async fn channel(st: &AppState, id: &str) -> broadcast::Sender<LiveMsg> {
    let mut map = st.presentations.lock().await;
    map.entry(id.to_string()).or_insert_with(|| broadcast::channel(64).0).clone()
}

async fn load(st: &AppState, id: &str) -> ApiResult<PresRow> {
    sqlx::query_as(sql!("select {COLUMNS} from presentations where id = $1"))
        .bind(id)
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("presentation_not_found", format!("There is no presentation `{id}`."), "Check the follow link; the presenter may have started a new one."))
}

#[derive(Deserialize)]
pub struct StartBody {
    slide: Option<String>,
}

pub async fn start(State(st): State<AppState>, caller: Caller, Path(id): Path<String>, JsonBody(body): JsonBody<StartBody>) -> ApiResult<Response> {
    access::deck_for(&st, &id, Some(caller.uuid), Need::View).await?;
    let (_, live) = crate::rooms::current_json(&st, &id).await?;
    let slides = live["slides"].as_array().cloned().unwrap_or_default();
    let slide = match body.slide {
        Some(s) => {
            if !slides.iter().any(|x| x["id"] == s.as_str()) {
                return Err(ApiError::not_found("slide_not_found", format!("There is no slide `{s}` in this deck."), "Read the deck to get its slide ids."));
            }
            Some(s)
        }
        None => slides.iter().find(|s| s["skipped"] != true).or(slides.first()).and_then(|s| s["id"].as_str().map(String::from)),
    };
    let p: PresRow = sqlx::query_as(sql!("insert into presentations (id, deck, presenter, slide) values ($1, $2, $3, $4) returning {COLUMNS}"))
        .bind(crate::ids::new_id())
        .bind(&id)
        .bind(caller.uuid)
        .bind(&slide)
        .fetch_one(&st.pool)
        .await?;
    channel(&st, &p.id).await;
    Ok((StatusCode::CREATED, Json(pres_json(&st, &p).await)).into_response())
}

pub async fn list_for_deck(State(st): State<AppState>, caller: MaybeCaller, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    access::deck_for(&st, &id, caller.uuid(), Need::View).await?;
    let rows: Vec<PresRow> = sqlx::query_as(sql!("select {COLUMNS} from presentations where deck = $1 and ended_at is null order by started_at desc"))
        .bind(&id)
        .fetch_all(&st.pool)
        .await?;
    let mut out = Vec::new();
    for p in &rows {
        out.push(pres_json(&st, p).await);
    }
    Ok(Json(json!({ "presentations": out })))
}

pub async fn get(State(st): State<AppState>, caller: MaybeCaller, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    let p = load(&st, &pid).await?;
    access::deck_for(&st, &p.deck, caller.uuid(), Need::View).await?;
    Ok(Json(pres_json(&st, &p).await))
}

#[derive(Deserialize)]
pub struct MoveBody {
    slide: Option<String>,
    step: Option<i32>,
}

pub async fn update(State(st): State<AppState>, caller: Caller, Path(pid): Path<String>, JsonBody(body): JsonBody<MoveBody>) -> ApiResult<Json<Value>> {
    let p = load(&st, &pid).await?;
    access::deck_for(&st, &p.deck, Some(caller.uuid), Need::View).await?;
    if p.presenter != caller.uuid {
        return Err(ApiError::forbidden("not_the_presenter", "Only the presenter can move a presentation.", "Start your own presentation to present."));
    }
    if p.ended_at.is_some() {
        return Err(ApiError::conflict("presentation_ended", "This presentation has ended.", "Start a new one."));
    }
    let slide = body.slide.or(p.slide.clone());
    if let Some(s) = &slide {
        let (_, live) = crate::rooms::current_json(&st, &p.deck).await?;
        if !live["slides"].as_array().into_iter().flatten().any(|x| x["id"] == s.as_str()) {
            return Err(ApiError::not_found("slide_not_found", format!("There is no slide `{s}` in this deck."), "Read the deck to get its slide ids."));
        }
    }
    let step = body.step.unwrap_or(0).max(0);
    let p: PresRow = sqlx::query_as(sql!("update presentations set slide = $2, step = $3, updated_at = now() where id = $1 returning {COLUMNS}"))
        .bind(&pid)
        .bind(&slide)
        .bind(step)
        .fetch_one(&st.pool)
        .await?;
    let j = pres_json(&st, &p).await;
    let _ = channel(&st, &pid).await.send(LiveMsg { event: "state", data: j.clone() });
    Ok(Json(j))
}

pub async fn stop(State(st): State<AppState>, caller: Caller, Path(pid): Path<String>) -> ApiResult<Response> {
    let p = load(&st, &pid).await?;
    let (_, a) = access::deck_for(&st, &p.deck, Some(caller.uuid), Need::View).await?;
    if p.presenter != caller.uuid && a.role < Role::Owner {
        return Err(ApiError::forbidden("not_the_presenter", "Only the presenter (or the deck's owner) can stop a presentation.", "Ask the presenter to stop it."));
    }
    if p.ended_at.is_none() {
        sqlx::query("update presentations set ended_at = now(), updated_at = now() where id = $1").bind(&pid).execute(&st.pool).await?;
        let _ = channel(&st, &pid).await.send(LiveMsg { event: "ended", data: json!({ "id": pid }) });
        st.presentations.lock().await.remove(&pid);
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn live(State(st): State<AppState>, caller: MaybeCaller, Extension(viewer): Extension<crate::viewers::ViewerIdentity>, Path(pid): Path<String>) -> ApiResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let p = load(&st, &pid).await?;
    access::deck_for(&st, &p.deck, caller.uuid(), Need::View).await?;
    let ended = p.ended_at.is_some();
    let rx = channel(&st, &pid).await.subscribe();
    let mut first = vec![LiveMsg { event: "state", data: pres_json(&st, &p).await }];
    if ended {
        first.push(LiveMsg { event: "ended", data: json!({ "id": pid }) });
    }
    let updates = BroadcastStream::new(rx).take_while(|m| futures::future::ready(m.is_ok())).filter_map(|m| futures::future::ready(m.ok()));
    let pings = IntervalStream::new(tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(2), Duration::from_secs(2)))
        .map(|_| LiveMsg { event: "ping", data: json!({}) });
    let rest: std::pin::Pin<Box<dyn Stream<Item = LiveMsg> + Send>> =
        if ended { Box::pin(stream::empty()) } else { Box::pin(stream::select(updates, pings)) };
    // The stream ends right after `ended`, including loss of access to its deck.
    let account = caller.uuid();
    let deck = p.deck.clone();
    let mut saw_initial_state = false;
    let stream = stream::iter(first)
        .chain(rest)
        .then(move |m| {
            let st = st.clone();
            let deck = deck.clone();
            let viewer = viewer.clone();
            let record = m.event == "state" && !saw_initial_state;
            if record { saw_initial_state = true; }
            async move {
                if crate::viewers::deck_for(&st, &deck, account, Need::View, &viewer).await.is_err()
                    || (record && crate::viewers::record(&st, &deck, account, &viewer).await.is_err()) {
                    LiveMsg { event: "ended", data: json!({ "role": null }) }
                } else { m }
            }
        })
        .scan(false, |done, m| {
            if *done {
                return futures::future::ready(None);
            }
            if m.event == "ended" {
                *done = true;
            }
            futures::future::ready(Some(m))
        })
        .map(|m| Ok::<_, Infallible>(Event::default().event(m.event).data(m.data.to_string())))
        .take_until(tokio::time::sleep(Duration::from_secs(300)));
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(60))))
}
