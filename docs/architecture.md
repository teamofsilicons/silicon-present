# Silicon Present: how it is built

`understanding/UNDERSTANDING.md` says what Silicon Present is and is the only source of truth for behaviour. This file
says how it is built: the shared deck format, the service's API, and which part does what. If the two disagree, the
understanding wins and this file is fixed.

Vocabulary in every string a Carbon or Silicon reads (pages, errors, CLI output, docs): **Carbon**, **Silicon**, never
"human", "user account", "AI agent", "organization", "org", "team" (for a group of accounts), "frontend", "backend".

## Parts

| Part | Path | Language | What it does |
| --- | --- | --- | --- |
| Deck model | `crates/present-deck` | Rust (yrs) | The deck as a Yjs document; JSON ⇄ Yjs; edit ops; diff; text view |
| Service | `crates/present-service` | Rust (axum, sqlx, Postgres) | The API, live sync, storage, sharing, comments, versions, Ting, presentations |
| Rust package | `crates/silicon-present-client` | Rust | Stateless typed client for the whole API |
| CLI | `crates/present-cli` (binary `present`) | Rust | Everything the web editor can do, built only on the package |
| Deck model (TS) | `packages/deck` | TypeScript (yjs) | Yjs ⇄ JSON, typed helpers to read and change a deck in the browser |
| Slide renderer | `packages/render` | TypeScript | One function that turns deck JSON into static slide HTML. Used by the web viewer, present mode, the screenshot/PDF renderer and HTML export, so a slide looks the same everywhere |
| Converter | `renderer/` | TypeScript (Node, Playwright, LibreOffice, pptxgenjs) | Internal sidecar: slide → PNG/JPG, deck → PDF/PPTX/PPT/ODP/KEY/HTML, any file → deck JSON |
| Web | `web/` | Next.js 16 + React 19 + Silicon UI | `present.teamofsilicons.com`: decks, editor, comments, sharing, history, present mode. Light mode only, minimal |
| End to end | `e2e/` | shell + Playwright | The whole stack against a local Silicon Accounts stack and a Ting stand-in |

### Local ports (never use the Carbon's own 8589/8590/8600 stack or Postgres 5444)

| What | Port |
| --- | --- |
| web (Next.js) | 4320 |
| service | 4321 |
| converter sidecar | 4322 |
| Ting stand-in (tests) | 4323 |
| Postgres (own Homebrew pg16 cluster at `.dev/pg`) | 5490 |
| Silicon Accounts test stack | 9740–9747 |

While several agents build in parallel, each tests on its own lane so nobody kills anybody's processes, each lane
with its own database on the 5490 cluster (`present_<lane>`) and its own `PRESENT_DATA_DIR` under `.dev/<lane>`:

| Lane | web | service | converter | Ting stand-in | database |
| --- | --- | --- | --- | --- | --- |
| final e2e | 4320 | 4321 | 4322 | 4323 | `present` |
| web pages | 4330 | 4331 | 4332 | 4333 | `present_pages` |
| web editor | 4340 | 4341 | 4342 | 4343 | `present_editor` |
| CLI | — | 4351 | 4352 | 4353 | `present_cli` |
| service tests | — | 4361 | 4362 | 4363 | throwaway |

Web callbacks for 4320/4330/4340/4360 are registered at the Accounts test stack. Only stop processes you started.

Rust builds always use `CARGO_TARGET_DIR=/Users/codanium/Documents/silicon/silicon-present/target`,
`CARGO_BUILD_JOBS=4`, `CARGO_INCREMENTAL=0` and the dev profile with `debug = 0` (disk is tight; never make another
target dir).

## The deck document

A deck's content is one Yjs document. The service keeps it in Postgres as an append-only log of Yjs updates, each one
stamped with who made it. Deck metadata that isn't content (title, owner, folder, sharing, trash) lives in Postgres
tables, not in the document.

Slides are 1920 × 1080 by default (`size`). Every position and size is in slide pixels of that coordinate system.

