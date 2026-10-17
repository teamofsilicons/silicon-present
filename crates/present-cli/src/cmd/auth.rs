//! Signing in and settings: login, login status, logout, accounts, whoami, config.

use crate::args::{ConfigCmd, LoginArgs};
use crate::ctx::{Ctx, to_value};
use crate::fail::{Fail, R};
use crate::state::{Home, StoredSignIn};
use serde_json::{Value, json};
use silicon_present_client::Secret;
use silicon_present_client::accounts::{self, Tokens, now};
use std::io::{IsTerminal as _, Read as _};

pub async fn login(ctx: &Ctx, a: &LoginArgs) -> R<()> {
    let slt = if a.slt_stdin {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .map_err(|e| Fail::io("read the short-lived token from stdin", &e))?;
        let s = s.trim().to_owned();
        if s.is_empty() {
            return Err(Fail::new(
                "empty_token",
                "--slt-stdin read nothing from stdin.",
                format!("Pipe a token in: `{}`.", accounts::SILICON_SIGN_IN),
            ));
        }
        Some(s)
    } else {
        a.slt.clone().or_else(|| a.token.clone())
    };
    let signin = ctx.sign_in()?;
    let (tokens, method) = match slt {
        Some(t) => (signin.exchange_slt(&Secret::new(t)).await?, "slt"),
        None => {
            let label = a.label.clone().unwrap_or_else(|| {
                format!("present CLI on {}", std::env::var("HOSTNAME").or_else(|_| std::env::var("HOST")).unwrap_or_else(|_| "this machine".into()))
            });
            let device = signin.start_device(Some(&label)).await.map_err(|e| {
                let mut f: Fail = e.into();
                f.hint = Some(format!(
                    "{} Silicons sign in with `{}`.",
                    f.hint.clone().unwrap_or_default(),
                    accounts::SILICON_SIGN_IN
                ));
                f
            })?;
            if ctx.json {
                println!(
                    "{}",
                    json!({
                        "status": "waiting_for_approval",
                        "user_code": device.user_code,
                        "verification_uri": device.verification_uri,
                        "verification_uri_complete": device.verification_uri_complete,
                        "expires_at": device.expires_at,
                    })
                );
            } else {
                eprintln!("To sign in to Silicon Present, open {} and confirm the code:\n\n    {}\n", device.browser_url(), device.user_code);
                eprintln!("Waiting for approval (the code works for {} minutes)…", device.expires_in.div_ceil(60));
            }
            (signin.wait_for_device(&device, |_| {}).await?, "device")
        }
    };
    let stored = save(ctx, tokens, method)?;
    let out = status_json(&stored, None);
    ctx.out(&out, || {
        format!(
            "Signed in to Silicon Present as {} ({}{}).\nNext: present list, present new \"My deck\", present docs getting-started",
            stored.account.id,
            stored.account.kind,
            if stored.account.display_name.is_empty() { String::new() } else { format!(", {}", stored.account.display_name) }
        )
    });
    Ok(())
}

fn save(ctx: &Ctx, t: Tokens, method: &str) -> R<StoredSignIn> {
    let stored = StoredSignIn {
        accounts_url: ctx.accounts_url.clone(),
        app_id: accounts::APP_ID.into(),
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: t.expires_at,
        refresh_expires_at: t.refresh_expires_at,
        scope: t.scope,
        account: t.account,
        method: method.into(),
        signed_in_at: now(),
    };
    let key = ctx.accounts_url.clone();
    let s2 = stored.clone();
    ctx.home.update(move |s| {
        s.sign_ins.insert(key, s2);
    })?;
    Ok(stored)
}

fn status_json(s: &StoredSignIn, verified: Option<bool>) -> Value {
    let mut v = json!({
        "authenticated": true,
        "app_id": s.app_id,
        "uuid": s.account.uuid,
        "id": s.account.id,
        "kind": s.account.kind,
        "display_name": s.account.display_name,
        "pfp_url": s.account.pfp_url,
        "expires_at": s.expires_at,
        "refresh_expires_at": s.refresh_expires_at,
        "method": s.method,
        "scope": s.scope,
        "accounts_url": s.accounts_url,
    });
    if let Some(ok) = verified {
        v["verified"] = json!(ok);
    }
    v
}

