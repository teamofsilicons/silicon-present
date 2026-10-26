# Silicon Present converter (`renderer/`)

The internal sidecar that turns slides into images and files, and any file into a deck. Contract:
`docs/architecture.md`, "Converter sidecar". HTTP(S) requests, including HTML-element scripts and subresources in Chromium, go through a DNS-pinned transport that blocks private, loopback, link-local and reserved addresses at every redirect. Exact deck asset URLs supplied by the authenticated service may reach its private endpoint. Downloads are capped at 64 MiB and 30 seconds; WebSockets and service workers are disabled in render contexts. Public internet resources remain available.

```
CONVERTER_SECRET=... CONVERTER_PORT=4322 pnpm --filter @silicon-present/renderer start   # tsx src/server.ts
```

| Env | Default | |
| --- | --- | --- |
| `CONVERTER_SECRET` | (required) | the value of `X-Converter-Secret` the service sends |
| `CONVERTER_PORT` | 4322 | bound to 127.0.0.1 only |
| `SOFFICE_PATH`, `PDFTOPPM_PATH`, `PDFTOTEXT_PATH`, `PDFTOCAIRO_PATH`, `PDFINFO_PATH`, `FFMPEG_PATH` | `/opt/homebrew/bin/...` | tools |
| `CONVERTER_TMP` | OS temp dir | each process works in its own `silicon-present-converter-<pid>` folder |
| `CONVERTER_MAX_BODY` | 1 GiB | largest request |

Needs Playwright's Chromium (`playwright@1.56.1` → `chromium_headless_shell-1194`, already in
`~/Library/Caches/ms-playwright`), LibreOffice, poppler, optionally ffmpeg (re-encodes media PowerPoint and Keynote
can't play) and Keynote (`.key`; the converter's user needs Automation permission for Keynote, and Accessibility for
System Events so Keynote's alerts and sheets can be read and dismissed instead of waiting for the time limit).
Keynote conversions share a kernel file lock across converter processes on the same Mac. Missing Keynote or an
explicit Apple Events permission denial returns `keynote_unavailable`; native scripting failures retain their
underlying error as `keynote_failed`. An installed app is not proof that its scripting support is working.

Plain-text export uses `pdftotext` on the rendered slides, including skipped slides, without speaker notes.
Current-slide SVG export uses `pdftocairo -svg` on that slide's PDF: shapes and fonts stay vector, images are embedded.
Both tools are part of poppler. SVG requests require `slide`.

## Layout

- `src/server.ts` the HTTP endpoints; `src/browser.ts` the shared Chromium (screenshots, PDF, element pictures,
  image decoding); `src/office.ts` LibreOffice and Keynote; `src/media.ts` file types, image sizes, font names.
- `src/export/` deck → pptx (pptxgenjs + XML post-processing for groups, transitions, hidden slides, slide ids) and
  every other format.
- `src/import/` pptx parser (`pptx.ts`, animations in `pptx-animations.ts`), html decks laid out in Chromium into
  native elements (`html.ts`, with `html-page.ts` running in the page), the other formats (`index.ts`), a small
  ordered XML tree (`xml.ts`).

## Tests

```
pnpm --filter @silicon-present/renderer test        # starts the sidecar on a free port; every import and export
pnpm --filter @silicon-present/renderer fixtures    # rebuild test/fixtures (pptxgenjs, LibreOffice, Keynote, ffmpeg)
```

Looking at results (do this after changing anything visual):

```
tsx scripts/export-all.ts /tmp/out [pptx,odp,pdf,txt,png,jpg]   # the test deck in every format
tsx scripts/view-import.ts test/fixtures/rich.pptx /tmp/out/imp       # import a file, render every slide to PNG
```
