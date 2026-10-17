//! Against the real local Silicon Accounts test stack (e2e/stack/test-stack.json) and the Ting stand-in
//! (tools/ting-standin) on the service-tests lane (4363): real token verification, real account lookups, real
//! proofs, real Ting delivery. Opt in with PRESENT_LIVE_STACK=1 (it needs the stack running and node).

mod common;

use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use serde_json::{Value, json};

struct Kill(Child);
impl Drop for Kill {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn repo() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[tokio::test]
async fn real_accounts_tokens_lookups_and_ting_delivery() {
    if std::env::var("PRESENT_LIVE_STACK").ok().as_deref() != Some("1") {
        eprintln!("skipped: set PRESENT_LIVE_STACK=1 to run against the local Silicon Accounts stack");
        return;
    }
    let stack: Value = serde_json::from_str(&std::fs::read_to_string(repo().join("e2e/stack/test-stack.json")).unwrap()).unwrap();
    let api = stack["accounts_api_url"].as_str().unwrap().to_string();
    let issuer = stack["accounts_public_url"].as_str().unwrap().to_string();
    // Ting stand-in on the service-tests lane, checking proofs with the seeded ting app.
    let _ting = Kill(
        Command::new("node")
            .arg(repo().join("tools/ting-standin/server.mjs"))
            .env("TING_PORT", "4363")
            .env("ACCOUNTS_API_URL", &api)
            .env("TING_APP_SECRET", stack["apps"]["ting"]["app_secret"].as_str().unwrap())
            .stdout(Stdio::null())
            .spawn()
            .expect("node runs the Ting stand-in"),
    );
    let http = reqwest::Client::new();
    for _ in 0..50 {
        if http.get("http://127.0.0.1:4363/health").send().await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    http.delete("http://127.0.0.1:4363/_tings").send().await.unwrap();
    // Tokens for a Carbon and a Silicon.
    let tsx = dirs_home().join("Documents/silicon/silicon-accounts/testkit/node_modules/.bin/tsx");
    let out = Command::new(tsx)
        .current_dir(repo())
        .args(["crates/present-service/tests/live/mint.mts", "--email", "present-service-tests@example.com", "--silicon", "si:present-svc-tester", "--cache", ".dev/live-mint.json"])
        .output()
        .expect("tsx runs the mint script");
    assert!(out.status.success(), "mint failed: {}", String::from_utf8_lossy(&out.stderr));
    let minted: Value = serde_json::from_slice(&out.stdout).unwrap();
    let carbon = &minted["carbon"];
    let silicon = &minted["silicon"];
    // The service with the real adapters, in process.
    let n = rand::random::<u32>();
    let db = format!("present_t_{}_live_{n}", std::process::id());
    let admin = sqlx::PgPool::connect(common::ADMIN_URL).await.unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!("create database {db}"))).execute(&admin).await.unwrap();
    let data = std::env::temp_dir().join(&db);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let env: HashMap<&str, String> = [
        ("PRESENT_DATABASE_URL", format!("postgres://present@127.0.0.1:5490/{db}")),
        ("PRESENT_PUBLIC_URL", url.clone()),
        ("PRESENT_WEB_URL", "http://127.0.0.1:4320".into()),
        ("PRESENT_DATA_DIR", data.display().to_string()),
        ("ACCOUNTS_URL", issuer),
        ("ACCOUNTS_API_URL", api),
        ("PRESENT_APP_SECRET", stack["apps"]["present"]["app_secret"].as_str().unwrap().into()),
        ("PRESENT_TING_URL", "http://127.0.0.1:4363".into()),
        ("PRESENT_IRIS_URL", stack["mock_iris_url"].as_str().unwrap().into()),
    ]
    .into();
    let cfg = present_service::Config::from_lookup(|k| env.get(k).cloned()).unwrap();
    let pool = present_service::connect(&cfg.database_url).await.unwrap();
    let deps = present_service::real_deps(&cfg).unwrap();
    let st = present_service::AppState::new(cfg, pool.clone(), deps);
    present_service::spawn_workers(&st);
    let server = tokio::spawn(present_service::serve(listener, st));
    let call = |method: &str, path: &str, token: &str, body: Option<Value>| {
        let mut r = http.request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), format!("{url}{path}")).bearer_auth(token);
        if let Some(b) = body {
            r = r.json(&b);
        }
        async move {
            let resp = r.send().await.unwrap();
            let s = resp.status().as_u16();
            (s, resp.json::<Value>().await.unwrap_or(Value::Null))
        }
    };
    let ct = carbon["access_token"].as_str().unwrap();
    let stoken = silicon["access_token"].as_str().unwrap();
    let (s, me) = call("GET", "/v1/me", ct, None).await;
    assert_eq!(s, 200, "{me}");
    assert_eq!(me["id"], carbon["id"]);
    assert_eq!(call("GET", "/v1/me", stoken, None).await.1["kind"], "silicon");
    let (s, e) = call("GET", "/v1/me", "eyJhbGciOiJFZERTQSJ9.e30.AAAA", None).await;
    assert_eq!((s, e["error"]["code"].as_str().unwrap()), (401, "token_invalid"));
    // Real lookups: share with the Silicon by si:id; it comments and mentions the Carbon.
    let (s, deck) = call("POST", "/v1/decks", ct, Some(json!({ "title": "Live stack deck" }))).await;
    assert_eq!(s, 201, "{deck}");
    let id = deck["id"].as_str().unwrap().to_string();
    let (s, m) = call("POST", &format!("/v1/decks/{id}/access"), ct, Some(json!({ "to": silicon["id"], "role": "editor" }))).await;
    assert_eq!(s, 201, "{m}");
    assert_eq!(m["account"]["uuid"], silicon["uuid"]);
    let mention = format!("@{} have a look", carbon["id"].as_str().unwrap());
    let (s, t) = call("POST", &format!("/v1/decks/{id}/threads"), stoken, Some(json!({ "anchor": { "kind": "deck" }, "body": mention }))).await;
    assert_eq!(s, 201, "{t}");
    // Both tings reach the stand-in through real proofs; both accounts were enrolled on their first request.
    let mut tings = Value::Null;
    for _ in 0..100 {
        tings = http.get("http://127.0.0.1:4363/_tings").send().await.unwrap().json().await.unwrap();
        if tings["tings"].as_array().map(|a| a.len()).unwrap_or(0) >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let list = tings["tings"].as_array().unwrap().clone();
    assert!(list.iter().any(|t| t["type"] == "present.deck.shared" && t["for"] == silicon["uuid"]), "{tings}");
    let m = list.iter().find(|t| t["type"] == "present.mention.received").expect("mention ting");
    assert_eq!(m["for"], carbon["uuid"]);
    assert_eq!(m["data"]["deck"]["id"], id.as_str());
    assert_eq!(m["data"]["comment"]["body"], mention.as_str());
    let subs: Value = http.get("http://127.0.0.1:4363/_subscriptions").send().await.unwrap().json().await.unwrap();
    let subscribed: Vec<&str> = subs["subscriptions"].as_array().unwrap().iter().filter_map(|s| s["for"].as_str()).collect();
    assert!(subscribed.contains(&carbon["uuid"].as_str().unwrap()) && subscribed.contains(&silicon["uuid"].as_str().unwrap()), "{subs}");
    let states: Vec<String> = sqlx::query_scalar("select state from ting_outbox").fetch_all(&pool).await.unwrap();
    assert!(states.iter().all(|s| s == "sent"), "{states:?}");
    server.abort();
    pool.close().await;
    let _ = sqlx::query(sqlx::AssertSqlSafe(format!("drop database if exists {db} with (force)"))).execute(&admin).await;
    let _ = std::fs::remove_dir_all(data);
}

fn dirs_home() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap())
}
