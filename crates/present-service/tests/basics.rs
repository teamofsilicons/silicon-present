//! Auth, decks, folders, live sync, ops, trash, search, idempotent retries.

mod common;

use common::*;
use serde_json::json;
use yrs::Transact;
use yrs::updates::decoder::Decode;

#[tokio::test]
async fn health_and_token_checks() {
    let s = Stack::start().await;
    let (st, h) = s.get("/health", None).await;
    assert_eq!(st, 200);
    assert_eq!(h["ok"], true);
    let (st, e) = s.get("/v1/decks", None).await;
    assert_eq!(st, 401);
    assert_eq!(e["error"]["code"], "sign_in_required");
    assert!(e["error"]["hint"].as_str().unwrap().contains("Bearer"));
    let ada = s.person("c:ada");
    let expired = Person { uuid: ada.uuid, handle: ada.handle.clone(), token: s.token(ada.uuid, "c:ada", -120, "present") };
    let (st, e) = s.get("/v1/decks", Some(&expired)).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (401, "token_expired"));
    let other_app = Person { uuid: ada.uuid, handle: ada.handle.clone(), token: s.token(ada.uuid, "c:ada", 600, "remind") };
    let (st, e) = s.get("/v1/decks", Some(&other_app)).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (401, "token_wrong_audience"));
    let (st, me) = s.get("/v1/me", Some(&ada)).await;
    assert_eq!(st, 200);
    assert_eq!(me["id"], "c:ada");
    assert_eq!(me["uuid"], ada.uuid.to_string());
    let (st, r) = s.get("/v1/accounts/resolve?q=c:ada", Some(&ada)).await;
    assert_eq!(st, 200, "{r}");
    assert_eq!(r["account"]["uuid"], ada.uuid.to_string());
    let (st, r) = s.get("/v1/accounts/resolve?q=c:nobody", Some(&ada)).await;
    assert_eq!((st, r["error"]["code"].as_str().unwrap()), (404, "account_not_found"));
    let (st, e) = s.get("/v1/nope", Some(&ada)).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (404, "not_found"));
    s.stop().await;
}

#[tokio::test]
async fn decks_folders_and_ownership() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let bot = s.person("si:writer");
    let id = s.deck(&ada, "Q4 review").await;
    let (st, d) = s.get(&format!("/v1/decks/{id}"), Some(&ada)).await;
    assert_eq!(st, 200);
    assert_eq!(d["title"], "Q4 review");
    assert_eq!(d["owner"]["id"], "c:ada");
    assert_eq!(d["role"], "owner");
    assert_eq!(d["version"], 1);
    let c = s.content(&id, &ada).await;
    assert_eq!(c["slides"].as_array().unwrap().len(), 1);
    assert_eq!(c["title"], "Q4 review");
    // Rename.
    let (st, d) = s.req("PATCH", &format!("/v1/decks/{id}"), Some(&ada), Some(json!({ "title": "Q4 final" }))).await;
    assert_eq!((st, d["title"].as_str().unwrap()), (200, "Q4 final"));
    // A folder shared with a Silicon as editor: the deck it makes inside belongs to the folder's owner.
    let (st, f) = s.post("/v1/folders", &ada, json!({ "name": "Board" })).await;
    assert_eq!(st, 201);
    let folder = f["id"].as_str().unwrap().to_string();
    s.share("folders", &folder, &ada, "si:writer", "editor").await;
    let (st, d) = s.post("/v1/decks", &bot, json!({ "title": "Made by a Silicon", "folder": folder })).await;
    assert_eq!(st, 201, "{d}");
    assert_eq!(d["owner"]["id"], "c:ada");
    assert_eq!(d["creator"]["id"], "si:writer");
    let inside = d["id"].as_str().unwrap().to_string();
    let (_, mine) = s.get("/v1/decks?scope=mine", Some(&ada)).await;
    assert_eq!(mine["decks"].as_array().unwrap().len(), 2);
    let (_, shared) = s.get("/v1/decks?scope=shared", Some(&bot)).await;
    assert_eq!(shared["decks"][0]["id"], inside.as_str());
    let (_, root) = s.get("/v1/decks?scope=mine&folder=root", Some(&ada)).await;
    assert_eq!(root["decks"].as_array().unwrap().len(), 1);
    let (_, in_folder) = s.get(&format!("/v1/decks?folder={folder}"), Some(&bot)).await;
    assert_eq!(in_folder["decks"].as_array().unwrap().len(), 1);
    // Moving a deck into someone else's folder is refused.
    let bots_own = s.deck(&bot, "Own deck").await;
    let (st, e) = s.req("PATCH", &format!("/v1/decks/{bots_own}"), Some(&bot), Some(json!({ "folder": folder }))).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (403, "folder_owned_by_someone_else"));
    // Ada moves her deck in and out.
    let (st, d) = s.req("PATCH", &format!("/v1/decks/{id}"), Some(&ada), Some(json!({ "folder": folder }))).await;
    assert_eq!((st, d["folder"].as_str().unwrap()), (200, folder.as_str()));
    let (_, d) = s.req("PATCH", &format!("/v1/decks/{id}"), Some(&ada), Some(json!({ "folder": null }))).await;
    assert!(d["folder"].is_null());
    let (_, fl) = s.get("/v1/folders?scope=shared", Some(&bot)).await;
    assert_eq!(fl["folders"][0]["id"], folder.as_str());
    // Errors say what to do.
    let (st, e) = s.get("/v1/decks/zzzzzzzzzzzz", Some(&ada)).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (404, "deck_not_found"));
    s.stop().await;
}

