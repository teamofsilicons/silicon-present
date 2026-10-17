# Silicon Present converter (`renderer/`)

The internal sidecar that turns slides into images and files, and any file into a deck. Contract:
`docs/architecture.md`, "Converter sidecar". It never sends anything anywhere except the asset URLs it is handed.

```
CONVERTER_SECRET=... CONVERTER_PORT=4322 pnpm --filter @silicon-present/renderer start   # tsx src/server.ts
```

| Env | Default | |
| --- | --- | --- |
| `CONVERTER_SECRET` | (required) | the value of `X-Converter-Secret` the service sends |
| `CONVERTER_PORT` | 4322 | bound to 127.0.0.1 only |
| `SOFFICE_PATH`, `PDFTOPPM_PATH`, `PDFTOTEXT_PATH`, `PDFINFO_PATH`, `FFMPEG_PATH` | `/opt/homebrew/bin/...` | tools |
| `CONVERTER_TMP` | OS temp dir | each process works in its own `silicon-present-converter-<pid>` folder |
| `CONVERTER_MAX_BODY` | 1 GiB | largest request |

Needs Playwright's Chromium (`playwright@1.56.1` → `chromium_headless_shell-1194`, already in
`~/Library/Caches/ms-playwright`), LibreOffice, poppler, optionally ffmpeg (re-encodes media PowerPoint and Keynote
can't play) and Keynote (`.key`; the converter's user needs Automation permission for Keynote, and Accessibility for
System Events so Keynote's alerts and sheets can be read and dismissed instead of waiting for the time limit).

## Layout

- `src/server.ts` the HTTP endpoints; `src/browser.ts` the shared Chromium (screenshots, PDF, element pictures,
  image decoding); `src/office.ts` LibreOffice and Keynote; `src/media.ts` file types, image sizes, font names.
- `src/export/` deck → pptx (pptxgenjs + XML post-processing for groups, transitions, hidden slides, slide ids) and
  every other format.
- `src/import/` pptx parser (`pptx.ts`), the other formats (`index.ts`), a small ordered XML tree (`xml.ts`).

## Tests

```
pnpm --filter @silicon-present/renderer test        # starts the sidecar on a free port; every import and export
pnpm --filter @silicon-present/renderer fixtures    # rebuild test/fixtures (pptxgenjs, LibreOffice, Keynote, ffmpeg)
```

Looking at results (do this after changing anything visual):

```
tsx scripts/export-all.ts /tmp/out [pdf,png,html,pptx,odp,ppt,key]   # the test deck in every format
tsx scripts/view-import.ts test/fixtures/rich.pptx /tmp/out/imp       # import a file, render every slide to PNG
tsx scripts/view-html.ts /tmp/out/deck.html /tmp/out/html              # play an HTML export, screenshot its slides
```
