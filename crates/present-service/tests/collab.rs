//! Versions, comments and tings, transfers, presentations, files, email invites, snapshots.

mod common;

use std::sync::atomic::Ordering;

use common::*;
use serde_json::{Value, json};

fn texts(c: &Value, slide: usize) -> Vec<String> {
    c["slides"][slide]["elements"].as_array().unwrap().iter().filter(|e| e["kind"] == "text").map(|e| present_deck::plain_text(&e["text"])).collect()
}

#[tokio::test]
async fn versions_group_summarize_compare_restore_and_undo() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let bot = s.person("si:designer");
    let viewer = s.person("c:vic");
    let id = s.deck(&ada, "History").await;
    s.share("decks", &id, &ada, "si:designer", "editor").await;
    s.share("decks", &id, &ada, "c:vic", "viewer").await;
    let c = s.content(&id, &ada).await;
    let slide = first_slide(&c);
    let title = c["slides"][0]["elements"][0]["id"].as_str().unwrap().to_string();
    // v2, v3: Ada (one version). v4: the Silicon (explicit summary). v5: Ada again.
    s.edits(&id, &ada, json!([{ "op": "update_element", "slide": slide, "element": title, "set": { "text": "Q4 review" } }])).await;
    s.edits(&id, &ada, json!([{ "op": "add_slide", "slide": { "id": "s_second", "elements": [ { "id": "e_body01", "kind": "text", "text": "Body" } ] } }])).await;
    let (_, r) = s.post(&format!("/v1/decks/{id}/edits"), &bot, json!({ "summary": "Rebuilt slide 2", "ops": [
        { "op": "update_element", "slide": "s_second", "element": "e_body01", "set": { "text": "Body by the Silicon" } },
        { "op": "add_element", "slide": "s_second", "element": { "id": "e_chart1", "kind": "chart" } }
    ]})).await;
    let silicon_version = r["version"].as_i64().unwrap();
    assert_eq!(silicon_version, 4);
    s.edits(&id, &ada, json!([{ "op": "update_slide", "slide": slide, "set": { "notes": "Ada's notes" } }])).await;
    let (st, named) = s.post(&format!("/v1/decks/{id}/versions/3/name"), &ada, json!({ "name": "Sent to the client" })).await;
    assert_eq!((st, named["name"].as_str().unwrap()), (200, "Sent to the client"));
    let (st, v) = s.get(&format!("/v1/decks/{id}/versions"), Some(&ada)).await;
    assert_eq!(st, 200, "{v}");
    let versions = v["versions"].as_array().unwrap();
    let summaries: Vec<&str> = versions.iter().map(|x| x["summary"].as_str().unwrap()).collect();
    assert_eq!(versions.len(), 4, "{summaries:?}");
    assert_eq!(summaries[0], "c:ada changed slide 1");
    assert_eq!(summaries[1], "si:designer rebuilt slide 2");
    assert_eq!(summaries[2], "c:ada added slide 2 and changed slide 1");
    assert_eq!(versions[2]["name"], "Sent to the client");
    assert_eq!(versions[2]["from"], 2);
    assert_eq!(versions[3]["summary"], "c:ada created the deck");
    assert!(v["events"].as_array().unwrap().iter().any(|e| e["kind"] == "version.named"));
    // Viewers can't open the history.
    assert_eq!(s.get(&format!("/v1/decks/{id}/versions"), Some(&viewer)).await.0, 403);
    assert_eq!(s.get(&format!("/v1/decks/{id}/content?version=2"), Some(&viewer)).await.0, 403);
    // Any version can be read.
    let (_, old) = s.get(&format!("/v1/decks/{id}/content?version=2"), Some(&ada)).await;
    assert_eq!(old["version"], 2);
    assert_eq!(old["slides"].as_array().unwrap().len(), 1);
    // Compare says what changed and who changed it.
    let (_, cmp) = s.get(&format!("/v1/decks/{id}/compare?from=3&to=5"), Some(&ada)).await;
    assert_eq!(cmp["summary"], "changed slides 1 and 2");
    let authors: Vec<&str> = cmp["authors"]["s_second"].as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap()).collect();
    assert_eq!(authors, vec!["si:designer"]);
    assert_eq!(cmp["diff"]["slidesChanged"][1]["elementsAdded"][0]["kind"], "chart");
    // Bring back one element, then one slide, then the whole version 3.
    let (st, r) = s.post(&format!("/v1/decks/{id}/restore"), &ada, json!({ "version": 3, "slide": "s_second", "element": "e_body01" })).await;
    assert_eq!(st, 200, "{r}");
    let c = s.content(&id, &ada).await;
    assert_eq!(texts(&c, 1), vec!["Body\n"]);
    assert_eq!(c["slides"][1]["elements"].as_array().unwrap().len(), 2, "the chart stays: only the element came back");
    s.edits(&id, &ada, json!([{ "op": "delete_slide", "slide": "s_second" }])).await;
    let (_, r) = s.post(&format!("/v1/decks/{id}/restore"), &ada, json!({ "version": 4, "slide": "s_second" })).await;
    assert_eq!(r["summary"], "brought back slide 2 from version 4");
    let c = s.content(&id, &ada).await;
    assert_eq!(texts(&c, 1), vec!["Body by the Silicon\n"]);
    let (_, r) = s.post(&format!("/v1/decks/{id}/restore"), &ada, json!({ "version": 3 })).await;
    let restored_at = r["version"].as_i64().unwrap();
    let c = s.content(&id, &ada).await;
    let (_, v3) = s.get(&format!("/v1/decks/{id}/content?version=3"), Some(&ada)).await;
    assert_eq!(c["slides"], v3["slides"]);
    // Going back deleted nothing: every earlier version is still there.
    let (_, v4) = s.get(&format!("/v1/decks/{id}/content?version=4"), Some(&ada)).await;
    assert_eq!(texts(&v4, 1), vec!["Body by the Silicon\n"]);
    let (_, v) = s.get(&format!("/v1/decks/{id}/versions"), Some(&ada)).await;
    assert_eq!(v["versions"][0]["version"], restored_at);
    assert_eq!(v["versions"][0]["summary"], "c:ada restored version 3");
    // Undo everything the Silicon did since a version, keeping Ada's later work.
    let (_, r) = s.post(&format!("/v1/decks/{id}/edits"), &bot, json!({ "ops": [
        { "op": "update_element", "slide": "s_second", "element": "e_body01", "set": { "text": "Silicon again" } },
        { "op": "add_element", "slide": "s_second", "element": { "id": "e_extra1", "kind": "shape" } }
    ]})).await;
    let before_silicon = r["version"].as_i64().unwrap() - 1;
    s.edits(&id, &ada, json!([{ "op": "update_slide", "slide": slide, "set": { "notes": "Ada's later notes" } }])).await;
    let (st, r) = s.post(&format!("/v1/decks/{id}/undo-account"), &ada, json!({ "account": "si:designer", "since": before_silicon })).await;
    assert_eq!(st, 200, "{r}");
    assert_eq!(r["summary"], format!("undid si:designer's changes since version {before_silicon}"));
    assert_eq!(r["updatesUndone"], 1);
    let c = s.content(&id, &ada).await;
    let (_, before) = s.get(&format!("/v1/decks/{id}/content?version={before_silicon}"), Some(&ada)).await;
    assert_eq!(texts(&c, 1), texts(&before, 1));
    assert_eq!(texts(&c, 1), vec!["Body\n"]);
    assert!(c["slides"][1]["elements"].as_array().unwrap().iter().all(|e| e["id"] != "e_extra1"));
    assert_eq!(c["slides"][0]["notes"], "Ada's later notes");
    // A new deck from any older version.
    let (st, d) = s.post("/v1/decks", &bot, json!({ "from": { "deck": id, "version": 4 } })).await;
    assert_eq!(st, 201, "{d}");
    assert_eq!(d["title"], "Copy of History");
    let copy = s.content(d["id"].as_str().unwrap(), &bot).await;
    assert_eq!(texts(&copy, 1), vec!["Body by the Silicon\n"]);
    let (st, e) = s.get(&format!("/v1/decks/{id}/content?version=999"), Some(&ada)).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (400, "version_not_found"));
    s.stop().await;
}