#[tokio::test]
async fn two_clients_sync_live_and_offline_changes_merge() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let bob = s.person("c:bob");
    let id = s.deck(&ada, "Live").await;
    s.share("decks", &id, &ada, "c:bob", "editor").await;
    let mut a = LiveClient::connect(&s, &id, &ada).await;
    let mut b = LiveClient::connect(&s, &id, &bob).await;
    assert_eq!(a.json(), b.json());
    let slide = first_slide(&a.json());
    let el = a.json()["slides"][0]["elements"][0]["id"].as_str().unwrap().to_string();
    // Ada types; Bob sees it with Ada as the author and the slide touched.
    let r = a.edit(json!([{ "op": "update_element", "slide": slide, "element": el, "set": { "text": "Hello from Ada" } }])).await;
    assert_eq!(r["version"], 2);
    let ev = b.receive().await;
    assert_eq!(ev.data["author"]["id"], "c:ada");
    assert_eq!(ev.data["touched"], json!([slide]));
    assert_eq!(ev.data["version"], 2);
    assert_eq!(a.json(), b.json());
    let _ = a.receive().await; // Ada's own echo
    // Presence: Bob says where he is; Ada sees it with Bob's account (not a claimed one).
    let (st, _) = s.post(&format!("/v1/decks/{id}/presence"), &bob, json!({ "session": b.session, "slide": slide, "selection": [el], "cursor": { "x": 10, "y": 20 } })).await;
    assert_eq!(st, 200);
    let p = a.sse.next("presence").await;
    assert_eq!(p.data["account"]["id"], "c:bob");
    assert_eq!(p.data["selection"], json!([el]));
    // Bob drops off; both keep editing; Bob comes back and everything merges.
    let bob_doc = present_deck::clone_doc(&b.doc);
    b.sse.close();
    let left = a.sse.next("presence_left").await;
    assert_eq!(left.data["session"].as_str().unwrap(), b.session);
    a.edit(json!([{ "op": "replace_text", "slide": slide, "element": el, "find": "Hello", "replace": "Hi" }])).await;
    let (offline, _) = present_deck::apply_ops_update(&bob_doc, &present_deck::parse_ops(&json!([
        { "op": "replace_text", "slide": slide, "element": el, "find": "Ada", "replace": "Ada and Bob" },
        { "op": "add_slide", "slide": { "id": "s_bob001", "notes": "written offline" } }
    ])).unwrap()).unwrap();
    bob_doc.transact_mut().apply_update(yrs::Update::decode_v1(&offline).unwrap()).unwrap();
    let b2 = LiveClient::connect_with_doc(&s, &id, &bob, bob_doc).await;
    let merged = s.content(&id, &ada).await;
    assert_eq!(present_deck::plain_text(&merged["slides"][0]["elements"][0]["text"]), "Hi from Ada and Bob\n");
    assert_eq!(merged["slides"][1]["notes"], "written offline");
    let mut synced = b2.json();
    synced["id"] = merged["id"].clone();
    synced["title"] = merged["title"].clone();
    synced["version"] = merged["version"].clone();
    // Bob's doc has everything too once Ada's change arrives (it was in the sync).
    assert_eq!(synced, merged);
    // Resending the same update changes nothing and logs nothing.
    let again = b2.send(offline).await;
    assert_eq!(again["changed"], false);
    // A viewer can't send updates.
    let carol = s.person("c:carol");
    s.share("decks", &id, &ada, "c:carol", "viewer").await;
    let (st, e) = s.post(&format!("/v1/decks/{id}/updates"), &carol, json!({ "update": b64(&[0, 0]) })).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (403, "edit_not_allowed"));
    s.stop().await;
}

