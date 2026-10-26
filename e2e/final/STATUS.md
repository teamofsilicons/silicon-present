# Present continuation and verification

Updated 2026-10-17. This continues the stopped local Claude build at commit `6fadfb8`. The original direction remains
a minimal, light-only website with working browser and CLI journeys. Changes are local; no deployment is claimed.

## Completed fixes

- Rust and TypeScript share strict canonical writers, tolerant pure readers, Unicode-safe text operations,
  formatting-preserving replacements, atomic invalid-op rejection, and consistent malformed-document handling.
  Tables, master slides, ordering and stale-base targets have dedicated regressions.
- The service stages content on a trial document and persists it before replacing live state. Invalid UTF-16
  boundaries cannot corrupt the room or its history. The local yrs patch is documented in `vendor/yrs/PATCH.md`.
- Push recovery persists identities, uploads and the exact pending request; durable service idempotency prevents
  concurrent replay. An interrupted refresh or successful push without refresh requires a pull before another push.
  Local references cannot traverse outside the deck folder or follow symlinks.
  Pull and push share an OS file lock, released on process exit; ids cannot collide on case-insensitive disks.
- Revoked live readers stop receiving content; historical exports require editor access. Presence and request
  bodies are bounded. Uploaded active documents receive restrictive headers, preserved by the web proxy.
- Chromium and Node converter downloads validate and pin public destinations and restrict private service access
  to exact signed asset paths. Native Office processes remain outside that network boundary.
- Tests require checked-in cross-language fixtures and compare independent expected JSON rather than regenerating
  expected data. The deterministic parity probe is now reproducible from the repository.

## Reproduce

The local Accounts stack must already run from `e2e/stack/test-stack.json`, and Present's Postgres cluster must run
on 5490 (`scripts/dev-db.sh start`). Secrets stay in the existing ignored stack files and process environment.

```sh
CARGO_TARGET_DIR="$PWD/target" CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 cargo test --workspace
pnpm test:deck
pnpm test:render
pnpm test:renderer
pnpm test:contract
pnpm test:contract:probe
pnpm --filter @silicon-present/web typecheck
pnpm --filter @silicon-present/web lint
pnpm --filter @silicon-present/web test
pnpm --filter @silicon-present/web build
pnpm run test:web:production --screens --service-live
bash e2e/cli/run.sh
```

The production browser runner owns ports 4320–4323, checks that they are free, copies its service executable to
avoid macOS executable-replacement failures, and stops only its own processes. `--service-live` also uses 4363 for
the Ting stand-in. Results are in `.dev/final/`; screenshots are in `web/screens/`. Other Playwright selectors can
be passed through the runner. Native Keynote conversion is serialized on the host; run native converter suites
sequentially when possible.

## Evidence boundaries

`requirements.json` contains 840 acceptance statements, not 840 verified results. It remains an inventory until
each statement is linked to observed evidence. Current tests cover broad local workflows, but do not prove every
statement, production deployment, real Ting delivery or report-email delivery. Local Accounts is real; the test
notification and messaging endpoints are stand-ins. The default Cargo run does not execute the opt-in live-service
tests; use the production runner's `--service-live` option for those.

Keynote 14.1 on this host currently opens test documents but fails AppleScript document queries (`-1728` / `-1708`).
That blocks native `.key` export and faithful `.key` import. LibreOffice's fallback drops hidden-slide metadata and
rasterizes some shapes before Present reads its output, losing editable shape/fill information. No flags are guessed
and no fidelity assertions have been weakened.
This is not evidence of denied Automation permission. The converter now reports the original scripting error
promptly, and the browser export test refuses to count arbitrary Keynote errors as success. Installing or repairing
the native application is separate from the code changes here.

The first full converter run also had three template failures: Nature_Illustration aborted inside LibreOffice's
PowerPoint output writer; Vintage and Blueprint_Plans produced unusable intermediate output. Original templates
passed ZIP integrity checks, all three reruns passed, and a complete ordered ten-template rerun passed. Low disk
space was observed at the time but is not a proven cause. No blanket retry or weakened comparison was added.

## Final verification results

| Check | Result | Local evidence |
| --- | --- | --- |
| Rust workspace | Passed, including four real-process CLI recovery/concurrency tests | `.dev/codex-rust-workspace.log` |
| TypeScript deck | 57 passed; typecheck passed | package test run |
| Shared contract expectations | 26 passed; nine successful documents exchanged in both directions | `.dev/codex-contract.log` |
| Deterministic differential probe | 6,100 passed, seed 42 | `.dev/codex-parity-probe.log` |
| Render package | 12 passed | `.dev/codex-render.log` |
| Web checks | Typecheck, lint, 56 unit tests and production build passed | `.dev/codex-web-*.log` |
| Opt-in live service | Both real-Accounts/Ting-stand-in and real-converter journeys passed | `.dev/final/service-live-tests.log` |
| Full CLI journey | 336 passed; native `.key` export failed with the diagnosed host scripting error | `/tmp/present-cli-final-e2e.log` |
| Full converter rerun | 50 passed; only native `.key` export and fallback import fidelity failed; all ten template comparisons passed | `/tmp/present-renderer-final-rerun.log` |
| Full production browser/screens run | 70 passed; native `.key` export failed; its serial group initially skipped three following checks | `.dev/final/browser-all-tests.log` |
| Focused production file/screens rerun | 13 passed, none skipped; only native `.key` export failed | `.dev/final/browser-tests.log` |

The file checks now run independently so a failed native format cannot suppress the following image/import checks.
The focused rerun passed all three checks previously skipped (single-slide export/render, opening a PowerPoint file,
and page-error checks), plus desktop/phone capture with the editor included. Fifty fresh screenshots (34 page views
and 16 editor scenarios) were visually inspected with no blank/error screen, horizontal clipping or visible layout
defect. Automated accessibility checks passed separately; screenshot review alone is not an accessibility audit.

All owned service and converter test processes were stopped after the runs, and their ports are free. Remaining work includes
native Keynote host repair and rerunning its strict import/export tests. Production rollout and the remaining
requirement-by-requirement evidence audit are not completed by these local test results.