#[tokio::test]
async fn comments_mentions_and_tings() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let cam = s.person("c:cam");
    let bot = s.person("si:designer");
    let outsider = s.person("c:out");
    let id = s.deck(&ada, "Comments").await;
    s.share("decks", &id, &ada, "c:cam", "commenter").await;
    s.share("decks", &id, &ada, "si:designer", "editor").await;
    let shared = s.outbox().await;
    assert!(shared.iter().any(|t| t.0 == "present.deck.shared" && t.1 == cam.uuid));
    let c = s.content(&id, &ada).await;
    let slide = first_slide(&c);
    let (_, r) = s.edits(&id, &ada, json!([{ "op": "add_element", "slide": slide, "element": { "id": "e_chart1", "kind": "chart", "chart": { "title": "Revenue" } } }])).await;
    assert_eq!(r["changed"], true);
    let threads = format!("/v1/decks/{id}/threads");
    // Every anchor kind.
    for anchor in [
        json!({ "kind": "deck" }),
        json!({ "kind": "slide", "slide": slide }),
        json!({ "kind": "point", "slide": slide, "x": 100, "y": 200 }),
        json!({ "kind": "area", "slide": slide, "x": 1, "y": 2, "w": 300, "h": 200, "element": "e_chart1", "ex": 0.1, "ey": 0.2, "ew": 0.5, "eh": 0.5 }),
        json!({ "kind": "element", "slide": slide, "element": "e_chart1" }),
        json!({ "kind": "text", "slide": slide, "field": "notes", "quote": "x" }),
    ] {
        let (st, t) = s.post(&threads, &cam, json!({ "anchor": anchor, "body": "a note" })).await;
        assert_eq!(st, 201, "{anchor} {t}");
    }
    let (st, e) = s.post(&threads, &cam, json!({ "anchor": { "kind": "element", "slide": slide, "element": "e_nope00" }, "body": "x" })).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (404, "element_not_found"));
    let (st, e) = s.post(&threads, &cam, json!({ "anchor": { "kind": "deck" }, "body": "  " })).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (400, "empty_comment"));
    // The Carbon drags over the chart and asks the Silicon; the outsider mentioned can't see the deck.
    let (st, t) = s.post(&threads, &cam, json!({ "anchor": { "kind": "area", "slide": slide, "element": "e_chart1", "x": 10, "y": 10, "w": 50, "h": 50 },
        "body": "@si:designer make this simpler, cc @c:out @c:nobody" })).await;
    assert_eq!(st, 201, "{t}");
    assert_eq!(t["snapshot"]["label"], "an area on slide 1 on chart “Revenue”");
    assert_eq!(t["mentionedWithoutAccess"][0]["id"], "c:out");
    assert_eq!(t["unknownMentions"], json!(["c:nobody"]));
    assert_eq!(t["comments"][0]["mentions"][0]["id"], "si:designer");
    let tid = t["id"].as_str().unwrap().to_string();
    let cid = t["comments"][0]["id"].as_str().unwrap().to_string();
    let outbox = s.outbox().await;
    let mention = outbox.iter().find(|x| x.0 == "present.mention.received" && x.1 == bot.uuid).expect("mention ting");
    assert_eq!(mention.3["deck"]["id"], id.as_str());
    assert_eq!(mention.3["slide"]["number"], 1);
    assert_eq!(mention.3["on"]["label"], "an area on slide 1 on chart “Revenue”");
    assert_eq!(mention.3["comment"]["body"], "@si:designer make this simpler, cc @c:out @c:nobody");
    assert!(!outbox.iter().any(|x| x.1 == outsider.uuid), "no ting to someone who can't see the deck");
    assert!(outbox.iter().any(|x| x.0 == "present.comment.created" && x.1 == ada.uuid && x.2.contains(&cid)));
    assert!(!outbox.iter().any(|x| x.1 == cam.uuid && x.0 != "present.deck.shared"), "never to the actor");
    // The Silicon replies; the starter hears about it, the owner too; the Silicon doesn't.
    let (st, r) = s.post(&format!("/v1/threads/{tid}/replies"), &bot, json!({ "body": "Done: two series instead of five." })).await;
    assert_eq!(st, 201, "{r}");
    let reply_id = r["comment"]["id"].as_str().unwrap().to_string();
    let outbox = s.outbox().await;
    assert!(outbox.iter().any(|x| x.0 == "present.comment.replied" && x.1 == cam.uuid && x.2.contains(&reply_id)));
    assert!(!outbox.iter().any(|x| x.1 == bot.uuid && x.2.contains(&reply_id)));
    // Reactions (one per account per emoji), edits, resolve, reopen, delete.
    let thumbs = urlencode("👍");
    let (st, t) = s.req("PUT", &format!("/v1/comments/{reply_id}/reactions/{thumbs}"), Some(&cam), None).await;
    assert_eq!(st, 200);
    s.req("PUT", &format!("/v1/comments/{reply_id}/reactions/{thumbs}"), Some(&cam), None).await;
    let (_, t2) = s.req("PUT", &format!("/v1/comments/{reply_id}/reactions/{thumbs}"), Some(&ada), None).await;
    assert_eq!(t2["comments"][1]["reactions"][0]["count"], 2);
    assert_eq!(t["comments"][1]["reactions"][0]["emoji"], "👍");
    let (_, t3) = s.req("DELETE", &format!("/v1/comments/{reply_id}/reactions/{thumbs}"), Some(&ada), None).await;
    assert_eq!(t3["comments"][1]["reactions"][0]["count"], 1);
    let (st, e) = s.req("PATCH", &format!("/v1/comments/{reply_id}"), Some(&cam), Some(json!({ "body": "hijack" }))).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (403, "not_your_comment"));
    let (st, t) = s.req("PATCH", &format!("/v1/comments/{cid}"), Some(&cam), Some(json!({ "body": "@si:designer make this simpler please, and @c:ada look" }))).await;
    assert_eq!(st, 200);
    assert!(t["comments"][0]["editedAt"].is_string());
    assert!(s.outbox().await.iter().any(|x| x.0 == "present.mention.received" && x.1 == ada.uuid && x.2.contains(&cid)), "newly mentioned by the edit");
    let (st, t) = s.post(&format!("/v1/threads/{tid}/resolve"), &bot, json!({})).await;
    assert_eq!((st, t["state"].as_str().unwrap()), (200, "resolved"));
    assert_eq!(t["resolvedBy"]["id"], "si:designer");
    assert!(s.outbox().await.iter().any(|x| x.0 == "present.thread.resolved" && x.1 == cam.uuid));
    let (_, open) = s.get(&format!("{threads}?state=open"), Some(&cam)).await;
    assert!(open["threads"].as_array().unwrap().iter().all(|t| t["id"] != tid.as_str()));
    let (_, t) = s.post(&format!("/v1/threads/{tid}/reopen"), &cam, json!({})).await;
    assert_eq!(t["state"], "open");
    let (st, _) = s.req("DELETE", &format!("/v1/comments/{reply_id}"), Some(&bot), None).await;
    assert_eq!(st, 204);
    let (_, all) = s.get(&threads, Some(&ada)).await;
    let th = all["threads"].as_array().unwrap().iter().find(|t| t["id"] == tid.as_str()).unwrap().clone();
    assert_eq!(th["comments"][1]["deleted"], true);
    assert!(th["comments"][1]["body"].is_null());
    let kept: String = sqlx::query_scalar("select body from comment_revisions where comment = $1 and reason = 'delete'").bind(&reply_id).fetch_one(&s.pool).await.unwrap();
    assert_eq!(kept, "Done: two series instead of five.");
    let (_, ev) = s.get(&format!("/v1/decks/{id}/events"), Some(&ada)).await;
    assert!(ev["events"].as_array().unwrap().iter().any(|e| e["kind"] == "comment.deleted"));
    // The comment follows its element; when the element goes, it stays and shows what it was on.
    s.edits(&id, &ada, json!([{ "op": "delete_element", "slide": slide, "element": "e_chart1" }])).await;
    let (_, all) = s.get(&threads, Some(&ada)).await;
    let th = all["threads"].as_array().unwrap().iter().find(|t| t["id"] == tid.as_str()).unwrap().clone();
    assert_eq!(th["current"]["exists"], false);
    assert_eq!(th["snapshot"]["elementKind"], "chart");
    let resp = s.http.get(format!("{}/v1/decks/{id}/content?format=text", s.url)).bearer_auth(&bot.token).send().await.unwrap().text().await.unwrap();
    assert!(resp.contains("make this simpler please"), "{resp}");
    // Every queued ting reaches Ting, once each.
    s.wait_until("tings delivered", || s.ting.sent.lock().unwrap().len() >= 6).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let sent = s.ting.sent.lock().unwrap().clone();
    let mut keys: Vec<&str> = sent.iter().map(|t| t.key.as_str()).collect();
    let total = keys.len();
    keys.dedup();
    assert_eq!(keys.len(), total);
    let states: Vec<String> = s.outbox().await.into_iter().map(|t| t.4).collect();
    assert!(states.iter().all(|x| x == "sent"), "{states:?}");
    s.stop().await;
}

