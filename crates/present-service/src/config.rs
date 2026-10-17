//! Configuration, all from the environment. Startup fails naming every missing or malformed setting.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

/// Every setting the service reads, with what it means. Printed by `present-service --help`.
pub const ENV_HELP: &str = "\
Silicon Present service. Configuration comes from the environment:

Required
  PRESENT_DATABASE_URL        Postgres URL, e.g. postgres://present@127.0.0.1:5490/present (migrations run at start)
  PRESENT_PUBLIC_URL          The service's own base URL as the converter reaches it, e.g. http://127.0.0.1:4321
  PRESENT_WEB_URL             The web editor's base URL, used in links (tings, follow links), e.g. http://127.0.0.1:4320
  PRESENT_DATA_DIR            Directory for asset files (created if missing), e.g. .dev/data
  ACCOUNTS_URL                Silicon Accounts public URL = the token issuer, e.g. http://localhost:9740
  PRESENT_APP_SECRET          The `present` app's secret at Silicon Accounts (sa_app_...)

Optional
  PRESENT_BIND                Address to listen on (default 127.0.0.1:4321)
  ACCOUNTS_API_URL            Silicon Accounts API for server-to-server calls (default: ACCOUNTS_URL)
  PRESENT_APP_ID              The app id tokens must be issued to (default: present)
  PRESENT_IRIS_URL            Where default profile photos come from: {url}/pfp/{carbon|silicon}?id=<uuid>
                              (default https://iris.teamofsilicons.com)
  PRESENT_CONVERTER_URL       The converter sidecar (renderer/), e.g. http://127.0.0.1:4322; unset = imports,
                              exports and renders answer 503 converter_not_configured
  CONVERTER_SECRET            Shared secret sent as X-Converter-Secret (required when PRESENT_CONVERTER_URL is set)
  PRESENT_TING_URL            Silicon Ting, e.g. https://backend.ting.teamofsilicons.com; unset = tings stay in
                              ting_outbox marked ting_not_configured
  PRESENT_TING_APP_ID         Ting's app id at Silicon Accounts (default: ting)
  PRESENT_TING_TIMEOUT_SECONDS  Timeout for each Ting call (default 15)
  PRESENT_POSTMARK_TOKEN      Postmark server token for invite emails; unset = emails stay in email_outbox and are logged
  PRESENT_MAIL_FROM           From address for invite emails (default present@teamofsilicons.com)
  RUST_LOG                    Log filter (default info)

Silicon Present records no telemetry.
";

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind: SocketAddr,
    pub public_url: String,
    pub web_url: String,
    pub data_dir: PathBuf,
    pub accounts_url: String,
    pub accounts_api_url: String,
    pub app_id: String,
    pub app_secret: String,
    pub iris_url: String,
    pub converter_url: Option<String>,
    pub converter_secret: Option<String>,
    pub ting_url: Option<String>,
    pub ting_app_id: String,
    pub ting_timeout: Duration,
    pub postmark_token: Option<String>,
    pub mail_from: String,
}

fn trim_url(s: String) -> String {
    s.trim().trim_end_matches('/').to_string()
}