/// `present login status`: with --json always exits 0.
pub async fn status(ctx: &Ctx, offline: bool) -> R<()> {
    let result: R<Option<(StoredSignIn, Option<bool>)>> = async {
        if offline {
            let st = ctx.home.read()?;
            return Ok(st.sign_ins.get(&ctx.accounts_url).cloned().map(|s| (s, None)));
        }
        match ctx.session().await? {
            None => Ok(None),
            Some(s) => {
                // Check the token with Present itself when it answers; a network problem is not a sign-out.
                let verified = match ctx.client()?.with_token(s.access_token.clone()).me().await {
                    Ok(_) => Some(true),
                    Err(e) if e.is_unauthenticated() => Some(false),
                    Err(_) => None,
                };
                Ok(Some((s, verified)))
            }
        }
    }
    .await;
    match result {
        Ok(Some((s, verified))) => {
            let v = status_json(&s, verified);
            ctx.out(&v, || {
                format!(
                    "Signed in as {} ({}) at {}; access token valid until {} (refreshed by itself).{}",
                    s.account.id,
                    s.account.kind,
                    s.accounts_url,
                    s.expires_at,
                    match verified {
                        Some(false) => " Silicon Present refused the token just now: sign in again.",
                        None if !offline => " (Silicon Present could not be reached to check it.)",
                        _ => "",
                    }
                )
            });
            Ok(())
        }
        Ok(None) => {
            let v = json!({ "authenticated": false, "accounts_url": ctx.accounts_url });
            if ctx.json {
                println!("{v}");
                Ok(())
            } else {
                Err(Fail::new(
                    "not_signed_in",
                    "Nobody is signed in to Silicon Present here.",
                    format!("Sign in: `{}` (Silicons) or `present login` (Carbons).", accounts::SILICON_SIGN_IN),
                ))
            }
        }
        Err(f) => {
            if ctx.json {
                println!("{}", json!({ "authenticated": false, "reason": f.message, "code": f.code }));
                Ok(())
            } else {
                Err(f)
            }
        }
    }
}

pub async fn logout(ctx: &Ctx) -> R<()> {
    let st = ctx.home.read()?;
    let Some(saved) = st.sign_ins.get(&ctx.accounts_url).cloned() else {
        ctx.out(&json!({ "signed_out": false, "reason": "nobody was signed in" }), || {
            "Nobody was signed in here.".into()
        });
        return Ok(());
    };
    let revoked = ctx.sign_in()?.revoke(&saved.refresh_token).await;
    let key = ctx.accounts_url.clone();
    ctx.home.update(move |s| {
        s.sign_ins.remove(&key);
    })?;
    let note = revoked.as_ref().err().map(|e| e.to_string());
    ctx.out(
        &json!({ "signed_out": true, "id": saved.account.id, "revoked_at_accounts": revoked.is_ok(), "note": note }),
        || match &note {
            None => format!("Signed out {} here and at Silicon Accounts.", saved.account.id),
            Some(n) => format!("Signed out {} here; Silicon Accounts could not be told ({n}).", saved.account.id),
        },
    );
    Ok(())
}

/// `present accounts --json`: no network.
pub fn accounts_info(ctx: &Ctx) -> R<()> {
    let v = json!({
        "app_id": accounts::APP_ID,
        "client_id": accounts::APP_ID,
        "accounts_url": ctx.accounts_url,
        "api_url": ctx.api_url,
        "version": env!("CARGO_PKG_VERSION"),
        "device_flow": true,
        "public_client": true,
        "state_dir": ctx.home.dir.display().to_string(),
        "sign_in": {
            "silicon": accounts::SILICON_SIGN_IN,
            "carbon": "present login",
        },
    });
    ctx.out(&v, || {
        format!(
            "app id:        present\nSilicon Accounts: {} ({})\nAPI:           {} ({})\nState:         {}\nSilicons:      {}\nCarbons:       present login (device code)",
            ctx.accounts_url, ctx.accounts_source, ctx.api_url, ctx.api_source, ctx.home.dir.display(), accounts::SILICON_SIGN_IN
        )
    });
    Ok(())
}

