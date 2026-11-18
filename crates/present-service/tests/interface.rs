//! An independent HTTP client plus two upstream authorities. Only the test authority can change a team membership.
mod common;
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
};
use base64::Engine;
use common::Stack;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Default)]
struct Data {
    profiles: HashMap<String, Value>,
    books: HashMap<(String, String), Value>,
    roles: HashMap<String, bool>,
}
type Store = Arc<Mutex<Data>>;
fn who(h: &HeaderMap, prefix: &str) -> String {
    let raw = h["authorization"]
        .to_str()
        .unwrap()
        .strip_prefix(prefix)
        .expect("correct authority");
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw.split('.').nth(1).unwrap())
        .unwrap();
    serde_json::from_slice::<Value>(&bytes).unwrap()["sub"]
        .as_str()
        .unwrap()
        .into()
}
async fn authority() -> (String, Store) {
    let data: Store = Default::default();
    async fn lookup(
        State(db): State<Store>,
        h: HeaderMap,
        Query(q): Query<HashMap<String, String>>,
    ) -> axum::response::Response {
        assert!(
            h["authorization"]
                .to_str()
                .unwrap()
                .starts_with("Proof test-")
        );
        let db = db.lock().unwrap();
        let account = db
            .profiles
            .values()
            .find(|a| a["id"] == q["q"] || a["uuid"] == q["q"]);
        match account {
            Some(a) => Json(a.clone()).into_response(),
            None => (
                StatusCode::NOT_FOUND,
                Json(json!({"error":{"code":"account_not_found"}})),
            )
                .into_response(),
        }
    }
    async fn list(
        State(db): State<Store>,
        h: HeaderMap,
        Query(q): Query<HashMap<String, usize>>,
    ) -> Json<Value> {
        let owner = who(&h, "Proof test-read-");
        let db = db.lock().unwrap();
        let mut items: Vec<_> = db
            .books
            .iter()
            .filter(|((o, _), _)| o == &owner)
            .map(|(_, v)| v.clone())
            .collect();
        items.sort_by_key(|v| v["uuid"].as_str().unwrap().to_owned());
        // A single item per page exercises all-page ranking even with two contacts.
        Json(
            json!({"total":items.len(),"items":items.into_iter().skip(q["offset"]).take(1).collect::<Vec<_>>()}),
        )
    }
    async fn save(
        State(db): State<Store>,
        h: HeaderMap,
        Json(mut entry): Json<Value>,
    ) -> Json<Value> {
        let owner = who(&h, "Proof test-write-");
        let mut db = db.lock().unwrap();
        let id = entry["id"].as_str().unwrap().to_owned();
        entry["account"] = db.profiles[&id].clone();
        entry["uuid"] = json!(id);
        db.books.insert((owner, id), entry.clone());
        Json(entry)
    }
    async fn get_contact(
        State(db): State<Store>,
        h: HeaderMap,
        Path(id): Path<String>,
    ) -> axum::response::Response {
        let writing = h["authorization"]
            .to_str()
            .unwrap()
            .starts_with("Proof test-write-");
        let owner = who(
            &h,
            if writing {
                "Proof test-write-"
            } else {
                "Proof test-read-"
            },
        );
        match db.lock().unwrap().books.get(&(owner, id)) {
            Some(entry) => Json(entry.clone()).into_response(),
            None => (
                StatusCode::NOT_FOUND,
                Json(json!({"error":{"code":"contact_not_found"}})),
            )
                .into_response(),
        }
    }
    async fn remove(State(db): State<Store>, h: HeaderMap, Path(id): Path<String>) -> Json<Value> {
        let owner = who(&h, "Proof test-write-");
        Json(json!({"deleted":db.lock().unwrap().books.remove(&(owner,id)).is_some()}))
    }
    async fn org_me(State(db): State<Store>, h: HeaderMap) -> Json<Value> {
        let uuid = who(&h, "Bearer ");
        let role = db.lock().unwrap().roles.get(&uuid).copied();
        let org = json!({"org_id":"acme","name":"Acme","capabilities":{"admin":role==Some(true)}});
        let target = json!({"type":"team","id":"acme/design","name":"Design","org_id":"acme"});
        Json(json!({
            "account_uuid":uuid,
            "organizations":role.map(|_| vec![org]).unwrap_or_default(),
            "groups":role.map(|_|vec!["organization:acme", "team:acme/design"]).unwrap_or_default(),
            "share_targets":role.map(|_|vec![target]).unwrap_or_default()
        }))
    }
    async fn org_action(
        State(db): State<Store>,
        h: HeaderMap,
        Json(body): Json<Value>,
    ) -> axum::response::Response {
        let uuid = who(&h, "Bearer ");
        assert_eq!(h["idempotency-key"], "team-example");
        if db.lock().unwrap().roles.get(&uuid) != Some(&true) {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":{"code":"forbidden"}})),
            )
                .into_response();
        }
        assert_eq!(body["action"], "team_create");
        Json(json!({"ok":true,"name":body["name"]})).into_response()
    }
    let app = Router::new()
        .route(
            "/v1/me",
            get(|h: HeaderMap| async move { Json(json!({"uuid":who(&h,"Proof test-read-")})) }),
        )
        .route("/v1/lookup", get(lookup))
        .route("/v1/contacts", get(list).post(save))
        .route("/v1/contacts/{id}", get(get_contact).delete(remove))
        .route(
            "/v1/relationships",
            get(|h: HeaderMap| async move {
                who(&h, "Proof test-read-");
                Json(json!({"items":[]}))
            }),
        )
        .route(
            "/v1/photos/{id}",
            get(|h: HeaderMap| async move {
                who(&h, "Proof test-read-");
                common::PNG
            }),
        )
        .route("/v1/integrations/present/me", get(org_me))
        .route(
            "/v1/integrations/present/orgs/acme/actions",
            axum::routing::post(org_action),
        )
        .with_state(data.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), data)
}