### Yjs layout (exact keys; Rust `present-deck` and TS `packages/deck` must agree byte for byte)

```
Y.Doc
├─ "deck": Y.Map
│   ├─ "size": { width: number, height: number }                       plain JSON value
│   ├─ "theme": { name, fonts: { heading, body }, colors: { background, text, accent, accent2, accent3, muted },
│   │             customFonts: [ { family, src: "asset:<id>" } ] }     plain JSON value
│   └─ "version": 1                                                      schema version
├─ "order": Y.Array<string>                                              slide ids, first to last
├─ "slides": Y.Map<slideId, Y.Map>                                       one per slide, plus the key "master"
│   └─ <slideId>: Y.Map
│       ├─ "id": string
│       ├─ "layout": string                    "title" | "title-body" | "two-columns" | "section" | "title-only" | "image-caption" | "blank"
│       ├─ "background": null | { color } | { image: "asset:<id>", fit: "cover"|"contain" }
│       ├─ "skipped": boolean
│       ├─ "section": null | string            a section starts at this slide with this name
│       ├─ "hideMaster": boolean
│       ├─ "transition": null | { type: "fade"|"push"|"wipe"|"zoom"|"cover", duration: ms, direction?: "left"|"right"|"up"|"down" }
│       ├─ "notes": Y.Text                      plain text speaker notes
│       ├─ "elementOrder": Y.Array<string>     element ids, back to front (z order)
│       └─ "elements": Y.Map<elementId, Y.Map>
│           └─ <elementId>: Y.Map
│               ├─ "id", "kind"                kind: text | shape | image | video | audio | table | chart | html
│               ├─ "x", "y", "w", "h", "rotation"   numbers
│               ├─ "locked": boolean, "group": null | string (elements with the same group id move together)
│               ├─ "link": null | string (url, or "slide:<slideId>")
│               ├─ "animation": null | { effect: "appear"|"fade"|"fly-in"|"zoom"|"wipe"|"rise", trigger: "click"|"with-previous"|"after-previous",
│               │                        order: number, duration: ms, delay: ms, direction?: "left"|"right"|"up"|"down" }
│               ├─ "style": { fill?, stroke?, strokeWidth?, radius?, opacity?, shadow?: boolean, padding?, verticalAlign?: "top"|"middle"|"bottom" }
│               ├─ text, shape:  "text": Y.Text (rich text, below)          shape also has "shape": string
│               ├─ image:        "src": "asset:<id>" | url, "alt": string, "fit": "cover"|"contain"|"fill"
│               ├─ video, audio: "src", "alt", "autoplay": bool, "loop": bool, "muted": bool, (video) "poster": null | "asset:<id>"
│               ├─ table:        "rows": number, "cols": number, "colWidths": number[], "rowHeights": number[], "headerRow": bool,
│               │                "cells": Y.Map<"r:c", Y.Map{ "text": Y.Text, "fill": null|string }>
│               ├─ chart:        "chart": { type: "bar"|"column"|"line"|"area"|"pie"|"donut"|"scatter", title?: string,
│               │                           labels: string[], series: [{ name, values: number[], color?: string }], legend: bool }
│               └─ html:         "html": Y.Text, "css": Y.Text, "js": Y.Text
```

Plain JSON values (theme, transition, animation, style, chart, background, size) are replaced whole when changed; two
Carbons changing the same one at once means the later wins, which is fine at that size. Everything a person types
(slide text, cell text, notes, HTML/CSS/JS) is a `Y.Text`, so concurrent typing merges.

The `"master"` slide holds elements drawn under every slide that doesn't set `hideMaster` (a logo, a footer). It is
never in `order`.

Shapes: `rect`, `round-rect`, `ellipse`, `triangle`, `right-triangle`, `diamond`, `pentagon`, `hexagon`, `octagon`,
`star`, `arrow-right`, `arrow-left`, `arrow-up`, `arrow-down`, `chevron`, `line`, `callout`, `heart`, `cloud`, `plus`.

