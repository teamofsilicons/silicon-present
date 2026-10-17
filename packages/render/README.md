# @silicon-present/render

The one definition of how a Silicon Present slide looks: deck JSON in, static HTML out. The web viewer, present
mode, thumbnails, the converter's screenshots/PDF and HTML export all use it, so a slide looks the same everywhere.

```ts
import { renderSlideHtml, renderSlideDocument, renderDeckHtml, slideCss, fontCss, scaleToFit, slideSteps, transitionCss } from "@silicon-present/render";

renderSlideHtml(deck, slideId, {
  assetUrl: (id) => `/api/v1/assets/${id}`, // default
  step: "all" | 0 | 1 | ...,   // click-step to show; "all" (default) = final state
  animate: false,              // true: play the shown step's animations (present mode)
  html: "live" | "static",     // HTML elements as sandboxed iframes, or a cheap placeholder (thumbnails)
  media: "interactive" | "static",
  links: true, placeholders: false, includeCss: true, googleFonts: true, hide: [], only: undefined,
});
```

- `renderSlideHtml` returns a fragment: a `deck.size` box (1920 × 1080 by default). Scale it with
  `scaleToFit(boxW, boxH, deck.size)` and a CSS `transform: scale()`. With `includeCss: false`, add `slideCss()` and
  `fontCss(deck)` to the page once.
- Present mode: render with `step: 0, animate: true`, then move through steps by setting the slide root's
  `data-sp-at="<k>"` (and `data-sp-animate="1"`); `slideSteps(slide).steps` says how many clicks a slide has.
  `transitionCss(slide.transition)` gives the CSS animations for the incoming (`in`) and outgoing (`out`) slide.
  Animation and transition `direction` is the way the motion goes (fly-in "up" rises from below; push "left" brings
  the new slide in from the right).
- `renderSlideDocument` is a full HTML page of one slide (for screenshots); `renderDeckHtml` is the whole deck as a
  player (arrow keys, clicks, steps, transitions, `window.SiliconPresent.go(i, step)`) or as print pages
  (`mode: "print"`, for PDF), optionally with the deck JSON and assets embedded (HTML export).

HTML elements run in `<iframe sandbox="allow-scripts" srcdoc=...>`: no `allow-same-origin`, so they get an opaque
origin and can't read the viewer's cookies or storage, reach the page around them, navigate it or open popups; they
can load anything from the internet. All other deck content is escaped; colours, fonts and URLs are filtered
(`javascript:` and friends never reach the page).

## Consuming it

TypeScript source, no build step (same as `@silicon-present/deck`): in Next.js add both packages to
`transpilePackages`; in Node run through `tsx`.

## Tests

```
pnpm --filter @silicon-present/render test     # unit + Chromium tests (sandbox, player)
pnpm --filter @silicon-present/render visual [outDir] [nameFilter]   # PNGs of every sample deck to look at
```
