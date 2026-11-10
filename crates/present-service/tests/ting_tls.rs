use present_service::{Config, real_deps};
use serde_json::json;

// A separate test binary starts with no process-global provider. Plain ws://
// stand-ins do not exercise the implicit Rustls builder used by wss://.
#[tokio::test]
async fn real_adapters_initialize_websocket_tls() {
    let cfg = Config::from_lookup(|key| {
        Some(match key {
            "PRESENT_DATABASE_URL" => "postgres://localhost/present",
            "PRESENT_PUBLIC_URL" => "http://127.0.0.1:4321",
            "PRESENT_WEB_URL" => "http://127.0.0.1:4320",
            "PRESENT_DATA_DIR" => "/tmp/present-ting-tls",
            "ACCOUNTS_URL" => "https://accounts.teamofsilicons.com",
            "PRESENT_APP_SECRET" => "sa_app_test_unused",
            _ => return None,
        }.to_owned())
    }).unwrap();
    real_deps(&cfg).unwrap();
    assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    let _ = rustls::ClientConfig::builder()
        .with_root_certificates(rustls::RootCertStore::empty())
        .with_no_client_auth();

    if let Ok(origin) = std::env::var("PRESENT_TING_TLS_SMOKE_URL") {
        assert!(origin.starts_with("https://"));
        let client = ting_client::Client::new(&origin).unwrap();
        let mut receiver = ting_client::websocket::WebSocket::connect(&client).await.unwrap();
        let registered = receiver.register(&["present".into()], None).await.unwrap();
        assert_eq!(registered["session_id"], receiver.session_id());
        assert_eq!(registered["for"], serde_json::Value::Null);
        assert_eq!(registered["app_ids"], json!(["present"]));
    }
}
