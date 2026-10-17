# Silicon Present on the web

`present.teamofsilicons.com`: decks and folders, the slide editor, comments, sharing, history and present mode, for
Carbons in the browser (Silicons use the `present` command line). Built from the shared Silicon web kit (the rest of
this file is the kit's guide). Light mode only and minimal, for now: one calm column, a wordmark and one pill.

## Run it locally (the "web pages" lane, docs/architecture.md)

Postgres on 5490 (`.dev/pg`, database `present_pages`) and the Silicon Accounts test stack (9740/9741,
`e2e/stack/test-stack.json`) must run. Then, from the repository root:

```sh
# The converter on 4332 (its own process; tsx reads the sources at start, so restart it after changes)
(cd renderer && CONVERTER_PORT=4332 CONVERTER_SECRET=<any secret> ./node_modules/.bin/tsx src/server.ts)

# The service on 4331. Run a copy of the binary: macOS kills a process whose executable is rewritten, and the
# shared target/ is rebuilt by everyone.
CARGO_TARGET_DIR=$PWD/target CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 cargo build -p present-service
mkdir -p .dev/pages/bin && cp target/debug/present-service .dev/pages/bin/present-service.new \
  && mv .dev/pages/bin/present-service.new .dev/pages/bin/present-service
PRESENT_DATABASE_URL=postgres://present@127.0.0.1:5490/present_pages PRESENT_BIND=127.0.0.1:4331 \
PRESENT_PUBLIC_URL=http://127.0.0.1:4331 PRESENT_WEB_URL=http://127.0.0.1:4330 PRESENT_DATA_DIR=$PWD/.dev/pages \
ACCOUNTS_URL=http://localhost:9740 ACCOUNTS_API_URL=http://127.0.0.1:9741 PRESENT_APP_SECRET=<present's secret> \
PRESENT_IRIS_URL=http://127.0.0.1:9745 PRESENT_CONVERTER_URL=http://127.0.0.1:4332 CONVERTER_SECRET=<same secret> \
  .dev/pages/bin/present-service

# The web on 4330
cd web
cp .env.example .env.local   # APP_SECRET from e2e/stack/test-stack.json; APP_API_URL=http://127.0.0.1:4331;
                             # PUBLIC_URL=http://127.0.0.1:4330; SESSION_SECRET=$(openssl rand -base64 48)
PORT=4330 pnpm dev
E2E_PORT=4330 pnpm test:e2e  # the kit's specs, e2e/pages*.spec.ts and the editor's specs against the real stack
E2E_PORT=4330 pnpm screens   # PNGs of every page at 1440 and 390 into screens/ (and screens/top/ for the first screen)
```

Each lane runs its own browser tests beside the others: `E2E_PORT` picks the lane (4330 pages, 4340 editor), and the
results folder, the signed-in Carbons (`test-results/.auth-<port>`) and the `next dev` build directory
(`.next-e2e-<port>`) are kept per port. The setup reuses the last run's two Carbons for 12 hours
(`E2E_FRESH_ACCOUNTS=1` signs new ones in), so repeated runs stay off the shared stack's email-code budget.

## Pages

| Address | What |
| --- | --- |
| `/` | the landing page (signed out); signed in it goes to `/decks` |
| `/decks` | My decks; `?scope=shared` Shared with me; `?folder=<id>` one folder, with breadcrumbs. New deck, new folder, open a file (import with progress), search, and per row rename, share, move, transfer, move to trash |
| `/trash` | restore, or delete for good (asks to type the name) |
| `/transfers` | accept or decline what was offered to you, cancel what you offered |
| `/decks/[id]` | the editor (and its view and comment mode); owned by the editor (`app/(editor)`) |
| `/decks/[id]/history` | versions, events between them, open read-only, compare, restore whole/slide/element, undo one account, name, new deck from a version |
| `/decks/[id]/present` | present mode (public decks open signed out) |
| `/decks/[id]/presenter` | presenter view: notes, current and next slide, timer, follow link; in step with present mode over a BroadcastChannel |
| `/p/[presentation]` | follow a presentation live (SSE through the proxy; public decks signed out) |
| `/sandbox/html` | the page every HTML element of a slide runs in (see below) |

## For the editor: what to import

- **The service, typed**: `import { getDeck, getContent, ... } from "@/lib/present"` (one file per area in
  `lib/present/`: `decks`, `sharing`, `transfers`, `versions`, `presentations`, `files`, `me`; shapes in `types.ts`,
  made tolerant by `normalize.ts`). Server Components: `lib/present/server.ts` and `lib/present/load-public.ts`.
- **Share dialog**: `import { ShareButton, ShareDialog } from "@/components/share"`.
  `<ShareButton kind="deck" id={id} name={title} selfId={me?.id} role={deck.role} />` or the controlled
  `<ShareDialog ... open={open} onOpenChange={setOpen} onChanged={access => ...} />`. It reads and writes the service
  itself (no query client needed) and needs the kit's toast stack (`Providers`).
- **Export menu**: `import { ExportMenu } from "@/components/export"`. `<ExportMenu deck={id} />` gives the whole
  deck in every format; `version` downloads the deck as it was; `slide` adds "This slide" as one PNG or JPG. Plain
  download links through the proxy (works for public visitors too).
- **Public decks signed out**: `lib/session-optional.ts`.
  - `proxy.ts` lets `/decks/[id]`, `/decks/[id]/present` and `/p/[id]` render without a session (`isPublicPage`).
  - The API proxy forwards the public reads with no token when there is no session (`lib/server/forward.ts`
    `publicReadPath`: the deck, `content`, `live`, `threads`, `export`, slide renders, assets, presentations). Every
    write (comments, updates, presence) still needs a session: send the visitor to `signInHref(here)`.
  - In a Server Component: `const session = await getOptionalSession()` (never redirects) and
    `const { data, error, signedIn } = await optionalApiFetch(path)` (the token when signed in, none otherwise; errors
    as data). A private deck seen signed out answers 401/403/404: `redirect(signInHref("/decks/" + id))`.
  - A layout for those pages must not call `requireSession()`; mount
    `<Providers session={sessionView(session)}>` (see `app/(present)/layout.tsx`).
- **Slides on a page**: `components/slides/slide-view.tsx` (`SlideStyles` once per page, `SlideView` per slide, scaled
  to its box) wraps `@silicon-present/render`.
- **HTML elements must run through `/sandbox/html`**: a `srcdoc` iframe inherits this site's CSP (scripts by nonce
  only), so an element's JS would never run in place. After putting `renderSlideHtml(...)` markup in the page, call
  `liveHtmlElements(container)` from `lib/slides/sandbox.ts` (it returns a cleanup). The frames stay
  `sandbox="allow-scripts"` with an opaque origin. Images, video, audio and Google fonts load from anywhere (CSP).

