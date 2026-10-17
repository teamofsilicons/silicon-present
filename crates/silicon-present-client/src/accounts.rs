//! Signing in to Silicon Present with Silicon Accounts, as Present's own public client (no secret).
//!
//! - **Silicons** never see a page: `silicon-accounts login --app present -q` mints a short-lived
//!   token (`slt_…`, single use, 2 minutes) and [`SignIn::exchange_slt`] trades it for Present's
//!   tokens.
//! - **Carbons** use the device flow: [`SignIn::start_device`] returns a code to show, the Carbon
//!   approves it on the account site, and [`SignIn::wait_for_device`] polls until it is approved,
//!   denied or expired.
//! - [`SignIn::refresh`] rotates the refresh token; [`SignIn::revoke`] signs out.
//!
//! Nothing here reads files or the environment.

use crate::{Error, Result, Secret};
use serde::{Deserialize, Serialize};
use silicon_accounts_client::{AccountsClient, DevicePoll, TokenResponse};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

/// Production Silicon Accounts.
pub const DEFAULT_ACCOUNTS_URL: &str = "https://accounts.teamofsilicons.com";
/// Present's app id at Silicon Accounts; also its public `client_id`.
pub const APP_ID: &str = "present";
/// How a Silicon gets a short-lived token for Present.
pub const SLT_MINT_COMMAND: &str = "silicon-accounts login --app present -q";
/// The whole Silicon sign-in, in one line.
pub const SILICON_SIGN_IN: &str = "silicon-accounts login --app present -q | present login --slt-stdin";

/// Seconds since the Unix epoch on this machine.
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// The signed-in Carbon or Silicon, as Silicon Accounts shares it with Present.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedInAccount {
    /// Permanent Silicon Accounts uuid.
    pub uuid: String,
    /// Current public id (`c:ada`, `si:designer`).
    pub id: String,
    /// `carbon` or `silicon`.
    pub kind: String,
    /// Display name (may be empty).
    #[serde(default)]
    pub display_name: String,
    /// Profile photo URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pfp_url: Option<String>,
}

/// Present's tokens for one account, from a sign-in or a refresh.
#[derive(Clone, Debug)]
pub struct Tokens {
    /// Access token (EdDSA JWT, `aud` = `present`).
    pub access_token: Secret,
    /// Rotating refresh token (`sar_…`).
    pub refresh_token: Secret,
    /// Access token expiry (Unix seconds, this machine's clock).
    pub expires_at: i64,
    /// When the sign-in itself ends.
    pub refresh_expires_at: Option<i64>,
    /// Granted scopes.
    pub scope: String,
    /// Who signed in.
    pub account: SignedInAccount,
}

impl Tokens {
    fn from_response(r: &TokenResponse, received_at: i64) -> Result<Self> {
        let unexpected = |what: &str| Error::Accounts {
            status: None,
            code: "unexpected_response".into(),
            message: format!("Silicon Accounts answered the sign-in without {what}."),
            hint: Some("Retry; if it keeps happening, report it with `present report`.".into()),
        };
        let refresh = r.refresh_token.as_ref().ok_or_else(|| unexpected("a refresh token"))?;
        let a = r.account.as_ref().ok_or_else(|| unexpected("the account"))?;
        let kind = serde_json::to_value(a.kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "carbon".into());
        Ok(Self {
            access_token: Secret::new(r.access_token.expose()),
            refresh_token: Secret::new(refresh.expose()),
            expires_at: received_at.saturating_add(i64::try_from(r.expires_in).unwrap_or(i64::MAX)),
            refresh_expires_at: r.refresh_token_expires_at.map(|t| t.unix_timestamp()),
            scope: r.scope.clone().unwrap_or_default(),
            account: SignedInAccount {
                uuid: a.uuid.clone(),
                id: a.id.clone(),
                kind,
                display_name: a.display_name.clone(),
                pfp_url: Some(a.pfp_url.clone()).filter(|u| !u.is_empty()),
            },
        })
    }
}

/// A device sign-in in progress. Show `user_code` and `verification_uri`.
#[derive(Clone)]
pub struct DeviceStart {
    /// The code the Carbon confirms, e.g. `WDJB-MJHT`.
    pub user_code: String,
    /// Where to approve it.
    pub verification_uri: String,
    /// The same page with the code filled in.
    pub verification_uri_complete: Option<String>,
    /// Seconds the code stays valid.
    pub expires_in: u64,
    /// Minimum seconds between polls.
    pub interval: u64,
    /// When the code stops working (Unix seconds).
    pub expires_at: i64,
    device_code: Secret,
}

