//! Discover the production endpoint through the real CLI without a browser session or network calls.
use serde_json::Value;
use std::{path::Path, process::Command};

fn cli(home: &Path, args: &[&str], endpoint: Option<&str>) -> Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_present"));
    command
        .env("SILICON_HOME", home)
        .env_remove("PRESENT_API_URL")
        .env_remove("ACCOUNTS_URL");
    if let Some(endpoint) = endpoint {
        command.env("PRESENT_API_URL", endpoint);
    }
    let output = command.args(args).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn fresh_cli_discovers_the_public_bearer_endpoint() {
    let home = tempfile::tempdir().unwrap();
    let info = cli(home.path(), &["accounts", "--json"], None);
    assert_eq!(
        info["api_url"],
        "https://backend.present.teamofsilicons.com"
    );
    let settings = cli(home.path(), &["config", "show", "--json"], None);
    assert_eq!(settings["api_url"]["source"], "default");
    assert_eq!(
        settings["api_url"]["value"],
        "https://backend.present.teamofsilicons.com"
    );
}

#[test]
fn explicit_endpoints_keep_precedence_over_the_production_default() {
    let home = tempfile::tempdir().unwrap();
    cli(
        home.path(),
        &["config", "api-url", "http://127.0.0.1:4321", "--json"],
        None,
    );
    assert_eq!(
        cli(home.path(), &["accounts", "--json"], None)["api_url"],
        "http://127.0.0.1:4321"
    );
    assert_eq!(
        cli(
            home.path(),
            &["accounts", "--json"],
            Some("http://127.0.0.1:4322")
        )["api_url"],
        "http://127.0.0.1:4322"
    );
    assert_eq!(
        cli(
            home.path(),
            &["accounts", "--api-url", "http://127.0.0.1:4323", "--json"],
            Some("http://127.0.0.1:4322")
        )["api_url"],
        "http://127.0.0.1:4323"
    );
}
