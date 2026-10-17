//! Every role rule: viewer, commenter, editor, owner, public modes, signed-out reads, folder inheritance, max role.

mod common;

use common::*;
use serde_json::json;

fn comment_body() -> serde_json::Value {
    json!({ "anchor": { "kind": "deck" }, "body": "Looks good" })
}

#[tokio::test]
async fn roles_decide_who_can_view_comment_and_edit() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let viewer = s.person("c:vic");
    let commenter = s.person("c:cam");
    let editor = s.person("si:ed");
    let stranger = s.person("c:stranger");
    let id = s.deck(&ada, "Roles").await;
    s.share("decks", &id, &ada, "c:vic", "viewer").await;
    s.share("decks", &id, &ada, "c:cam", "commenter").await;
    s.share("decks", &id, &ada, "si:ed", "editor").await;
    let add = json!([{ "op": "add_slide", "slide": {} }]);
    let threads = format!("/v1/decks/{id}/threads");

    // Viewer: reads, can't comment or edit.
    assert_eq!(s.get(&format!("/v1/decks/{id}/content"), Some(&viewer)).await.0, 200);
    let (st, e) = s.post(&threads, &viewer, comment_body()).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (403, "comment_not_allowed"));
    let (st, e) = s.edits(&id, &viewer, add.clone()).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (403, "edit_not_allowed"));
    assert!(e["error"]["message"].as_str().unwrap().contains("viewer"));
    // Commenter: comments, can't edit.
    assert_eq!(s.post(&threads, &commenter, comment_body()).await.0, 201);
    assert_eq!(s.edits(&id, &commenter, add.clone()).await.0, 403);
    // Editor: edits, comments and invites; can't change the public switch (owner only) or delete.
    assert_eq!(s.edits(&id, &editor, add.clone()).await.0, 200);
    assert_eq!(s.post(&threads, &editor, comment_body()).await.0, 201);
    s.share("decks", &id, &editor, "c:stranger", "viewer").await;
    let (st, e) = s.req("PUT", &format!("/v1/decks/{id}/public"), Some(&editor), Some(json!({ "mode": "view" }))).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (403, "owner_only"));
    let (st, _) = s.req("DELETE", &format!("/v1/decks/{id}"), Some(&editor), None).await;
    assert_eq!(st, 403);
    // Removing the stranger again; anyone can leave by themselves.
    let (st, _) = s.req("DELETE", &format!("/v1/decks/{id}/access/{}", stranger.uuid), Some(&stranger), None).await;
    assert_eq!(st, 204);
    let (st, e) = s.get(&format!("/v1/decks/{id}"), Some(&stranger)).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (403, "no_access"));
    // Viewers can't invite.
    let (st, _) = s.post(&format!("/v1/decks/{id}/access"), &viewer, json!({ "to": "c:stranger", "role": "viewer" })).await;
    assert_eq!(st, 403);
    // Role change and listing.
    let (st, m) = s.req("PATCH", &format!("/v1/decks/{id}/access/{}", viewer.uuid), Some(&ada), Some(json!({ "role": "commenter" }))).await;
    assert_eq!((st, m["role"].as_str().unwrap()), (200, "commenter"));
    let (_, list) = s.get(&format!("/v1/decks/{id}/access"), Some(&viewer)).await;
    assert_eq!(list["owner"]["id"], "c:ada");
    assert_eq!(list["members"].as_array().unwrap().len(), 3);
    let (st, e) = s.post(&format!("/v1/decks/{id}/access"), &ada, json!({ "to": "c:ada", "role": "viewer" })).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (409, "already_owner"));
    let (st, e) = s.post(&format!("/v1/decks/{id}/access"), &ada, json!({ "to": "c:ada", "role": "owner" })).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (400, "invalid_role"));
    let (st, e) = s.post(&format!("/v1/decks/{id}/access"), &ada, json!({ "to": "c:ghost", "role": "viewer" })).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (404, "account_not_found"));
    s.stop().await;
}