#[tokio::test]
async fn ting_outbox_retries_and_stays_put_without_ting() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let _bob = s.person("c:bob");
    s.ting.fail_next.store(2, Ordering::SeqCst);
    let id = s.deck(&ada, "Retry").await;
    s.share("decks", &id, &ada, "c:bob", "viewer").await;
    // Two failures back off for 2 s and 4 s; pull them forward instead of waiting.
    for _ in 0..40 {
        sqlx::query("update ting_outbox set next_attempt_at = now() where state = 'pending'").execute(&s.pool).await.unwrap();
        s.state.ting_notify.notify_one();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if !s.ting.sent.lock().unwrap().is_empty() {
            break;
        }
    }
    assert_eq!(s.ting.sent.lock().unwrap().len(), 1);
    let (attempts, state): (i32, String) = sqlx::query_as("select attempts, state from ting_outbox").fetch_one(&s.pool).await.unwrap();
    assert_eq!((attempts, state.as_str()), (3, "sent"));
    // Accounts are enrolled with Ting on their first request.
    s.wait_until("enrolment", || s.ting.enrolled.lock().unwrap().contains(&ada.uuid)).await;
    s.stop().await;

    let s = Stack::start_with(false, false).await;
    let ada = s.person("c:ada");
    s.person("c:bob");
    let id = s.deck(&ada, "No Ting").await;
    s.share("decks", &id, &ada, "c:bob", "viewer").await;
    let outbox = s.outbox().await;
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].4, "ting_not_configured");
    s.stop().await;
}