#[tokio::test]
async fn ops_on_an_old_base_merge_into_newer_edits() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let bot = s.person("si:designer");
    let id = s.deck(&ada, "Merge").await;
    s.share("decks", &id, &ada, "si:designer", "editor").await;
    let c = s.content(&id, &ada).await;
    let slide = first_slide(&c);
    let el = c["slides"][0]["elements"][0]["id"].as_str().unwrap().to_string();
    let (st, r) = s.edits(&id, &ada, json!([{ "op": "update_element", "slide": slide, "element": el, "set": { "text": "Revenue grew" } }])).await;
    assert_eq!(st, 200, "{r}");
    let base = r["version"].as_i64().unwrap();
    // Ada keeps editing.
    s.edits(&id, &ada, json!([{ "op": "replace_text", "slide": slide, "element": el, "find": "grew", "replace": "grew 40%" }])).await;
    // The Silicon edits the version it pulled.
    let (st, r) = s.post(&format!("/v1/decks/{id}/edits"), &bot, json!({ "base": base, "summary": "Rebuilt slide 1", "ops": [
        { "op": "replace_text", "slide": slide, "element": el, "find": "Revenue", "replace": "Net revenue" },
        { "op": "add_element", "slide": slide, "element": { "kind": "chart", "chart": { "type": "bar", "labels": ["Q3", "Q4"], "series": [{ "name": "2026", "values": [1, 2] }] } } }
    ]})).await;
    assert_eq!(st, 200, "{r}");
    assert_eq!(r["elementsAdded"].as_array().unwrap().len(), 1);
    assert_eq!(r["summary"], "Rebuilt slide 1");
    let c = s.content(&id, &ada).await;
    assert_eq!(present_deck::plain_text(&c["slides"][0]["elements"][0]["text"]), "Net revenue grew 40%\n");
    assert_eq!(c["slides"][0]["elements"].as_array().unwrap().len(), 3);
    // replace_text errors come back with the deck's error shape.
    let (st, e) = s.edits(&id, &bot, json!([{ "op": "replace_text", "slide": slide, "element": el, "find": "Gross revenue", "replace": "x" }])).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (409, "text_not_found"));
    assert!(e["error"]["hint"].as_str().unwrap().contains("Net revenue"), "{e}");
    let (st, e) = s.edits(&id, &bot, json!([{ "op": "explode" }])).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (400, "invalid_op"));
    // Text view.
    let resp = s.http.get(format!("{}/v1/decks/{id}/content?format=text", s.url)).bearer_auth(&bot.token).send().await.unwrap();
    let text = resp.text().await.unwrap();
    assert!(text.contains("Net revenue grew 40%"), "{text}");
    assert!(text.contains("bar chart"), "{text}");
    s.stop().await;
}

#[tokio::test]
async fn trash_restore_and_permanent_delete() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let bob = s.person("c:bob");
    let id = s.deck(&ada, "Old deck").await;
    s.share("decks", &id, &ada, "c:bob", "editor").await;
    let (st, e) = s.req("DELETE", &format!("/v1/decks/{id}"), Some(&bob), None).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (403, "owner_only"));
    let (st, d) = s.req("DELETE", &format!("/v1/decks/{id}"), Some(&ada), None).await;
    assert_eq!(st, 200);
    assert!(d["trashedAt"].is_string());
    let (_, t) = s.get("/v1/decks?scope=trash", Some(&ada)).await;
    assert_eq!(t["decks"][0]["id"], id.as_str());
    let (_, m) = s.get("/v1/decks?scope=mine", Some(&ada)).await;
    assert!(m["decks"].as_array().unwrap().is_empty());
    let (st, e) = s.get(&format!("/v1/decks/{id}"), Some(&bob)).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (404, "deck_in_trash"));
    let (st, e) = s.edits(&id, &ada, json!([{ "op": "add_slide", "slide": {} }])).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (409, "deck_in_trash"));
    // Permanent delete needs the trash and the exact title.
    let (st, e) = s.req("DELETE", &format!("/v1/decks/{id}?permanent=true&confirm=wrong"), Some(&ada), None).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (400, "confirmation_required"));
    let (st, _) = s.post(&format!("/v1/decks/{id}/untrash"), &ada, json!({})).await;
    assert_eq!(st, 200);
    let (st, _) = s.get(&format!("/v1/decks/{id}"), Some(&bob)).await;
    assert_eq!(st, 200);
    let (st, e) = s.req("DELETE", &format!("/v1/decks/{id}?permanent=true&confirm=Old%20deck"), Some(&ada), None).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (409, "not_in_trash"));
    s.req("DELETE", &format!("/v1/decks/{id}"), Some(&ada), None).await;
    let (st, _) = s.req("DELETE", &format!("/v1/decks/{id}?permanent=true&confirm=Old%20deck"), Some(&ada), None).await;
    assert_eq!(st, 204);
    let (st, _) = s.get(&format!("/v1/decks/{id}"), Some(&ada)).await;
    assert_eq!(st, 404);
    let left: i64 = sqlx::query_scalar("select count(*) from deck_updates").fetch_one(&s.pool).await.unwrap();
    assert_eq!(left, 0);
    // Folders: trashing hides everything inside from others; permanent delete takes it all.
    let (_, f) = s.post("/v1/folders", &ada, json!({ "name": "Archive" })).await;
    let folder = f["id"].as_str().unwrap().to_string();
    let (_, d) = s.post("/v1/decks", &ada, json!({ "title": "Inside", "folder": folder })).await;
    let inside = d["id"].as_str().unwrap().to_string();
    s.share("folders", &folder, &ada, "c:bob", "viewer").await;
    assert_eq!(s.get(&format!("/v1/decks/{inside}"), Some(&bob)).await.0, 200);
    s.req("DELETE", &format!("/v1/folders/{folder}"), Some(&ada), None).await;
    assert_eq!(s.get(&format!("/v1/decks/{inside}"), Some(&bob)).await.0, 404);
    let (st, _) = s.req("DELETE", &format!("/v1/folders/{folder}?permanent=true&confirm=Archive"), Some(&ada), None).await;
    assert_eq!(st, 204);
    assert_eq!(s.get(&format!("/v1/decks/{inside}"), Some(&ada)).await.0, 404);
    s.stop().await;
}