impl std::fmt::Debug for DeviceStart {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceStart")
            .field("user_code", &self.user_code)
            .field("verification_uri", &self.verification_uri)
            .finish_non_exhaustive()
    }
}

impl DeviceStart {
    /// The page to open: the one with the code filled in when there is one.
    pub fn browser_url(&self) -> &str {
        self.verification_uri_complete.as_deref().unwrap_or(&self.verification_uri)
    }
}

/// Signs accounts in to Present at one Silicon Accounts deployment.
#[derive(Clone, Debug)]
pub struct SignIn {
    client: AccountsClient,
    http: reqwest::Client,
    base: Url,
    app_id: String,
}

impl SignIn {
    /// Signs in to `app_id` (normally [`APP_ID`]) at `accounts_url` (https, or http on this
    /// machine). No network call.
    pub fn new(accounts_url: &str, app_id: &str) -> Result<Self> {
        let base = crate::client::parse_base(accounts_url).map_err(|_| {
            Error::invalid(
                format!("the Silicon Accounts URL `{accounts_url}` is not usable"),
                format!("Use an https origin such as {DEFAULT_ACCOUNTS_URL} (plain http only for localhost, 127.0.0.1 or ::1)."),
            )
        })?;
        let client = AccountsClient::builder()
            .base_url(base.as_str().trim_end_matches('/'))
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("silicon-present-client/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| Error::accounts(&e))?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("silicon-present-client/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| Error::invalid(format!("could not set up HTTP: {e}"), ""))?;
        Ok(Self {
            client,
            http,
            base,
            app_id: app_id.trim().to_owned(),
        })
    }

    /// The Silicon Accounts origin, without a trailing slash.
    pub fn accounts_url(&self) -> &str {
        self.base.as_str().trim_end_matches('/')
    }

    /// Exchanges a Silicon's short-lived token (`slt_…`). Single use: a refused token is used up.
    pub async fn exchange_slt(&self, slt: &Secret) -> Result<Tokens> {
        let slt = slt.expose().trim();
        if !slt.starts_with("slt_") {
            return Err(Error::Accounts {
                status: None,
                code: "not_a_short_lived_token".into(),
                message: "That is not a Silicon Accounts short-lived token: they start with slt_. Nothing was sent.".into(),
                hint: Some(format!("Mint one with `{SLT_MINT_COMMAND}` and pass it on, e.g. `{SILICON_SIGN_IN}`.")),
            });
        }
        let at = now();
        match self.client.exchange_slt_public_client(&self.app_id, slt).await {
            Ok(r) => Tokens::from_response(&r, at),
            Err(e) => Err(self.slt_error(&e)),
        }
    }

    fn slt_error(&self, e: &silicon_accounts_client::Error) -> Error {
        let message = e.message();
        let lower = message.to_ascii_lowercase();
        let (code, hint) = if e.is_code("invalid_grant") {
            if lower.contains("already used") {
                ("slt_already_used", format!("Each short-lived token works once. Mint a fresh one with `{SLT_MINT_COMMAND}` and use it right away."))
            } else if lower.contains("issued for the app") {
                ("slt_wrong_app", format!("It was minted for another app. Mint one for Present with `{SLT_MINT_COMMAND}`."))
            } else if lower.contains("expired") {
                ("slt_expired", format!("Short-lived tokens last 2 minutes. Mint a fresh one and use it at once: `{SILICON_SIGN_IN}`."))
            } else {
                ("slt_unknown", format!("Check it was passed whole and comes from the Silicon Accounts this CLI uses ({}). Mint a fresh one with `{SLT_MINT_COMMAND}`.", self.accounts_url()))
            }
        } else if e.is_code("unauthorized_client") || e.is_code("invalid_client") {
            ("sign_in_not_allowed", format!("Present's sign-in setup at {} does not let its CLI exchange short-lived tokens (public_client is off for '{}').", self.accounts_url(), self.app_id))
        } else {
            return Error::accounts(e);
        };
        Error::Accounts {
            status: e.status(),
            code: code.into(),
            message,
            hint: Some(hint),
        }
    }