#[tokio::test]
async fn transfers_need_acceptance() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let bob = s.person("c:bob");
    let eve = s.person("c:eve");
    let id = s.deck(&ada, "Handover").await;
    let (st, t) = s.post(&format!("/v1/decks/{id}/transfer"), &ada, json!({ "to": "c:bob" })).await;
    assert_eq!(st, 201, "{t}");
    let tid = t["id"].as_str().unwrap().to_string();
    let (st, e) = s.post(&format!("/v1/decks/{id}/transfer"), &ada, json!({ "to": "c:eve" })).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (409, "transfer_pending"));
    let (_, list) = s.get("/v1/transfers", Some(&bob)).await;
    assert_eq!(list["incoming"][0]["resource"]["name"], "Handover");
    assert_eq!(s.post(&format!("/v1/transfers/{tid}/accept"), &eve, json!({})).await.0, 404);
    assert_eq!(s.post(&format!("/v1/transfers/{tid}/accept"), &ada, json!({})).await.0, 403);
    let (st, t) = s.post(&format!("/v1/transfers/{tid}/accept"), &bob, json!({})).await;
    assert_eq!((st, t["state"].as_str().unwrap()), (200, "accepted"));
    let (_, d) = s.get(&format!("/v1/decks/{id}"), Some(&bob)).await;
    assert_eq!(d["owner"]["id"], "c:bob");
    assert_eq!(s.get(&format!("/v1/decks/{id}"), Some(&ada)).await.1["role"], "editor");
    let (st, _) = s.post(&format!("/v1/transfers/{tid}/decline"), &bob, json!({})).await;
    assert_eq!(st, 409);
    // Declined and cancelled transfers move nothing.
    let (_, t) = s.post(&format!("/v1/decks/{id}/transfer"), &bob, json!({ "to": "c:eve" })).await;
    let t2 = t["id"].as_str().unwrap().to_string();
    let (_, t) = s.post(&format!("/v1/transfers/{t2}/decline"), &eve, json!({})).await;
    assert_eq!(t["state"], "declined");
    let (_, t) = s.post(&format!("/v1/decks/{id}/transfer"), &bob, json!({ "to": "c:eve" })).await;
    let t3 = t["id"].as_str().unwrap().to_string();
    let (_, t) = s.post(&format!("/v1/transfers/{t3}/cancel"), &bob, json!({})).await;
    assert_eq!(t["state"], "cancelled");
    assert_eq!(s.get(&format!("/v1/decks/{id}"), Some(&bob)).await.1["owner"]["id"], "c:bob");
    // A folder moves with everything in it.
    let (_, f) = s.post("/v1/folders", &ada, json!({ "name": "Box" })).await;
    let folder = f["id"].as_str().unwrap().to_string();
    let (_, d) = s.post("/v1/decks", &ada, json!({ "title": "In the box", "folder": folder })).await;
    let inner = d["id"].as_str().unwrap().to_string();
    let (_, t) = s.post(&format!("/v1/folders/{folder}/transfer"), &ada, json!({ "to": "c:eve" })).await;
    s.post(&format!("/v1/transfers/{}/accept", t["id"].as_str().unwrap()), &eve, json!({})).await;
    assert_eq!(s.get(&format!("/v1/decks/{inner}"), Some(&eve)).await.1["owner"]["id"], "c:eve");
    s.stop().await;
}