## The web kit

Present departs from the kit in three ways: light only (the theme is pinned to light; no switch, no dark tokens), a
top bar with the wordmark and one pill instead of the sidebar, and the demo removed (its pages, stub service and
specs). What follows is the kit's own guide, kept for the parts Present shares (sign-in, the session, the proxy, the
environment); its "Run it" now points at Present's own lane above.

The template every Silicon app's web frontend is built from. Copy it into an app's `web/`, edit one file
(`lib/app.config.ts`), and the app has:

- **The Silicon look** of the developer site, the account site and the store: BDO Grotesk (self-hosted) over the system
  text face, the light `#F7F8FA`/`#292929` and dark `#02040A`/`#F7F8FA` palettes with brand blue `#1F5FB8` for actions,
  squircles on every rounded surface, and a light, dark or system theme that is remembered and never flashes.
- **Arc UI** (uiarc.dev): every free component, vendored with the Silicon edits, and `@uiarc` registered for the shadcn
  CLI so more can be added.
- **A signed-in workspace**: a sidebar with the app's sections (a menu sheet on phones), a top bar with ⌘K search, the
  account menu (photo, display name, `c:`/`si:` id, Carbon or Silicon, theme, sign out), toasts, empty states,
  skeletons, and error and not-found pages.
- **Sign-in with Silicon Accounts as a BFF**: the hosted sign-in with PKCE, the code exchanged with the app secret on
  the server, the session sealed in one httpOnly cookie, single-flight refresh, sign-out that revokes. The browser never
  holds a token.
- **A proxy to the app's own service**: `/api/*` reaches `APP_API_URL` with `Authorization: Bearer`, and Server
  Components call it with `apiFetch()`.
- **Public pages**: a server-rendered landing page, `robots.txt`, `sitemap.xml`, the manifest, `llms.txt`, icons and an
  Open Graph image, all built from the config.
