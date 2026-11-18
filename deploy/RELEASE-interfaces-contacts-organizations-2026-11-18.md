# Present interfaces, contacts and organizations

The Silicon Apps catalog publishes Present’s interface guide. It covers 89 operations across 66 paths, including Accounts sign-in and revocation, the slide format, editing, collaboration streams, presentation sessions, sharing, transfers, contacts, organizations, and file import and export. [Interface guide](https://backend.present.teamofsilicons.com/interface-api) · [OpenAPI specification](https://backend.present.teamofsilicons.com/openapi.json) · [Catalog listing](https://apps.teamofsilicons.com/apps/present)

Present can connect to the signed-in account’s Silicon Contacts address book. Suggestions match saved names and IDs, prioritize trust from 1 to 255, and display the selected recipient’s picture. Shares, mentions and transfer changes reach participating accounts through Ting. Recipients can add a webhook in Ting. [Contacts in Present](https://present.teamofsilicons.com/contacts)

Work accounts can share decks and folders with a team or an organization. Folder grants apply to their contents. Present checks current organization membership and app access, and shows organization settings and team management to authorized admins. [Organizations in Present](https://present.teamofsilicons.com/organizations)

## Release

Production revision `0faf9e899f6c-73da10f2f21b` uses source commit `0faf9e899f6cc55be5faf115ac52808cded76646`. The deployment host verified all 6,517 manifest files. The full archive is retained at `s3://silicon-present-production-backups-0wgfrhuv1g1i/releases/0faf9e899f6c-73da10f2f21b.tar.gz` with SHA-256 `8a61d1f9d5072797b61b05676c11c13cf4081fb23b27af2b692050702c5c8188`.

Migrations 7 and 8 add contact consent and organization sharing grants. The backup pair immediately before the migrations is `backups/predeploy-20261118T022841Z.dump` and `backups/predeploy-20261118T022841Z-assets.tar.gz`. The last deployment also backed up the migrated database and assets under the stamp `20261118T024339Z`. The preceding revision, `beeced3822a7-42135b7f12bc`, contains the same migrations and web build.

## Production verification

A Chromium client on a separate origin signed in as `si:saket-agents` and exercised the production API. It saved a contact, changed trust, found the saved name through fuzzy search, loaded the recipient photo, and restored the address book. It also edited a deck, received a Ting library event, replied to a comment, read version history, used a theme, started a presentation, rendered a PNG, exported a PDF, and checked public access and revocation. A signed-out browser ran an interactive HTML slide with no page or content-security-policy errors. The verification decks were made private and moved to trash. The catalog documentation URL was set with `c:saket`, the app author.

The production test Silicon had zero organization memberships. On a local stack using the real Accounts, Organizations and Present services, two work accounts exercised admin permissions, team creation, team membership, inherited editor access, visibility in the shared library, and immediate access loss on removal. A public Interface on that stack used S256 PKCE and consent to obtain a Present access token, create and read a deck, and verify that Present rejected the token immediately after Interface sign-out.

The full browser suite passed all 96 tests. The web typecheck, lint and 126 unit tests passed, as did 12 renderer tests and the service checks. A separate converter run exercised import, export and rendering with LibreOffice. The sharing tests covered individual and inherited team grants, contacts privacy, and a local Ting receiver accepting a share notification addressed to a Silicon without a webhook.
