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

## 3. Silicon Ting 0.4

The receiver-session and notification contract was checked against Ting main
`163e5ca6d6c160172ff0d19d0c9dcec63dad4dc0` on 2026-11-10. Present uses the published
`silicon-ting-client` 0.4 for WebSocket receivers. Account sign-in sessions and
Ting receiver sessions are separate: a receiver address exists only while its
socket is active.

### Account notifications

Mentions, comments, replies, resolved threads, and shares use `for: <account UUID>`
and `from: <verified acting account UUID>`. They reach the account's eligible
sessions and remain in Ting history. They never carry `session_id`. Names are
`present.mentionReceived`, `present.commentCreated`, `present.commentReplied`,
`present.threadResolved`, and `present.deckShared`.

Each recipient is enrolled lazily, using a User verification proof scoped to
`subscriptions.register`, then `POST /v1/subscriptions {app_id, for}`. Sends use
an App verification proof scoped to `tings.send`. Proofs are cached independently
by scope, replaced 60 seconds before expiry, and invalidated only if the rejected
credential is still the cached one. New proof issuances never reuse a stable
idempotency key that could replay an expired proof.

Before its first send, each service process registers the six definitions in
`deploy/ting-types.json` with a separate `types.manage` proof. Ting requires exactly
two-part names and validates every payload against its registered JSON Schema.
An existing type is accepted; a conflicting registration error is not treated as
success. Future schema edits use Ting's authorized author flow, rather than
silently overwriting a live catalog definition.

A send is `{type, for, from?, key, data, metadata}`; data and metadata are objects,
the request is at most 256 KiB, and the key is at most 200 bytes. Outbox retries
preserve the original target, attribution, payload and key. A `blocked` receipt is
terminal and stored as `blocked`, without a delivery timestamp. Retrying stops
before Ting's 14-day deduplication window ends. Acceptance means Ting accepted the
notification, not that the recipient read it.

### Live library sessions

`GET /v1/library/events` requires Present authentication and opens one anonymous
Ting WebSocket, registers `app_ids: ["present"]`, and binds the returned receiver
address to the caller on the backend. The caller cannot provide or adopt a Ting
session address. There is no extra Ting sign-in, no browser credential, and no
change to the account's notification preferences or subscriptions.

The SSE stream begins with `ready: {session_id}` only after binding. Clients must
then reconcile the library through ordinary authenticated reads. A library mutation
queues `present.libraryChanged` for each affected account's active observers. Its
wire body contains `session_id`, a stable key, `data: {}`, and `metadata: {}`; it
contains no `for`, `from`, resource identifier, title, comment or result. Receiving
this ting produces `library: {}` over SSE. All content and access checks remain in
Present. These content-free invalidations have no notification sound or inbox UI.

Affected observers include owners, acting accounts, direct and inherited members,
removed members, old parent-folder members after moves, and transfer participants.
Deck creation/import, rename, move, share changes, trash/restore and transfers
invalidate open lists. Permanent deletion refreshes the owner's trash. Editor Yjs
sync, presence, comments and presentation playback keep their existing streams.

The service rechecks the Present token and renews a 45-second lease every 15 seconds.
At most eight receivers can be attached per account across service processes.
Disconnect drops both the socket and lease; a crash leaves at most the lease TTL.
Streams end after four minutes so the web proxy can refresh authentication. Dead
sessions and `session_gone` are terminal: their queued messages are never sent to
a new session or broadcast to the account.

Decks, search, trash and transfers pages open the stream while visible, coalesce
bursts, reconnect with bounded exponential backoff and jitter, and reconcile after
every new `ready`. They also reconcile every 30 seconds while visible, covering
missed hints or unavailable Ting. Hiding or leaving the page closes its session.
Native clients may consume the same SSE endpoint with their Present access token;
`present ls` remains a one-shot command.

### Upgrade and configuration

`PRESENT_TING_URL` enables the integration (HTTPS; HTTP only on loopback). The
sender does not follow redirects with credentials. `PRESENT_TING_APP_ID` defaults
to `ting`; `PRESENT_TING_TIMEOUT_SECONDS` defaults to 15.

Migration `0006_ting_sessions.sql` adds sender attribution, receiver addresses,
leases and the terminal blocked state. Legacy unsent three-part notifications are
preserved as failed rows for reconciliation. They are not renamed in place: an
old request may already have been accepted before its response was lost. Inspect
Ting sent history before deliberately resending an old event with a new type/key.
Already sent historical rows remain unchanged.

The local `tools/ting-standin` checks proof scopes, two-part names, registered
schemas, subscription/session grants, exact idempotency fields and WebSocket
receiver lifetime. Install workspace dependencies with `pnpm install` before
running it. `TING_VERIFY=off` is restricted to local tests; it never changes the
real service's authentication.
