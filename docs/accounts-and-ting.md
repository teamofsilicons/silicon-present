# Silicon Accounts and Silicon Ting: how Present talks to them

Researched 2026-10-17 from the Accounts source, the published `silicon-accounts-client` 0.6.0
(`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/silicon-accounts-client-0.6.0/`), Remind's migrated service
(`~/Documents/silicon/.worktrees/remind-accounts-apps`) and DM's current Ting delivery
(`~/Documents/silicon/.worktrees/dm-ting-delivery-20261017`).

## Local test stack (already seeded)

`e2e/stack/test-stack.json` has every URL, port, app secret and the start/seed/stop commands.

- Accounts public URL (= token `iss`): `http://localhost:9740`; accounts-api `http://127.0.0.1:9741`;
  JWKS `http://127.0.0.1:9741/.well-known/jwks.json`; mock email `http://127.0.0.1:9743/_messages`; mock Iris 9745.
- Apps `present` and `ting` are seeded from `e2e/stack/apps.json` (email sign-in, `email` optional, device flow and
  public client on, redirect `http://{127.0.0.1,localhost}:4320/auth/callback`).
- Stop: `cd ~/Documents/silicon/silicon-accounts && ACCOUNTS_PORT=9740 scripts/stop.sh` (never `--all`/`--db`).

## 1. Verifying tokens in the service

```toml
silicon-accounts-client = "0.6"
```

```rust
let client = AccountsClient::builder().base_url(api_url).timeout(t).user_agent("silicon-present/x").max_retries(1).build()?;
let verify = VerifyOptions::for_app("present").with_issuer(public_url /* ACCOUNTS_URL, no trailing / */);
let jwks = client.jwks().await?;                       // cache it
match silicon_accounts_client::verify_access_token(&jwks, token, &verify) {
    Err(Error::Token(TokenError::UnknownKey { .. })) => { /* refetch JWKS (at most every 30 s), retry */ }
    r => r,
}
```

Claims: `sub` = account uuid (store this), `kind` (carbon|silicon), `id` (`c:…`/`si:…` at issue time, can change),
`mid` = `present:{uuid}`, `scope`, `iss`, `aud`, `exp`, `fid`. Template: Remind's
`src/infrastructure/accounts.rs` (`AccountsGateway`) and `src/config.rs`.

Config: `ACCOUNTS_URL` (public origin = `iss`), `ACCOUNTS_API_URL` (server to server, defaults to `ACCOUNTS_URL`),
`PRESENT_APP_ID`, `PRESENT_APP_SECRET`.

### Looking up accounts

`let app = client.as_app("present", secret);` then `app.lookup(uuid)`, `app.lookup_by_id("c:ada")`,
`app.resolve(uuid_or_id)` → `AccountSummary { uuid, kind, id, status, custodian }`. Over app credentials
`display_name` and `pfp_url` come back empty. For name and photo use `app.user(uuid)` → `AppUser { display_name,
pfp_url, email?, … }`, which is 404 until that account has signed in to Present: then show the id and the default
photo `{IRIS}/pfp/{carbon|silicon}?id=<uuid>`. Lookups are limited to 600/min per app: cache. Also refresh the cache
from every verified token (the token carries `id`), and from the `account.updated` / `account.id_changed` webhooks
when configured (`verify_and_parse_webhook`).

### Email invites

Apps can't turn an email into an account. Present keeps an email invite as a pending member and makes it real when
an account signs in whose `AppUser.email` (the optional `email` field) is that address. `app.start_import(ImportRow {
email })` can also match or pre-create an unclaimed Carbon, but it sends no email. Present sends the invite email
itself through a mail adapter (`PRESENT_POSTMARK_TOKEN`; without it the message is kept in an `email_outbox` table and
logged, which is what the tests read).

## 2. CLI sign-in (reference: Remind's `crates/client/src/accounts.rs`, `crates/cli/src/{args,login,state,session}.rs`)

- Silicons: `silicon-accounts login --app present -q | present login --slt-stdin`; also `present login --slt TOKEN`
  and positional `present login slt_…`. Reject anything not starting with `slt_`. 0.6:
  `client.exchange_slt_public_client("present", slt)`.
