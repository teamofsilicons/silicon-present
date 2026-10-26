// Opening HTML pages that hold slides, through the running converter: Claude-Design-style decks (test/fixtures/
// claude-deck.html), reveal.js markup, plain pages (one live HTML element) and Present's own HTML export.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { THEMES, normalizeDeck } from "@silicon-present/deck";
import type { DeckJson, Element, HtmlElement, ImageElement, ShapeElement, TableElement, TextElement } from "@silicon-present/deck";
import { htmlElementDoc, renderDeckHtml } from "@silicon-present/render";
import { type Converter, fixture, importThrough, plain, startConverter } from "./helpers";

let c: Converter;
before(async () => {
  c = await startConverter();
});
after(async () => {
  await c.stop();
});

const near = (a: number, b: number, tol = 3) => Math.abs(a - b) <= tol;
const box = (e: Element, x: number, y: number, w: number, h: number, tol = 3) =>
  assert.ok(near(e.x, x, tol) && near(e.y, y, tol) && near(e.w, w, tol) && near(e.h, h, tol), `${e.kind} at ${[e.x, e.y, e.w, e.h]}, expected about ${[x, y, w, h]}`);
const texts = (els: Element[]) => els.filter((e): e is TextElement => e.kind === "text");
const byText = (els: Element[], s: string) => texts(els).find((e) => plain(e.text).includes(s))!;
const html = (s: string) => Buffer.from(s, "utf8");

let deck: Awaited<ReturnType<typeof importThrough>>;
async function claudeDeck() {
  deck ??= await importThrough(c, "claude-deck.html");
  return deck;
}

test("html deck: every slide of a Claude-Design-style page, in order, with title, notes and backgrounds", async () => {
  const r = await claudeDeck();
  assert.equal(r.status, 200);
  const d = r.deck;
  assert.equal(d.title, "Quarterly Review");
  assert.deepEqual(d.size, { width: 1920, height: 1080 });
  assert.equal(d.slides.length, 5);
  assert.deepEqual(d.slides.map((s) => texts(s.elements).map((e) => plain(e.text))[0]), ["Quarterly Review", "Highlights", "By region", "Try it", "Thank you"]);
  assert.deepEqual(d.slides[0]!.background, { color: "#101828" });
  assert.deepEqual(d.slides[1]!.background, { color: "#faf7f2" });
  assert.equal(d.slides[0]!.notes, "Welcome everyone. Start with the headline numbers.");
  assert.equal(d.theme.fonts.body, "Arial");
  assert.match(r.notes[0]!, /5 slides.*deck-stage/);
});

test("html deck: text keeps its runs, styles and place", async () => {
  const s1 = (await claudeDeck()).deck.slides[0]!;
  const title = byText(s1.elements, "Quarterly");
  box(title, 140, 120, title.w, 126); // h1: 120px font, line-height 1.05
  assert.ok(title.w >= 1000);
  assert.deepEqual(title.text.paragraphs[0]!.runs, [
    { text: "Quarterly ", bold: true, color: "#f5f5f5", size: 120, font: "Arial" },
    { text: "Review", bold: true, color: "#e8590c", size: 120, font: "Arial" },
  ]);
  const lede = byText(s1.elements, "Revenue grew");
  assert.ok(near(lede.x, 140) && near(lede.y, 285.7) && near(lede.h, 123.2), `lede at ${[lede.x, lede.y, lede.h]}`);
  const runs = lede.text.paragraphs[0]!.runs;
  const run = (t: string) => runs.find((x) => x.text === t)!;
  assert.equal(plain(lede.text), "Revenue grew 42%, churn fell to 1.8%, and we shipped the new editor.");
  assert.equal(run("42%").bold, true);
  assert.equal(run("1.8%").italic, true);
  assert.equal(run("shipped").underline, true);
  assert.equal(run("editor").color, "#7cd4fd");
  assert.equal(run("42%").size, 44);
  // centred heading keeps its alignment and stays centred on the slide
  const s3 = (await claudeDeck()).deck.slides[2]!;
  const centred = byText(s3.elements, "By region");
  assert.equal(centred.text.paragraphs[0]!.align, "center");
  assert.ok(near(centred.x + centred.w / 2, 960), "centred on the slide");
});

