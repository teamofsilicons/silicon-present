# Silicon Present CLI 0.1.1

This CLI release adds layer commands and native Windows and Apple Silicon Mac packages. The browser's bottom-right Layers panel and row dragging were deployed separately on 2026-10-25; the web/API revision remains `6fadfb8a38d9-5dac8085e65b`.

## Commands

```sh
present layers DECK SLIDE
present layers move DECK SLIDE ELEMENT_A ELEMENT_B --to front
present layers move DECK SLIDE ELEMENT --before TARGET
present layers move DECK SLIDE ELEMENT --after TARGET
present docs layers
```

The list is front first and includes IDs, z positions, groups and locks. Multiple selected objects retain their relative order; selecting a group member moves the whole unlocked group. Relative placement respects target group boundaries. Locked objects and groups containing a locked member are skipped. Existing `front` and `back` commands use the same rules. Commands resolve selectors against one snapshot and submit one versioned edit through the existing authenticated client; the service merges concurrent edits through its normal protocol.

Windows home discovery uses `SILICON_HOME`, then `HOME`, then `USERPROFILE`. The CLI package alone is versioned 0.1.1; the deployed service and shared client keep their existing versions.

## Validation and packaging

- All 30 CLI tests pass: 14 unit, 2 defaults, 3 native home/state, 7 command/HTTP integration and 4 recovery tests. The planner exercises 1,792 combinations of selections, directions, groups, locks and relative destinations. Native `cargo clippy -p present-cli --all-targets -- -D warnings` passes.
- Five release packaging tests pass. Build scripts bind archives to the complete CLI/client source, embedded documentation and dependency lockfile; they reject mixed-source or wrong-architecture builds.
- `scripts/build-cli-release.py` builds sequentially using the repository target directory. `scripts/package-cli-release.py` produces Apps archives and a Windows ZIP. Windows links the CRT statically; Linux x86_64 uses musl.
- Release artifacts and validation receipts are retained under ignored `.dev/production/cli-platforms/`, `.dev/production/cli-builds-0.1.1/` and `.dev/production/cli-release-0.1.1/`.

Published to Silicon Apps production on **2026-10-25 at 04:01:29 IST** (2026-10-24 22:31:29 UTC).

- Production release: `4e373975-4baa-437b-8549-8d8d29eb0a97`.
- Development release: `eada1982-bee5-4cba-8abd-060aeb0f8b8b`.
- All four packages passed Apps' isolated `--help`, `accounts --json` and signed-out `login status --json` checks before release creation.
- Fresh anonymous development and default production installs passed on all four targets. Each Mac/Linux proof passed 13 checks; each Windows proof passed 23, including command shims, `USERPROFILE` fallback and four successive state writes/readbacks. Signatures, archive/binary hashes, version, layer help and signed-out state were verified; test updaters stayed disabled.
- A normal Linux ARM64 `silicon-apps update present` upgraded an isolated 0.1.0 installation to 0.1.1. Eleven checks confirmed the production release, executable and layer commands, preserving a user marker and saved API preference byte for byte.
- Linux x86_64 installation ran without emulation in an existing pinned Debian 13 container. The gateway host's Amazon Linux 2023 glibc 2.34 cannot run the published Apps 0.3.1 installer (which requires glibc 2.38/2.39); this failed before Present installation. The Present x86_64 binary itself uses static musl. Linux ARM64 installation ran directly on the Ubuntu host.
- Independent public catalog/resolve checks select production 0.1.1 and the exact frozen archive on all four targets. Chrome visibly shows version 0.1.1, the release notes and macOS Apple Silicon, Windows x64, Linux x86-64/ARM64 availability; screenshot `apps-listing-live.png` is retained with the receipts.

```sh
silicon-apps install present
# For an existing installation:
silicon-apps update present
present docs layers
```

## Frozen artifacts

Source fingerprint: `d1b93a0efce04e168a6903f1360e1ef3129108f19f9106a947727ffabfe7ff48`.

| Target | Apps archive SHA-256 |
| --- | --- |
| `macos-aarch64` | `df6e675f755e91e0ecffde6fb3114c66b73844935af15a605ab3e3778578aa93` |
| `linux-aarch64` | `8b12b905135b080d8b3a4b4108efe4a4d970cd49ea92772c8e06dd0078e7c18a` |
| `linux-x86_64` | `24d58c57653cfdb132d5ed66a6f4bd05e5d56f99a0cd25ac1259600a176d46ba` |
| `windows-x86_64` | `565da8cd53c281063fb7e06343f6adbfd3402b37975b5ad7c7686825a35d4760` |

All four archive checksums and their embedded binary checksums were independently rechecked against the final manifest. The Mac release binary passed ten authenticated production layer checks on private synthetic deck `Mtyim5oD76oh`, with exact content restoration after the checks. The published binary has the same SHA-256 as the staged binary tested against production.

## Temporary Mac validation transport

The exact approved Mac archive passed local sandbox checks but exceeded the release session's default 30-second upload limit through the private relay. The release-only helper now accepts an explicit `--upload-seconds 60`, still capped at 60 seconds and shortened to preserve the lease's 90-second execution reserve. Seven helper tests pass, including slow-transfer and expiry cases; independent review confirmed unchanged authentication, exact archive, size and sandbox boundaries. Gateway-forwarded validation then passed in approximately 50 seconds. The ordinary gateway limits were not changed. The temporary API target, gateway route, forwarding key, secret field, token and tunnel were removed. Both loopback listeners closed and the worker exited cleanly; the existing Windows route and other secret fields were preserved. The permanent Mac upload validator remains unconfigured; the accepted immutable Mac package continues to resolve and install normally. Cleanup receipt: `mac-session-cleanup.json`.

## Published feature journey and fixture cleanup

The fresh default production Mac installation passed the same ten authenticated live layer checks as the staged build: front-first listing/z positions, stable multi-selection, before/after placement, one-step moves, legacy commands, source and target group boundaries, locked no-ops without version changes, and mixed locked/unlocked selection. Receipt: `live-layers-published-macos.json`.

Private synthetic fixture `Mtyim5oD76oh` was restored exactly apart from its monotonically increasing version (1 → 23), then moved to recoverable Trash. User decks and sharing were unchanged. Receipt: `fixture-cleanup.json`.

Independent public default-channel resolution and full downloads of all four Apps archives matched the frozen sizes and SHA-256 checksums. Receipt: `public-download-verification.json`.