impl Config {
    /// Reads the environment. On failure returns one line per problem.
    pub fn from_env() -> Result<Self, Vec<String>> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, Vec<String>> {
        let mut problems = Vec::new();
        let get = |k: &str| get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let mut required = |k: &str, example: &str| match get(k) {
            Some(v) => v,
            None => {
                problems.push(format!("{k} is not set: set it to {example}."));
                String::new()
            }
        };
        let database_url = required("PRESENT_DATABASE_URL", "a Postgres URL, e.g. postgres://present@127.0.0.1:5490/present");
        let public_url = trim_url(required("PRESENT_PUBLIC_URL", "the service's own base URL, e.g. http://127.0.0.1:4321"));
        let web_url = trim_url(required("PRESENT_WEB_URL", "the web editor's base URL, e.g. http://127.0.0.1:4320"));
        let data_dir = required("PRESENT_DATA_DIR", "a directory for asset files, e.g. .dev/data");
        let accounts_url = trim_url(required("ACCOUNTS_URL", "the Silicon Accounts public URL, e.g. http://localhost:9740"));
        let app_secret = required("PRESENT_APP_SECRET", "the present app's secret at Silicon Accounts (sa_app_...)");
        let bind_raw = get("PRESENT_BIND").unwrap_or_else(|| "127.0.0.1:4321".into());
        let bind = match bind_raw.parse::<SocketAddr>() {
            Ok(b) => b,
            Err(_) => {
                problems.push(format!("PRESENT_BIND is `{bind_raw}`, which isn't an address: use host:port, e.g. 127.0.0.1:4321."));
                "127.0.0.1:4321".parse().expect("valid default")
            }
        };
        let converter_url = get("PRESENT_CONVERTER_URL").map(trim_url);
        let converter_secret = get("CONVERTER_SECRET");
        if converter_url.is_some() && converter_secret.is_none() {
            problems.push("CONVERTER_SECRET is not set but PRESENT_CONVERTER_URL is: set it to the converter's shared secret.".into());
        }
        let ting_timeout = match get("PRESENT_TING_TIMEOUT_SECONDS").map(|v| v.parse::<u64>()) {
            None => Duration::from_secs(15),
            Some(Ok(s)) if s > 0 => Duration::from_secs(s),
            Some(_) => {
                problems.push("PRESENT_TING_TIMEOUT_SECONDS must be a whole number of seconds above 0, e.g. 15.".into());
                Duration::from_secs(15)
            }
        };
        if !problems.is_empty() {
            return Err(problems);
        }
        Ok(Config {
            database_url,
            bind,
            public_url,
            web_url,
            data_dir: PathBuf::from(data_dir),
            accounts_api_url: get("ACCOUNTS_API_URL").map(trim_url).unwrap_or_else(|| accounts_url.clone()),
            accounts_url,
            app_id: get("PRESENT_APP_ID").unwrap_or_else(|| "present".into()),
            app_secret,
            iris_url: get("PRESENT_IRIS_URL").map(trim_url).unwrap_or_else(|| "https://iris.teamofsilicons.com".into()),
            converter_url,
            converter_secret,
            ting_url: get("PRESENT_TING_URL").map(trim_url),
            ting_app_id: get("PRESENT_TING_APP_ID").unwrap_or_else(|| "ting".into()),
            ting_timeout,
            postmark_token: get("PRESENT_POSTMARK_TOKEN"),
            mail_from: get("PRESENT_MAIL_FROM").unwrap_or_else(|| "present@teamofsilicons.com".into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn names_every_missing_setting() {
        let err = Config::from_lookup(|_| None).unwrap_err();
        let all = err.join("\n");
        for k in ["PRESENT_DATABASE_URL", "PRESENT_PUBLIC_URL", "PRESENT_WEB_URL", "PRESENT_DATA_DIR", "ACCOUNTS_URL", "PRESENT_APP_SECRET"] {
            assert!(all.contains(k), "{all}");
        }
    }

    #[test]
    fn defaults_fill_the_rest() {
        let env: HashMap<&str, &str> = [
            ("PRESENT_DATABASE_URL", "postgres://x"),
            ("PRESENT_PUBLIC_URL", "http://127.0.0.1:4321/"),
            ("PRESENT_WEB_URL", "http://127.0.0.1:4320"),
            ("PRESENT_DATA_DIR", "/tmp/x"),
            ("ACCOUNTS_URL", "http://localhost:9740"),
            ("PRESENT_APP_SECRET", "s"),
        ]
        .into();
        let c = Config::from_lookup(|k| env.get(k).map(|v| v.to_string())).unwrap();
        assert_eq!(c.public_url, "http://127.0.0.1:4321");
        assert_eq!(c.accounts_api_url, "http://localhost:9740");
        assert_eq!(c.app_id, "present");
        assert_eq!(c.bind.port(), 4321);
        assert!(c.ting_url.is_none());
    }
}
