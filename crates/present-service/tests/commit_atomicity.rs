//! Persistence failure must leave even already-acquired Room handles at the last durable revision.
mod common;
use common::*;
use serde_json::json;

#[tokio::test]
async fn failed_persistence_does_not_publish_or_replace_the_live_room() {
    let s = Stack::start().await;
    let owner = s.person("c:writer");
    let id = s.deck(&owner, "Commit atomicity").await;
    let content = s.content(&id, &owner).await;
    let slide = first_slide(&content);
    let room = s.state.rooms.get(&s.state, &id).await.unwrap();
    let (version, bytes) = {
        let state = room.state.lock().await;
        (state.seq, present_deck::encode_doc(&state.doc))
    };
    // A real database refusal after the update is prepared, but before it can commit.
    sqlx::query(
        "alter table deck_updates add constraint test_refuse_ops check (origin <> 'ops') not valid",
    )
    .execute(&s.pool)
    .await
    .unwrap();
    let (status, _) = s
        .edits(
            &id,
            &owner,
            json!([{"op":"update_slide","slide":slide,"set":{"notes":"must never leak"}}]),
        )
        .await;
    assert_eq!(status, 500);
    {
        let state = room.state.lock().await;
        assert_eq!(state.seq, version);
        assert_eq!(present_deck::encode_doc(&state.doc), bytes);
    }
    assert!(std::sync::Arc::ptr_eq(
        &room,
        &s.state.rooms.loaded(&id).await.unwrap()
    ));
    assert_eq!(s.content(&id, &owner).await, content);
    sqlx::query("alter table deck_updates drop constraint test_refuse_ops")
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        s.edits(
            &id,
            &owner,
            json!([{"op":"update_slide","slide":slide,"set":{"notes":"durable"}}])
        )
        .await
        .0,
        200
    );
    {
        let state = room.state.lock().await;
        assert_eq!(state.seq, version + 1);
        assert_eq!(state.json["slides"][0]["notes"], "durable");
    }
    drop(room);
    s.stop().await;
}