#[tokio::test]
async fn standalone_people_team_sharing_and_ting() {
    let (origin, authority) = authority().await;
    let s = Stack::with_integrations(&origin).await;
    let owner = s.person("c:owner.acme");
    let member = s.person("si:review.acme");
    let outsider = s.person("c:outside");
    let photo = Uuid::new_v4();
    {
        let mut a = authority.lock().unwrap();
        a.roles.insert(owner.uuid.to_string(), true);
        a.roles.insert(member.uuid.to_string(), false);
        for p in [&owner, &member, &outsider] {
            a.profiles.insert(p.uuid.to_string(),json!({"uuid":p.uuid,"kind":if p.handle.starts_with("si:"){"silicon"}else{"carbon"},"id":p.handle,"display_name":p.handle,"pfp_url":"https://example.test/picture.png"}));
        }
    }
    let resp = s
        .http
        .request(reqwest::Method::OPTIONS, format!("{}/v1/decks", s.url))
        .header("origin", "https://interface.example")
        .header("access-control-request-method", "POST")
        .header(
            "access-control-request-headers",
            "authorization,content-type,idempotency-key",
        )
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
    assert_eq!(resp.headers()["access-control-allow-origin"], "*");
    let doc = s.get("/openapi.json", None).await;
    assert_eq!(doc.1["openapi"], "3.1.0");
    assert_eq!(s.get("/v1/people", None).await.0, 401);
    let revoked = s.person("c:revoked");
    let wrong = s.person("c:wrongtype");
    for p in [&revoked, &wrong] {
        assert_eq!(
            s.get("/v1/me", Some(p)).await.1["error"]["code"],
            "token_inactive"
        );
    }
    assert_eq!(
        s.get("/v1/organizations", Some(&owner)).await.1["organizations"][0]["capabilities"]["admin"],
        true
    );
    assert_eq!(
        s.post(
            "/v1/contacts",
            &owner,
            json!({"id":member.handle,"name":"Review partner","trust":190})
        )
        .await
        .0,
        403
    );
    assert_eq!(
        s.req(
            "PUT",
            "/v1/contacts/connection",
            Some(&owner),
            Some(json!({"connected":true}))
        )
        .await
        .0,
        200
    );
    for (p, name, trust) in [
        (&member, "Review partner", 190),
        (&outsider, "Review peer", 4),
    ] {
        assert_eq!(
            s.post(
                "/v1/contacts",
                &owner,
                json!({"id":p.handle,"name":name,"trust":trust})
            )
            .await
            .0,
            200
        );
    }
    {
        let mut a = authority.lock().unwrap();
        let saved = a
            .books
            .get_mut(&(owner.uuid.to_string(), member.uuid.to_string()))
            .unwrap();
        saved["photo_id"] = json!(photo);
        saved["note"] = json!("Private note kept across edits");
    }
    let result = s
        .post(
            "/v1/contacts",
            &owner,
            json!({"id":member.uuid,"name":"Review partner","trust":255}),
        )
        .await
        .1;
    assert_eq!(result["pfp"], format!("/v1/contacts/photos/{photo}"));
    assert_eq!(
        authority.lock().unwrap().books[&(owner.uuid.to_string(), member.uuid.to_string())]["note"],
        "Private note kept across edits"
    );
    let ranked = s.get("/v1/people?q=rvw", Some(&owner)).await.1;
    assert_eq!(ranked["total"], 2);
    assert_eq!(ranked["items"][0]["uuid"], member.uuid.to_string());
    assert_eq!(
        s.get("/v1/people?q=rvw", Some(&outsider)).await.1["total"],
        0
    );
    assert_eq!(
        s.get(
            &format!("/v1/accounts/resolve?q={}", member.handle),
            Some(&owner)
        )
        .await
        .1["account"]["displayName"],
        "Review partner"
    );
    let action_path = "/v1/organizations/acme/actions";
    let team_action = json!({"action":"team_create","name":"Product"});
    assert_eq!(
        s.post(action_path, &owner, team_action.clone()).await.0,
        400
    );
    for (who, expected) in [(&owner, 200), (&member, 403)] {
        let ((status, _), _) = s
            .req_h(
                "POST",
                action_path,
                Some(who),
                Some(team_action.clone()),
                &[("Idempotency-Key", "team-example")],
            )
            .await;
        assert_eq!(status, expected);
    }
    let folder = s
        .post("/v1/folders", &owner, json!({"name":"Interface folder"}))
        .await
        .1["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = s
        .post(
            "/v1/decks",
            &owner,
            json!({"title":"Interface deck","folder":folder}),
        )
        .await
        .1["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let deck = format!("/v1/decks/{id}");
    let team_path = format!("/v1/folders/{folder}/groups");
    assert_ne!(s.get(&deck, Some(&member)).await.0, 200);
    let grant = json!({"principal":"team:acme/design","role":"editor"});
    assert_eq!(
        s.req("PUT", &team_path, Some(&owner), Some(grant)).await.0,
        200
    );
    assert_eq!(s.get(&deck, Some(&member)).await.1["role"], "editor");
    assert_eq!(
        s.get("/v1/decks?scope=shared", Some(&member)).await.1["decks"][0]["id"],
        id
    );
    assert_eq!(
        s.get("/v1/search?q=Interface", Some(&member)).await.1["results"][0]["deck"]["id"],
        id
    );
    assert_eq!(
        s.get(&format!("{deck}/groups"), Some(&member)).await.1["groups"][0]["inherited"],
        true
    );
    assert_ne!(s.get(&deck, Some(&outsider)).await.0, 200);
    let editor = s
        .edits(
            &id,
            &member,
            json!([{"op":"add_slide","slide":{"id":"s_review","notes":"Discuss the design."}}]),
        )
        .await;
    assert_eq!(editor.0, 200, "{editor:?}");
    authority
        .lock()
        .unwrap()
        .roles
        .remove(&member.uuid.to_string());
    assert_eq!(s.get(&deck, Some(&member)).await.0, 403);
    authority
        .lock()
        .unwrap()
        .roles
        .insert(member.uuid.to_string(), false);
    s.share("decks", &id, &owner, &member.handle, "viewer")
        .await;
    let access = s.get(&format!("{deck}/access"), Some(&owner)).await.1;
    assert_eq!(
        access["members"][0]["account"]["displayName"],
        "Review partner"
    );
    let offer = s
        .post(
            &format!("{deck}/transfer"),
            &owner,
            json!({"to":member.uuid}),
        )
        .await;
    assert_eq!(offer.0, 201, "{offer:?}");
    let tid = offer.1["id"].as_str().unwrap();
    assert_eq!(
        s.post(&format!("/v1/transfers/{tid}/decline"), &member, json!({}))
            .await
            .0,
        200
    );
    let outbox = s.outbox().await;
    for kind in ["present.deckShared", "present.transferChanged"] {
        assert!(outbox.iter().any(|t| t.0 == kind && t.1 == member.uuid));
    }
    let deletion = s
        .req(
            "DELETE",
            &format!("/v1/contacts/{}", member.uuid),
            Some(&owner),
            None,
        )
        .await;
    assert_eq!(deletion.0, 200);
    assert_eq!(
        s.get("/v1/contacts?q=rvw", Some(&owner)).await.1["total"],
        1
    );
    assert_eq!(
        s.req(
            "PUT",
            "/v1/contacts/connection",
            Some(&owner),
            Some(json!({"connected":false}))
        )
        .await
        .0,
        200
    );
    assert_eq!(
        s.get(&format!("/v1/contacts/photos/{photo}"), Some(&owner))
            .await
            .0,
        403
    );
    s.stop().await;
}
