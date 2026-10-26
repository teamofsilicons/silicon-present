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
| Slide renderer | `packages/render` | TypeScript | One function that turns deck JSON into static slide HTML. Used by the web viewer, present mode, and the screenshot/PDF renderer, so a slide looks the same everywhere |
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
│   ├─ "size": { width: number, height: number }                       plain JSON value, exactly these two keys
│   ├─ "theme": { name, fonts: { heading, body }, colors: { background, text, accent, accent2, accent3, muted },
│   │             customFonts: [ { family, src: "asset:<id>" } ] }     plain JSON value
│   └─ "version": 1                                                      schema version
├─ "order": Y.Array<string>                                              slide ids, first to last
├─ "slides": Y.Map<slideId, Y.Map>                                       one per slide, plus the key "master"
│   └─ <slideId>: Y.Map
│       ├─ "id": string                        the map key
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
│               ├─ "id", "kind"                id = the map key; kind: text | shape | image | video | audio | table | chart | html
│               ├─ "x", "y", "w", "h", "rotation"   numbers
│               ├─ "locked": boolean, "group": null | string (elements with the same group id move together)
│               ├─ "link": null | string (url, or "slide:<slideId>")
│               ├─ "animation": null | { effect: "appear"|"fade"|"fly-in"|"zoom"|"wipe"|"rise", trigger: "click"|"with-previous"|"after-previous",
│               │                        order: number, duration: ms, delay: ms, direction?: "left"|"right"|"up"|"down" }
│               ├─ "style": { fill?, stroke?, strokeWidth?, radius?, opacity?, shadow?: boolean, padding?, verticalAlign?: "top"|"middle"|"bottom" }
│               ├─ text, shape:  "text": Y.Text (rich text, below)          shape also has "shape": one of the shapes below
│               ├─ image:        "src": "asset:<id>" | url, "alt": string, "fit": "cover"|"contain"|"fill"
│               ├─ video, audio: "src", "alt", "autoplay": bool, "loop": bool, "muted": bool, (video) "poster": null | "asset:<id>"
│               ├─ table:        "rows", "cols": whole numbers 1–100, "colWidths": number[cols], "rowHeights": number[rows],
│               │                "headerRow": bool, "cells": Y.Map<"r:c", Y.Map{ "text": Y.Text, "fill": null|string }>
│               ├─ chart:        "chart": { type: "bar"|"column"|"line"|"area"|"pie"|"donut"|"scatter", title?: string,
│               │                           labels: string[], series: [{ name, values: number[], color?: string }], legend: bool }
│               └─ html:         "html": Y.Text, "css": Y.Text, "js": Y.Text
```

Plain JSON values (theme, transition, animation, style, chart, background, size) are replaced whole when changed. When
two people change the same one at once, one change wins (Yjs picks the same one on every client) and both stay in the
history, which is fine at that size. Everything a person types (slide text, cell text, notes, HTML/CSS/JS) is a
`Y.Text`, so concurrent typing merges.

The `"master"` slide holds elements drawn under every slide that doesn't set `hideMaster` (a logo, a footer). Its map
holds only `id: "master"`, `elementOrder` and `elements`. It is never in `order`, no slide can be called `master`, and
it is reached only as `"slide": "master"` of the element ops (*Edit ops*).

Shapes: `rect`, `round-rect`, `ellipse`, `triangle`, `right-triangle`, `diamond`, `pentagon`, `hexagon`, `octagon`,
`star`, `arrow-right`, `arrow-left`, `arrow-up`, `arrow-down`, `chevron`, `line`, `callout`, `heart`, `cloud`, `plus`.

### Rich text (`Y.Text` deltas)

Quill-style deltas. Character runs carry inline attributes; each paragraph ends with `"\n"` whose attributes are the
paragraph's. These are all the attributes there are:

| Attribute | On | Takes |
| --- | --- | --- |
| `bold`, `italic`, `underline`, `strike`, `code` | characters | `true` |
| `color`, `highlight` (colours), `font` (a family), `link` (a url) | characters | a non-empty string |
| `size` | characters | a number > 0 (px) |
| `align` | `"\n"` | `left`, `center`, `right` or `justify` |
| `list` | `"\n"` | `bullet` or `ordered` |
| `indent` | `"\n"` | a whole number 1–8 |
| `heading` | `"\n"` | a whole number 1–3 |
| `lineHeight` | `"\n"` | a number > 0 |

`null`, `false` and `""` mean the attribute is absent, and so does `indent: 0`; they are never stored. "A number",
"a whole number" and "a string" are defined under *Canonical JSON* (so `size: "40"` is 40, but `"40px"` is not a
number). Readers leave out every other attribute: an unknown key, a value outside its row (`list: "checked"`,
`heading: 0`, `indent: 9`, `bold: "yes"`), a paragraph attribute on a character and an inline one on a `"\n"`.
Writers refuse them in JSON (an unknown key or one on the wrong kind of character with `invalid_field`, a value outside
its row with `invalid_value`) and store only attributes from this table, each on its own kind of character.

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

### Canonical JSON

Deck JSON has one canonical form, and both deck models produce exactly it. Code that touches a deck is one of two
kinds:

- **Readers**: `doc_to_json` / `docToJson`, every helper that reads a document, and `normalize_deck` /
  `normalizeDeck` run on JSON. They take anything, never fail and never change the document. They follow the rules
  below, but where a writer would refuse a value they use the field's default (for a list entry, what `null` means
  there), and they leave out what a writer would refuse whole: an unknown key, an entry of `slides` or `elements` that
  isn't an object, an element without a kind they know, a slide called `master`, and every repeat of a slide id, or of
  an element id within one slide or the master, after its first (in JSON, or in `order` / `elementOrder`). What a
  reader returns is canonical, so it is always valid writer input: pulling then pushing, restoring a version or
  undoing never trips over its own output.
- **Writers**: `json_to_doc` / `jsonToDoc`, `reconcile` / `applyJsonToDoc` and every edit op. They check what they are
  given against the rules below and refuse what the rules don't allow, with the codes under *Edit ops*
  (`invalid_field`, `invalid_value`, `unknown_element_kind`, `duplicate_id`, `reserved_id`). Nothing is stored as
  sent and nothing is dropped silently: what the rules allow (a number written as a string, `null` for a default) is
  turned into the canonical form, and only that is stored.

So the same input makes the same document on both sides, and the same document reads the same on both sides.
`fixtures/contract/` checks this; its README says how.

**Numbers.** A *number* is a JSON number, read as the nearest float64 (as `JSON.parse` reads it; Rust parses with
serde_json's `float_roundtrip` feature), or a string holding exactly one JSON number, optionally with spaces, tabs,
`\n` or `\r` around it, whose value is finite: `"12"`, `" 1e3 "` and `"-0.5"` are numbers; `"0x10"`, `"1."`, `".5"`,
`"+1"`, `"1,5"`, `"Infinity"`, `""` and `"1e400"` are not, and neither are `true`, `false`, lists and objects. A
*whole number* is a number whose value is an integer (`3`, `3.0`, `"3"`, `1e2`; not `2.5`). Numbers are stored and
returned as numbers, never as strings, and `-0` becomes `0`. Rust writes a whole number with |n| ≤ 2^53 − 1 as an
integer and every other number as a float, so a Yjs BigInt (lib0 type 122) is never written: `9007199254740993` is
stored as the float `9007199254740992`, which is what `JSON.parse` makes of it. This holds everywhere, inside plain
values too. A reader that finds a BigInt reads it as the nearest float64.

**Strings.** A *string* is a JSON string, kept exactly as given (no trimming, no Unicode normalization), or a number,
written as the shortest decimal that reads back as the same float64, without an exponent: `1.0` → `"1"`, `-0` → `"0"`,
`2.5` → `"2.5"`, `12345678901234567890` → `"12345678901234567000"`, `0.000001` → `"0.000001"` (JavaScript's
`String(n)`; Rust's `format!("{n}")` once `-0` is `0`). A number `String(n)` writes with an exponent (magnitude 1e21 or
more, or below 1e-6 and not 0) is not a string, and neither are `true`, `false`, lists and objects. Text is valid
Unicode: a string holding half of a surrogate pair is refused (`invalid_value`, or `invalid_op` in an op's own keys;
serde_json already refuses such JSON). Ids are the one place a number is not a string.

**Fields.** A field that is missing or `null` gets its default. A value the field doesn't take is refused by writers
(`invalid_value`) and read as the default by readers.

| Field | Takes | Default |
| --- | --- | --- |
| element `x`, `y`, `rotation` | a number | `0` |
| element `w`, `h` | a number | `400`, `200` |
| `locked`, `skipped`, `hideMaster`, `headerRow`, `autoplay`, `loop`, `muted` | `true` or `false` | `false` |
| `src`, `alt`, `html`, `css`, `js`, slide `notes` | a string | `""` |
| `group`, `link`, `section`, `poster`, cell `fill` | a string | `null` |
| `shape` | one of the 20 shapes | `"rect"` |
| image `fit` | `"cover"`, `"contain"` or `"fill"` | `"contain"` |
| slide `layout` | one of the 7 layouts | `"blank"` |
| `style` | a JSON object | `{}` |
| `animation`, `transition`, `background` | a JSON object | `null` |
| `text`, cell `text` | rich text (below) | `{ "paragraphs": [] }` |
| `rows`, `cols`, `colWidths`, `rowHeights`, `cells` | *Tables* (below) | |
| `chart`, `theme`, `size` | *Charts*, *Theme*, *Size* (below) | |

A JSON object is a plain object, never a list. `style`, `animation`, `transition` and `background` keep exactly the
keys and values given; only their numbers are normalized (`"strokeWidth": "3"` inside `style` stays a string).

**Keys.** Deck JSON takes `id`, `title` and `version` (the service's own; writers ignore them), `size`, `theme`,
`master` and `slides`. `master` takes `elements`. A slide takes `id`, `layout`, `background`, `skipped`, `section`,
`hideMaster`, `transition`, `notes` and `elements`. An element takes `id`, `kind`, `x`, `y`, `w`, `h`, `rotation`,
`locked`, `group`, `link`, `animation`, `style` and its kind's keys from the Yjs layout. A cell takes `text` and
`fill`. Writers refuse any other key (`invalid_field`). `slides`, `elements` and `cells` are lists (missing or `null`:
empty); every entry of `slides` and `elements` is an object, and `master` is an object or `null` (`invalid_value`
otherwise). An element's `kind` is one of the eight; writers refuse an element without one (`unknown_element_kind`).

**Ids.** Slide and element ids are non-empty JSON strings; a missing, `null` or `""` id gets a new one (`s_` or `e_` +
6 base36 characters, unused in the deck) and any other value is refused (`invalid_value`). In deck JSON slide ids are
unique and element ids are unique within a slide and within the master: writers refuse a repeat (`duplicate_id`) and a
slide called `master` (`reserved_id`). The same element id may appear on two slides (imported and older decks have
that), but `add_slide` and `add_element` refuse an element id the deck already uses anywhere. Deck, folder, thread,
comment, presentation and asset ids are 12-character base58 strings generated by the service.

**Rich text** in JSON is either a string or number (plain text, one paragraph per line: split at `"\n"`, `""` being
one empty paragraph), or an object whose only key is `paragraphs`, a list (missing or `null`: none). A paragraph is an
object with `runs` (a list; missing or `null`: none) and paragraph attributes, or `null` (an empty paragraph). A run is
an object with `text` (a string; missing or `null`: `""`) and inline attributes, or `null` (left out). Attributes
follow the table under *Rich text*. A `"\n"` inside run text ends the paragraph there, and the rest starts a new
paragraph with the same paragraph and run attributes. Empty runs are left out and neighbouring runs with equal
attributes are merged. In the `Y.Text`, every paragraph is its runs followed by a `"\n"` carrying the paragraph's
attributes, so `{ "paragraphs": [] }` is an empty `Y.Text` and `[{ "runs": [] }]` is `"\n"`. Reading, each `"\n"`
closes a paragraph and text after the last one is one more paragraph without attributes. A soft line break inside a
paragraph is U+2028 (rendered as `<br>`, `a:br` in pptx).

**Tables.**
- `rows` and `cols` are whole numbers 1–100. Missing or `null`, they come from `cells`: `rows` is its number of rows
  and `cols` the length of its longest row, each 2 when that is 0.
- `cells` is a list of rows. A row is a list of cells, or `null` (an empty row). A cell is an object (`text`, `fill`),
  a string or number (its plain text), or `null` (an empty cell). The grid is padded with empty cells
  (`{ "text": { "paragraphs": [] }, "fill": null }`) to `rows` × `cols`; a grid with more rows than `rows` or a row
  longer than `cols` is refused (`invalid_value`), never cut.
- `colWidths` and `rowHeights` are lists of exactly `cols` and `rows` numbers. Missing or `null`, every entry is
  `w / cols` (`h / rows`).
- In the document, `cells["r:c"]` (`r` and `c` in decimal from 0) exists for every `0 <= r < rows` and
  `0 <= c < cols`, and no other key does: writers create the missing cell maps and remove the other keys.
- Readers take a stored `rows` that is a whole number 1–100; anything else reads as 1 + the largest `r` among the cell
  map's keys `"r:c"` (decimal without leading zeros; other keys don't count), at most 100, or 2 when there is no such
  key. `cols` likewise with `c`. A stored `colWidths` (`rowHeights`) that isn't a list of exactly `cols` (`rows`)
  numbers reads as spread evenly. A missing cell map reads as an empty cell.

**Charts.** `chart` is a JSON object; missing or `null` it is `{ "type": "column", "labels": [], "series": [],
"legend": true }`. Its keys are kept as given (`title`, `stacked`, ...), with numbers normalized, except:
- `type`: `bar`, `column`, `line`, `area`, `pie`, `donut` or `scatter` (default `"column"`);
- `labels`: a list of strings, a `null` entry being `""` (default `[]`);
- `series`: a list (default `[]`) of JSON objects, a `null` entry being `{ "name": "", "values": [] }`. A series keeps
  its other keys (`color`, ...), except `name`: a string (default `""`), and `values`: a list of numbers, a `null`
  entry being `0` (default `[]`);
- `legend`: `true` or `false` (default `true`).

Readers read any other value at one of these places (a list entry included) as its default.

**Theme.** `theme` is a JSON object; missing or `null` it is the default theme, Paper: name `"Paper"`, fonts `Inter`
and `Inter`, colours background `#ffffff`, text `#1b1b1f`, accent `#2f5bea`, accent2 `#e5484d`, accent3 `#12a594`,
muted `#6f6f78`, no custom fonts. Its keys are kept as given, with numbers normalized, except:
- `name`: a string (default `"Paper"`);
- `fonts`: a JSON object laid over Paper's, `heading` and `body` each a string (default `"Inter"`), other keys kept;
- `colors`: a JSON object laid over Paper's six colours, each of the six a string (default its Paper colour), other
  keys kept;
