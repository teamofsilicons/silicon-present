//! Durable retries and UTF-16 boundary rejection against the actual HTTP service and Postgres.
mod common;
use common::*;
use serde_json::{Value, json};
use yrs::{Map, ReadTxn, Text, Transact};

#[tokio::test]
async fn concurrent_retries_commit_one_edit_and_reject_changed_bodies() {
    let s = Stack::start().await;
    let owner = s.person("si:writer");
    let id = s.deck(&owner, "Retries").await;
    let original = s.content(&id, &owner).await;
    let base = original["version"].as_i64().unwrap();
    let body = json!({"base":base,"ops":[{"op":"add_slide","slide":{"id":"s_retry1","notes":"Only once"}}]});
    let url = format!("{}/v1/decks/{id}/edits", s.url);
    let mut jobs = Vec::new();
    for _ in 0..8 {
        let http=s.http.clone(); let url=url.clone(); let token=owner.token.clone(); let body=body.clone();
        jobs.push(tokio::spawn(async move { http.post(url).bearer_auth(token).header("idempotency-key","push-one").json(&body).send().await.unwrap().status().as_u16() }));
    }
    for job in jobs { assert!(matches!(job.await.unwrap(), 200 | 503)); }
    let replay = s.http.post(&url).bearer_auth(&owner.token).header("idempotency-key","push-one").json(&body).send().await.unwrap();
    assert_eq!(replay.status(), 200);
    assert_eq!(replay.headers()["idempotent-replayed"], "true");
    let replay: Value = replay.json().await.unwrap();
    assert_eq!(replay["version"], base+1);
    let content=s.content(&id,&owner).await;
    assert_eq!(content["slides"].as_array().unwrap().len(),original["slides"].as_array().unwrap().len()+1);
    let changed = json!({"base":base,"ops":[{"op":"add_slide","slide":{"id":"s_retry2"}}]});
    let response=s.http.post(&url).bearer_auth(&owner.token).header("idempotency-key","push-one").json(&changed).send().await.unwrap();
    assert_eq!(response.status(),409);
    assert_eq!(response.json::<Value>().await.unwrap()["error"]["code"],"idempotency_key_reused");
    assert_eq!(s.content(&id,&owner).await["version"],base+1);
    s.stop().await;
}

#[tokio::test]
async fn a_raw_update_cutting_an_emoji_is_rejected_without_changing_history() {
    let s=Stack::start().await;
    let owner=s.person("c:writer");
    let id=s.deck(&owner,"Unicode").await;
    let content=s.content(&id,&owner).await;
    let slide=first_slide(&content);
    assert_eq!(s.edits(&id,&owner,json!([{"op":"update_slide","slide":slide,"set":{"notes":"A😀B"}}])).await.0,200);
    let before=s.content(&id,&owner).await;
    let mut stream=Sse::connect(&format!("{}/v1/decks/{id}/live",s.url),Some(&owner.token)).await;
    let sync=stream.next("sync").await;
    let doc=present_deck::decode_doc(&unb64(sync.data["update"].as_str().unwrap())).unwrap();
    let state=doc.transact().state_vector();
    let slides=doc.get_or_insert_map("slides");
    let notes={
        let txn=doc.transact();
        let yrs::Out::YMap(slide)=slides.get(&txn,&slide).unwrap() else { panic!("slide map") };
        let yrs::Out::YText(notes)=slide.get(&txn,"notes").unwrap() else { panic!("notes text") };
        notes
    };
    notes.remove_range(&mut doc.transact_mut(),2,1);
    let update=doc.transact().encode_state_as_update_v1(&state);
    let (status,error)=s.post(&format!("/v1/decks/{id}/updates"),&owner,json!({"session":"invalid-emoji","update":b64(&update)})).await;
    assert_eq!(status,422,"{error}");
    assert_eq!(error["error"]["code"],"invalid_update");
    assert_eq!(s.content(&id,&owner).await,before);
    drop(stream);
    s.stop().await;
}

#[tokio::test]
async fn ordinary_and_presence_requests_have_small_body_limits() {
    let s=Stack::start().await;
    let owner=s.person("c:writer");
    let id=s.deck(&owner,"Limits").await;
    for key in [None,Some("with-key")] {
        let mut request=s.http.post(format!("{}/v1/decks/{id}/presence",s.url)).bearer_auth(&owner.token).json(&json!({"session":"large","blob":"x".repeat(17*1024)}));
        if let Some(key)=key {request=request.header("idempotency-key",key);}
        assert_eq!(request.send().await.unwrap().status(),413);
    }
    s.stop().await;
}
