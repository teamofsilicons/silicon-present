# Custom themes, slide word limit and Present CLI 0.1.4

Deployed on 29 October 2026 (IST) to https://present.teamofsilicons.com, with Present CLI 0.1.4 published to Silicon Apps.

## What changed

- **Custom themes.** A theme saved from a deck belongs to its account and can be used in any deck that account edits
  (`/v1/themes`, migration `0005_themes.sql`). Saving keeps copies of fonts uploaded to the deck. Editors of a shared deck
  can add its theme to their own themes as a separate copy; commenters and viewers can't. Web: "Your themes" and
  "Save to my themes" / "Add to my themes" in the Theme panel. CLI: `present theme <deck> --save NAME`,
  `present theme <deck> NAME`, `--list`, `--rename`, `--delete`.
- **Slide word limit (CLI).** `add`, `slide add` and `set text=` refuse a change that adds words and takes a slide past
  50 words (`slide_too_text_heavy`) unless `--dangerously-add-long-text` is given. Text boxes, shape text and table cells
  count; notes, charts, images and HTML don't. Not enforced for `replace`, `push`, raw `edit` ops or the web editor.

## Server release

- Revision `4322b03d641e-70e609d2b0f2` (archive SHA256 `2b0641216fb1d00168ec3956c7ce5fadf10d24e89308bbc02dc935e1d7d3812e`),
  web BUILD_ID `MyGmZcOJSq1bZlw6NAuX1`, service SHA256 `568d7b0b7272ebacabc6156d5f4386f3389062203aa9e29d79ea371173ee8658`.
- Rollback target: `4322b03d641e-0d511889abf3`, a web-only branding release that went live from another session
  minutes before this one. This release's web build contains the same branding commits (`de82852`, `4322b03`).
  Migration 0005 only adds tables, which the rollback release ignores.
- Outside `web/`, only `bin/present-service` and `migrations/0005_themes.sql` changed; every other file, mode and link
  was kept as in the baseline.
- Before deploying: Rust 146 tests (service, deck, client, CLI) and clippy; web typecheck, lint, 124 unit tests,
  production build; the themes browser test (`web/e2e/editor-themes.spec.ts`) was run locally by the themes session.
- The installer took predeploy backups `backups/predeploy-20261029T060146Z{.dump,-assets.tar.gz}`. Afterwards, 6473
  deployed file hashes, six active units, local and public health, and migrations 1–5 checksums were verified.
- Live check as si:saket-agents with CLI 0.1.4: saved a theme, applied it to a second deck and rendered it, then
  confirmed the word limit refuses an 80-word slide and accepts it with the flag. The live site serves the
  Theme panel strings. Both check decks were trashed and the check theme deleted.
- Not done live: a signed-in browser walk of the Theme panel (covered by the local browser test).

## Present CLI 0.1.4

- Production release `22c9da81-746a-4726-a870-a91effc8ea98` (promoted from development
  `d63ed3b1-c55c-4f1b-bd0a-6401cf8c2323`). Packages: macos-aarch64 `8c547b12…`, linux-aarch64 `eda8f590…`,
  linux-x86_64 `990dbc21…`, windows-x86_64 `0cca7657…`.
- Fresh installs from development and production passed 17 checks each on macOS ARM64 (this Mac); the Linux ARM64 and
  x86-64 install proofs passed on both channels. All four targets resolve publicly to 0.1.4 with matching hashes.
- **Windows x86-64 was not tested.** No Windows machine exists; the user chose to publish it untested, and it was
  uploaded with `--confirm-platform-checks` on that waiver only.

Records: `.dev/production/custom-themes/` (server) and `.dev/production/cli-0.1.4/` (CLI).
