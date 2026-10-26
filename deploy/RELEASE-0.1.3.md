# Present CLI 0.1.3

Published to Silicon Apps on 27 October 2026 (production release `17339f70-108b-405a-9b2b-9ad0a39a2754`). `present export --format` takes exactly pptx, odp, pdf, txt, png, jpg and svg; ppt, key and html are no longer export formats (they still open). Keynote users export pptx and open it in Keynote.

Fresh installs from the development and production channels passed 17 checks each on macOS ARM64 (this Mac), Linux ARM64 and Linux x86-64 (native, via SSM). All four public production targets resolve to and download the exact packaged archives. See `verification-cli-0.1.3.json`.

**Windows x86-64 was not tested.** The user waived the Windows run; its package was uploaded with `--confirm-platform-checks` on that waiver only, and no Windows command, install or proof was run.

Binaries, manifest and receipts are in `.dev/production/cli-release-0.1.3/` and `.dev/production/cli-0.1.3/`.