test("html deck: lists become list paragraphs", async () => {
  const s2 = (await claudeDeck()).deck.slides[1]!;
  const list = byText(s2.elements, "Two new regions");
  assert.deepEqual(list.text.paragraphs.map((p) => [p.list, plain({ paragraphs: [p] })]), [
    ["bullet", "Two new regions live"],
    ["bullet", "Support replies in under an hour"],
  ]);
  // the item text starts where the page put it (ul padding 60px), the marker gutter before it
  assert.ok(near(list.x + 1.1 * 40, 200), `list x ${list.x}`);
  assert.equal(list.text.paragraphs[1]!.runs[1]!.bold, true);
});

test("html deck: pictures become image assets, boxes become shapes", async () => {
  const r = await claudeDeck();
  const [s1, s2] = r.deck.slides;
  const img = s1!.elements.find((e): e is ImageElement => e.kind === "image")!;
  box(img, 1220, 120, 560, 315);
  assert.equal(img.fit, "cover");
  assert.equal(img.style.radius, 24);
  const asset = r.assets.find((a) => `asset:${a.key}` === img.src)!;
  assert.equal(asset.contentType, "image/png");
  assert.equal(Buffer.from(asset.data, "base64").readUInt32BE(16), 800);
  const bar = s1!.elements.find((e): e is ShapeElement => e.kind === "shape")!;
  box(bar, 0, 1056, 1920, 24);
  assert.equal(bar.style.fill, "#e8590c");
  const cards = s2!.elements.filter((e): e is ShapeElement => e.kind === "shape" && e.shape === "rect");
  assert.equal(cards.length, 2);
  // a 4px border sits inside the 480 x 300 box; a shape's stroke is centred on its outline
  box(cards[0]!, 142, 412, 476, 296);
  box(cards[1]!, 670, 412, 476, 296);
  assert.deepEqual(cards[0]!.style, { fill: "#ffffff", stroke: "#d0d5dd", strokeWidth: 4, radius: 32 });
  const growth = byText(s2!.elements, "Growth");
  assert.ok(near(growth.x, 184) && growth.y > 412 && growth.y < 470, "card text inside its card");
  const dot = s2!.elements.find((e): e is ShapeElement => e.kind === "shape" && e.shape === "ellipse")!;
  box(dot, 1640, 760, 160, 160);
  // text is drawn over its card
  assert.ok(s2!.elements.indexOf(growth) > s2!.elements.indexOf(cards[0]!));
});

test("html deck: tables become table elements", async () => {
  const s3 = (await claudeDeck()).deck.slides[2]!;
  const t = s3.elements.find((e): e is TableElement => e.kind === "table")!;
  box(t, 140, 250, 1200, 284);
  assert.equal(t.rows, 3);
  assert.equal(t.cols, 3);
  assert.ok(near(t.colWidths.reduce((a, b) => a + b, 0), 1200));
  assert.deepEqual(t.cells.map((row) => row.map((cell) => plain(cell.text))), [["Region", "Revenue", "Growth"], ["Europe", "$4.2M", "+38%"], ["Americas", "$6.9M", "+44%"]]);
  assert.equal(t.headerRow, true);
  assert.equal(t.cells[0]![0]!.fill, "#1d2939");
  assert.equal(t.cells[1]![2]!.fill, "#d1fadf");
  assert.equal(t.cells[1]![0]!.fill, null);
  assert.equal(t.cells[0]![0]!.text.paragraphs[0]!.runs[0]!.bold, true);
  assert.equal(t.cells[0]![0]!.text.paragraphs[0]!.runs[0]!.color, "#ffffff");
  assert.equal(t.style.stroke, "#98a2b3");
  assert.equal(t.style.strokeWidth, 2);
});