#[tokio::test]
async fn presentations_are_followed_live() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let bot = s.person("si:presenter");
    let id = s.deck(&ada, "Talk").await;
    s.share("decks", &id, &ada, "si:presenter", "viewer").await;
    s.edits(&id, &ada, json!([{ "op": "add_slide", "slide": { "id": "s_two222" } }])).await;
    let (st, p) = s.post(&format!("/v1/decks/{id}/presentations"), &bot, json!({})).await;
    assert_eq!(st, 201, "{p}");
    assert_eq!(p["followUrl"], format!("http://web.test/p/{}", p["id"].as_str().unwrap()));
    let pid = p["id"].as_str().unwrap().to_string();
    let mut follow = Sse::connect(&format!("{}/v1/presentations/{pid}/live", s.url), Some(&ada.token)).await;
    let state = follow.next("state").await;
    assert_eq!(state.data["slideNumber"], 1);
    let (st, e) = s.req("PUT", &format!("/v1/presentations/{pid}"), Some(&ada), Some(json!({ "slide": "s_two222" }))).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (403, "not_the_presenter"));
    let (st, _) = s.req("PUT", &format!("/v1/presentations/{pid}"), Some(&bot), Some(json!({ "slide": "s_two222", "step": 1 }))).await;
    assert_eq!(st, 200);
    let moved = follow.next("state").await;
    assert_eq!(moved.data["slide"], "s_two222");
    assert_eq!(moved.data["step"], 1);
    let (_, active) = s.get(&format!("/v1/decks/{id}/presentations"), Some(&ada)).await;
    assert_eq!(active["presentations"].as_array().unwrap().len(), 1);
    assert_eq!(s.req("DELETE", &format!("/v1/presentations/{pid}"), Some(&bot), None).await.0, 204);
    follow.next("ended").await;
    s.stop().await;
}

