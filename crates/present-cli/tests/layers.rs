//! Exercise the shipped command tree and edit contract against a local HTTP peer.
use serde_json::{Value, json};
use std::{
    path::Path,
    process::{Command, Output},
};
use wiremock::{
    Mock, MockServer, Request, ResponseTemplate,
    matchers::{method, path},
};

const DECK: &str = "dk7Hq2mP9xRt";

fn state(root: &Path, api: &str, signed_in: bool) {
    let mut value = json!({"api_url":api,"accounts_url":api});
    if signed_in {
        value["sign_ins"] = json!({api:{"accounts_url":api,"app_id":"present","access_token":"local-test-token","refresh_token":"local-test-refresh","expires_at":4102444800_i64,"method":"slt","signed_in_at":0,"account":{"uuid":"test","id":"si:test","kind":"silicon"}}});
    }
    let path = root.join(".present/state.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
}

async fn cli(root: &Path, args: &[&str]) -> Output {
    let root = root.to_owned();
    let args: Vec<_> = args.iter().map(|arg| arg.to_string()).collect();
    tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_present"))
            .env("SILICON_HOME", root)
            .env_remove("PRESENT_API_URL")
            .env_remove("ACCOUNTS_URL")
            .args(args)
            .arg("--json")
            .output()
            .unwrap()
    })
    .await
    .unwrap()
}