#[tokio::test]
async fn public_modes_and_signed_out_reads() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let stranger = s.person("c:stranger");
    let id = s.deck(&ada, "Public").await;
    let content = format!("/v1/decks/{id}/content");
    let (st, e) = s.get(&content, None).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (401, "sign_in_required"));
    for (mode, anon_read, can_comment, can_edit) in [("view", true, false, false), ("comment", true, true, false), ("edit", true, true, true), ("off", false, false, false)] {
        let (st, _) = s.req("PUT", &format!("/v1/decks/{id}/public"), Some(&ada), Some(json!({ "mode": mode }))).await;
        assert_eq!(st, 200);
        assert_eq!(s.get(&content, None).await.0 == 200, anon_read, "{mode}: signed-out read");
        // Signed-out callers never comment or edit, whatever the mode.
        let (st, _) = s.req("POST", &format!("/v1/decks/{id}/threads"), None, Some(comment_body())).await;
        assert_eq!(st, 401, "{mode}: signed-out comment");
        let (st, _) = s.post(&format!("/v1/decks/{id}/threads"), &stranger, comment_body()).await;
        assert_eq!(st == 201, can_comment, "{mode}: signed-in comment");
        let (st, _) = s.edits(&id, &stranger, json!([{ "op": "add_slide", "slide": {} }])).await;
        assert_eq!(st == 200, can_edit, "{mode}: signed-in edit");
    }
    // A public deck's threads and live stream are readable signed out; its listing shows nowhere.
    s.req("PUT", &format!("/v1/decks/{id}/public"), Some(&ada), Some(json!({ "mode": "view" }))).await;
    assert_eq!(s.get(&format!("/v1/decks/{id}/threads"), None).await.0, 200);
    let mut sse = Sse::connect(&format!("{}/v1/decks/{id}/live", s.url), None).await;
    let sync = sse.next("sync").await;
    assert!(sync.data["version"].as_i64().unwrap() >= 1);
    let (_, shared) = s.get("/v1/decks?scope=shared", Some(&stranger)).await;
    assert!(shared["decks"].as_array().unwrap().is_empty());
    s.stop().await;
}

#[tokio::test]
async fn folder_sharing_inherits_and_the_highest_role_wins() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let bob = s.person("c:bob");
    let (_, f) = s.post("/v1/folders", &ada, json!({ "name": "Top" })).await;
    let top = f["id"].as_str().unwrap().to_string();
    let (_, f) = s.post("/v1/folders", &ada, json!({ "name": "Inner", "parent": top })).await;
    let inner = f["id"].as_str().unwrap().to_string();
    let (_, d) = s.post("/v1/decks", &ada, json!({ "title": "Deep", "folder": inner })).await;
    let deep = d["id"].as_str().unwrap().to_string();
    assert_eq!(s.get(&format!("/v1/decks/{deep}"), Some(&bob)).await.0, 403);
    // Viewer on the top folder → viewer on everything below, including what's added later.
    s.share("folders", &top, &ada, "c:bob", "viewer").await;
    let (_, d) = s.get(&format!("/v1/decks/{deep}"), Some(&bob)).await;
    assert_eq!(d["role"], "viewer");
    let (_, later) = s.post("/v1/decks", &ada, json!({ "title": "Later", "folder": inner })).await;
    let (_, d) = s.get(&format!("/v1/decks/{}", later["id"].as_str().unwrap()), Some(&bob)).await;
    assert_eq!(d["role"], "viewer");
    // Direct commenter on the deck + viewer through the folder → commenter.
    s.share("decks", &deep, &ada, "c:bob", "commenter").await;
    assert_eq!(s.get(&format!("/v1/decks/{deep}"), Some(&bob)).await.1["role"], "commenter");
    // Editor on the inner folder beats both.
    s.share("folders", &inner, &ada, "c:bob", "editor").await;
    assert_eq!(s.get(&format!("/v1/decks/{deep}"), Some(&bob)).await.1["role"], "editor");
    // The access list shows inherited members and where they come from.
    let (_, list) = s.get(&format!("/v1/decks/{deep}/access"), Some(&bob)).await;
    let vias: Vec<_> = list["members"].as_array().unwrap().iter().map(|m| m["via"]["id"].clone()).collect();
    assert!(vias.contains(&json!(inner)) && vias.contains(&json!(top)), "{list}");
    // Public on the folder makes what's inside public.
    s.req("PUT", &format!("/v1/folders/{top}/public"), Some(&ada), Some(json!({ "mode": "view" }))).await;
    assert_eq!(s.get(&format!("/v1/decks/{deep}/content"), None).await.0, 200);
    // Shared folders list for Bob.
    let (_, fl) = s.get("/v1/folders?scope=shared", Some(&bob)).await;
    assert_eq!(fl["folders"].as_array().unwrap().len(), 2);
    let (_, inside) = s.get(&format!("/v1/folders?parent={top}"), Some(&bob)).await;
    assert_eq!(inside["folders"][0]["id"], inner.as_str());
    s.stop().await;
}
