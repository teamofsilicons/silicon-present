//! Server-owned anonymous Ting receivers for content-free library refresh hints.
//! Present authenticates the observer and every subsequent read. A caller cannot
//! bind an arbitrary session, and an expired address is never retargeted.
use std::{convert::Infallible, time::Duration};

use axum::{
    extract::State,
    http::HeaderMap,
    response::sse::{Event, KeepAlive, Sse},
};
use futures::{Stream, StreamExt};
use serde_json::{Value, json};
use ting_client::{
    Client,
    websocket::{Event as TingEvent, WebSocket},
};
use uuid::Uuid;

use crate::{
    auth::Caller,
    error::{ApiError, ApiResult},
    state::AppState,
};

struct Lease {
    pool: sqlx::PgPool,
    session: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let pool = self.pool.clone();
        let session = self.session.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = sqlx::query("delete from ting_library_sessions where session_id=$1")
                    .bind(session)
                    .execute(&pool)
                    .await;
            });
        }
    }
}

fn unavailable() -> ApiError {
    ApiError::unavailable(
        "ting_session_unavailable",
        "Live library updates are temporarily unavailable.",
        "Refresh the library and try again shortly.",
    )
}

pub async fn events(
    State(st): State<AppState>,
    caller: Caller,
    headers: HeaderMap,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let url = st.cfg.ting_url.as_deref().ok_or_else(unavailable)?;
    let client = Client::new(url).map_err(|_| unavailable())?;
    let mut receiver = tokio::time::timeout(st.cfg.ting_timeout, async {
        let mut receiver = WebSocket::connect(&client).await?;
        let reply = receiver.register(&[st.cfg.app_id.clone()], None).await?;
        if reply["session_id"] != receiver.session_id()
            || reply.get("for") != Some(&Value::Null)
            || reply["app_ids"] != json!([st.cfg.app_id])
        {
            return Err(ting_client::Error::new(
                "invalid_receiver",
                "Unexpected Ting receiver registration",
                "Reconnect",
                true,
            ));
        }
        Ok(receiver)
    })
    .await
    .map_err(|_| unavailable())?
    .map_err(|_| unavailable())?;
    let session = receiver.session_id().to_owned();
    let mut tx = st.pool.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("present-ting:{}", caller.uuid))
        .execute(&mut *tx)
        .await?;
    sqlx::query("delete from ting_library_sessions where expires_at<=now()")
        .execute(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar("select count(*) from ting_library_sessions where owner=$1")
        .bind(caller.uuid)
        .fetch_one(&mut *tx)
        .await?;
    if count >= 8 {
        return Err(unavailable());
    }
    sqlx::query("insert into ting_library_sessions(session_id,owner,expires_at) values($1,$2,now()+interval '45 seconds')")
        .bind(&session)
        .bind(caller.uuid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let lease = Lease {
        pool: st.pool.clone(),
        session: session.clone(),
    };
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.trim().split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| token.trim())
        .unwrap_or_default()
        .to_owned();
    let stream = async_stream::stream! {
        let _lease = lease;
        // Bind before reconciliation, so a mutation during the refetch still has a receiver.
        yield Ok(Event::default().event("ready").data(json!({"session_id":session}).to_string()));
        let mut renew = tokio::time::interval_at(tokio::time::Instant::now()+Duration::from_secs(15), Duration::from_secs(15));
        loop {
            tokio::select! {
                next = receiver.next_event() => {
                    match next {
                        Ok(TingEvent::Tings { session_id: Some(address), tings, .. })
                        | Ok(TingEvent::SilentDigest { session_id: address, tings, .. }) if address == session => {
                            if tings.iter().any(|t| t["type"] == "present.libraryChanged" && t["session_id"] == session && t["data"] == json!({})) {
                                yield Ok(Event::default().event("library").data("{}"));
                            }
                        }
                        Ok(TingEvent::Paused { .. }) | Err(_) => break,
                        _ => {}
                    }
                }
                _ = renew.tick() => {
                    if !receiver.is_connected() || !st.verifier.verify(&token).await.is_ok_and(|v| v.uuid == caller.uuid) { break; }
                    let renewed = sqlx::query("update ting_library_sessions set expires_at=now()+interval '45 seconds' where session_id=$1 and expires_at>now()")
                        .bind(&session).execute(&st.pool).await;
                    if !renewed.is_ok_and(|r| r.rows_affected() == 1) { break; }
                    yield Ok(Event::default().event("ping").data("{}"));
                }
            }
        }
    }.take_until(tokio::time::sleep(Duration::from_secs(240)));
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(10))))
}

/// Queue a hint for each current observer of the affected accounts. The wire body
/// contains neither an account nor any deck identifier, title, or comment.
pub async fn enqueue_accounts(conn: &mut sqlx::PgConnection, accounts: &[Uuid]) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into ting_outbox(idempotency_key,type,recipient,payload,session_id)
        select $1 || ':' || md5(session_id),'present.libraryChanged',owner,'{}'::jsonb,session_id
        from ting_library_sessions where owner=any($2) and expires_at>now()",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(accounts)
    .execute(conn)
    .await?;
    Ok(())
}

/// Library mutations can affect current members, former parent-folder members,
/// a removed member, or both sides of a transfer. Only those accounts get hints.
pub async fn enqueue_event(
    conn: &mut sqlx::PgConnection,
    deck: Option<&str>,
    folder: Option<&str>,
    actor: Uuid,
    kind: &str,
    data: &Value,
) -> Result<(), sqlx::Error> {
    if !(kind.starts_with("deck.")
        || kind.starts_with("folder.")
        || kind.starts_with("transfer.")
        || matches!(kind, "shared" | "unshared" | "role_changed" | "public_changed"))
    {
        return Ok(());
    }
    let old_folder = if kind.ends_with(".moved") { data["from"].as_str() } else { None };
    let mut accounts = vec![actor];
    for key in if kind.starts_with("transfer.") {
        &["from", "to"][..]
    } else if matches!(kind, "shared" | "role_changed" | "unshared") {
        &["to", "member"][..]
    } else {
        &[][..]
    } {
        if let Some(id) = data[key].as_str().and_then(|s| Uuid::parse_str(s).ok()) {
            accounts.push(id);
        }
    }
    let members: Vec<Uuid> = sqlx::query_scalar(
        "with recursive
        roots as (select coalesce($2, (select folder from decks where id=$1)) as id union select $3::text),
        ancestors as (select f.id,f.parent,f.owner,0 as depth from folders f join roots r on r.id=f.id
            union all select f.id,f.parent,f.owner,a.depth+1 from folders f join ancestors a on a.parent=f.id where a.depth<64),
        descendants as (select id,owner,0 as depth from folders where id=$2
            union all select f.id,f.owner,d.depth+1 from folders f join descendants d on f.parent=d.id where d.depth<64),
        affected_decks as (select id,owner from decks where id=$1 or folder in (select id from descendants))
        select owner from affected_decks union select owner from ancestors union select owner from descendants
        union select account from access where account is not null and
            ((resource_kind='deck' and resource_id in (select id from affected_decks)) or
             (resource_kind='folder' and resource_id in (select id from ancestors union select id from descendants)))",
    )
    .bind(deck)
    .bind(folder)
    .bind(old_folder)
    .fetch_all(&mut *conn)
    .await?;
    accounts.extend(members);
    enqueue_accounts(conn, &accounts).await
}