test("html deck: canvas game, looping animation, SVG and gradient stay live HTML over exactly their part", async () => {
  const r = await claudeDeck();
  const s4 = r.deck.slides[3]!;
  const live = s4.elements.filter((e): e is HtmlElement => e.kind === "html");
  assert.equal(live.length, 3);
  const game = live.find((e) => e.html.includes("<canvas"))!;
  // the canvas and the score it updates are one widget, with the script that drives them
  box(game, 140, 300, 900, 600);
  assert.match(game.html, /id="score"/);
  assert.match(game.html, /getContext\("2d"\)/);
  assert.doesNotMatch(game.html, /customElements\.define/, "the deck's own script stays out");
  const spin = live.find((e) => /class="spin"/.test(e.html))!;
  box(spin, 1520, 360, 200, 200);
  assert.match(spin.css, /@keyframes spin/);
  assert.match(spin.css, /border-right-color:\s*rgb\(232, 89, 12\)/, "var() borders survive");
  const svg = live.find((e) => e.html.includes("<svg"))!;
  box(svg, 1440, 640, 320, 200);
  // nothing on the slide was dropped: the heading is still native text
  assert.equal(texts(s4.elements).length, 1);
  const s5 = r.deck.slides[4]!;
  const bg = s5.elements[0] as HtmlElement;
  assert.equal(bg.kind, "html");
  box(bg, 0, 0, 1920, 1080);
  assert.match(bg.html, /linear-gradient/);
  assert.equal(byText(s5.elements, "Thank you").text.paragraphs[0]!.runs[0]!.color, "#ffffff");
  assert.ok(r.notes.some((n) => /^Slide 4: .*scripted widget.*looping animation.*SVG drawing.* stayed live HTML\.$/.test(n)), r.notes.join("\n"));
  assert.ok(r.notes.some((n) => /^Slide 5: a gradient .* stayed live HTML\.$/.test(n)));
});

test("html deck: the game still runs and plays inside its HTML element", async () => {
  const game = (await claudeDeck()).deck.slides[3]!.elements.find((e): e is HtmlElement => e.kind === "html" && e.html.includes("<canvas"))!;
  const b = await chromium.launch();
  try {
    const page = await b.newPage({ viewport: { width: game.w, height: game.h } });
    await page.setContent(htmlElementDoc(game, THEMES[0]!));
    await page.waitForTimeout(300);
    // the ball is drawn (orange pixels on the dark board) and moves
    const ball = () => page.evaluate(() => {
      const cv = document.getElementById("board") as HTMLCanvasElement;
      const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i]! > 200 && d[i + 1]! < 120) return i;
      return -1;
    });
    const a = await ball();
    await page.waitForTimeout(200);
    assert.ok(a >= 0, "the canvas draws");
    assert.notEqual(await ball(), a, "it animates");
    await page.mouse.click(450, 200);
    assert.equal(await page.textContent("#score"), "1", "clicks reach the script");
  } finally {
    await b.close();
  }
});

test("html deck: assets referenced are returned", async () => {
  const r = await claudeDeck();
  const keys = new Set(r.assets.map((a) => a.key));
  for (const m of JSON.stringify(r.deck).matchAll(/"asset:([A-Za-z0-9_-]+)"/g)) assert.ok(keys.has(m[1]!), `asset ${m[1]} returned`);
});

test("html deck: reveal.js markup (nested sections, fragments, notes, backgrounds, scaled to 1920)", async () => {
  const page = `<!doctype html><html><head><title>Reveal style</title><style>
    body{margin:0;font-family:Georgia, serif}
    .reveal .slides section{width:960px;height:700px;position:relative;box-sizing:border-box;padding:40px;background:#fff}
    h2{font-size:48px;margin:0 0 20px;line-height:1.2} p{font-size:24px;margin:0 0 10px;line-height:1.5}
    .fragment{opacity:0}.fragment.visible{opacity:1}</style></head><body><div class="reveal"><div class="slides">
    <section><h2>One</h2><p class="fragment" data-fragment-index="1">First point</p><p class="fragment" data-fragment-index="2">Second point</p><aside class="notes">Say one.</aside></section>
    <section><section><h2>Two A</h2></section><section data-background-color="#222222"><h2 style="color:#fff">Two B</h2></section></section>
    </div></div></body></html>`;
  const r = await importThrough(c, "reveal.html", html(page));
  assert.equal(r.status, 200);
  assert.deepEqual(r.deck.size, { width: 1920, height: 1400 });
  assert.deepEqual(r.deck.slides.map((s) => plain((s.elements[0] as TextElement).text)), ["One", "Two A", "Two B"]);
  const [s1, , s3] = r.deck.slides;
  assert.equal(s1!.notes, "Say one.");
  assert.deepEqual(s3!.background, { color: "#222222" });
  const h2 = s1!.elements[0] as TextElement;
  box(h2, 80, 80, h2.w, 115.2); // padding 40 and a 57.6px line, doubled
  assert.equal(h2.text.paragraphs[0]!.runs[0]!.size, 96);
  assert.equal(h2.text.paragraphs[0]!.runs[0]!.font, "Georgia");
  const [first, second] = [byText(s1!.elements, "First"), byText(s1!.elements, "Second")];
  assert.deepEqual([first.animation?.trigger, first.animation?.order, second.animation?.order], ["click", 1, 2]);
  assert.ok(near(second.y - first.y, (36 + 10) * 2));
});

