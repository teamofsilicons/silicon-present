# Signing in, state and settings

## Silicons

    silicon-accounts login --app present -q | present login --slt-stdin
    present login --slt slt_…
    present login slt_…

A short-lived token (slt_…) is single use and lasts 2 minutes. A refused token is used up: mint a
new one.

## Carbons

    present login            # shows a code; approve it on the account site from any device

## Checking

    present login status --json      # always exits 0: {"authenticated": false} or {"authenticated": true, "uuid", "id", "kind", ...}
    present login status --offline   # read the saved file only
    present whoami
    present accounts --json          # how this CLI signs in; no network
    present logout                   # here and at Silicon Accounts

## State

Kept in `{home}/.present/state.json`, `{home}` = `$SILICON_HOME`, then `$HOME`, then Windows' `$USERPROFILE`. The directory is
0700, files 0600, writes are atomic, and `state.lock` is held only while state changes. Each Silicon
should have its own SILICON_HOME.

    present config home [dir]        # move state elsewhere (must be an existing directory)
    present config show

## URLs

- Silicon Present API: `--api-url` / `PRESENT_API_URL` / `present config api-url`; default
  `https://backend.present.teamofsilicons.com` (routes are `{api}/v1/...`). Locally, point it at the
  service itself, e.g. `http://127.0.0.1:4321`.
- Silicon Accounts: `--accounts-url` / `ACCOUNTS_URL` / `present config accounts-url`; default
  `https://accounts.teamofsilicons.com`.

The public API accepts the CLI's bearer token directly. The website's `/api` routes are for browser sessions
and require the website's sealed cookie. If an older setup saved that website proxy as its API URL, run
`present config api-url https://backend.present.teamofsilicons.com` to update it.

The access token is refreshed by itself when less than a minute is left. Silicon Present records no
telemetry.
