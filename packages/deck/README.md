# @silicon-present/deck

The Silicon Present deck as a Yjs document (layout in `docs/architecture.md`), in TypeScript:

- `docToJson(doc, meta?)` / `jsonToDoc(json)` / `applyJsonToDoc(doc, json)` (minimal reconcile, one transaction)
- `applyOps(doc, ops)`: the edit ops from the architecture, atomic (all or nothing, one update)
- helpers for the web editor: `addSlide`, `duplicateSlide`, `moveSlideTo`, `deleteSlide`, `updateSlide`, `setNotes`,
  `addElement`, `updateElement(s)`, `deleteElements`, `reorderElement`, `duplicateElements`, `setElementText`,
  `setCellText`, `setCode`, `groupElements`, `ungroup`, `moveElements`, `alignElements`, `distributeElements`,
  `findInDeck`, `replaceInDeck`, `getTextField` (the `Y.Text` to bind a text editor to)
- rich text: `yTextToRichText`, `setRichText` (minimal diff), `richTextFromPlain`, `richTextToPlain`
- ids (`newSlideId`, `newElementId`), `THEMES` (7 themes), `layoutElements(layout, theme, size, content)` (7 layouts)

Readers (`docToJson`, `normalizeDeck` and the read helpers) tolerate malformed stored values and never write to the
Y.Doc. Writers check canonical fields and values before changing the document. `applyOps` also checks every op's
shape before applying the batch; `{ atomic: false }` still preflights the entire batch, then performs the verified
changes as a local transaction so an UndoManager can track them.

`getTextField` only returns an existing Y.Text and throws when the field is missing or malformed. Writers can call
`ensureTextField` inside their transaction to repair its storage using the text readers see. Text writers and
`replaceTextRange` share a Unicode code-point diff; `findMatches` returns offsets into the original text even when
case folding expands a character.

## How to consume it

The package ships TypeScript source (`exports` points at `src/index.ts`); there is no build step.

- Next.js (`web/`): add `"@silicon-present/deck": "workspace:*"` and `transpilePackages: ["@silicon-present/deck",
  "@silicon-present/render"]` in `next.config.ts`.
- Node: run through `tsx` (the converter sidecar does).

Use the `Y` re-export (`import { Y } from "@silicon-present/deck"`) or depend on the same exact `yjs` version, so
there is only one copy of yjs in a bundle.

## Tests

```
pnpm --filter @silicon-present/deck test          # node:test via tsx
pnpm --filter @silicon-present/deck exec tsx ../../scripts/contract-probe.mts   # optional broad differential probe
pnpm --filter @silicon-present/deck exec tsx test/make-fixtures.ts   # rewrite fixtures/contract/*.json + *.ts.yupdate
```

`fixtures/contract/` holds the cross-language fixtures: `<name>.json` (canonical deck JSON), `<name>.ts.yupdate`
(made here) and `<name>.rust.yupdate` (made by `crates/present-deck`). The contract test decodes every
`.rust.yupdate` and checks it reads back as exactly `<name>.json`.

The separate deterministic probe compares TypeScript and Rust across malformed raw Yjs fields, strict writer inputs,
edit values, and 600 formatted text replacements (seed 42). It complements the independently expected fixtures; a
matching result alone does not establish that both implementations follow the contract. It writes no fixtures.
