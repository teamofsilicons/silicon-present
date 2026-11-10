# Present Ting sessions production release — 2026-11-10

Live at https://present.teamofsilicons.com with API https://backend.present.teamofsilicons.com.

| Evidence | Value |
| --- | --- |
| Active release | `9c74d0bb79de-6839c22a02f3` |
| Source commit | `9c74d0bb79deaa9222b7125b938bef43691cfb58` |
| Web build | `ziwSho0YWP3EHc3GucG5r` |
| Linux ARM64 API SHA-256 | `c6be835d27074d63af20825e14b97a6d668c1fdfdb3db4889a926489c23187b8` |
| Release archive SHA-256 | `d7429e5c490ff479bd4cb8f367fa5b95d725394c4929e7783d70dcaf261e0ba9` |
| Original production baseline | `033c24591286-61754394c342` |
| Immediate previous release | `f3898ac5140a-1472fab540bf` |

The release upgrades the Ting integration to client 0.4.0 and uses authenticated Present streams backed by server-owned anonymous Ting receivers for library, trash, and transfer refreshes. Session hints contain only `{}`. Notifications use six registered two-part type names with schemas, scoped proofs, stable retry keys, actor attribution for account notifications, and terminal handling for blocked or expired targets.

Migration 0006 adds receiver leases and session/actor outbox fields. All six applied migration checksums and all 6,483 deployed manifest files were verified. There were no pending legacy notifications before migration; existing sent and failed records were preserved. Infrastructure definitions and the CLI binary were unchanged.

## Validation

- 51 service tests, 125 web unit tests, web typecheck/lint/build, and 10 focused production-build browser tests passed.
- The real Accounts proof integration and a real production Ting TLS registration passed.
- Linux ARM64 service startup and candidate web routes passed before cutover.
- Production tests as `si:saket-agents` confirmed two distinct receivers, create/rename/trash delivery to both, fresh addresses after reconnect, and content-free hints. Both QA decks were moved to trash.
- Final receiver audit: zero remaining QA leases, zero pending session hints, ten delivered hints, and one retired disconnected target without retargeting.
- All six new notification schemas matched the live catalog exactly; five historical types remain registered.
- API, web, converter, Caddy, PostgreSQL, and the backup timer were active; all three HTTP readiness checks passed. A real slide also rendered to a valid PNG through the restored converter.

The first live session check exposed conflicting Rustls providers when opening `wss://`, which plain local WebSocket stand-ins had not exercised. The final API explicitly selects its TLS provider before connecting; `tests/ting_tls.rs` covers the regression and optionally verifies a real secure receiver registration. The deployment also restored missing converter dependencies found during preflight.

## Artifacts, backups, and rollback

The full release is retained at `s3://silicon-present-production-backups-0wgfrhuv1g1i/releases/9c74d0bb79de-6839c22a02f3.tar.gz`. Local detailed receipts are under ignored `.dev/production/ting-sessions/`.

Consistent predeployment database and asset backups were uploaded under `backups/predeploy-20261110T130303Z.dump` / `backups/predeploy-20261110T130303Z-assets.tar.gz` and `backups/predeploy-20261110T132401Z.dump` / `backups/predeploy-20261110T132401Z-assets.tar.gz` in the same bucket. The original baseline archive is also saved under `backups/ting-sessions-baseline/033c24591286-61754394c342.tar.gz`.

Rollback must preserve the database. Before starting any binary predating session support, stop the API, mark pending session-addressed outbox rows failed without changing their keys or payloads, and clear receiver leases. This prevents the old sender from interpreting a session hint as an account notification. The automatic installer rollback used this guard. The immediate previous release supports session addressing but lacks the TLS-provider fix, so its live refreshes fall back to reconciliation until corrected.