### Rich text (`Y.Text` deltas)

Quill-style deltas. Character runs carry inline attributes; each paragraph ends with `"\n"` whose attributes are the
paragraph's.

- inline: `bold`, `italic`, `underline`, `strike`, `color` (hex), `highlight` (hex), `size` (px number), `font`
  (family), `link` (url), `code` (bool)
- paragraph (on `"\n"`): `align` (`left`|`center`|`right`|`justify`), `list` (`bullet`|`ordered`), `indent` (0–8),
  `heading` (1–3), `lineHeight` (number)

### Deck JSON (API, CLI, pull/push, converter, renderer)

```jsonc
{
  "id": "dk7Hq2mP9xRt",            // deck id
  "title": "Q4 review",            // from the decks table
  "version": 42,                   // the update sequence number this JSON was read at
  "size": { "width": 1920, "height": 1080 },
  "theme": { ... },
  "master": { "elements": [ Element, ... ] },
  "slides": [
    {
      "id": "s_f3k9a2", "layout": "title", "background": null, "skipped": false, "section": null,
      "hideMaster": false, "transition": null, "notes": "Say hello",
      "elements": [ Element, ... ]   // back to front
    }
  ]
}
```

`Element` is the element map as plain JSON, with each `Y.Text` turned into:

- `text`: `{ "paragraphs": [ { "align"?, "list"?, "indent"?, "heading"?, "lineHeight"?, "runs": [ { "text": "Hi", "bold"?: true, ... } ] } ] }`
- table `cells`: `"cells": [[ { "text": RichText, "fill": null }, ... ], ...]` (rows of cols)
- html: `"html"`, `"css"`, `"js"` as strings
- notes: a string

**Canonical JSON** (so the TS and Rust models read and write the same shape; checked by `fixtures/contract/`):

- Every key above is always present when reading and always written to the element/slide map. Defaults for missing
  input: slide `layout "blank"`, `background null`, `skipped false`, `section null`, `hideMaster false`,
  `transition null`, `notes ""`; element `rotation 0`, `locked false`, `group null`, `link null`, `animation null`,
  `style {}`; text/shape `text {paragraphs: []}`, shape `shape "rect"`; image `src ""`, `alt ""`, `fit "contain"`;
  video/audio `src ""`, `alt ""`, `autoplay/loop/muted false`, video `poster null`; table `headerRow false`,
  `colWidths`/`rowHeights` spread evenly over `w`/`h`, missing cells `{text: {paragraphs: []}, fill: null}`;
  chart `type "column"`, `labels []`, `series []`, `legend true`; html `html/css/js ""`.
- Plain JSON values (style, animation, transition, chart, background, size, theme) keep exactly the keys given, minus
  `undefined` ones.
- Rich text: attributes whose value is `false`, `null` or `""`, and `indent: 0`, are left out; empty runs are left
  out; neighbouring runs with equal attributes are merged. Every paragraph is written followed by `"\n"`, so
  `{paragraphs: []}` is an empty `Y.Text` and `[{runs: []}]` is `"\n"`. Reading, text after the last `"\n"` is one more
  paragraph without attributes. A soft line break inside a paragraph is U+2028 (rendered as `<br>`, a:br in pptx).
- The `"master"` map holds only `id: "master"`, `elementOrder` and `elements`. Readers skip ids in `order` (or
  `elementOrder`) that appear twice (keeping the first) or have no map, which can happen after concurrent moves.
- Table cells live at `cells["r:c"]` for every `0 <= r < rows`, `0 <= c < cols`; keys outside are removed on write.

Ids: slides `s_` + 6 base36 chars, elements `e_` + 6, generated by whoever creates them. Deck, folder, thread, comment,
presentation and asset ids are 12-character base58 strings generated by the service.