#[tokio::test]
async fn assets_imports_exports_and_renders() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let stranger = s.person("c:stranger");
    let id = s.deck(&ada, "Files & things").await;
    let resp = s.http.post(format!("{}/v1/decks/{id}/assets", s.url)).bearer_auth(&ada.token).header("Content-Type", "image/png").header("X-Filename", "logo%20one.png").body(PNG.to_vec()).send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 201);
    let asset: Value = resp.json().await.unwrap();
    assert_eq!(asset["filename"], "logo one.png");
    let aid = asset["id"].as_str().unwrap().to_string();
    let get = |who: Option<&Person>, path: String| {
        let mut r = s.http.get(format!("{}{path}", s.url));
        if let Some(p) = who {
            r = r.bearer_auth(&p.token);
        }
        r.send()
    };
    let r = get(Some(&ada), format!("/v1/assets/{aid}")).await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    assert_eq!(r.headers()["content-type"], "image/png");
    assert_eq!(r.bytes().await.unwrap().as_ref(), PNG);
    assert_eq!(get(Some(&stranger), format!("/v1/assets/{aid}")).await.unwrap().status().as_u16(), 403);
    // Export: the converter gets the deck and a signed asset base that works without a token, with or
    // without a doubled slash.
    let r = get(Some(&ada), format!("/v1/decks/{id}/export?format=pptx")).await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    assert!(r.headers()["content-disposition"].to_str().unwrap().contains("Files & things.pptx"));
    let call = s.converter.calls.lock().unwrap().last().cloned().unwrap();
    let base = call.1["assetBase"].as_str().unwrap().to_string();
    assert_eq!(call.1["deck"]["title"], "Files & things");
    assert_eq!(s.http.get(format!("{base}{aid}")).send().await.unwrap().status().as_u16(), 200);
    assert_eq!(s.http.get(format!("{base}/{aid}")).send().await.unwrap().status().as_u16(), 200);
    let forged = base.replace("/assets/", "x/assets/");
    assert_eq!(s.http.get(format!("{forged}{aid}")).send().await.unwrap().status().as_u16(), 403);
    let r = get(Some(&ada), format!("/v1/decks/{id}/export?format=png")).await.unwrap();
    assert!(r.headers()["content-disposition"].to_str().unwrap().contains(".zip"));
    assert_eq!(get(Some(&ada), format!("/v1/decks/{id}/export?format=doc")).await.unwrap().status().as_u16(), 400);
    // Render one slide.
    let c = s.content(&id, &ada).await;
    let slide = first_slide(&c);
    let r = get(Some(&ada), format!("/v1/decks/{id}/slides/{slide}/render?width=960&at=500")).await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    assert_eq!(r.headers()["content-type"], "image/png");
    let call = s.converter.calls.lock().unwrap().last().cloned().unwrap();
    assert_eq!((call.1["width"].as_i64(), call.1["at"].as_i64()), (Some(960), Some(500)));
    // Public decks export without a token.
    s.req("PUT", &format!("/v1/decks/{id}/public"), Some(&ada), Some(json!({ "mode": "view" }))).await;
    assert_eq!(get(None, format!("/v1/decks/{id}/export?format=pdf")).await.unwrap().status().as_u16(), 200);
    // Opening a file makes a new deck, with its assets stored and referenced by new ids.
    let r = s.http.post(format!("{}/v1/imports", s.url)).bearer_auth(&ada.token).header("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation").header("X-Filename", "board.pptx").body(b"PK fake".to_vec()).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 201);
    let d: Value = r.json().await.unwrap();
    assert_eq!(d["title"], "Imported deck");
    let imported = s.content(d["id"].as_str().unwrap(), &ada).await;
    let src = imported["slides"][0]["elements"][1]["src"].as_str().unwrap().to_string();
    assert!(src.starts_with("asset:") && src != "asset:img1", "{src}");
    assert_eq!(get(Some(&ada), format!("/v1/assets/{}", &src[6..])).await.unwrap().status().as_u16(), 200);
    let (_, v) = s.get(&format!("/v1/decks/{}/versions", d["id"].as_str().unwrap()), Some(&ada)).await;
    assert_eq!(v["versions"][0]["summary"], "c:ada opened board.pptx");
    // Opening a file on top of a deck makes it the next version.
    let r = s.http.post(format!("{}/v1/decks/{id}/imports", s.url)).bearer_auth(&ada.token).header("X-Filename", "new.pptx").body(b"PK".to_vec()).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let c = s.content(&id, &ada).await;
    assert_eq!(c["slides"][0]["notes"], "imported notes");
    // Without a converter these answer 503 with what to do.
    let s2 = Stack::start_with(true, false).await;
    let ada2 = s2.person("c:ada");
    let id2 = s2.deck(&ada2, "x").await;
    let (st, e) = s2.get(&format!("/v1/decks/{id2}/export?format=pdf"), Some(&ada2)).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (503, "converter_not_configured"));
    s2.stop().await;
    s.stop().await;
}