#[tokio::test]
async fn search_finds_titles_text_notes_and_tables_the_caller_can_see() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let bob = s.person("c:bob");
    let id = s.deck(&ada, "Pricing strategy").await;
    let c = s.content(&id, &ada).await;
    let slide = first_slide(&c);
    s.edits(&id, &ada, json!([
        { "op": "update_slide", "slide": slide, "set": { "notes": "Mention the zebra discount" } },
        { "op": "add_element", "slide": slide, "element": { "kind": "table", "cells": [["Plan", "Price"], ["Walrus", "$9"]] } },
        { "op": "add_slide", "slide": { "elements": [ { "kind": "text", "text": "Our octopus plan" } ] } }
    ])).await;
    let (_, r) = s.get("/v1/search?q=zebra", Some(&ada)).await;
    assert_eq!(r["results"][0]["matches"][0]["where"], "notes");
    let (_, r) = s.get("/v1/search?q=walrus", Some(&ada)).await;
    assert_eq!(r["results"][0]["matches"][0]["where"], "table");
    let (_, r) = s.get("/v1/search?q=octopus", Some(&ada)).await;
    assert_eq!(r["results"][0]["matches"][0]["slideNumber"], 2);
    let (_, r) = s.get("/v1/search?q=pricing", Some(&ada)).await;
    assert_eq!(r["results"][0]["matches"][0]["where"], "title");
    let (_, r) = s.get("/v1/search?q=zebra", Some(&bob)).await;
    assert!(r["results"].as_array().unwrap().is_empty());
    s.share("decks", &id, &ada, "c:bob", "viewer").await;
    let (_, r) = s.get("/v1/search?q=zebra", Some(&bob)).await;
    assert_eq!(r["results"].as_array().unwrap().len(), 1);
    s.stop().await;
}

#[tokio::test]
async fn retried_requests_with_an_idempotency_key_act_once() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let h = [("Idempotency-Key", "create-q4-1")];
    let ((st1, d1), _) = s.req_h("POST", "/v1/decks", Some(&ada), Some(json!({ "title": "Once" })), &h).await;
    let ((st2, d2), headers) = s.req_h("POST", "/v1/decks", Some(&ada), Some(json!({ "title": "Once" })), &h).await;
    assert_eq!((st1, st2), (201, 201));
    assert_eq!(d1["id"], d2["id"]);
    assert_eq!(headers.get("idempotent-replayed").unwrap(), "true");
    let (_, mine) = s.get("/v1/decks", Some(&ada)).await;
    assert_eq!(mine["decks"].as_array().unwrap().len(), 1);
    let ((st, e), _) = s.req_h("POST", "/v1/folders", Some(&ada), Some(json!({ "name": "x" })), &h).await;
    assert_eq!((st, e["error"]["code"].as_str().unwrap()), (409, "idempotency_key_reused"));
    // Ops retried with the same key apply once.
    let id = d1["id"].as_str().unwrap();
    let k = [("Idempotency-Key", "ops-1")];
    let body = json!({ "ops": [ { "op": "add_slide", "slide": {} } ] });
    let ((_, r1), _) = s.req_h("POST", &format!("/v1/decks/{id}/edits"), Some(&ada), Some(body.clone()), &k).await;
    let ((_, r2), _) = s.req_h("POST", &format!("/v1/decks/{id}/edits"), Some(&ada), Some(body), &k).await;
    assert_eq!(r1, r2);
    assert_eq!(s.content(id, &ada).await["slides"].as_array().unwrap().len(), 2);
    s.stop().await;
}
