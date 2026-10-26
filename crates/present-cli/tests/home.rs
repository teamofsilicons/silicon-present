//! Exercise native home discovery and repeated state replacement through the shipped command.
use serde_json::Value;
use std::{path::Path, process::Command};

fn run(profile: &Path, home: Option<&Path>, silicon_home: Option<&Path>, args: &[&str]) -> Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_present"));
    command
        .env_remove("SILICON_HOME")
        .env_remove("HOME")
        .env_remove("PRESENT_API_URL")
        .env_remove("ACCOUNTS_URL")
        .env("USERPROFILE", profile);
    if let Some(home) = home {
        command.env("HOME", home);
    }
    if let Some(home) = silicon_home {
        command.env("SILICON_HOME", home);
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
fn windows_profile_discovers_home_without_creating_state() {
    let profile = tempfile::tempdir().unwrap();
    let info = run(profile.path(), None, None, &["config", "home", "--json"]);
    assert_eq!(info["home"], profile.path().display().to_string());
    assert_eq!(info["source"], "USERPROFILE");
    assert!(!profile.path().join(".present").exists());
}

#[test]
fn explicit_home_precedence_is_preserved() {
    let profile = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let silicon = tempfile::tempdir().unwrap();
    let info = run(
        profile.path(),
        Some(home.path()),
        None,
        &["config", "home", "--json"],
    );
    assert_eq!(info["home"], home.path().display().to_string());
    assert_eq!(info["source"], "HOME");
    let info = run(
        profile.path(),
        Some(home.path()),
        Some(silicon.path()),
        &["config", "home", "--json"],
    );
    assert_eq!(info["home"], silicon.path().display().to_string());
    assert_eq!(info["source"], "SILICON_HOME");
}

#[test]
fn native_state_can_be_replaced_repeatedly_in_profile_home() {
    let profile = tempfile::tempdir().unwrap();
    for url in ["http://127.0.0.1:4321", "http://127.0.0.1:4322"] {
        run(
            profile.path(),
            None,
            None,
            &["config", "api-url", url, "--json"],
        );
        let info = run(profile.path(), None, None, &["config", "show", "--json"]);
        assert_eq!(info["api_url"]["value"], url);
    }
    let state = profile.path().join(".present").join("state.json");
    let saved: Value = serde_json::from_slice(&std::fs::read(state).unwrap()).unwrap();
    assert_eq!(saved["api_url"], "http://127.0.0.1:4322");
    assert_eq!(
        std::fs::read_dir(profile.path().join(".present"))
            .unwrap()
            .count(),
        2
    );
}
