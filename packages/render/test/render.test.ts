import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDeck, THEMES } from "@silicon-present/deck";
import type { DeckJson } from "@silicon-present/deck";
import { renderSlideHtml, renderSlideDocument, renderDeckHtml, slideSteps, transitionCss, scaleToFit, fontCss, shapeGeometry, niceScale, DECK_JSON_ID, SLIDE_CSS } from "../src/index";
import { contractDecks } from "./samples";

const every = () => contractDecks()["every-element"]!;

function evil(): DeckJson {
  return normalizeDeck({
    theme: { ...THEMES[0]!, fonts: { heading: 'x";}</style><script>alert(1)</script>', body: "Inter" } },
    slides: [
      {
        id: "s_aaaaaa",
        background: { image: 'javascript:alert(1)")', fit: "cover" },
        elements: [
          { kind: "text", text: { paragraphs: [{ runs: [{ text: "<script>alert(1)</script>", color: "red;background:url(javascript:alert(1))", font: "a'</style>", link: "javascript:alert(1)" }] }] } },
          { kind: "image", src: "javascript:alert(1)", alt: '"><img src=x onerror=alert(1)>' },
          { kind: "shape", shape: "rect", style: { fill: '"/><script>alert(1)</script>' }, link: "javascript:alert(2)" },
          { kind: "html", html: "<script>parent.document.cookie</script>", css: "", js: "</script><script>alert(1)" },
          { kind: "chart", chart: { type: "bar", title: "<b>t</b>", labels: ["<i>"], series: [{ name: "<s>", values: [1], color: "url(x)" }] } },
        ],
      },
    ],
  });
}