- `customFonts`: a list, kept as given (default `[]`).

A theme is always completed from Paper, never from the deck's current theme. Readers read any other value at one of
these places as its default.

**Size.** `size` is exactly `{ "width", "height" }`, each a number > 0; missing or `null` it is
`{ "width": 1920, "height": 1080 }`. Writers refuse another key (`invalid_field`) and any other value
(`invalid_value`). Readers read a side that isn't a number > 0 as its default, anything but an object as 1920 × 1080,
and leave other keys out.

**Reading any document**, whoever wrote it (`POST /updates` accepts any editor's raw Yjs update):
- The slides are the ids in `order` and a slide's elements the ids in its `elementOrder`: the first occurrence of each
  id that has a map. Later repeats, ids without a map and `"master"` in `order` are skipped (concurrent moves and
  deletes leave such entries behind); a map whose id isn't listed isn't part of the deck. The master's elements are
  read the same way from the `"master"` map; its other keys are ignored. A missing map or array reads as empty.
- An id is its map key; a stored `id` that is missing or different doesn't matter.
- An element map whose `kind` isn't one of the eight (missing, unknown, or a name such as `constructor`) is left out.
- A Y type where a plain value belongs reads as missing. A plain string (or number) where a `Y.Text` belongs reads as
  that text (rich text: one paragraph per line); a missing `Y.Text` reads as empty. Embeds (`Y.Text` inserts that
  aren't strings) are skipped.
- Reading never changes the document: nothing that only reads creates a missing `Y.Text`, map or array or rewrites a
  value, so a client that only looks at a deck never sends an update.

Writers create what they need as part of the change they make. A writer that changes a field holding the wrong type
(a plain string where a `Y.Text` belongs, a plain value where a map or array belongs) first replaces it with the right
type holding what readers read there, then makes its change. A writer that rewrites a map (`update_slide`,
`update_element`, `reconcile`, `applyJsonToDoc`) leaves it holding exactly its canonical keys and values: a stored value
that isn't canonical is rewritten and a key that doesn't belong there is removed.

**Motion.** Animation and transition `direction` is the way the motion goes: fly-in `up` rises from below, wipe
`right` reveals left to right, push `left` brings the new slide in from the right. A click-step starts at each
`trigger: "click"`; `with-previous` starts with the animation before it, `after-previous` after everything before it
in that step.

Assets are referenced as `"asset:<id>"`. Whoever renders resolves them: the web to `/api/v1/assets/<id>`, the
converter to the URL the service hands it.

### Edit ops (`POST /v1/decks/{id}/edits`)

Silicons edit through ops, never by overwriting the deck. All ops in one request are one Yjs transaction: they apply
in order, each seeing the ones before it, and either all of them apply or none does (the document is left exactly as
it was). The web's helpers run the same ops, so an op does the same thing whoever sends it.

```jsonc
{ "base": 41, "summary": "Rebuilt slide 4", "ops": [
  { "op": "update_deck", "set": { "size"?, "theme"? } },
  { "op": "add_slide", "after"?: "s_abc" | null, "slide"?: { /* slide JSON incl. elements, id optional */ } },
  { "op": "update_slide", "slide": "s_abc", "set": { "layout"?, "background"?, "skipped"?, "section"?, "hideMaster"?, "transition"?, "notes"? } },
  { "op": "move_slide", "slide": "s_abc", "after"?: "s_def" | null },
  { "op": "delete_slide", "slide": "s_abc" },
  { "op": "add_element", "slide": "s_abc" | "master", "element": { /* element JSON, id optional */ }, "z"?: 0 },
  { "op": "update_element", "slide": "s_abc" | "master", "element": "e_123", "set": { /* the element's own keys */ } },
  { "op": "replace_text", "slide": "s_abc" | "master", "element"?: "e_123", "field"?: "text"|"notes"|"html"|"css"|"js"|"cell:r:c",
    "find": "exact passage", "replace": "new", "all"?: false, "matchCase"?: true },
  { "op": "reorder_element", "slide": "s_abc" | "master", "element": "e_123", "to": "front"|"back"|"forward"|"backward"|0 },
  { "op": "delete_element", "slide": "s_abc" | "master", "element": "e_123" }
]}
```

**Checking.** Before anything applies, the shape of every op is checked, and a bad one fails the request with
`invalid_op`. An op is an object whose `op` names one of the ten ops and which has exactly the keys shown for it: the
ones marked `?` may be left out, and `null` is the same as left out except for `after`, where `null` means first and
leaving it out means last.
- `slide`, `element` (an id) and `find` are non-empty strings; `replace` and `field` are strings; `after` is a
  non-empty string or `null`.
- `set`, and `element` in `add_element`, are objects; `slide` in `add_slide` is an object.
- `z` is a whole number ≥ 0; `to` is `front`, `back`, `forward`, `backward` or a whole number ≥ 0 (so `1.0` is 1, and
  `1.5` or `-1` are refused).
- `all` and `matchCase` are `true` or `false` (defaults `false` and `true`).
- `"master"` may only be the `slide` of `add_element`, `update_element`, `replace_text`, `reorder_element` and
  `delete_element`, never of `update_slide`, `move_slide` or `delete_slide`, and never an `after`.

Then the ops apply in order and the first failure stops the request. Values in `set`, in added slides and elements,
and in deck JSON are checked and normalized as *Canonical JSON* says, never stored as sent. When one op has several
problems, which one is reported isn't specified. Errors are `{ code, message, hint }`: the message names the op's
index and says what happened and why, the hint says what to do.

| Code | Status | When |
| --- | --- | --- |
| `invalid_op` | 400 | `ops` isn't a list; an op has the wrong shape (*Checking*); `"master"` where it isn't allowed; a slide moved after itself; `replace_text` with a `field` other than `notes` but no `element`, or with `field: "notes"` and an `element`, or on the master |
| `invalid_field` | 400 | a key that can't be there: one a deck, master, slide, element, cell, size, rich text, paragraph or run doesn't take (*Keys*, *Rich text*); a `set` key the op or the element's kind doesn't have (`update_deck` takes `size` and `theme`, `update_slide` only its seven fields, so `id`, `elements` and `elementOrder` are refused); an element's `id` or `kind` set to anything but its current value |
| `invalid_value` | 400 | a value a field doesn't take: `rows: 2.5`, `w: "wide"`, `layout: "fancy"`, `list: "checked"`, a theme, chart or style that isn't an object, a grid bigger than its table, `colWidths` of the wrong length, a size side that isn't a number > 0, an id that isn't a string, half a surrogate pair |
| `unknown_element_kind` | 400 | an element whose `kind` is missing or not one of the eight |
| `duplicate_id` | 400 | deck JSON or an added slide repeats a slide id, or an element id within one slide or the master |
| `reserved_id` | 400 | a slide called `master` |
| `slide_not_found` | 404 | the slide (or `after`) isn't in the deck; with a base, the live deck has deleted it |
| `element_not_found` | 404 | the element isn't on that slide; with a base, the live deck has deleted it |
| `field_not_found` | 404 | `replace_text` names a field the element doesn't have |
| `cell_not_found` | 404 | `replace_text` names a cell outside the table; with a base, an op changes a cell the live deck has removed |
| `slide_exists` | 409 | `add_slide` with an id the deck already uses for a slide (listed in `order` or not) |
| `element_exists` | 409 | `add_element` or `add_slide` with an element id the deck already uses, on any slide (listed or not) or the master |
| `id_exists` | 409 | with a base: an op creates a slide, an element or a table cell that the live deck has but that version doesn't |
| `text_not_found` | 409 | `replace_text` found nothing (the closest passage is in the hint) |
| `text_ambiguous` | 409 | `replace_text` found more than one occurrence and `all` isn't set (the count is in the message) |

**What each op does.**
- `update_deck`: `size` and `theme` each replace the stored value whole, normalized; `null` resets one to its default.
  A partial theme is completed from Paper (never merged into the current theme), so send the whole theme.
- `add_slide`: the new slide goes right after `after`, first for `null`, last when `after` is left out. Its keys are
  the slide keys; what is missing gets its default.
- `update_slide` and `update_element` read the slide or element, lay each key of `set` over it (a key replaces that
  field whole: a new `style` or `chart` is not merged with the old one), check and normalize the result as deck JSON
  is, and write it back, changing only what differs. `null` sets a field to its default, which is how `present push`
  clears one. `update_slide` takes `layout`, `background`, `skipped`, `section`, `hideMaster`, `transition` and
  `notes`; `update_element` takes the element's own keys, with `id` and `kind` only at their current values.
  - A `text` given as a string (or number) keeps the element's look: every line takes the paragraph attributes of the
    current first paragraph and the inline attributes of its first run (none if there is no paragraph or run). Rich
    text JSON sets exactly what it says. A cell given as a string is plain text.
  - Tables: below.
- `move_slide`: `after` as in `add_slide`.
- `add_element`: `z` is the index back to front the element gets (0 = back); left out, `null` or at least the number
  of elements puts it in front.
- `reorder_element`: with the slide's elements back to front, `to` is the index the element ends at: `front` the last,
  `back` 0, `forward` one more than now, `backward` one less (never past either end), and a number the index itself
  (at least the last index puts it in front).
- `delete_slide` and `delete_element` remove the map and every occurrence of the id.

**Order with repeats.** After concurrent moves, `order` and `elementOrder` can hold an id twice, or an id without a
map. Ops count positions in what readers see (the first occurrence of each id that has a map), remove the moved or
added id everywhere it occurs, and insert it once: right after the first occurrence of the slide it goes after
(`add_slide`, `move_slide`; at the start for `null`, at the end when `after` is left out), or right before the first
occurrence of the element that ends up directly above it (`add_element`, `reorder_element`; at the end when it goes in
front).

**Tables in `update_element`.** The new table is worked out from the current one and `set` (`cols`, `colWidths` and
`w` exactly like `rows`, `rowHeights` and `h`):
1. `rows`: from `set` when it's there and not `null`; otherwise from `set.cells` when that is a grid (its number of
   rows, 2 when 0); otherwise the current `rows`.
2. `cells`: a grid in `set`, which must fit the new `rows` × `cols` (`invalid_value` otherwise); `cells: null`, every
   cell empty; otherwise the current cells, cut to the new size. Either way padded with empty cells.
3. `rowHeights`: from `set` when it's there and not `null` (exactly `rows` numbers); `rowHeights: null`, spread evenly
   over the new `h`; otherwise, when `rows` changed, spread evenly over the new `h`; otherwise, when `h` changed, every
   height multiplied by `k = new h / old h` (spread evenly when the old `h` is 0); otherwise the current heights.
4. In the document, cells that are still inside keep their maps (their text and fill change through *Text edits*),
   new cells get new maps and cells outside the new size are removed, so a table shrunk and grown again gets empty
   cells back, never its old ones.

**Text edits.** Every change a writer makes to a `Y.Text` (rich `text` and cell text, `notes`, `html`, `css`, `js`; by
an op, by `reconcile` or `applyJsonToDoc`, or by the web's helpers and text bindings) is this diff of the current
characters against the target's, both taken as sequences of Unicode code points, never of UTF-16 units, so it never
splits a surrogate pair:
1. Keep the longest common prefix, then the longest common suffix of what remains.
2. In the middle, when both sides have at most 2,000 code points, keep a longest common subsequence chosen like this
   (otherwise delete the whole old middle, then insert the new one): with `L[i][j]` the length of a longest common
   subsequence of `old[i..]` and `new[j..]`, walk from `i = j = 0` until both are used up. When `old[i]` equals
   `new[j]`, keep it; otherwise delete `old[i]` if `new` is used up or `L[i+1][j] >= L[i][j+1]`, else insert `new[j]`.
3. Neighbouring code points that are kept, deleted or inserted form one chunk.

The result is exactly the target. In rich text every character then carries exactly the attributes the target gives
it (a paragraph break exactly its paragraph's, any other character exactly its run's), so formatting changes only
where it differs, and others' concurrent typing outside the changed characters survives.

**`replace_text`.**
- Where it looks: with `field`, in that field (`notes` without `element`; `text`, `html`, `css`, `js` or `cell:R:C` of
  the element, the cell in row `R` and column `C` counted from 0, written in decimal without leading zeros); with
  `element` but no `field`, in every text field of that element (`text`; `html`, `css` and `js`; every cell); with
  neither, in the slide's notes and every text field of every element on it (the master has no notes). A field name
  the element doesn't have is `field_not_found`; a cell outside the table is `cell_not_found`. A `Y.Text` is searched
  as its characters, every paragraph ending with `"\n"`, so a passage can span paragraphs.
- Matching: occurrences of `find` don't overlap and are taken from the start. With `"matchCase": false`, each code
  point of the text and of `find` is lowercased on its own (its full Unicode lowercase mapping, without locale or
  context: `İ` becomes `i̇`, `Σ` becomes `σ`, never `ς`), and an occurrence must start and end on whole code points of
  the original text, so offsets always point into the original (`"i"` doesn't match `"İ"`). The web's find & replace
  matches the same way and replaces through this op's rules.
- No occurrence fails with `text_not_found`; more than one (counted over every field searched) fails with
  `text_ambiguous` unless `"all": true`, which replaces every one.
- Each occurrence (the passage as it is in the text) is changed into `replace` by the diff above, so untouched
  characters keep their formatting and others' concurrent typing. Attributes are looked up in the text as it was
  before the op. An inserted chunk takes exactly the inline attributes of the first character that isn't a paragraph
  break in the chunk deleted right before it; when no chunk was deleted right before it, or that chunk holds only
  paragraph breaks, it takes those of the nearest such character of the passage before it, else after it, else none.
  A `"\n"` it inserts takes the paragraph attributes of the paragraph it splits: those of the first `"\n"` at or after
  the insertion point (none when there is none). In `notes`, `html`, `css` and `js` nothing carries attributes.

**Ops written against an older version.** With `"base": N` (an older version), the service applies the ops to the deck
as it was at version N, so every diff carries only the Silicon's own change, and merges the resulting Yjs update into
the live deck, so the change merges with everything that happened since. Before committing, it checks every slide,
element and table cell the ops name, change or create against the live deck (present-deck does this, so the service
and the contract tests run the same code):
- One they create that the live deck already has but version N doesn't fails with `id_exists`: a slide id, an element
  id anywhere in the deck, or a table cell (a `"r:c"` map, when a table grows). Otherwise two maps would sit under the
  same key, Yjs would keep one of them, and everything inside the other would be lost. This is also what refuses an
  `add_slide` or `add_element` with an explicit id that is sent twice. Ids the service generates are unused in both.
- One they name or change that version N has but the live deck has deleted fails with `slide_not_found`,
  `element_not_found` or `cell_not_found` (an `after` slide included), so nothing is written into a deleted map.
  Deleting it again is fine.
- Plain values and positions merge as concurrent edits do: of two changes to the same value, one wins.

Sending the same ops again at the same base applies them again (inserted text would appear twice), so a client
advances its base after every successful request and sends an `Idempotency-Key`, so a retry after a lost answer is
answered once. `present push` does both:
- Before sending, it writes the ids it generated for new slides and elements into the folder's files, so the same
  folder always makes the same ops.
- It sends them with `base` = the version in `.present/pull.json` and `Idempotency-Key:
  push:<deck>:<base>:<sha256 of the edit request>`, so the same push sent twice (by a retry, or by running it again) changes
  the deck once.
- Before sending, `.present/pending.json` stores the exact request and local snapshot. An ambiguous failure retries
  those same bytes and key; changed local files require recovery first. Local asset uploads and generated ids are
  saved back to the source files before the request is recorded.
- As soon as the edit succeeds, it marks `.present/pull.json` as pushed at the new version, then refreshes: it reads
  the deck at that version, writes `.present/base.json` and the folder from it, and only then records the new version
  as the folder's base and clears the mark.
- A folder still marked pushed (`--no-refresh`, or a refresh that failed) can't be pushed again: `present push` fails
  with `pull_needed` and says to run `present pull`, which brings down the merged deck (the pushed changes are in it).
  When the folder changed after the push, `present pull` needs `--force`, and its error says to copy those changes
  first.
- Downloads are staged before replacing managed files. `.present/refreshing.json` blocks edits if installation was
  interrupted; copying local changes aside and pulling with `--force` repairs it. Deck ids are encoded as filename
  components, and local references cannot escape the pulled folder through traversal or symlinks.
- Pull and push hold the same OS file lock before inspecting or replacing local state. A concurrent operation gets
  `folder_busy`; a process exit releases the lock. Encoded filenames remain distinct on case-insensitive disks.

## The service

Rust, axum 0.8, sqlx 0.9 (Postgres 16), yrs. Errors are always
`{"error": {"code": "snake_case", "message": "what happened and why", "hint": "what to do"}}` with the right status.
No telemetry.

Mutations with an `Idempotency-Key` claim that key durably for the caller before executing. Method, path, relevant
content headers and request bytes must match on retry; a different request gets `409 idempotency_key_reused`.
Concurrent or interrupted requests with no saved response get `503 idempotency_pending`; successful responses are
replayed. A failed response write never authorizes re-executing the mutation. JSON requests are limited to 4 MiB,
presence to 16 KiB, and asset/import uploads to 512 MiB.

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

Content updates are applied and validated on a trial document, persisted, and only then installed in the live room
and broadcast. A database failure leaves the existing room, document and subscribers intact.

### Live editing (no websockets; everything goes through the web's API proxy)

- `GET /v1/decks/{id}/live?sv=<base64 state vector>` is a server-sent event stream. First event `sync`:
  `{ update: base64 (everything the client lacks), sv: base64 (the server's state vector), version }`. Then `update`:
  `{ update, author: Account, version, origin, summary?, touched: [slideId] }`, `presence`: `{ session, account,
  slide, selection: [elementId], cursor: {x,y} | null, color }`, `presence_left`: `{ session }`, `comments`:
  `{ thread }` when threads change, `deck` (below), and a `ping` every 20 s. The proxy ends a stream after 5 minutes;
  clients reconnect with their state vector.
- `deck` carries deck fields that changed. `title`, `folder` and `publicMode` go to every stream of the deck. `role`
  goes to each stream whose caller's effective role changed, with the new role (`owner`, `editor`, `commenter` or
  `viewer`), after anything that changes who can open the deck: sharing it or a folder it is in (with everything
  inside), changing or removing a role there, the public switch, a transfer, moving it between folders, trashing or
  restoring it. A signed-out stream of a public deck counts as `viewer`. A stream whose caller can no longer open the
  deck gets `{ "role": null }` and then ends. Pages apply a new role at once: an editor who became a viewer stops
  editing without waiting for a refused update.
  Effective access is checked before each outgoing content event and every two seconds while idle; both deck and
  presentation streams close after five minutes so the client reconnects with current credentials.
- `POST /v1/decks/{id}/updates` `{ update: base64, session }` applies a client's Yjs update (editors only; others get
  403), appends it to the log with the caller as author, and broadcasts it. Clients batch for ~40 ms. An update that
  would cut a character in two (an insert, delete or format boundary between the two halves of a UTF-16 surrogate
  pair) is refused with `422 invalid_update`: yjs turns both halves into U+FFFD while yrs moves the cut, so the
  service would read a different deck from the browsers. First-party writers never send one (*Text edits*).
- `POST /v1/decks/{id}/presence` `{ session, slide, selection, cursor }` (anyone who can view); presence expires after
  30 s without a heartbeat. The service adds the caller's account; clients can't claim to be someone else.
  Each account can hold eight sessions per room, with at most 256 total. Selection and cursor data are bounded.
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

Public decks optionally collect a contact email before viewing. The owner sets
`PUT /v1/decks/{id}/public { mode, requireEmail?: boolean }`; omitting the flag preserves it,
and switching public access off retains the setting for later. The setting is also returned as
`requireEmail` in deck metadata and sharing access. It applies while the deck is public, including
through its folder. The owner is exempt. Private access checks always run first.

When enabled, readers use their signed-in Accounts email when available; otherwise they supply
`X-Present-Viewer-Email`. A missing or malformed address returns `403 email_required` on deck
reads, live streams, presentations, exports, renders and assets. This address is self-reported,
does not sign anyone in, and never grants editing, commenting or private-deck access. The web
stores entered addresses in a separately sealed, HttpOnly cookie for 24 hours, forwards them
server-side, and explains that the owner sees the address and visit times. No verification mail
is sent. Existing streams recheck the requirement before further content is delivered.

`GET /v1/decks/{id}/viewers` is owner-only and returns
`{ viewers: [{ email, source: "account"|"entered", firstViewedAt, lastViewedAt, views }] }`.
Only successful content reads while email collection is enabled are recorded; owner activity,
metadata reads and asset fetches do not count. Repeat opens within 30 minutes count as one view.
Entered and account-supplied addresses retain separate provenance. The list does not identify
visitors from before collection was enabled, and entered addresses are not verified identities.

### Files

- `POST /v1/imports` (raw body, `Content-Type`, `X-Filename`, optional `?folder=`) → a new deck from any supported
  file. `POST /v1/decks/{id}/imports` → opening a file on top of a deck makes it the deck's next version.
- `GET /v1/decks/{id}/export?format=pptx|odp|pdf|txt|png|jpg|svg&version=&slide=&width=&at=` → the file
  (`Content-Disposition` with the deck title). png/jpg of a whole deck is a `.zip` with one image per slide; with
  `slide` the deck is trimmed to that slide and the converter gets `slide` too, so png/jpg is the image itself.
  Any other format (ppt, key, html included: they open, they don't export) is `400 invalid_format`.
- `GET /v1/decks/{id}/slides/{slide}/render?format=png|jpg&width=1920&version=&at=<ms>` → one slide as an image, how a
  Carbon would see it (HTML elements run for `at` ms first, default 1500).
- `POST /v1/decks/{id}/assets` (raw body, `Content-Type`, `X-Filename`) → `{ id, url, contentType, size }`;
  `GET /v1/assets/{id}` (anyone who can view the deck; `?deck=&exp=&sig=` for the converter). The converter gets
  `assetBase` = `{PRESENT_PUBLIC_URL}/v1/signed/{deck}/{exp}/{sig}/assets/` (valid one hour) and fetches
  `assetBase + id`; the service collapses `//`, so `assetBase + "/" + id` works too.

Historical exports and renders require editor access. Asset responses carry `nosniff`, `no-store` and a scriptless
sandbox CSP; active document types are attachments. The web proxy preserves these headers. Chromium conversion and
Node asset downloads reject private/reserved destinations, pin validated DNS results and revalidate redirects.
Only the authenticated service's exact signed asset path can reach its private origin. Native LibreOffice and
Keynote conversions are separate OS processes and are not covered by that browser/network isolation.

### Presenting

- `POST /v1/decks/{id}/presentations` → `{ id, followUrl, slide, step }` (anyone who can view may present).
- `GET /v1/presentations/{p}`; `PUT /v1/presentations/{p} { slide, step }` (the presenter only);
  `DELETE /v1/presentations/{p}` (stop); `GET /v1/presentations/{p}/live` (SSE: `state`, `ended`).
- Following needs view access to the deck (or a public deck).

### Search and accounts

- `GET /v1/search?q=` — every deck the caller can view whose title, slide text, notes or table text matches.
- `GET /v1/accounts/resolve?q=c:ada` — for invites and mentions.
- `GET /v1/me`.
- `POST /v1/reports { message (≤ 10,000 chars), pr?: url, context?: object }` (any signed-in Carbon or Silicon;
  `present report`) → `{ id }`. Each report is kept in `reports` (who, when, message, pr, context, service version,
  User-Agent) and mailed through the mail adapter to saketdev12@gmail.com, shubhastro2@gmail.com and
  bugs@teamofsilicons.com, the same destinations as the other Silicon apps' report commands.
- `POST /v1/accounts/webhook` — Silicon Accounts' signed webhook (`account.id_changed`, `account.updated`) refreshes
  how that account is shown at once; on only when `PRESENT_ACCOUNTS_WEBHOOK_SECRET` is set.

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

Internal only (bound to 127.0.0.1, port `CONVERTER_PORT`, default 4322; every request but `GET /health` carries
`X-Converter-Secret` = `CONVERTER_SECRET`). Node 24, TypeScript, Playwright Chromium (already installed under
`~/Library/Caches/ms-playwright`), LibreOffice (`/opt/homebrew/bin/soffice`), poppler (`pdftoppm`, `pdftotext`,
`pdfinfo`, `pdftocairo`), pptxgenjs; ffmpeg (optional) and Keynote (optional, macOS). Each process has its own temp dir and
LibreOffice profile, so several converters (one per lane) run side by side.

`assetBase` is where the converter fetches `asset:<id>`: a URL prefix the id is appended to
(`https://svc/v1/signed/<deck>/<exp>/<sig>/assets/` + id), or a template containing `{id}`.

- `POST /render { deck, slide, width?=1920, format?=png|jpg, at?, assetBase }` → the image (`image/png` or
  `image/jpeg`). Built with `packages/render`; the final state of every animation; HTML elements and videos run for
  `at` ms first (default 1500 when the slide has any, otherwise none).
- `POST /export { deck, format, assetBase, slide?, width?, at? }` → the file, with `X-Export-Extension` (`zip` for
  a whole deck as png/jpg) and, when something had to be approximated, `X-Converter-Warnings` (URI-encoded, ` | `
  between warnings).
  - pdf/png/jpg via Chromium, one page/image per slide that isn't skipped; png/jpg with `slide` is that one image.
  - txt: rendered text of all slides, including skipped slides, without speaker notes (PDF through `pdftotext`).
  - svg: requires `slide`, including a skipped slide; one vector image (PDF through `pdftocairo -svg`) with outlined
    fonts and embedded images. The web menu offers pptx/odp/pdf/txt and current-slide jpg/png/svg.
  - pptx via pptxgenjs: native text runs, preset shapes, tables, charts, pictures, video/audio, notes, sections,
    hidden slides (`show="0"`), groups (`p:grpSp`, when the members are adjacent in z-order) and transitions. Element
    ids are the shape names and slide ids the slide names, so a round trip keeps them. HTML elements become a picture
    of how they render. Video/audio PowerPoint can't play (webm, ogg...) is re-encoded to mp4/mp3 with ffmpeg, or
    becomes a picture without it. Element animations are each slide's `<p:timing>` with PowerPoint's own entrance
    presets: appear = Appear (1), fly-in = Fly In (2, subtype = the side it comes from), fade = Fade (10), wipe = Wipe
    (22, subtype = the side it starts at), zoom = Zoom (53/16), rise = Rise Up (37); click / with previous / after
    previous, order, duration, delay and direction are kept, timed as the player plays them. A group whose members all
    animate as one (consecutive, the rest `with-previous` with no delay and the same effect) gets one effect on the
    group; a group whose members animate one by one is left ungrouped, with a warning (PowerPoint animates a group as
    a whole). Master elements don't animate, as in the player.
  - odp: that pptx through LibreOffice; LibreOffice maps every animation onto its matching effect (fade-in, fly-in,
    wipe, fade-in-and-zoom, rise-up, appear) with trigger, timing and direction, so animations survive in the .odp.
  - Nothing else: ppt, key and html are `400 unsupported_format` (they are import formats only).
- `POST /import { filename, contentType?, data (base64) }` →
  `{ deck, assets: [{ key, filename, contentType, data }], notes: [string] }`; the deck refers to assets as
  `asset:<key>` (the service swaps keys for real ids), `notes` says what became a picture or was approximated.
  - pptx/ppsx/potx parsed natively (text with runs, geometry, pictures, tables, charts, media, backgrounds, notes,
    placeholders inherited from layouts and masters, the most used master's decorations as the deck master, groups
    flattened with `group` ids, sections, hidden slides → `skipped`, transitions, entrance animations (other entrance
    presets become the closest effect, unknown ones fade; emphasis, exit and motion-path effects are left out; order
    is each animation's place on its slide, 1, 2, 3...); EMU scaled to 1920 wide).
  - odp/ppt (via odp) → pptx through LibreOffice first; key → pptx through Keynote (LibreOffice if Keynote fails).
  - pdf → one slide per page (page picture as background, page text in notes); html → a page carrying Present's
    embedded deck JSON (older html exports) opens exactly; a page with slides (reveal.js sections, `<deck-stage>`
    children as Claude Design writes them, `.slide`/`[data-slide]`, or same-size stacked pages) is laid out in the
    isolated Chromium and each slide becomes native text (runs, lists), images, shapes, tables, background and notes,
    with anything that can't be mapped faithfully (canvas, SVG, iframes, form controls, scripted widgets, looping
    animations, filters) kept as a live HTML element over exactly that part; any other page becomes one full-slide
    HTML element; images, video, audio → one slide each; fonts (ttf, otf, woff, woff2) → a deck whose theme uses that font
    (`theme.customFonts`); Google Slides through its `.pptx` export.
  - Anything the parser can't model (SmartArt, OLE objects, ink, 3D, custom geometry, unknown graphic data, pictures
    browsers can't show such as EMF/WMF/TIFF) becomes a picture of that part cut from LibreOffice's render of the
    slide, so nothing is dropped.

## Web (`web/`)

Copied from the shared web kit (`/Users/codanium/Documents/silicon/.migration/web-kit`, its `ADOPTING.md`): Next.js
BFF with a sealed session cookie, Silicon Accounts sign-in, `/api/*` proxy to the service. Components from Silicon UI
(`https://ui.teamofsilicons.com/r/{name}.json`, the kit's `components/arc` set). **Light mode only, minimal**: one calm
look, few boxes, no theme switch.

Pages: `/` (landing when signed out), `/decks` (mine, shared, folders, trash, transfers), `/decks/[id]` (editor),
`/decks/[id]/present`, `/decks/[id]/presenter`, `/decks/[id]/history`, `/p/[presentation]` (follow along).

### Home and editor interaction contract

- Deck listings and global search use responsive first-slide cards with a title link, direct Present action and
  role-aware actions menu. Folders remain in a separate navigation section. Search preserves owner, location and matching
  excerpts. Previews use the ordinary content route and account-scoped queries, load near the viewport, render
  static HTML/media with links disabled, and clear while access is rechecked or refused. Videos use posters only.
- Selected editor toggles retain their accent color on hover and keyboard focus; inactive hover is neutral and
  disabled controls stay visually disabled. Focus is visible through fills and edges, following the Silicon UI.
- The open comment composer has a persistent point pin or area/object outline on its own slide until post or
  cancel. Draft and saved anchors share geometry resolution; coordinates are scaled once inside the panned stage.
  Element anchors follow object geometry, and dragged areas remain axis-aligned. Whole-slide/deck comments have no
  point marker. The existing drag preview remains visible before the composer opens.
- The shape tool defaults to Rectangle and remembers its last choice. Its main button, labeled chooser and
  shortcuts (`R`, `O`, `L`, `Shift+L`) arm drawing without adding an object. A drag in any direction shows a local
  preview at the correct zoom/pan position; a click alone adds nothing. Shift constrains closed shapes to equal
  width/height and lines to 45-degree angles. Release commits one undo step and returns to Select. Escape,
  pointer cancellation, tool/slide changes or lost focus discard the draft. Image/video uses `Mod+Shift+K`
  (`Mod` is Command on macOS, Control elsewhere); typing, controls, menus, composition and repeats retain their keys.
- Layers opens upward from the canvas's bottom-right corner and lists objects front-first so obscured objects
  remain selectable. Dragging a row shows the moving selection and insertion boundary; the list scrolls near its
  edges. Mouse dragging works across the row, while the grip supports touch dragging without blocking list scroll.
  Drags, order buttons and object-menu equivalents preserve relative order within a multi-selection and move
  selected groups together, respecting locks and stack boundaries. Each order change is a separate undo step;
  unavailable actions are disabled. Escape, pointer cancellation, lost focus, changed selection/permissions or
  slide navigation cancel a drag. At narrow canvas widths the Layers control sits above the creation dock.
- Right-click opens the same object menu from the canvas or a layer row, preserving a selection that already
  contains the target. Actions follow the current edit/comment permissions and lock state. The canvas also
  supports Shift+F10/Context Menu for a selected object; editable text retains its native text menu. Double-click
  still edits unlocked text, shapes and table cells; on an unlocked HTML object it enters edit-inside (its code
  editor stays on Enter, the toolbar and the object menu).
- Icon-only editor hints are compact and prefer the space above their controls. Visibly labeled More tools options
  have no redundant tooltips. Popover autofocus and keyboard navigation remain intact.
- New slide tiles follow the last thumbnail in the strip and grid, use the deck's aspect ratio, and append after
  the latest last slide independently of selection. Their layout picker also appends; viewer roles cannot add.
- Applying a layout must rearrange usable content rather than only change its label. Because placeholders are
  ordinary elements and older layout labels may be wrong, recognize canonical templates by their actual geometry
  across all layouts. Reuse compatible IDs/content, preserve unmatched authored objects and labels within custom
  graphics, and delete only confidently unchanged empty template elements. Protected or rotated objects remain in
  place. Authored elements receive geometry changes only, preserving rich text, styles, sources and metadata.
  `lib/editor/layout-change.ts` plans sparse operations from fresh document state; the editor applies them in one
  transaction between undo capture boundaries. Reapplying the selected layout also repairs its actual geometry.

### CLI layers and native releases

CLI 0.1.1 adds `present layers <deck> <slide>` and `present layers move` with `--to`, `--before` or
`--after`. Lists are front-first while z selectors remain 1-based from the back. The planner resolves all
selectors against one read, preserves selected relative order, expands groups, respects target group boundaries
and skips locked sources or groups with a locked member. Legacy `front`/`back` delegate to this planner.
Moves are submitted through the authenticated client as one numeric reorder transaction based on the read
version; the service's usual historical-version merge semantics remain unchanged. Bundled `present docs layers`
describes the commands and version restoration.

The CLI has its own package version so a CLI-only release does not imply a web/API deployment. Windows home
discovery falls back from `SILICON_HOME` to `HOME` to `USERPROFILE`. The release build/package scripts bind each
target binary to a complete source fingerprint and reject stale or wrong-target artifacts. Native target
validation and actual isolated installs gate Apps promotion; see `deploy/RELEASE-0.1.1.md` for receipts.

## End to end

`e2e/` starts everything on the ports above: Postgres, a Silicon Accounts test stack with the `present` app seeded,
the Ting stand-in (records every ting), the converter, the service and the web; then runs the CLI suite and the
Playwright suite (two Carbons and a Silicon working on the same deck).
