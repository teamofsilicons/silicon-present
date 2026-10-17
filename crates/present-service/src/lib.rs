//! Silicon Present's service: the API, live sync, storage, sharing, comments, versions, Ting and presentations.
//! See docs/architecture.md ("The service") for the contract. No telemetry.

/// A query string built from constant column lists (never from input): audited safe for sqlx.
macro_rules! sql {
    ($($t:tt)*) => { sqlx::AssertSqlSafe(format!($($t)*)) };
}

pub mod access;
pub mod accounts;
pub mod auth;
pub mod config;
pub mod converter;
pub mod error;
pub mod extract;
pub mod ids;
pub mod mail;
pub mod rooms;
pub mod routes;
pub mod state;
pub mod store;
pub mod tings;
pub mod views;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use silicon_accounts_client::AccountsClient;
use sqlx::postgres::PgPoolOptions;

pub use config::Config;
pub use state::{AppState, Deps};

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

/// Connects to Postgres and runs the migrations.
pub async fn connect(database_url: &str) -> anyhow::Result<sqlx::PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .acquire_timeout(Duration::from_secs(10))
        .connect(database_url)
        .await
        .with_context(|| "Silicon Present couldn't connect to PRESENT_DATABASE_URL; is Postgres running (scripts/dev-db.sh start)?")?;
    MIGRATOR.run(&pool).await.context("running the database migrations failed")?;
    Ok(pool)
}

fn accounts_client(cfg: &Config) -> anyhow::Result<AccountsClient> {
    let loopback = |u: &str| u.contains("://localhost") || u.contains("://127.0.0.1") || u.contains("://[::1]");
    let insecure = std::env::var("ACCOUNTS_ALLOW_INSECURE_HTTP").map(|v| v == "1" || v == "true").unwrap_or(false) || loopback(&cfg.accounts_api_url);
    AccountsClient::builder()
        .base_url(cfg.accounts_api_url.clone())
        .timeout(Duration::from_secs(15))
        .user_agent(format!("silicon-present/{}", env!("CARGO_PKG_VERSION")))
        .allow_insecure_http(insecure)
        .max_retries(1)
        .build()
        .map_err(|e| anyhow::anyhow!("ACCOUNTS_API_URL `{}` can't be used: {}", cfg.accounts_api_url, e))
}

/// The real adapters: Silicon Accounts, Silicon Ting (when configured) and the converter (when configured).
pub fn real_deps(cfg: &Config) -> anyhow::Result<Deps> {
    let client = accounts_client(cfg)?;
    let http = reqwest::Client::builder().timeout(cfg.ting_timeout).build()?;
    Ok(Deps {
        verifier: Arc::new(auth::AccountsTokenVerifier::new(client.clone(), &cfg.app_id, &cfg.accounts_url)),
        directory: Arc::new(accounts::AccountsAppDirectory { client: client.clone(), app_id: cfg.app_id.clone(), app_secret: cfg.app_secret.clone() }),
        ting: cfg.ting_url.clone().map(|url| {
            Arc::new(tings::HttpTingSender::new(http.clone(), url, client.clone(), cfg.app_id.clone(), cfg.app_secret.clone(), cfg.ting_app_id.clone()))
                as Arc<dyn tings::TingSender>
        }),
        converter: match (&cfg.converter_url, &cfg.converter_secret) {
            (Some(url), Some(secret)) => Some(Arc::new(converter::HttpConverter {
                http: reqwest::Client::builder().timeout(Duration::from_secs(300)).build()?,
                url: url.clone(),
                secret: secret.clone(),
            }) as Arc<dyn converter::Converter>),
            _ => None,
        },
    })
}

/// Starts the background workers (Ting outbox, presence expiry, idle rooms).
pub fn spawn_workers(st: &AppState) {
    tokio::spawn(tings::run_worker(st.clone()));
    tokio::spawn(rooms::run_upkeep(st.clone()));
}

/// Serves the API on a bound listener until the process stops.
pub async fn serve(listener: tokio::net::TcpListener, st: AppState) -> std::io::Result<()> {
    let svc = routes::service(st);
    axum::serve(listener, axum::ServiceExt::<axum::extract::Request>::into_make_service(svc)).await
}

/// Everything `present-service` does: config, database, adapters, workers, listen.
pub async fn run(cfg: Config) -> anyhow::Result<()> {
    std::fs::create_dir_all(cfg.data_dir.join("assets"))
        .with_context(|| format!("PRESENT_DATA_DIR `{}` can't be created", cfg.data_dir.display()))?;
    let pool = connect(&cfg.database_url).await?;
    let deps = real_deps(&cfg)?;
    let bind = cfg.bind;
    let st = AppState::new(cfg, pool, deps);
    spawn_workers(&st);
    let listener = tokio::net::TcpListener::bind(bind).await.with_context(|| format!("can't listen on {bind} (PRESENT_BIND); is something else using it?"))?;
    tracing::info!("Silicon Present service listening on http://{bind}");
    serve(listener, st).await?;
    Ok(())
}