Assets are referenced as `"asset:<id>"`. Whoever renders resolves them: the web to `/api/v1/assets/<id>`, the
converter to the URL the service hands it.

### Edit ops (`POST /v1/decks/{id}/edits`)

Silicons edit through ops, never by overwriting the deck. All ops in one request are one Yjs transaction, so the whole
change appears at once. With `"base": <version>`, the service applies the ops to the deck as it was at that version and
merges the resulting Yjs update into the live deck, so a Silicon editing an older copy (after `present pull`) merges
cleanly with everything that happened since.

```jsonc
{ "base": 41, "summary": "Rebuilt slide 4", "ops": [
  { "op": "update_deck", "set": { "size"?, "theme"? } },
  { "op": "add_slide", "after": "s_abc" | null /* null = first */, "slide": { /* partial slide JSON incl. elements */ } },
  { "op": "update_slide", "slide": "s_abc", "set": { "layout"?, "background"?, "skipped"?, "section"?, "hideMaster"?, "transition"?, "notes"? } },
  { "op": "move_slide", "slide": "s_abc", "after": "s_def" | null },
  { "op": "delete_slide", "slide": "s_abc" },
  { "op": "add_element", "slide": "s_abc" | "master", "element": { /* element JSON, id optional */ }, "z"?: number },
  { "op": "update_element", "slide": "s_abc", "element": "e_123", "set": { /* any element fields; text/html/css/js/cells replace that field's content via a minimal diff */ } },
  { "op": "replace_text", "slide": "s_abc", "element"?: "e_123", "field"?: "text"|"notes"|"html"|"css"|"js"|"cell:r:c", "find": "exact passage", "replace": "new", "all"?: false },
  { "op": "reorder_element", "slide": "s_abc", "element": "e_123", "to": "front"|"back"|"forward"|"backward"|number },
  { "op": "delete_element", "slide": "s_abc", "element": "e_123" }
]}
```

`replace_text` fails with `text_not_found` (and the closest match in the hint) or `text_ambiguous` (the count) unless
`all` is set. Replacing text through a minimal diff (not delete-all + insert) keeps others' concurrent typing and the
formatting of untouched runs.

## The service

Rust, axum 0.8, sqlx 0.9 (Postgres 16), yrs. Errors are always
`{"error": {"code": "snake_case", "message": "what happened and why", "hint": "what to do"}}` with the right status.
No telemetry.

### Accounts

Every request carries a Silicon Accounts access token (`Authorization: Bearer`, EdDSA JWT, `aud` = `present`) verified
locally against `{ACCOUNTS_URL}/.well-known/jwks.json` with the official `silicon-accounts-client` crate. Carbons and
Silicons are stored by their Accounts uuid (`sub`) and shown by their current c:id / si:id, display name and pfp, which
the service caches and refreshes from Accounts. Reading a public deck (and its assets, renders, exports and a
presentation of it) works without a token.

### Storage

- `decks`, `folders`: id, owner uuid, creator uuid, title/name, parent folder, public mode (`off|view|comment|edit`),
  trashed_at, created/updated.
- `access`: (resource kind, resource id, account uuid or pending email) → role (`editor|commenter|viewer`), who invited.
  Effective role = max(owner, direct, every ancestor folder, public mode for signed-in callers).
- `deck_updates`: (deck, seq, yjs update bytes, author uuid, origin `edit|ops|restore|import|create|undo`, summary,
  touched slide ids, created_at). Append only, never deleted while the deck exists.
- `deck_snapshots`: full Yjs state every 200 updates, to read old versions fast.
- `version_names`: (deck, seq, name, who).
- `events`: everything that isn't content: renames, moves, sharing changes, public switch, transfers, trash/restore,
  comment deletes and resolves. Shown in the history next to versions.
- `threads`, `comments`, `reactions`: below.
- `assets`: id, deck, owner, filename, content type, size, sha256; bytes on disk under `PRESENT_DATA_DIR/assets`.
- `transfers`, `presentations`, `ting_outbox`.

