# present-service

Silicon Present's service: the whole API in `docs/architecture.md` ("The service" and "Answers"), live sync over
SSE + POST, storage in Postgres, sharing, comments, versions, Ting and presentations. No telemetry.

## Run it

```sh
scripts/dev-db.sh start                       # Postgres 16 on 127.0.0.1:5490 (.dev/pg)
scripts/dev-db.sh create present_mylane       # a database for your lane, if needed
cargo build -p present-service                # with CARGO_TARGET_DIR=…/silicon-present/target CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0

PRESENT_DATABASE_URL=postgres://present@127.0.0.1:5490/present \
PRESENT_BIND=127.0.0.1:4321 \
PRESENT_PUBLIC_URL=http://127.0.0.1:4321 \
PRESENT_WEB_URL=http://127.0.0.1:4320 \
PRESENT_DATA_DIR=.dev/data \
ACCOUNTS_URL=http://localhost:9740 ACCOUNTS_API_URL=http://127.0.0.1:9741 \
PRESENT_APP_SECRET=<present app secret from e2e/stack/test-stack.json> \
PRESENT_IRIS_URL=http://127.0.0.1:9745 \
PRESENT_CONVERTER_URL=http://127.0.0.1:4322 CONVERTER_SECRET=<converter secret> \
PRESENT_TING_URL=http://127.0.0.1:4323 \
target/debug/present-service
```

Migrations run at start. A missing setting stops it with one line per problem. Every setting:

| Variable | Required | Meaning |
| --- | --- | --- |
| `PRESENT_DATABASE_URL` | yes | Postgres URL |
| `PRESENT_PUBLIC_URL` | yes | The service's own base URL as the converter reaches it (signed asset URLs) |
| `PRESENT_WEB_URL` | yes | The web editor's base URL, for links in tings and follow links |
| `PRESENT_DATA_DIR` | yes | Where asset files live (`assets/` inside; created if missing) |
| `ACCOUNTS_URL` | yes | Silicon Accounts public URL = the token issuer |
| `PRESENT_APP_SECRET` | yes | The `present` app's secret at Silicon Accounts |
| `PRESENT_BIND` | no (127.0.0.1:4321) | Listen address |
| `ACCOUNTS_API_URL` | no (= `ACCOUNTS_URL`) | Accounts for server-to-server calls (JWKS, lookups, proofs) |
| `PRESENT_APP_ID` | no (`present`) | Token audience / app id |
| `PRESENT_IRIS_URL` | no (`https://iris.teamofsilicons.com`) | Default photos: `{url}/pfp/{carbon\|silicon}?id=<uuid>` |
| `PRESENT_CONVERTER_URL`, `CONVERTER_SECRET` | no | The converter; without it imports/exports/renders answer 503 `converter_not_configured` |
| `PRESENT_TING_URL` | no | Silicon Ting; without it tings stay in `ting_outbox` as `ting_not_configured` |
| `PRESENT_TING_APP_ID` | no (`ting`) | Ting's app id (receiving app of the proofs) |
| `PRESENT_TING_TIMEOUT_SECONDS` | no (15) | Timeout per Ting call |
| `PRESENT_POSTMARK_TOKEN`, `PRESENT_MAIL_FROM` | no | Invite emails; without a token they stay in `email_outbox` and are logged |
| `ACCOUNTS_ALLOW_INSECURE_HTTP` | no | Allow plain http to a non-loopback Accounts (loopback is always allowed) |
| `RUST_LOG` | no (`info`) | Log filter |

`present-service --help` prints the same list.

## Test it

`cargo test -p present-service` runs everything against throwaway databases on the 5490 cluster (created and dropped
per test), with a real token verifier against a JWKS the tests serve and fakes for Accounts lookups, Ting and the
converter. Two opt-in suites use the real things:

```sh
# the local Silicon Accounts stack + tools/ting-standin on 4363 (started by the test)
PRESENT_LIVE_STACK=1 cargo test -p present-service --test live_stack
# the real converter (renderer/), e.g. on the service-tests lane:
#   (cd renderer && CONVERTER_PORT=4362 CONVERTER_SECRET=s ./node_modules/.bin/tsx src/server.ts)
PRESENT_LIVE_CONVERTER_URL=http://127.0.0.1:4362 PRESENT_LIVE_CONVERTER_SECRET=s cargo test -p present-service --test live_converter
```

The Ting stand-in (`node tools/ting-standin/server.mjs`, port `TING_PORT`, default 4323) records every ting and
subscription; tests read them at `GET /_tings` and `GET /_subscriptions`. See its header for the rest.
