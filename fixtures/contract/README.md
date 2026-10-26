# Deck contract fixtures

Both deck models, Rust `crates/present-deck` (yrs) and TypeScript `packages/deck` (yjs), must turn the same input
into the same document and read the same document the same way. `docs/architecture.md` ("The deck document",
"Canonical JSON", "Edit ops") is the rulebook; the files here are its test cases. Every `expect` was worked out by hand
from the rulebook, not copied from either implementation, so when a runner disagrees with a case, the implementation
is wrong, or the case is, and then the case and the rulebook are fixed together.

## Current executable coverage

`pnpm test:contract` runs the checked-in `normalize/` and `ops/` cases through both implementations, verifies their
independently written expected JSON or error codes, checks failed-op atomicity, and exchanges every successful
document in both directions. `scripts/contract-check.mts` drives `crates/present-deck/examples/contract_bridge.rs`.
The ordinary Rust and TypeScript contract tests also require and decode all checked-in round-trip counterparts;
tests never regenerate expected fixtures.

The raw-document case format, full stored-tree comparisons and concurrent case-file runner described below are
the intended extension protocol; no `read/` fixture directory or general runner for those fields is claimed here.
Raw-map, Unicode, stale-base and failed-persistence regressions currently live in the package and service tests.

```
fixtures/contract/
  <name>.json, <name>.rust.yupdate, <name>.ts.yupdate   whole decks both writers must agree on (round trip, below)
  normalize/<case>.json   deck JSON given to a writer: the deck it stores, or the error it refuses it with
  read/<case>.json        a raw Yjs document any editor could have made: what readers return
  ops/<case>.json         edit ops applied to a deck: the deck after them, or the error
```

## Case files

Every case is one JSON object with these keys and no others:

| Key | In | What |
| --- | --- | --- |
| `name` | all | the file name without `.json` |
| `description` | all | what the case shows, in a sentence or two |
| `findings` | all | ids of the audit findings it guards against (may be empty) |
| `sides` | all, optional | `["rust"]` or `["ts"]` when only one model can run the case (base merges are Rust only); missing means both |
| `input` | normalize | deck JSON, usually not canonical |
| `doc` | read | a raw document (below) |
| `start` | ops | the deck before the ops, as canonical deck JSON |
| `startRaw` | ops | instead of `start`: the deck before the ops, as a raw document (below) |
| `concurrent` | ops, Rust only | ops someone else applied to the live deck after `start` was read (base merges, below) |
| `ops` | ops | the `ops` list of one edit request |
| `expect` | all | canonical deck JSON (without `id`, `title` and `version`) |
| `expectError` | normalize, ops | `{ "code": "..." }` instead of `expect` |
| `expectRaw` | ops, optional | the raw document the ops must leave behind (below) |

A case has exactly one of `start` and `startRaw`, exactly one of `expect` and `expectError` (`read` cases always
`expect`), and `concurrent` only together with `start` and `"sides": ["rust"]`. Ids in cases are always given, so
nothing depends on a generated id, and no outcome depends on Yjs client ids.

### Raw documents

`doc`, `startRaw` and `expectRaw` describe a document exactly as Yjs holds it, including content our own writers never
make (a plain string where a `Y.Text` belongs, repeated ids in `order`, unknown attributes, a BigInt):

```jsonc
{ "deck": { "size": { "width": 1920, "height": 1080 } },   // the root map "deck": its keys and values
  "order": ["s_000001"],                                    // the root array "order": its items
  "slides": { "s_000001": { "$map": { ... } } } }           // the root map "slides": its keys and values
```

The three keys are the three roots; a missing one is empty. A value is a plain JSON value (stored as one Yjs plain
value exactly as given: a string stays a string, `2.5` a float, an object a plain object) or one of these objects:

| Value | Is |
| --- | --- |
| `{ "$map": { "key": value, ... } }` | a `Y.Map` |
| `{ "$array": [ value, ... ] }` | a `Y.Array` |
| `{ "$text": [ { "insert": "Hi", "attributes": { "bold": true } }, { "insert": "\n" } ] }` | a `Y.Text`, built by inserting each piece at its end with exactly those attributes (any JSON, stored as given); an `insert` that is an object is an embed |
| `{ "$bigint": "9007199254740993" }` | a lib0 BigInt (type 122); it may also sit inside a plain value |

A runner builds the document with its own Yjs: create each `Y.Map`, `Y.Array` or `Y.Text` in its parent, then fill it.
In Rust a BigInt is `Any::Number(Number::Int(n))` with |n| > 2^53, which yrs writes as type 122; in TS it is a JS
`bigint`.

The **dump** of a document is the same shape read back: all three roots (empty when the document has none), every map
with all its keys, a `Y.Text` as its delta with neighbouring inserts of equal attributes merged, attributes whose value
is `null` dropped and an empty `attributes` left out, and a stored integer beyond ±(2^53 − 1) (in Rust
`Number::Int(n)`, in TS a `bigint`) as `{ "$bigint": "<n>" }`, so it never equals a plain number.