test("untrusted deck content never becomes markup or script in the viewer's page", () => {
  const html = renderSlideHtml(evil(), "s_aaaaaa");
  // the only <script> allowed is inside the escaped srcdoc of the sandboxed iframe
  const outsideIframes = html.replace(/srcdoc="[^"]*"/g, 'srcdoc=""');
  assert.ok(!/<script/i.test(outsideIframes), "no script tags outside the iframe");
  assert.ok(!/javascript:/i.test(outsideIframes), "no javascript: urls");
  assert.ok(!/onerror=/i.test(outsideIframes.replace(/&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/, "")), "no event handlers");
  assert.ok(!outsideIframes.includes("</style><script"), "fonts can't close the style");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("HTML elements run in an iframe sandboxed to scripts only (never same-origin)", () => {
  const html = renderSlideHtml(every(), "s_000003");
  const iframes = html.match(/<iframe[^>]*>/g) ?? [];
  assert.equal(iframes.length, 1);
  for (const f of iframes) {
    assert.match(f, /sandbox="allow-scripts"/);
    assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/.test(f));
    assert.match(f, /srcdoc="/);
  }
  const stat = renderSlideHtml(every(), "s_000003", { html: "static" });
  assert.ok(!stat.includes("<iframe"));
});

test("master elements sit under slide elements unless hideMaster", () => {
  const d = every();
  const s1 = renderSlideHtml(d, "s_000001");
  const masterId = d.master.elements[0]!.id;
  const slideEl = d.slides[0]!.elements[0]!.id;
  assert.ok(s1.indexOf(`data-sp-id="${masterId}"`) < s1.indexOf(`data-sp-id="${slideEl}"`));
  const s2 = renderSlideHtml(d, "s_000002");
  assert.ok(!s2.includes(`data-sp-id="${masterId}"`), "slide 2 hides the master");
});

test("assets resolve through assetUrl; default is the web API path", () => {
  const d = every();
  assert.match(renderSlideHtml(d, "s_000002"), /\/api\/v1\/assets\/Img1aaaaaaaa/);
  const html = renderSlideHtml(d, "s_000002", { assetUrl: (id) => `https://conv.local/a/${id}?sig=1` });
  assert.match(html, /https:\/\/conv\.local\/a\/Img1aaaaaaaa\?sig=1/);
  assert.match(html, /poster="https:\/\/conv\.local\/a\/Img1aaaaaaaa/);
  assert.match(fontCss(d, { assetUrl: (id) => `/f/${id}` }), /@font-face\{font-family:"Brand Sans";src:url\("\/f\/7Fq2mP9xRtA1"\)/);
});

test("click-steps: click starts a step, with/after-previous chain, step option hides later steps", () => {
  const s = every().slides[1]!;
  const { steps, elements } = slideSteps(s);
  assert.equal(steps, 3); // fly-in (click), zoom (with-previous), rise (after-previous), wipe (click), appear (click)
  const ids = s.elements.map((e) => e.id);
  assert.equal(elements.get(ids[0]!)!.step, 1);
  assert.equal(elements.get(ids[1]!)!.step, 1);
  assert.equal(elements.get(ids[1]!)!.delay, 100); // with-previous starts with the fly-in (delay 100)
  assert.equal(elements.get(ids[2]!)!.delay, 100 + 600 + 200); // after-previous: after zoom (starts 100, lasts 400)... longest chain
  assert.equal(elements.get(ids[4]!)!.step, 2);
  assert.equal(elements.get(ids[5]!)!.step, 3);
  const at1 = renderSlideHtml(every(), "s_000002", { step: 1, animate: true });
  assert.match(at1, /data-sp-at="1"/);
  assert.match(at1, /data-sp-animate="1"/);
  assert.match(at1, /\[data-sp-at="1"\] \.sp-el\[data-sp-step="2"\]/);
  assert.match(renderSlideHtml(every(), "s_000002"), /data-sp-at="all"/);
});

test("transitions map to CSS animations", () => {
  assert.equal(transitionCss(null), null);
  assert.match(transitionCss({ type: "push", duration: 600, direction: "left" })!.in, /sp-tr-push-left-in 600ms/);
  assert.match(transitionCss({ type: "push", duration: 600, direction: "left" })!.out, /sp-tr-push-left-out/);
  assert.equal(transitionCss({ type: "fade", duration: 400 })!.out, "");
  for (const t of ["fade", "push", "wipe", "zoom", "cover"] as const) {
    const css = transitionCss({ type: t, duration: 300, direction: "up" })!;
    const name = css.in.split(" ")[0]!;
    assert.ok(SLIDE_CSS.includes(`@keyframes ${name} `), `${name} keyframes exist`);
  }
});

test("documents and deck HTML", () => {
  const d = every();
  const doc = renderSlideDocument(d, "s_000001");
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /width:1920px;height:1080px/);
  const deckHtml = renderDeckHtml({ ...d, title: "</script><b>" }, { embedDeck: true });
  const m = new RegExp(`<script type="application/json" id="${DECK_JSON_ID}">([^<]*)</script>`).exec(deckHtml);
  assert.ok(m, "deck JSON embedded without a raw <");
  assert.deepEqual(JSON.parse(m![1]!), { ...d, title: "</script><b>" });
  // skipped slide 3 is left out of the player unless asked
  assert.equal((deckHtml.match(/class="sp-frame"/g) ?? []).length, 4);
  assert.equal((renderDeckHtml(d, { includeSkipped: true }).match(/class="sp-frame"/g) ?? []).length, 5);
  const print = renderDeckHtml(d, { mode: "print" });
  assert.equal((print.match(/class="sp-page"/g) ?? []).length, 4);
  assert.ok(!print.includes("SiliconPresent"));
  const withAssets = renderDeckHtml(d, { assets: { Img1aaaaaaaa: { filename: "a.png", contentType: "image/png", data: "AAAA" } } });
  assert.match(withAssets, /src="sp-asset:Img1aaaaaaaa"/);
});

test("scaleToFit and geometry helpers", () => {
  assert.deepEqual(scaleToFit(960, 1000), { scale: 0.5, width: 960, height: 540, offsetX: 0, offsetY: 230 });
  for (const s of ["rect", "round-rect", "ellipse", "triangle", "right-triangle", "diamond", "pentagon", "hexagon", "octagon", "star", "arrow-right", "arrow-left", "arrow-up", "arrow-down", "chevron", "line", "callout", "heart", "cloud", "plus"]) {
    const g = shapeGeometry(s, 300, 200);
    assert.ok(g.d.startsWith("M") && !g.d.includes("NaN"), s);
  }
  assert.deepEqual(niceScale(0, 26).values, [0, 10, 20, 30]);
});

test("every contract deck renders every slide", () => {
  for (const deck of Object.values(contractDecks())) for (const s of deck.slides) assert.ok(renderSlideHtml(deck, s.id).length > 100);
  assert.throws(() => renderSlideHtml(every(), "s_nope00"), /no slide s_nope00/);
});