test("html deck: slides stacked as same-size pages", async () => {
  const page = `<!doctype html><html><body style="margin:0;background:#ddd">
    <div class="page" style="width:1600px;height:900px;margin:20px;position:relative;background:#fff"><h1 style="margin:0;position:absolute;left:100px;top:100px;font:700 80px Arial">First page</h1></div>
    <div class="page" style="width:1600px;height:900px;margin:20px;position:relative;background:#fef3c7"><h1 style="margin:0;position:absolute;left:100px;top:100px;font:700 80px Arial">Second page</h1></div>
    </body></html>`;
  const r = await importThrough(c, "pages.html", html(page));
  assert.deepEqual(r.deck.slides.map((s) => plain((s.elements[0] as TextElement).text)), ["First page", "Second page"]);
  assert.deepEqual(r.deck.slides[1]!.background, { color: "#fef3c7" });
  const t = r.deck.slides[1]!.elements[0] as TextElement;
  // 1600 wide -> 1920 wide: everything x1.2
  assert.ok(near(t.x, 120) && near(t.y, 120), `at ${[t.x, t.y]}`);
  assert.equal(t.text.paragraphs[0]!.runs[0]!.size, 96);
});

test("html: a plain page without slides stays one full-slide live HTML element", async () => {
  const r = await importThrough(c, "page.html");
  assert.equal(r.deck.slides.length, 1);
  const e = r.deck.slides[0]!.elements[0]! as HtmlElement;
  assert.equal(e.kind, "html");
  assert.deepEqual([e.x, e.y, e.w, e.h], [0, 0, 1920, 1080]);
  assert.match(e.html, /setInterval/);
  assert.deepEqual(r.notes, []);
});

test("html: a page whose script never stops falls back to one live element and says why", async () => {
  const page = `<!doctype html><html><head><title>Stuck</title></head><body><div class="slide">Hello</div><script>while (true) {}</script></body></html>`;
  const r = await importThrough(c, "stuck.html", html(page));
  assert.equal(r.status, 200);
  assert.equal(r.deck.slides.length, 1);
  assert.equal(r.deck.slides[0]!.elements[0]!.kind, "html");
  assert.match(r.notes.join(" "), /could not be measured.*one live HTML element/);
});

test("html: Present's own HTML export (embedded deck JSON) opens exactly", async () => {
  const src: DeckJson = normalizeDeck({
    title: "Round trip",
    theme: THEMES[1],
    slides: [
      { id: "s_aaaaaa", layout: "title", notes: "hi", elements: [{ id: "e_aaaaaa", kind: "text", x: 100, y: 100, w: 800, h: 200, text: { paragraphs: [{ runs: [{ text: "Hello", bold: true }] }] } }] },
      { id: "s_bbbbbb", layout: "blank", elements: [{ id: "e_bbbbbb", kind: "image", x: 0, y: 0, w: 400, h: 225, src: "asset:Img1aaaaaaaa", alt: "", fit: "cover" }] },
    ],
  });
  const page = renderDeckHtml(src, { embedDeck: true, assets: { Img1aaaaaaaa: { filename: "picture.png", contentType: "image/png", data: fixture("picture.png").toString("base64") } } });
  const r = await importThrough(c, "export.html", html(page));
  assert.equal(r.status, 200);
  assert.deepEqual(r.deck.slides.map((s) => s.id), ["s_aaaaaa", "s_bbbbbb"]);
  assert.deepEqual(r.deck.slides[0]!.elements, src.slides[0]!.elements);
  assert.equal(r.deck.theme.name, THEMES[1]!.name);
  assert.deepEqual(r.assets.map((a) => [a.key, a.contentType]), [["Img1aaaaaaaa", "image/png"]]);
  assert.deepEqual(r.notes, []);
});