### Comparing JSON

Objects compare key by key in any order, lists item by item, and numbers by value as float64 (`1` equals `1.0`, `-0`
equals `0`, and `12345678901234567890` equals the float `JSON.parse` makes of it). Strings compare exactly, UTF-16
unit for unit, with no normalization. Rust reads the case files with serde_json's `float_roundtrip` feature on, so
every number reads as the same float64 `JSON.parse` gives.

## Runners each side must have

Rust: one integration test in `crates/present-deck/tests/` (for example `contract_cases.rs`). TypeScript: one test file
in `packages/deck/test/` (for example `contract-cases.test.ts`). Each runs every case in `normalize/`, `read/` and
`ops/` whose `sides` include it, and:

- fails when a folder is missing or empty, when a case doesn't parse, has a key not listed above or a wrong
  combination of keys, or has a `name` that isn't its file name;
- prints how many cases it ran and how many it skipped for `sides`;
- compares error codes only, and checks that every error's `message` and `hint` are non-empty.

### `normalize/`

1. Write `input` into a new document (`json_to_doc` / `jsonToDoc`). With `expectError` it must fail with that code.
   Otherwise reading the document (`doc_to_json` / `docToJson`) must give `expect`, and the dump of the document must
   equal the dump of a new document written from `expect`, so nothing non-canonical was stored.
2. Write `input` again with the other writer, onto a document made from `minimal.json` (Rust `reconcile` with the whole
   deck as scope, TS `applyJsonToDoc`): the same error code, and the document unchanged; or a document that reads as
   `expect` and whose dump equals the dump of a new document written from `expect`.
3. Without `expectError`, the lenient normalizer (`normalize_deck` / `normalizeDeck`) of `input`, with `id`, `title`
   and `version` left out, must equal `expect`, and the normalizer of `expect` must give `expect` back.

### `read/`

1. Build the raw document from `doc` and note its state vector.
2. Reading it must give `expect`.
3. The state vector must be unchanged and no update emitted. TS also calls every read helper on it (`slideIds`;
   `getSlide` for every slide and `getElement` for every element, the master's included; `getSize`; `getTheme`; and
   `getTextField` for every text field, notes included, which may return nothing or throw for a missing field but
   must not create it) and checks the state vector again: reads never write.
4. A new document decoded from the document's whole state (one v1 update) must read as `expect` too.

### `ops/`

1. Build the deck: `json_to_doc(start)` / `jsonToDoc(start)`, or the raw document from `startRaw`.
2. Apply `ops` as one request (Rust `apply_ops`; TS `applyOps`, atomic).
3. With `expectError`: that code, and the document is unchanged (same state vector, reads as before).
4. Otherwise reading the document gives `expect`, and so does a new document decoded from the document's whole state
   (this catches text that only looks right locally, such as half of a surrogate pair). With `start`, the dump of the
   document must equal the dump of a new document written from `expect`; with `expectRaw`, the dump must equal
   `expectRaw`.

**Base merges** (`concurrent` present, `"sides": ["rust"]`, because only the service applies ops at a base):

1. `base` = the deck built from `start` (version N); `live` = a copy of it (same state, another client id).
2. Apply `concurrent` to `live` as an ordinary request; it must succeed. This is what others did after version N.
3. Apply `ops` the way `POST /edits` does with `"base": N`, through the same present-deck function the service calls:
   run them on `base`, check them against `live` ("Ops written against an older version"), and merge the resulting
   update into `live`.
4. With `expectError`: that code, and `live` is as step 2 left it. Otherwise `live` reads as `expect`, and its dump
   equals the dump of a new document written from `expect`.

## Round-trip fixtures (`<name>.json`)

`packages/deck/test/make-fixtures.ts` writes `<name>.json` (canonical deck JSON) and `<name>.ts.yupdate` (`jsonToDoc`
with client id 1, one v1 update); an explicit Rust command (never a side effect of `cargo test`) writes
`<name>.rust.yupdate` (`json_to_doc`). Each side decodes the other's update and must read exactly `<name>.json`. Both
runners fail when a counterpart file is missing, compare what they read against `<name>.json` itself (not against
their own normalization of it), check that `<name>.json` is canonical (their normalizer gives it back unchanged), and
check that their own writer still makes an update that reads as `<name>.json`.

## Adding a case

Keep it small: one slide and one or two elements, one thing per case, and one problem per error case (which of several
problems is reported isn't specified). Work `expect` out from `docs/architecture.md`; if the rulebook doesn't decide
it, decide it there first. Use ids like `s_000001` and `e_000001`, and name the file for what it shows. In base merges,
never let `concurrent` and `ops` insert at the same position or set the same key: Yjs breaks such ties by client id.