#[tokio::test]
async fn email_invites_become_members_when_they_sign_in() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let id = s.deck(&ada, "Invite").await;
    let (st, m) = s.post(&format!("/v1/decks/{id}/access"), &ada, json!({ "to": "New.Person@Example.com", "role": "commenter" })).await;
    assert_eq!(st, 201, "{m}");
    assert_eq!(m["pending"], true);
    assert_eq!(m["member"], "email:new.person@example.com");
    let (to, subject, state): (String, String, String) = sqlx::query_as("select to_email, subject, state from email_outbox").fetch_one(&s.pool).await.unwrap();
    assert_eq!(to, "new.person@example.com");
    assert!(subject.contains("c:ada shared “Invite”"), "{subject}");
    assert_eq!(state, "not_configured");
    // They join Silicon Accounts and sign in to Present with that email.
    let newbie = s.person_with("c:newbie", Some("new.person@example.com"));
    s.wait_until("invite claimed", || false || true).await;
    for _ in 0..50 {
        if s.get(&format!("/v1/decks/{id}"), Some(&newbie)).await.0 == 200 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let (st, d) = s.get(&format!("/v1/decks/{id}"), Some(&newbie)).await;
    assert_eq!((st, d["role"].as_str().unwrap_or("")), (200, "commenter"));
    let (_, list) = s.get(&format!("/v1/decks/{id}/access"), Some(&ada)).await;
    assert_eq!(list["members"][0]["account"]["id"], "c:newbie");
    // Inviting an email that already belongs to a known account shares with that account directly.
    let (_, m) = s.post(&format!("/v1/decks/{id}/access"), &ada, json!({ "to": "new.person@example.com", "role": "editor" })).await;
    assert_eq!(m["pending"], false);
    assert_eq!(m["role"], "editor");
    s.stop().await;
}

