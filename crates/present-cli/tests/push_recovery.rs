//! Execute the real CLI against a local HTTP peer: persisted state must prevent replay after refresh failures.
use serde_json::{Value, json};
use std::{
    path::Path,
    process::{Command, Output},
};
use wiremock::{
    Mock, MockServer, Request, ResponseTemplate,
    matchers::{method, path, query_param},
};
const ID: &str = "dk7Hq2mP9xRt";
fn write(path: &Path, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}
fn folder(root: &Path, api: &str) -> std::path::PathBuf {
    let dir = root.join("deck");
    let base = json!({"id":ID,"title":"Retry","version":1,"slides":[{"id":"s_000001","notes":"before","elements":[]}]});
    write(&dir.join(".present/base.json"), &base);
    write(
        &dir.join(".present/pull.json"),
        &json!({"deck":ID,"version":1}),
    );
    write(
        &dir.join("deck.json"),
        &json!({"id":ID,"title":"Retry","version":1}),
    );
    write(
        &dir.join("slides/01-s_000001/slide.json"),
        &json!({"id":"s_000001","notes":"after","elements":[]}),
    );
    write(
        &root.join("home/.present/state.json"),
        &json!({"api_url":api,"accounts_url":api,"sign_ins":{api:{"accounts_url":api,"app_id":"present","access_token":"local-test-token","refresh_token":"local-test-refresh","expires_at":4102444800_i64,"method":"slt","signed_in_at":0,"account":{"uuid":"test","id":"si:test","kind":"silicon"}}}}),
    );
    dir
}
async fn cli(root: &Path, args: Vec<String>) -> Output {
    let root = root.to_owned();
    tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_present"))
            .env("SILICON_HOME", root.join("home"))
            .args(args)
            .output()
            .unwrap()
    })
    .await
    .unwrap()
}
fn push(dir: &Path, extra: &[&str]) -> Vec<String> {
    let mut args = vec!["push".into(), dir.display().to_string(), "--json".into()];
    args.extend(extra.iter().map(|s| s.to_string()));
    args
}
fn error(out: &Output) -> String {
    serde_json::from_slice::<Value>(&out.stderr).unwrap()["error"]["code"]
        .as_str()
        .unwrap()
        .into()
}
#[tokio::test]
async fn no_refresh_cannot_replay_and_pull_advances_base() {
    let server = MockServer::start().await;
    let root = tempfile::tempdir().unwrap();
    let dir = folder(root.path(), &server.uri());
    Mock::given(method("POST"))
        .and(path(format!("/v1/decks/{ID}/edits")))
        .respond_with(|req: &Request| {
            assert!(
                req.headers
                    .get("idempotency-key")
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("push:")
            );
            ResponseTemplate::new(200).set_body_json(json!({"version":2,"changed":true}))
        })
        .expect(1)
        .mount(&server)
        .await;
    let first = cli(root.path(), push(&dir, &["--no-refresh"])).await;
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let retry = cli(root.path(), push(&dir, &[])).await;
    assert_eq!(error(&retry), "pull_needed");
    Mock::given(method("GET")).and(path(format!("/v1/decks/{ID}/content")))
  .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id":ID,"title":"Retry","version":2,"master":{"elements":[]},"slides":[{"id":"s_000001","notes":"after","elements":[]}]})))
  .mount(&server).await;
    let pulled = cli(
        root.path(),
        vec![
            "pull".into(),
            ID.into(),
            dir.display().to_string(),
            "--json".into(),
        ],
    )
    .await;
    assert!(
        pulled.status.success(),
        "{}",
        String::from_utf8_lossy(&pulled.stderr)
    );
    let state: Value =
        serde_json::from_slice(&std::fs::read(dir.join(".present/pull.json")).unwrap()).unwrap();
    assert_eq!(state["version"], 2);
    assert!(state.get("pushed").is_none());
}
#[tokio::test]
async fn failed_refresh_preserves_local_files_and_blocks_a_second_push() {
    let server = MockServer::start().await;
    let root = tempfile::tempdir().unwrap();
    let dir = folder(root.path(), &server.uri());
    Mock::given(method("POST"))
        .and(path(format!("/v1/decks/{ID}/edits")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"version":2,"changed":true})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/decks/{ID}/content")))
        .and(query_param("version", "2"))
        .respond_with(ResponseTemplate::new(503).set_body_json(
            json!({"error":{"code":"unavailable","message":"Offline","hint":"Retry"}}),
        ))
        .mount(&server)
        .await;
    assert!(!cli(root.path(), push(&dir, &[])).await.status.success());
    assert_eq!(
        error(&cli(root.path(), push(&dir, &[])).await),
        "pull_needed"
    );
    let raw: Value =
        serde_json::from_slice(&std::fs::read(dir.join("slides/01-s_000001/slide.json")).unwrap())
            .unwrap();
    assert_eq!(raw["notes"], "after");
}
#[tokio::test]
async fn interrupted_refresh_never_pairs_new_content_with_an_old_base_version() {
    let server = MockServer::start().await;
    let root = tempfile::tempdir().unwrap();
    let dir = folder(root.path(), &server.uri());
    write(&dir.join(".present/refreshing.json"), &json!({"version":2}));
    assert_eq!(
        error(&cli(root.path(), push(&dir, &[])).await),
        "pull_needed"
    );
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn one_folder_has_one_writer_and_a_killed_writer_can_be_retried() {
    use std::process::{Child, Stdio};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use std::time::Duration;
    struct KillOnDrop(Child);
    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let server = MockServer::start().await;
    let root = tempfile::tempdir().unwrap();
    let dir = folder(root.path(), &server.uri());
    // Added identities must be generated and persisted exactly once, even with overlapping commands.
    write(
        &dir.join("slides/02-new/slide.json"),
        &json!({"notes":"new slide","elements":[{"kind":"text","text":"new element"}]}),
    );
    let calls = Arc::new(AtomicUsize::new(0));
    Mock::given(method("POST"))
        .and(path(format!("/v1/decks/{ID}/edits")))
        .respond_with(move |_: &Request| {
            let response =
                ResponseTemplate::new(200).set_body_json(json!({"version":2,"changed":true}));
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                response.set_delay(Duration::from_secs(20))
            } else {
                response
            }
        })
        .expect(2)
        .mount(&server)
        .await;
    let mut first = KillOnDrop(
        Command::new(env!("CARGO_BIN_EXE_present"))
            .env("SILICON_HOME", root.path().join("home"))
            .args(push(&dir, &["--no-refresh"]))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if !server.received_requests().await.unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("first push reached the HTTP peer");
    let pending_before = std::fs::read(dir.join(".present/pending.json")).unwrap();
    let slide_before = std::fs::read(dir.join("slides/02-new/slide.json")).unwrap();
    assert_eq!(
        error(&cli(root.path(), push(&dir, &["--no-refresh"])).await),
        "folder_busy"
    );
    assert_eq!(
        error(
            &cli(
                root.path(),
                vec![
                    "pull".into(),
                    ID.into(),
                    dir.display().to_string(),
                    "--force".into(),
                    "--json".into()
                ]
            )
            .await
        ),
        "folder_busy"
    );
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
    assert_eq!(
        std::fs::read(dir.join(".present/pending.json")).unwrap(),
        pending_before
    );
    assert_eq!(
        std::fs::read(dir.join("slides/02-new/slide.json")).unwrap(),
        slide_before
    );
    first.0.kill().unwrap();
    first.0.wait().unwrap();
    let retry = cli(root.path(), push(&dir, &["--no-refresh"])).await;
    assert!(
        retry.status.success(),
        "{}",
        String::from_utf8_lossy(&retry.stderr)
    );
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].body, requests[1].body);
    assert_eq!(
        requests[0].headers.get("idempotency-key"),
        requests[1].headers.get("idempotency-key")
    );
    assert_eq!(
        std::fs::read(dir.join("slides/02-new/slide.json")).unwrap(),
        slide_before
    );
}
