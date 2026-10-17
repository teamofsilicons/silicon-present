//! `present-service`: run Silicon Present's service. Configuration is all environment; `--help` lists it.

use present_service::{Config, config::ENV_HELP};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{ENV_HELP}");
        return;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("present-service {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if let Some(a) = args.first() {
        eprintln!("present-service takes no arguments (got `{a}`); configure it with environment variables. See `present-service --help`.");
        std::process::exit(2);
    }
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,sqlx=warn".into()))
        .init();
    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(problems) => {
            eprintln!("present-service can't start; its configuration is incomplete:");
            for p in problems {
                eprintln!("  - {p}");
            }
            eprintln!("See `present-service --help` for every setting.");
            std::process::exit(2);
        }
    };
    if let Err(e) = present_service::run(cfg).await {
        eprintln!("present-service stopped: {e:#}");
        std::process::exit(1);
    }
}
