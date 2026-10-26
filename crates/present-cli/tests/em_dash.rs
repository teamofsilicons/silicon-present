//! Run the shipped CLI command tree with isolated Silicon and Carbon sessions.
use serde_json::{Value, json};
use std::{path::Path, process::Command};
use wiremock::{Mock, MockServer, ResponseTemplate, matchers::method};

async fn cli(home: &Path, args: &[&str]) {
    let home = home.to_owned();
    let args: Vec<_> = args.iter().map(|a| a.to_string()).collect();
    let out = tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_present"))
            .env("SILICON_HOME", home)
            .env_remove("PRESENT_API_URL")
            .env_remove("ACCOUNTS_URL")
            .arg("--json")
            .args(args)
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    assert!(
        out.status.success(),
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
#[tokio::test]
async fn silicon_rewrites_carbon_preserves_and_override_is_one_command() {
    for kind in ["silicon", "carbon"] {
        let server = MockServer::start().await;
        let api = server.uri();
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"id":"dk7Hq2mP9xRt","title":"Saved","body":"Saved"})),
            )
            .mount(&server)
            .await;
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".present")).unwrap();
        std::fs::write(root.path().join(".present/state.json"), json!({"api_url":api,"accounts_url":api,"sign_ins":{&api:{
            "accounts_url":api,"app_id":"present","access_token":"test","refresh_token":"test","expires_at":4102444800_i64,
            "account":{"uuid":"test","id":if kind=="silicon" {"si:test"} else {"c:test"},"kind":kind},"method":"slt","signed_in_at":0
        }}}).to_string()).unwrap();
        cli(root.path(), &["new", "Title—one"]).await;
        cli(
            root.path(),
            &["--dangerously-use-em-dash", "reply", "th_test", "Reply—one"],
        )
        .await;
        cli(root.path(), &["reply", "th_test", "Reply—two"]).await;
        let b: Vec<Value> = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .map(|r| serde_json::from_slice(&r.body).unwrap())
            .collect();
        let dash = if kind == "silicon" { "-" } else { "—" };
        assert_eq!(b[0]["title"], format!("Title{dash}one"));
        assert_eq!(b[1]["body"], "Reply—one");
        assert_eq!(b[2]["body"], format!("Reply{dash}two"));
    }
}