pub async fn whoami(ctx: &Ctx) -> R<()> {
    let c = ctx.authed().await?;
    let me = c.me().await?;
    let v = to_value(&me);
    ctx.out(&v, || {
        format!(
            "{} ({}){}\nuuid {}",
            me.id,
            me.kind,
            if me.display_name.is_empty() { String::new() } else { format!(" {}", me.display_name) },
            me.uuid
        )
    });
    Ok(())
}

pub fn config(ctx: &Ctx, cmd: &ConfigCmd) -> R<()> {
    match cmd {
        ConfigCmd::Home { dir: None } => {
            let v = json!({ "home": ctx.home.home.display().to_string(), "state_dir": ctx.home.dir.display().to_string(), "source": ctx.home.source });
            ctx.out(&v, || format!("{} (from {})", ctx.home.dir.display(), ctx.home.source));
        }
        ConfigCmd::Home { dir: Some(d) } => {
            let target = Home::set_pointer(d)?;
            let v = json!({ "home": target.display().to_string(), "state_dir": target.join(".present").display().to_string() });
            ctx.out(&v, || format!("State now lives in {}/.present. Sign in there with `present login`.", target.display()));
        }
        ConfigCmd::ApiUrl { url } => {
            let value = if url == "default" {
                None
            } else {
                silicon_present_client::parse_base(url)?;
                Some(url.trim_end_matches('/').to_owned())
            };
            let v2 = value.clone();
            ctx.home.update(move |s| s.api_url = v2)?;
            ctx.out(&json!({ "api_url": value }), || match &value {
                Some(u) => format!("API URL saved: {u}"),
                None => "API URL back to the default.".into(),
            });
        }
        ConfigCmd::AccountsUrl { url } => {
            let value = if url == "default" {
                None
            } else {
                silicon_present_client::parse_base(url)?;
                Some(url.trim_end_matches('/').to_owned())
            };
            let v2 = value.clone();
            ctx.home.update(move |s| s.accounts_url = v2)?;
            ctx.out(&json!({ "accounts_url": value }), || match &value {
                Some(u) => format!("Silicon Accounts URL saved: {u}"),
                None => "Silicon Accounts URL back to the default.".into(),
            });
        }
        ConfigCmd::Show => {
            let v = json!({
                "api_url": { "value": ctx.api_url, "source": ctx.api_source },
                "accounts_url": { "value": ctx.accounts_url, "source": ctx.accounts_source },
                "home": { "value": ctx.home.home.display().to_string(), "source": ctx.home.source },
                "state_dir": ctx.home.dir.display().to_string(),
            });
            ctx.out(&v, || {
                format!(
                    "api-url       {} ({})\naccounts-url  {} ({})\nhome          {} ({})",
                    ctx.api_url, ctx.api_source, ctx.accounts_url, ctx.accounts_source, ctx.home.home.display(), ctx.home.source
                )
            });
        }
    }
    Ok(())
}

/// Asks for a typed confirmation on a terminal.
pub fn confirm_typed(what: &str, expected: &str) -> R<()> {
    if !std::io::stdin().is_terminal() {
        return Err(Fail::new(
            "confirmation_needed",
            format!("Deleting {what} for good needs a confirmation, and there is no terminal to ask on."),
            format!("Pass --confirm \"{expected}\"."),
        ));
    }
    eprint!("This permanently deletes {what}. Type its title to confirm: ");
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .map_err(|e| Fail::io("read the confirmation", &e))?;
    if line.trim_end_matches(['\n', '\r']) != expected {
        return Err(Fail::new(
            "confirmation_mismatch",
            format!("What you typed is not `{expected}`, so nothing was deleted."),
            "Run it again and type the title exactly.",
        ));
    }
    Ok(())
}