fn result(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn error(output: &Output) -> Value {
    assert!(!output.status.success());
    serde_json::from_slice::<Value>(&output.stderr).unwrap()["error"].clone()
}

fn content(elements: Value) -> Value {
    json!({"id":DECK,"version":7,"slides":[{"id":"s_000001","elements":elements}],"master":{"id":"master","elements":[]}})
}

async fn serve_content(server: &MockServer, content: Value) {
    Mock::given(method("GET"))
        .and(path(format!("/v1/decks/{DECK}/content")))
        .respond_with(ResponseTemplate::new(200).set_body_json(content))
        .mount(server)
        .await;
}

#[tokio::test]
async fn public_listing_is_front_first_and_preserves_selector_positions() {
    let server = MockServer::start().await;
    let root = tempfile::tempdir().unwrap();
    state(root.path(), &server.uri(), false);
    serve_content(
        &server,
        content(json!([
            {"id":"e_000001","kind":"shape","shape":"rect","group":"g_team","locked":true},
            {"id":"e_000002","kind":"text","text":"Front\nlabel"}
        ])),
    )
    .await;
    let value = result(&cli(root.path(), &["layers", DECK, "1"]).await);
    assert_eq!(value["order"], "front-to-back");
    assert_eq!(value["version"], 7);
    assert_eq!(
        value["layers"][0],
        json!({"id":"e_000002","kind":"text","z":2,"group":null,"locked":false,"label":"Front label"})
    );
    assert_eq!(value["layers"][1]["group"], "g_team");
    assert_eq!(value["layers"][1]["locked"], true);
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(!requests[0].headers.contains_key("authorization"));
}

#[tokio::test]
async fn multi_select_resolves_once_and_submits_one_versioned_transaction() {
    let server = MockServer::start().await;
    let root = tempfile::tempdir().unwrap();
    state(root.path(), &server.uri(), true);
    serve_content(
        &server,
        content(json!([
            {"id":"e_000001","kind":"text","group":"g_team"},
            {"id":"e_000002","kind":"shape","group":"g_team"},
            {"id":"e_000003","kind":"image"},
            {"id":"e_000004","kind":"text"}
        ])),
    )
    .await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/decks/{DECK}/edits")))
        .respond_with(|request: &Request| {
            assert_eq!(
                request.headers.get("authorization").unwrap(),
                "Bearer local-test-token"
            );
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            assert_eq!(body["base"], 7);
            assert_eq!(
                body["ops"],
                json!([
                    {"op":"reorder_element","slide":"s_000001","element":"e_000002","to":3},
                    {"op":"reorder_element","slide":"s_000001","element":"e_000001","to":2}
                ])
            );
            ResponseTemplate::new(200).set_body_json(json!({"version":8,"changed":true}))
        })
        .expect(1)
        .mount(&server)
        .await;
    // Duplicate aliases do not duplicate a source; selecting one group member expands the group.
    let value = result(
        &cli(
            root.path(),
            &["layers", "move", DECK, "1", "text:1", "1", "--to", "front"],
        )
        .await,
    );
    assert_eq!(value["moved"], json!(["e_000001", "e_000002"]));
    assert_eq!(
        value["elements"],
        json!(["e_000003", "e_000004", "e_000001", "e_000002"])
    );
    assert_eq!(value["version"], 8);
}

#[tokio::test]
async fn relative_destination_uses_group_boundary_and_never_moves_a_locked_source() {
    let server = MockServer::start().await;
    let root = tempfile::tempdir().unwrap();
    state(root.path(), &server.uri(), true);
    serve_content(
        &server,
        content(json!([
            {"id":"e_000001","kind":"text","group":"g_team"},
            {"id":"e_000002","kind":"shape","group":"g_team"},
            {"id":"e_000003","kind":"image"},
            {"id":"e_000004","kind":"text","locked":true}
        ])),
    )
    .await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/decks/{DECK}/edits")))
        .respond_with(|request: &Request| {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            assert_eq!(body["base"], 7);
            assert_eq!(
                body["ops"],
                json!([{"op":"reorder_element","slide":"s_000001","element":"e_000003","to":0}])
            );
            ResponseTemplate::new(200).set_body_json(json!({"version":8,"changed":true}))
        })
        .expect(1)
        .mount(&server)
        .await;
    let value = result(
        &cli(
            root.path(),
            &[
                "layers", "move", DECK, "1", "image:1", "4", "--after", "shape:1",
            ],
        )
        .await,
    );
    assert_eq!(value["skipped"], json!(["e_000004"]));
    assert_eq!(
        value["elements"],
        json!(["e_000003", "e_000001", "e_000002", "e_000004"])
    );
}

#[tokio::test]
async fn locked_groups_boundaries_and_selected_targets_do_not_write() {
    let server = MockServer::start().await;
    let root = tempfile::tempdir().unwrap();
    state(root.path(), &server.uri(), true);
    serve_content(
        &server,
        content(json!([
            {"id":"e_000001","kind":"text","group":"g_team"},
            {"id":"e_000002","kind":"shape","group":"g_team","locked":true},
            {"id":"e_000003","kind":"image"}
        ])),
    )
    .await;
    for args in [
        vec!["front", DECK, "1", "1"],
        vec!["back", DECK, "1", "1", "--step"],
        vec!["layers", "move", DECK, "1", "3", "--to", "forward"],
        vec!["layers", "move", DECK, "1", "1", "--before", "2"],
    ] {
        assert_eq!(result(&cli(root.path(), &args).await)["changed"], false);
    }
    assert!(
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .all(|request| request.method == "GET")
    );
}

#[tokio::test]
async fn mutation_requires_sign_in_and_service_permission_is_not_bypassed() {
    let server = MockServer::start().await;
    let root = tempfile::tempdir().unwrap();
    state(root.path(), &server.uri(), false);
    let args = ["layers", "move", DECK, "1", "1", "--to", "front"];
    assert_eq!(
        error(&cli(root.path(), &args).await)["code"],
        "not_signed_in"
    );
    assert!(server.received_requests().await.unwrap().is_empty());
    state(root.path(), &server.uri(), true);
    serve_content(
        &server,
        content(json!([
            {"id":"e_000001","kind":"text"}, {"id":"e_000002","kind":"shape"}
        ])),
    )
    .await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/decks/{DECK}/edits")))
        .respond_with(ResponseTemplate::new(403).set_body_json(
            json!({"error":{"code":"forbidden","message":"Editing requires editor access."}}),
        ))
        .expect(1)
        .mount(&server)
        .await;
    assert_eq!(error(&cli(root.path(), &args).await)["code"], "forbidden");
}

#[tokio::test]
async fn invalid_selectors_and_missing_snapshot_version_never_write() {
    let server = MockServer::start().await;
    let root = tempfile::tempdir().unwrap();
    state(root.path(), &server.uri(), true);
    let mut snapshot =
        content(json!([{"id":"e_000001","kind":"text"},{"id":"e_000002","kind":"shape"}]));
    snapshot.as_object_mut().unwrap().remove("version");
    serve_content(&server, snapshot).await;
    for args in [
        vec!["layers", "move", DECK, "1", "1", "999", "--to", "front"],
        vec!["layers", "move", DECK, "1", "1", "--before", "999"],
    ] {
        assert_eq!(
            error(&cli(root.path(), &args).await)["code"],
            "element_not_found"
        );
    }
    assert_eq!(
        error(&cli(root.path(), &["front", DECK, "1", "1"]).await)["code"],
        "invalid_response"
    );
    assert!(
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .all(|request| request.method == "GET")
    );
}

#[tokio::test]
async fn destination_is_required_and_mutually_exclusive_before_network_access() {
    let server = MockServer::start().await;
    let root = tempfile::tempdir().unwrap();
    state(root.path(), &server.uri(), true);
    for args in [
        vec!["layers", "move", DECK, "1", "1"],
        vec![
            "layers", "move", DECK, "1", "1", "--to", "front", "--before", "2",
        ],
        vec![
            "layers", "move", DECK, "1", "1", "--before", "2", "--after", "3",
        ],
    ] {
        assert_eq!(cli(root.path(), &args).await.status.code(), Some(2));
    }
    assert!(server.received_requests().await.unwrap().is_empty());
}
