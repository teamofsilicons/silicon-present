//! Access tokens: Silicon Accounts EdDSA JWTs (`aud` = present), verified locally against the JWKS with the
//! official `silicon-accounts-client`. The JWKS is cached and refetched (at most every 30 s) when a token names a
//! key it doesn't have.

use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::extract::{FromRef, FromRequestParts};
use axum::http::request::Parts;
use silicon_accounts_client::{AccountsClient, Error as AccountsError, Jwks, TokenError, VerifyOptions, verify_access_token};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::error::ApiError;
use crate::state::AppState;

/// Who a verified token belongs to.
#[derive(Debug, Clone)]
pub struct VerifiedToken {
    pub uuid: Uuid,
    /// The c:id / si:id when the token was issued (it can have changed since).
    pub handle: Option<String>,
    /// `carbon` or `silicon`.
    pub kind: Option<String>,
    /// The raw token (used once to enrol the account with Silicon Ting).
    pub token: String,
}

#[async_trait]
pub trait TokenVerifier: Send + Sync {
    async fn verify(&self, token: &str) -> Result<VerifiedToken, ApiError>;
}

/// The real verifier.
pub struct AccountsTokenVerifier {
    client: AccountsClient,
    options: VerifyOptions,
    jwks: RwLock<Option<(Jwks, Instant)>>,
}

impl AccountsTokenVerifier {
    pub fn new(client: AccountsClient, app_id: &str, issuer: &str) -> Self {
        Self { client, options: VerifyOptions::for_app(app_id).with_issuer(issuer), jwks: RwLock::new(None) }
    }

    async fn fetch(&self) -> Result<Jwks, ApiError> {
        let jwks = self.client.jwks().await.map_err(|e| {
            ApiError::unavailable(
                "accounts_unreachable",
                format!("Silicon Present couldn't fetch the signing keys from Silicon Accounts to check the access token: {}.", e.message()),
                "Try again in a moment.",
            )
        })?;
        *self.jwks.write().await = Some((jwks.clone(), Instant::now()));
        Ok(jwks)
    }

    async fn keys(&self) -> Result<(Jwks, Instant), ApiError> {
        if let Some(k) = self.jwks.read().await.clone() {
            return Ok(k);
        }
        let jwks = self.fetch().await?;
        Ok((jwks, Instant::now()))
    }
}

fn token_error(e: AccountsError) -> ApiError {
    match &e {
        AccountsError::Token(TokenError::Expired { .. }) => ApiError::unauthorized(
            "token_expired",
            "The access token has expired (they last 30 minutes).",
            "Refresh it and retry; the present CLI does this by itself, or sign in again with `present login`.",
        ),
        AccountsError::Token(TokenError::WrongAudience { .. }) => ApiError::unauthorized(
            "token_wrong_audience",
            "The access token was issued to another app, not Silicon Present.",
            "Get a token for present: `present login`, or `silicon-accounts login --app present -q | present login --slt-stdin`.",
        ),
        AccountsError::Token(TokenError::WrongIssuer { expected }) => ApiError::unauthorized(
            "token_wrong_issuer",
            format!("The access token wasn't issued by the Silicon Accounts this service trusts ({expected})."),
            "Sign in against the same Silicon Accounts the service uses.",
        ),
        _ => ApiError::unauthorized(
            "token_invalid",
            format!("The access token isn't valid: {}.", e.message().trim_end_matches('.')),
            "Sign in again with `present login` and send the new token as `Authorization: Bearer <token>`.",
        ),
    }
}

#[async_trait]
impl TokenVerifier for AccountsTokenVerifier {
    async fn verify(&self, token: &str) -> Result<VerifiedToken, ApiError> {
        let (jwks, fetched) = self.keys().await?;
        let claims = match verify_access_token(&jwks, token, &self.options) {
            Err(AccountsError::Token(TokenError::UnknownKey { .. })) if fetched.elapsed() > Duration::from_secs(30) => {
                let jwks = self.fetch().await?;
                verify_access_token(&jwks, token, &self.options)
            }
            other => other,
        }
        .map_err(token_error)?;
        let uuid = Uuid::parse_str(&claims.sub).map_err(|_| {
            ApiError::unauthorized(
                "token_invalid",
                "The access token's subject isn't an account uuid.",
                "Sign in again with `present login`.",
            )
        })?;
        Ok(VerifiedToken {
            uuid,
            handle: claims.id.clone().filter(|s| !s.is_empty()),
            kind: claims.kind.map(|k| k.as_str().to_string()),
            token: token.to_string(),
        })
    }
}

/// A signed-in caller (the request must carry a valid token).
#[derive(Debug, Clone)]
pub struct Caller {
    pub uuid: Uuid,
    pub handle: Option<String>,
}

/// A caller who may be signed out (public decks).
#[derive(Debug, Clone)]
pub struct MaybeCaller(pub Option<Caller>);

impl MaybeCaller {
    pub fn uuid(&self) -> Option<Uuid> {
        self.0.as_ref().map(|c| c.uuid)
    }
}

fn bearer(parts: &Parts) -> Result<Option<String>, ApiError> {
    let Some(h) = parts.headers.get(axum::http::header::AUTHORIZATION) else {
        return Ok(None);
    };
    let s = h.to_str().unwrap_or("").trim();
    match s.split_once(' ') {
        Some((scheme, token)) if scheme.eq_ignore_ascii_case("bearer") && !token.trim().is_empty() => Ok(Some(token.trim().to_string())),
        _ => Err(ApiError::unauthorized(
            "token_invalid",
            "The Authorization header isn't `Bearer <token>`.",
            "Send `Authorization: Bearer <Silicon Accounts access token for present>`.",
        )),
    }
}

pub async fn caller_from_parts(parts: &Parts, state: &AppState) -> Result<Option<Caller>, ApiError> {
    let Some(token) = bearer(parts)? else { return Ok(None) };
    let verified = state.verifier.verify(&token).await?;
    let caller = Caller { uuid: verified.uuid, handle: verified.handle.clone() };
    crate::accounts::on_signed_in(state, verified).await;
    Ok(Some(caller))
}

impl<S> FromRequestParts<S> for Caller
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let st = AppState::from_ref(state);
        if let Some(c) = parts.extensions.get::<Caller>() {
            return Ok(c.clone());
        }
        let caller = caller_from_parts(parts, &st).await?.ok_or_else(ApiError::sign_in_required)?;
        parts.extensions.insert(caller.clone());
        Ok(caller)
    }
}

impl<S> FromRequestParts<S> for MaybeCaller
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let st = AppState::from_ref(state);
        if let Some(c) = parts.extensions.get::<Caller>() {
            return Ok(MaybeCaller(Some(c.clone())));
        }
        let caller = caller_from_parts(parts, &st).await?;
        if let Some(c) = &caller {
            parts.extensions.insert(c.clone());
        }
        Ok(MaybeCaller(caller))
    }
}