### Live editing (no websockets; everything goes through the web's API proxy)

- `GET /v1/decks/{id}/live?sv=<base64 state vector>` is a server-sent event stream. First event `sync`:
  `{ update: base64 (everything the client lacks), sv: base64 (the server's state vector), version }`. Then `update`:
  `{ update, author: Account, version, origin, summary?, touched: [slideId] }`, `presence`: `{ session, account,
  slide, selection: [elementId], cursor: {x,y} | null, color }`, `presence_left`: `{ session }`, `comments`:
  `{ thread }` when threads change, `deck`: `{ title, ... }` when metadata changes, and a `ping` every 20 s. The
  proxy ends a stream after 5 minutes; clients reconnect with their state vector.
- `POST /v1/decks/{id}/updates` `{ update: base64, session }` applies a client's Yjs update (editors only; others get
  403), appends it to the log with the caller as author, and broadcasts it. Clients batch for ~40 ms.
- `POST /v1/decks/{id}/presence` `{ session, slide, selection, cursor }` (anyone who can view); presence expires after
  30 s without a heartbeat. The service adds the caller's account; clients can't claim to be someone else.
- On reconnect the client sends everything the server lacks (`Y.encodeStateAsUpdate(doc, serverSv)`), so changes
  made while offline merge back in. The web also keeps the doc in IndexedDB.

### Versions

A version is a run of updates by the same author with no gap over 5 minutes (computed when listed). Each has an
automatic summary from diffing the deck JSON before and after ("si:designer changed slide 4", "c:ada added 2 slides").

- `GET /v1/decks/{id}/versions` — versions newest first, with author, time range, summary, name, and events between.
- `GET /v1/decks/{id}/content?version=N&format=json|text` — the deck at any version.
- `GET /v1/decks/{id}/compare?from=A&to=B` — slides and elements added, removed and changed, with who changed them.
- `POST /v1/decks/{id}/versions/{N}/name` `{ name }`.
- `POST /v1/decks/{id}/restore` `{ version, slide?, element? }` — reconciles the live deck to that version (whole, one
  slide, or one element) as a new update with origin `restore`.
- `POST /v1/decks/{id}/undo-account` `{ account, since }` — replays the log from `since` with that account's
  transactions tagged, undoes exactly those with a Yjs undo manager, and reconciles the live deck to the result.
  (Leaving their updates out of a replay is not enough: every Yjs update carries the whole delete set, so later
  updates by others would still carry their deletions.) Content that only existed inside what they added goes with it.
- `POST /v1/decks` `{ from: { deck, version } }` — a new deck from any version.

Nothing is ever deleted by going back; restoring is itself a new version.

### Comments

```
anchor = { kind: "deck" }
       | { kind: "slide", slide }
       | { kind: "point", slide, x, y, element?: id, ex?, ey? }          // ex/ey = 0..1 inside the element, so it follows it
       | { kind: "area",  slide, x, y, w, h, element?: id, ex?, ey?, ew?, eh? }
       | { kind: "element", slide, element }
       | { kind: "text", slide, element, field: "text"|"cell:r:c"|"notes", quote, start?: base64 Y.RelativePosition, end?: base64 }
```

Every anchor also stores `snapshot: { slideNumber, elementKind?, label }` taken when the comment is made, shown if the
slide or element is later deleted. Threads: open/resolved (who, when), reopen. Comments: body (plain text with
`@c:id` / `@si:id` mentions), edited_at, deleted (kept in history), reactions (one emoji per account per emoji).

- `GET /v1/decks/{id}/threads?state=open|resolved|all`, `POST /v1/decks/{id}/threads { anchor, body }`
- `POST /v1/threads/{t}/replies { body }`, `POST /v1/threads/{t}/resolve`, `POST /v1/threads/{t}/reopen`
- `PATCH /v1/comments/{c} { body }`, `DELETE /v1/comments/{c}`, `PUT|DELETE /v1/comments/{c}/reactions/{emoji}`