- **The account chip and the share-with-accounts control**, since sharing now names exact accounts.

It ships with a small demo, "Web Kit" (`app_id` `webkit`): three workspace pages on a stub service, so the kit runs and
is tested on its own. [ADOPTING.md](ADOPTING.md) is the checklist for turning it into an app's frontend;
[DESIGN.md](DESIGN.md) is the design system it follows.

Next.js 16 (App Router, Turbopack) with React 19 and TypeScript strict, pnpm 10.33, Node 24 or newer. The dependency
pins are the developer site's (`silicon-accounts/developer/package.json`). Read the bundled Next docs in
`node_modules/next/dist/docs/` before relying on memory: `proxy.ts` instead of `middleware.ts`, async `params`,
`PageProps` from `next typegen`.

## Run it

See "Run it locally" at the top of this file: Present's web on 4330 against its own service (4331) and converter
(4332), signing Carbons in on the local Silicon Accounts test stack (9740/9741).

| Command | What |
| --- | --- |
| `pnpm dev` | `next dev` on `$PORT` (4320; the pages lane uses `PORT=4330`) |
| `pnpm build`, `pnpm start` | the production build and server (`NEXT_OUTPUT=standalone pnpm build` for a self-contained server) |
| `pnpm typecheck` | `next typegen` + `tsc --noEmit` |
| `pnpm lint` | ESLint (Next's core-web-vitals and TypeScript rules), zero warnings |
| `pnpm test` | unit tests (`node:test` through tsx), no network |
| `pnpm test:e2e` | browser tests (Chromium) against the Accounts stack and the real service: public pages, sign-in through the hosted pages, the API proxy, real refreshes, accessibility (axe-core, WCAG 2.2 AA) on every page, sign-out in every tab, and Present's own journeys (e2e/pages*.spec.ts, e2e/editor*.spec.ts) |
| `pnpm screens` | PNGs of every page, light only, desktop (1440 × 900) and phone (390 × 844), into `screens/` |

The browser tests start `next dev` (in `.next-e2e-<port>`) unless it already runs; the service and the converter must
already run. They need the present app's secret: `APP_SECRET` in the environment or `.env.local`, else it is read from
`../e2e/stack/test-stack.json` (or `TEST_STACK_JSON=<path>`). `pnpm exec playwright
install chromium` once if Playwright has no Chromium yet. `e2e/public.spec.ts`, `session.spec.ts`, `refresh.spec.ts`
and `a11y.spec.ts` read `lib/app.config.ts` and stay when an app adopts the kit; Present's own journeys are
`e2e/pages*.spec.ts` (this part of the web) and `e2e/editor*.spec.ts` (the editor). The refresh tests reseal the session cookie with an earlier expiry (they know `SESSION_SECRET`), as if
half an hour had passed.

The shared stack allows 30 email codes per network in 10 minutes, for every app's tests together. A run spends two:
the `setup` project (`e2e/accounts.setup.ts`) signs two new Carbons in with a code, and every spec then signs in to the
kit as one of them with "Continue as" (a sign-in of its own, without a code). If the stack still counts down, the
sign-in helper waits it out.

## Environment

Read per request (`lib/server/env.ts`), never baked into the build, and checked at boot (`instrumentation.ts`): a
missing or malformed value stops `next start` with one exact sentence per problem, and in `next dev` every page and
route answers the same words until it is fixed. Secrets are never echoed.

| Variable | Required | What |
| --- | --- | --- |
| `APP_ID` | no (defaults to `appConfig.appId`) | The app's Silicon Accounts `app_id`. |
| `APP_SECRET` | yes | The app secret (`sa_app_…`). Server only: the code exchange, refresh and revoke send it with HTTP Basic. |
| `ACCOUNTS_URL` | yes | The public origin of Silicon Accounts (`https://accounts.teamofsilicons.com`; a local stack `http://localhost:9590`): the hosted sign-in, and the issuer of every token. |
| `ACCOUNTS_API_URL` | no (defaults to `ACCOUNTS_URL`) | Where this server reaches the Accounts API (a private address next to it, or the local stack's `http://127.0.0.1:9589`). |
| `APP_API_URL` | yes | The app's own service. `/api/*` and `apiFetch()` call it with the bearer token. May carry a path prefix. |
| `SESSION_SECRET` | yes | At least 32 bytes of randomness (`openssl rand -base64 48`). Seals the cookies; changing it signs everyone out. |
| `PUBLIC_URL` | yes | This site's origin. The redirect URI registered at Silicon Accounts is exactly `{PUBLIC_URL}/auth/callback`. |
| `EXTRA_IMG_ORIGINS` | no | More origins images may load from (the local stack's mock Iris, `http://127.0.0.1:9594`). |
| `EXTRA_ORIGINS` | no | More origins allowed to send state-changing requests (another domain of this same site). |

Production (`NODE_ENV=production`) requires https for `ACCOUNTS_URL` and `PUBLIC_URL` outside `localhost` and
`127.0.0.1`; over https the cookies are `Secure` and `__Host-` prefixed.

## How it works

```
browser ──── same origin only ────▶ this Next server ──── Basic app_id:app_secret ────▶ Silicon Accounts
   │  sealed httpOnly cookie          │  /auth/*: PKCE, exchange, refresh, revoke          (token, revoke)
   │  (never a token)                 │
   │                                  └── Authorization: Bearer <access token> ─────────▶ the app's service
   └── /auth/sign-in ──▶ {ACCOUNTS_URL}/authorize (the hosted pages) ──▶ /auth/callback       (APP_API_URL)
```

| Path | What it does |
| --- | --- |
| `/auth/sign-in?return_to=/x` | A fresh `state` and PKCE verifier are sealed into a 10-minute cookie (`<app_id>_signin`, up to three at once, for three tabs) and the browser goes to `{ACCOUNTS_URL}/authorize?app_id&redirect_uri&response_type=code&scope&state&code_challenge&code_challenge_method=S256`. A request on another host than `PUBLIC_URL`'s goes there first, so the cookie lives where the callback lands. `prompt=login\|select_account` and `intent=signup` pass through. |
| `/auth/callback` | The `state` must be one this browser started. The code is exchanged at `POST {ACCOUNTS_API_URL}/v1/oauth/token` with the verifier and the app's credentials; the tokens and the account go into the session cookie; a sign-in it replaces is revoked. Failures land on `/sign-in?error=<code>` with fixed words (never the address's `error_description`); `access_denied` gets a friendly page. |
| `/auth/sign-out` (POST) | Revokes the refresh token (`POST /v1/oauth/revoke`) and clears the cookie. A fetch gets 204; a form post goes to `/sign-in?signed_out=1`. |
| `/auth/session` | `{signed_in, account, expires_at}` from the cookie alone: no call to Accounts, never a token. |
| `/auth/refresh` | POST: the browser's session keeper refreshes when under 5 minutes are left (and only then). GET `?return_to=`: for a Server Component that found the token expired. |
| `/api/*` | The proxy to `APP_API_URL` (below). |
| everything else | the pages; `proxy.ts` runs first |

**The session** (`<app_id>_session`, `__Host-<app_id>_session` over https): httpOnly, SameSite=Lax, sealed with
AES-256-GCM under a key derived (HKDF-SHA256) from `SESSION_SECRET`, the cookie's purpose bound in as additional data
(`lib/server/seal.ts`). It holds the access token (an EdDSA JWT, `aud` = the app, 30 minutes), the refresh token
(rotates on every use, at most 900 days), their expiry times and the account as the app may show it: uuid, kind,
`c:`/`si:` id, display name, photo, a Silicon's custodian. Every refresh renews the account too.

**Refresh, one at a time.** Refresh tokens rotate, and presenting a used one ends the whole sign-in. So:

1. On the server, refreshing is single-flight per refresh token, and the answer is remembered for a minute for requests
   that still carry the old cookie (`lib/server/tokens.ts`). A failure is remembered for two seconds only.
2. The browser's session keeper (`lib/client/session.ts`) asks `POST /auth/refresh` 5 minutes before expiry, one tab at
   a time (`navigator.locks`), tells the other tabs (`BroadcastChannel`), and makes API calls wait for it in the last
   minute.
3. Page loads refresh in `proxy.ts` at 2 minutes left (Server Components cannot write cookies, so the proxy hands the
   new cookie to the render); `/api/*` refreshes only at 30 seconds.

Several server instances share no memory: on Vercel and behind load balancers the keeper is what keeps concurrent
refreshes from happening. A browser that sleeps through the refresh window refreshes on its first request back.

**The API proxy** (`app/api/[...path]/route.ts`, `lib/server/forward.ts`): `/api/v1/items?q=x` reaches
`{APP_API_URL}/v1/items?q=x` with the method, the query and the body streamed as sent. Request headers passed on:
`accept`, `accept-language`, `content-type`, `content-length`, `if-match`, `if-none-match`, `if-modified-since`,
`if-unmodified-since`, `range`, `idempotency-key`, `x-request-id`, the client's address (`X-Forwarded-For`) and user
agent, plus `appConfig.api.forwardHeaders`; never cookies or the browser's own `Authorization`. Answers come back
streamed with `content-type`, `content-disposition`, `content-language`, `content-range`, `accept-ranges`, `etag`,
`last-modified`, `location`, `retry-after`, `link` and `x-request-id` (plus `appConfig.api.exposeHeaders`), marked
`Cache-Control: private, no-store`; never `Set-Cookie`. A path with an empty, dot or encoded-slash segment answers 400
`invalid_path`. A 401 from the service clears the session and answers 401, and the browser sends the Carbon to
`/sign-in?reason=session_ended`.

**Same-origin guard (CSRF).** Every state-changing request to `/api/*`, `/auth/sign-out` and `/auth/refresh` must carry
an `Origin` of this site (`PUBLIC_URL`, `EXTRA_ORIGINS`, and in development its `localhost`/`127.0.0.1` twin) and, when
the browser sends it, `Sec-Fetch-Site: same-origin`; otherwise 403 `cross_site_request`.

**Pages' headers** (`proxy.ts`): a nonce CSP (`script-src 'self' 'nonce-…' 'strict-dynamic'`, `img-src 'self' data: blob:`
plus `ACCOUNTS_URL`, `https://iris.teamofsilicons.com` and `EXTRA_IMG_ORIGINS` for profile photos, `connect-src 'self'`,
`frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'none'`), `X-Frame-Options: DENY`, nosniff, a strict referrer
policy, a Permissions-Policy, and HSTS in production over https. The root layout gives the theme boot script the nonce.
`/` sends a signed-in browser to `appConfig.home`, and a workspace address sends a signed-out one to the hosted sign-in.

**Errors** are one shape everywhere: `{"error": {"code", "message", "hint", "details"?}}`. The kit's own codes:
`signed_out`, `cross_site_request`, `invalid_path`, `service_unreachable`, `accounts_unreachable`, `refresh_failed`,
`misconfigured`. In the browser and on the server they become `ApiError` (`lib/errors.ts`): `status`, `code`,
`message`, `hint`, `details`, `fields` (a 422's per-field messages), `requestId`, `retryAfter`.

## What lives where

| Area | Code |
| --- | --- |
| The one file an app edits | `lib/app.config.ts` (its shape: `lib/app-config.types.ts`) |
| The Silicon look | `styles/` (`tokens.css`, `base.css`, `fonts.css`, `squircle.css`), `public/fonts/bdo-grotesk/`, `lib/squircle/`, `lib/theme.ts` |
| Arc UI | `components/arc/` (vendored, local edits kept), `components.json`, `vendor/uiarc/` (MIT notice, provenance) |
| The workspace frame | `app/(workspace)/layout.tsx`, `components/foundation/shell/` (sidebar, top bar, ⌘K, account menu), `components/foundation/providers.tsx` |
| Building blocks | `components/foundation/layout/` (Page, PageHeader, Section, Surface, SettingsGroup and rows, DescriptionList), `feedback/` (skeletons, Problem, ErrorAlert), `account/` (AccountChip, ShareWithAccounts), `time/` (LocalTime: times in the reader's zone, after hydration), `brand/` (the app's mark), `button-link.tsx` |
| Sign-in (BFF) | `app/auth/*`, `lib/server/` (`env`, `seal`, `session`, `tokens`, `fresh`), `instrumentation.ts` |
| The service | `app/api/[...path]/route.ts`, `lib/server/forward.ts`, `lib/server/rsc.ts` (`getSession`, `requireSession`, `apiFetch`, `tryApiFetch`), `lib/client/api.ts` (`api`), `lib/client/query.ts` (React Query), `lib/client/session.ts` (the session keeper, `useSignOut`) |
| Headers and redirects | `proxy.ts` |
| Public pages | `app/page.tsx`, `components/landing/`, `components/site/`, `app/sign-in/`, `app/not-found.tsx`, `app/error.tsx`, `app/global-error.tsx` |
| Public files | `app/robots.txt`, `app/sitemap.xml`, `app/llms.txt`, `app/manifest.webmanifest`, `app/og.png`, `app/icon.tsx`, `app/apple-icon.tsx`, `lib/agent/files.ts`, `lib/brand-svg.ts` |
| Shared helpers | `lib/errors.ts` (ApiError), `lib/format.ts`, `lib/ids.ts` (`c:`/`si:` ids), `lib/notify.ts` (toasts), `lib/commands.ts` (⌘K), `lib/navigation.ts`, `lib/highlight.ts` |
| The demo (delete when adopting) | `demo/` (stub service, pages' components), `app/(workspace)/items/`, `app/(workspace)/settings/`, `e2e/demo.spec.ts` |
| Tests | `tests/*.test.ts` (unit), `e2e/` (browser), `playwright.config.ts` |

## Writing pages

A workspace page is a Server Component under `app/(workspace)/`. It reads the service with the session's token and
hands the answer to client components:

```tsx
// app/(workspace)/reminders/page.tsx
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { tryApiFetch } from "@/lib/server/rsc";

export const metadata = { title: "Reminders" };

export default async function RemindersPage() {
  const { data, error } = await tryApiFetch<{ reminders: Reminder[] }>("/v1/reminders");
  return (
    <Page>
      <PageHeader title="Reminders" description="What is due, and what you shared." actions={<NewReminderButton />} />
      {error ? <ErrorAlert error={error} title="Reminders could not be loaded" /> : <RemindersView initial={data.reminders} />}
    </Page>
  );
}
```

- `apiFetch(path, init)` throws `ApiError`; `tryApiFetch` returns `{ data, error }` so the page shows the service's own
  words (production hides a thrown error's message from the error page). `notFound: true` turns a 404 into the
  workspace's not-found page. A 401 sends the Carbon to `/sign-in?reason=session_ended`.
- `requireSession()` gives the signed-in account (`uuid`, `kind`, `id`, `display_name`, `pfp_url`, `custodian`); the
  layout already required one, so pages call it only when they need the account.
- In client components, call the service through `api` (`lib/client/api.ts`) inside React Query hooks, seeded with
  what the server fetched (`initialData`). Mutations toast failures with the service's message and hint unless they set
  `meta: { toast: false }` and show them inline; `idempotencyKey: true` sends an `Idempotency-Key`.
- `loading.tsx` shows skeletons in the final layout; `error.tsx` and `not-found.tsx` render inside the shell.
- Add the page to `appConfig.nav` and it appears in the sidebar, the phone menu and ⌘K. Page-level ⌘K commands:
  `useRegisterCommands`.

The demo's pages (`app/(workspace)/items/`, `app/(workspace)/settings/`, `demo/components/`) show each pattern: a
sortable table with filters and empty states, a detail page with tabs, an edit dialog and a hold-to-confirm delete, and
settings with switches and sharing.

## Deploying

- **Vercel**: import `web/` as the project root, set the environment variables for Production (and Preview, with a
  `PUBLIC_URL` whose `/auth/callback` is registered), deploy. Nothing else is needed.
- **Self-hosted**: `NEXT_OUTPUT=standalone pnpm build`, then run `.next/standalone/server.js` with `.next/static` and
  `public/` beside it, behind a TLS proxy that sets `X-Forwarded-For` and `X-Forwarded-Proto`.
- Every route renders per request (the nonce CSP needs it), except the icons and the Open Graph image, which are drawn
  at build time from the config.
- Rotating `SESSION_SECRET` signs every browser out. Rotating `APP_SECRET` at Silicon Apps needs the new value here at
  the same time.

## Provenance

The look, the theme store, the squircles, the foundation components, the BFF (seal, session, routes, proxy) and the
public site components are adapted from the Silicon developer site (`silicon-accounts/developer`); the code block, the
highlighter and the Open Graph fonts from the store (`silicon-apps/store`). Arc UI is MIT (copyright 2026 Elia Kuratli,
`vendor/uiarc/LICENSE`); only its Free components are in the kit (`vendor/uiarc/PROVENANCE.md`). BDO Grotesk is under
the SIL Open Font License 1.1 (`public/fonts/bdo-grotesk/OFL.txt`, `assets/og/OFL.txt`).