- Carbons: device flow: `client.app_device_authorize("present", scope, label)` → show `user_code` +
  `verification_uri`; poll `app_device_poll` (`Pending`, `SlowDown`, `Denied`, `Expired`, `Tokens`).
- Refresh: `client.refresh_app_public_client("present", refresh)` (rotates; never reuse). Logout: revoke
  (`revoke_public_client` or `POST /v1/oauth/revoke` with `token` + `client_id`).
- State: `{home}/.present/state.json`, `{home}` = `$SILICON_HOME` else `$HOME` (configurable with
  `present config home <dir>`, error if not a directory); dir 0700, files 0600, atomic writes, `state.lock` only
  around read-modify-write. Stores accounts_url, app_id, access_token, refresh_token, expires_at,
  refresh_expires_at, scope, account, method.
- `present accounts --json` (no network): `{ app_id, accounts_url, api_url, version, client_id, device_flow,
  public_client, sign_in: { carbon, silicon } }`. `present login status --json` always exits 0:
  `{"authenticated": false, "reason"?}` or `{"authenticated": true, uuid, id, kind, display_name, expires_at, … }`,
  refreshing when under 60 s remain (`--offline` reads the file only). Global `--accounts-url` / env `ACCOUNTS_URL`,
  `--api-url` / env `PRESENT_API_URL`.

Getting an SLT for a test Silicon (DM's `tests/e2e/mint.mts`): a Carbon gets a first-party token (testkit
`accounts.cliLogin(messaging, { email })` or `signUpCarbon`), `POST /v1/me/silicons { id: "si:…", display_name }` →
`silicon.uuid` + `stk`; `accounts.siliconLogin(id, stk)`; `POST /v1/me/short-lived-tokens { app_id: "present" }` →
`{ slt }`. Testkit library: `~/Documents/silicon/silicon-accounts/testkit/lib/index.ts`, run with
`testkit/node_modules/.bin/tsx`.

Playwright Carbon sign-in: web kit `e2e/support.ts` (`signInOnHostedPages`, `requestCode`, `codeFor`): read
`last_seq` from `GET {MSG}/_messages?limit=1`, fill Email → Continue, long-poll
`GET {MSG}/_messages/wait?to=<email>&after=<seq>&timeout_ms=20000`, type `.code`, click through "Create account" /
"Finish setup" / "Share and continue". 30 codes per network per 10 minutes: sign each Carbon in once and reuse
`storageState`.

## 3. Silicon Ting (0.3, proofs from Silicon Accounts)

1. **Enrol each recipient once** (lazily, in the background, on their first request to Present):
   `app.issue_user_verification(&IssueUserVerification { subject_token: <their present access token>,
   receiving_app: "ting", scopes: ["subscriptions.register"] }, Some(key))`, then `POST {TING}/v1/subscriptions` with
   `Authorization: Bearer sap_…` and `{"app_id": "present", "for": "<uuid>"}` → `{ id }`.
2. **Send**: `app.issue_app_verification(&IssueAppVerification { receiving_app: "ting", scopes: ["tings.send"] },
   key)` (cache; replace 60 s before expiry or on `invalid_proof` / `unauthorized` / `proof_expired`), then
   `POST {TING}/v1/tings` with `Authorization: Bearer sap_…` and
   `{"type": "present.mention.received", "for": "<uuid>", "key": "<≤200 B idempotency key>", "data": {…}, "metadata": {}}`.
   Unknown fields are rejected; 256 KiB max; keys dedupe for 14 days (`409 idempotency_conflict` if the content
   changed under the same key).
3. **Types** are registered once by an author of `present`: `ting types register --type present.comment.created
   --description '…'` (`POST /v1/apps/present/types`).

Config: `PRESENT_TING_URL` (unset = delivery off; tings stay in `ting_outbox` as `ting_not_configured`; production
`https://backend.ting.teamofsilicons.com`), `PRESENT_TING_APP_ID` (default `ting`),
`PRESENT_TING_TIMEOUT_SECONDS` (15). A worker retries the outbox.

Local stand-in: `tools/ting-standin/` (ours), speaking the current contract: verifies the Bearer proofs with
`POST {ACCOUNTS_API}/v1/proofs/verify` using the seeded `ting` app's credentials, accepts subscriptions and tings,
and lets tests read what arrived. DM's `scripts/dev_ting_stub.py` is stale (old `Authorization: Proof` contract).