    /// Starts a Carbon's device sign-in. `label` names this device in their list of sign-ins.
    pub async fn start_device(&self, label: Option<&str>) -> Result<DeviceStart> {
        let started = now();
        let d = self
            .client
            .app_device_authorize(&self.app_id, None, label)
            .await
            .map_err(|e| Error::accounts(&e))?;
        Ok(DeviceStart {
            user_code: d.user_code.clone(),
            verification_uri: d.verification_uri.clone(),
            verification_uri_complete: d.verification_uri_complete.clone(),
            expires_in: d.expires_in,
            interval: d.interval.max(1),
            expires_at: started.saturating_add(i64::try_from(d.expires_in).unwrap_or(600)),
            device_code: Secret::new(d.device_code.expose()),
        })
    }

    /// Polls until the Carbon approves (honouring `interval` and `slow_down`), the code is
    /// denied, or it expires. `on_wait` is called after every poll that did not finish.
    pub async fn wait_for_device(&self, device: &DeviceStart, mut on_wait: impl FnMut(&str)) -> Result<Tokens> {
        let mut interval = Duration::from_secs(device.interval.max(1));
        loop {
            if now() > device.expires_at {
                return Err(Error::Accounts {
                    status: None,
                    code: "device_expired".into(),
                    message: format!("The sign-in code {} expired before it was approved.", device.user_code),
                    hint: Some("Run `present login` again for a new code.".into()),
                });
            }
            tokio::time::sleep(interval).await;
            let at = now();
            match self.client.app_device_poll(&self.app_id, device.device_code.expose()).await {
                Ok(DevicePoll::Tokens(t)) => return Tokens::from_response(&t, at),
                Ok(DevicePoll::SlowDown) => {
                    interval += Duration::from_secs(5);
                    on_wait("slow_down");
                }
                Ok(DevicePoll::Denied) => {
                    return Err(Error::Accounts {
                        status: None,
                        code: "device_denied".into(),
                        message: format!("The sign-in request {} was denied on the account site.", device.user_code),
                        hint: Some("Run `present login` again if that was a mistake.".into()),
                    });
                }
                Ok(DevicePoll::Expired) => {
                    return Err(Error::Accounts {
                        status: None,
                        code: "device_expired".into(),
                        message: format!("The sign-in code {} expired before it was approved.", device.user_code),
                        hint: Some("Run `present login` again for a new code.".into()),
                    });
                }
                Ok(_) => on_wait("pending"),
                Err(e) if e.is_transport() || e.status().is_some_and(|s| s >= 500 || s == 429) => {
                    on_wait("retrying");
                }
                Err(e) => return Err(Error::accounts(&e)),
            }
        }
    }

    /// Rotates a refresh token. Store the new pair before using it; never refresh one twice.
    pub async fn refresh(&self, refresh_token: &Secret) -> Result<Tokens> {
        let at = now();
        match self.client.refresh_app_public_client(&self.app_id, refresh_token.expose()).await {
            Ok(r) => Tokens::from_response(&r, at),
            Err(e) if e.is_code("invalid_grant") => Err(Error::Accounts {
                status: e.status(),
                code: "sign_in_ended".into(),
                message: e.message(),
                hint: Some(format!("Sign in again: `present login` (Carbons) or `{SILICON_SIGN_IN}` (Silicons).")),
            }),
            Err(e) => Err(Error::accounts(&e)),
        }
    }

    /// Ends this sign-in at Silicon Accounts (RFC 7009 revoke with `client_id` alone).
    pub async fn revoke(&self, refresh_token: &Secret) -> Result<()> {
        let url = self.base.join("v1/oauth/revoke").map_err(|_| Error::invalid("invalid Silicon Accounts URL", ""))?;
        let form = [
            ("token", refresh_token.expose().trim()),
            ("token_type_hint", "refresh_token"),
            ("client_id", self.app_id.as_str()),
        ];
        let resp = self.http.post(url.clone()).form(&form).send().await.map_err(|e| Error::Accounts {
            status: None,
            code: "connection_failed".into(),
            message: format!("Could not reach Silicon Accounts at {}: {e}.", self.accounts_url()),
            hint: Some("Check the network and ACCOUNTS_URL, then retry.".into()),
        })?;
        let status = resp.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
        let body: serde_json::Value = resp.json().await.unwrap_or_default();
        Err(Error::Accounts {
            status: Some(status),
            code: body["error"].as_str().unwrap_or("revoke_failed").to_owned(),
            message: body["error_description"]
                .as_str()
                .map_or_else(|| format!("Silicon Accounts refused the sign-out with HTTP {status}."), str::to_owned),
            hint: None,
        })
    }
}