Commenters and editors comment; viewers only read threads.

### Notifications (Silicon Ting only)

`present.mention.received`, `present.comment.created`, `present.comment.replied`, `present.thread.resolved`,
`present.deck.shared`, each with a stable idempotency key, sent through the Ting adapter when `PRESENT_TING_URL` is set
(queued in `ting_outbox` and retried). Each carries the deck (id, title, link), the slide (id, number), what the
comment is on (anchor + snapshot label + quoted text), and the comment, so a Silicon can act straight away. Never
notify the person who caused the event.

### Sharing, folders, trash, transfers

- `GET /v1/decks?scope=mine|shared|trash&folder=<id>`, `POST /v1/decks { title?, folder?, from? }`,
  `GET|PATCH /v1/decks/{id}` (title, folder), `DELETE /v1/decks/{id}` → trash, `POST /v1/decks/{id}/untrash`,
  `DELETE /v1/decks/{id}?permanent=true&confirm=<deck title>` (only from the trash, owner only).
- The same for `/v1/folders` (`name`, `parent`). A deck or folder created inside someone else's folder is owned by that
  folder's owner and keeps `creator`.
- `GET /v1/{decks|folders}/{id}/access`, `POST .../access { to: "c:ada"|"si:writer"|"a@b.c", role }`,
  `PATCH|DELETE .../access/{member}` (member = account uuid or `email:<address>`), `PUT .../public { mode }`.
  An email with no known account is kept as a pending invite and Present sends the invite email itself (Accounts
  can't; see `docs/accounts-and-ting.md`); it becomes a real member when an account whose Accounts email is that
  address signs in to Present.
- `POST /v1/{decks|folders}/{id}/transfer { to }`, `GET /v1/transfers`, `POST /v1/transfers/{id}/accept|decline|cancel`.

### Files

- `POST /v1/imports` (raw body, `Content-Type`, `X-Filename`, optional `?folder=`) → a new deck from any supported
  file. `POST /v1/decks/{id}/imports` → opening a file on top of a deck makes it the deck's next version.
- `GET /v1/decks/{id}/export?format=pptx|ppt|key|odp|pdf|html|png|jpg&version=&slide=` → the file
  (`Content-Disposition` with the deck title). png/jpg of a whole deck is a `.zip` with one image per slide.
- `GET /v1/decks/{id}/slides/{slide}/render?format=png|jpg&width=1920&version=&at=<ms>` → one slide as an image, how a
  Carbon would see it (HTML elements run for `at` ms first, default 1500).
- `POST /v1/decks/{id}/assets` (raw body, `Content-Type`, `X-Filename`) → `{ id, url, contentType, size }`;
  `GET /v1/assets/{id}` (anyone who can view the deck; `?deck=&exp=&sig=` for the converter). The converter gets
  `assetBase` = `{PRESENT_PUBLIC_URL}/v1/signed/{deck}/{exp}/{sig}/assets/` (valid one hour) and fetches
  `assetBase + id`; the service collapses `//`, so `assetBase + "/" + id` works too.

### Presenting

- `POST /v1/decks/{id}/presentations` → `{ id, followUrl, slide, step }` (anyone who can view may present).
- `GET /v1/presentations/{p}`; `PUT /v1/presentations/{p} { slide, step }` (the presenter only);
  `DELETE /v1/presentations/{p}` (stop); `GET /v1/presentations/{p}/live` (SSE: `state`, `ended`).
- Following needs view access to the deck (or a public deck).

### Search and accounts

- `GET /v1/search?q=` — every deck the caller can view whose title, slide text, notes or table text matches.
- `GET /v1/accounts/resolve?q=c:ada` — for invites and mentions.
- `GET /v1/me`.

### Answers (shapes the service returns)

JSON keys are camelCase. Lists are wrapped: `{ "decks": [...] }`, `{ "folders": [...] }`, `{ "threads": [...] }`,
`{ "versions": [...], "events": [...] }`, `{ "results": [...] }`, `{ "presentations": [...] }`,
`{ "incoming": [...], "outgoing": [...] }`. Any `POST`/`PUT`/`PATCH`/`DELETE` may carry `Idempotency-Key`: a retry
with the same key (same caller, method and path) gets the first answer back with `Idempotent-Replayed: true`.

- **Account**: `{ uuid, id: "c:ada", kind: "carbon"|"silicon", displayName, pfp }` (`GET /v1/me` returns one;
  `GET /v1/accounts/resolve?q=` returns `{ query, account }`, for an email `{ query, email, account | null }`).
- **Deck**: `{ id, title, owner, creator, folder, publicMode, role: "owner"|"editor"|"commenter"|"viewer", version,
  trashedAt, createdAt, updatedAt, link }`. `GET /v1/decks?scope=mine|shared|trash&folder=<id>|root` (no folder =
  all of the scope; `folder=<id>` lists that folder for anyone who can view it). `POST /v1/decks` also takes
  `{ deck: DeckJSON }` to start from deck JSON (e.g. `present push` of a new folder).
- **Folder**: `{ id, name, owner, creator, parent, publicMode, role, trashedAt, createdAt, updatedAt, link }`;
  `GET /v1/folders?scope=mine|shared|trash&parent=<id>|root`. A folder's public mode applies to everything inside.
- **Content**: `GET …/content` → deck JSON (`format=text` → the text view, with open comments unless
  `comments=false`). Versions other than the latest need edit rights.
- **Edits**: `{ version, changed, summary, touched, slidesAdded, elementsAdded: [{ slide, element }], replacements }`.
  **Updates**: `{ version, changed, touched }` (`changed: false` = it was already applied; nothing logged).
- **Live**: `GET …/live?sv=&session=` — with `session`, that presence is removed when the stream closes. `update`
  events also carry `session` (the sender's), so a client can skip its own echo. `409 update_needs_history` means the
  update builds on changes the service lacks: reconnect and resend.
- **Version**: `{ version (last seq), from (first seq), author, startedAt, endedAt, origins, change, summary
  ("si:designer changed slide 4"), name, namedBy }`. Explicit summaries (ops `summary`, restores, undo, imports) win
  over automatic ones. A named version ends its group. **Event**: `{ id, kind, actor, data, createdAt }`, also at
  `GET /v1/decks/{id}/events`.
- **Compare**: `{ from, to, summary, diff: { deckFields, master?, slidesAdded, slidesRemoved, slidesMoved,
  slidesChanged: [{ id, number, fields, elementsAdded, elementsRemoved, elementsChanged: [{ id, kind, fields }],
  elementsReordered }] }, authors: { slideId: [Account] } }`. **Restore / undo**: `{ version, changed, summary,
  touched }` (+ `updatesUndone`).
- **Thread**: `{ id, deck, anchor, snapshot, current: { slideNumber, exists }, state, createdBy, createdAt, updatedAt,
  resolvedBy, resolvedAt, comments: [Comment] }`; creating one also returns `mentionedWithoutAccess: [Account]` and
  `unknownMentions: ["c:x"]`. A reply returns `{ thread, comment, mentionedWithoutAccess, unknownMentions }`.
  **Comment**: `{ id, thread, author, body (null once deleted), mentions: [Account], createdAt, editedAt, deleted,
  deletedAt, reactions: [{ emoji, count, accounts }] }`. Only the author edits a comment; the author or the deck's
  owner deletes it (earlier bodies are kept in `comment_revisions`).
- **Access**: `GET …/access` → `{ owner, publicMode, role, members: [{ member, account, email, pending, role,
  invitedBy, createdAt, via: { kind: "folder", id, name } | null }] }`; `via` marks access inherited from a folder.
  Only the owner flips the public switch; anyone can remove themselves.
- **Transfer**: `{ id, resource: { kind, id, name }, from, to, state, createdAt, decidedAt }`. On accept the deck or
  folder (with everything inside) moves to the recipient's top level and the previous owner keeps editor access.
- **Asset**: `{ id, ref: "asset:<id>", url, filename, contentType, size }`.
- **Presentation**: `{ id, deck, presenter, slide, slideNumber, step, startedAt, updatedAt, endedAt, followUrl }`;
  `GET /v1/decks/{id}/presentations` lists the running ones. The deck's owner may also stop one.
- **Search result**: `{ deck: Deck, matches: [{ where: "title"|"slide"|"notes"|"table", slide?, slideNumber?,
  element?, text }] }`.
- **Ting `data`**: `{ deck: { id, title, link }, slide: { id, number } | null, on: { anchor, label, quote }, thread:
  { id, state, link }, comment: { id, body, author, createdAt, link }, actor }`; `present.deck.shared`: `{ resource:
  { kind, id, name, link }, deck | null, role, by }`. Keys: `present.<type>:<comment id>:<recipient>` (resolves:
  `:<thread>:<resolved at ms>`, shares: `:<kind>:<id>:<access row>`).
- `GET /health` → `{ ok, service, version, database, converter, ting }`. `present-service --help` lists every
  environment variable.

## Converter sidecar (`renderer/`)

Internal only (bound to 127.0.0.1, `X-Converter-Secret`). Node 24, TypeScript, Playwright Chromium (already installed
under `~/Library/Caches/ms-playwright`), LibreOffice (`/opt/homebrew/bin/soffice`), `pdftoppm`, pptxgenjs.

- `POST /render { deck, slide, width, format, at, assetBase }` → image. Builds the page with `packages/render`.
- `POST /export { deck, format, assetBase }` → file. pdf/png/jpg via Chromium; html = one self-contained file (assets
  inlined, HTML elements live, arrow keys); pptx via pptxgenjs with native text, shapes, tables, charts, images,
  video/audio, notes, transitions where pptx can hold them; an HTML element becomes a picture of it (so no slide is
  blank); ppt/odp = pptx through LibreOffice; key = pptx through Keynote (`osascript`) when Keynote is installed,
  otherwise a clear error saying where Keynote export is available.
- `POST /import { filename, contentType, data }` → `{ deck, assets: [{ key, filename, contentType, data }] }`.
  pptx parsed natively (text with runs, geometry, pictures, tables, charts, media, backgrounds, notes, placeholders
  inherited from layouts and masters, groups flattened with `group` ids, sections, hidden slides, transitions);
  ppt/odp/key → pptx through LibreOffice first; pdf → one slide per page (page picture as background, text kept in
  notes); html → our own export opens exactly, any other page becomes one full-slide HTML element; images, video,
  audio → one slide each; Google Slides through its `.pptx` export. Anything the parser can't model (SmartArt, 3D,
  ink) becomes a picture of that part cut from LibreOffice's render of the slide, so nothing is dropped.

## Web (`web/`)

Copied from the shared web kit (`/Users/codanium/Documents/silicon/.migration/web-kit`, its `ADOPTING.md`): Next.js
BFF with a sealed session cookie, Silicon Accounts sign-in, `/api/*` proxy to the service. Components from Silicon UI
(`https://ui.teamofsilicons.com/r/{name}.json`, the kit's `components/arc` set). **Light mode only, minimal**: one calm
look, few boxes, no theme switch.

Pages: `/` (landing when signed out), `/decks` (mine, shared, folders, trash, transfers), `/decks/[id]` (editor),
`/decks/[id]/present`, `/decks/[id]/presenter`, `/decks/[id]/history`, `/p/[presentation]` (follow along).

## End to end

`e2e/` starts everything on the ports above: Postgres, a Silicon Accounts test stack with the `present` app seeded,
the Ting stand-in (records every ting), the converter, the service and the web; then runs the CLI suite and the
Playwright suite (two Carbons and a Silicon working on the same deck).