#[tokio::test]
async fn snapshots_every_200_updates_and_old_versions_read_across_them() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let id = s.deck(&ada, "Long history").await;
    let mut client = LiveClient::connect(&s, &id, &ada).await;
    let slide = first_slide(&client.json());
    let el = client.json()["slides"][0]["elements"][1]["id"].as_str().unwrap().to_string();
    for i in 0..205 {
        client.edit(json!([{ "op": "update_element", "slide": slide, "element": el, "set": { "text": format!("count {i}") } }])).await;
    }
    let _ = client.receive().await;
    let snaps: Vec<i64> = sqlx::query_scalar("select seq from deck_snapshots where deck = $1").bind(&id).fetch_all(&s.pool).await.unwrap();
    assert_eq!(snaps, vec![200]);
    s.state.rooms.evict(&id).await;
    let c = s.content(&id, &ada).await;
    assert_eq!(c["version"], 206);
    assert_eq!(present_deck::plain_text(&c["slides"][0]["elements"][1]["text"]), "count 204\n");
    let (_, old) = s.get(&format!("/v1/decks/{id}/content?version=150"), Some(&ada)).await;
    assert_eq!(present_deck::plain_text(&old["slides"][0]["elements"][1]["text"]), "count 148\n");
    let (_, old) = s.get(&format!("/v1/decks/{id}/content?version=203"), Some(&ada)).await;
    assert_eq!(present_deck::plain_text(&old["slides"][0]["elements"][1]["text"]), "count 201\n");
    s.stop().await;
}
