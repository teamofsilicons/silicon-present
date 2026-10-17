// Every export through the running converter, and round trips back through the importer:
//   deck -> pptx -> deck keeps text, positions, tables, charts (within a pixel or two);
//   deck -> html -> deck is exact; odp/ppt/key come back with their slides and text.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { chromium, type Browser } from "playwright";
import { normalizeDeck } from "@silicon-present/deck";
import type { ChartElement, DeckJson, Element, ShapeElement, TableElement, TextElement } from "@silicon-present/deck";
import { HAVE } from "../src/config";
import { type Converter, ASSET_FILES, deckText, exportDeck, fixture, importThrough, jpgSize, plain, pngSize, startAssetServer, startConverter } from "./helpers";

let c: Converter;
let assets: Awaited<ReturnType<typeof startAssetServer>>;
let browser: Browser;
const tmp = mkdtempSync(join(tmpdir(), "sp-export-test-"));

before(async () => {
  [c, assets, browser] = await Promise.all([startConverter(), startAssetServer(), chromium.launch()]);
});
after(async () => {
  await Promise.all([c.stop(), browser.close()]);
  assets.server.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function exportAs(format: string, extra: Record<string, unknown> = {}, deck: DeckJson = exportDeck()) {
  const r = await c.post("/export", { deck, format, assetBase: assets.base, ...extra });
  const data = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get("content-type") ?? "", ext: r.headers.get("x-export-extension"), warnings: decodeURIComponent(r.headers.get("x-converter-warnings") ?? ""), data };
}

/** Colour of one pixel of a PNG/JPEG, read through Chromium. */
async function pixel(img: Buffer, type: string, x: number, y: number): Promise<[number, number, number]> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async ({ url, x, y }) => {
        const im = new Image();
        im.src = url;
        await im.decode();
        const cv = document.createElement("canvas");
        cv.width = im.naturalWidth;
        cv.height = im.naturalHeight;
        const g = cv.getContext("2d")!;
        g.drawImage(im, 0, 0);
        const d = g.getImageData(x, y, 1, 1).data;
        return [d[0]!, d[1]!, d[2]!] as [number, number, number];
      },
      { url: `data:${type};base64,${img.toString("base64")}`, x, y },
    );
  } finally {
    await page.close();
  }
}

const close = (a: number[], b: number[], tol = 24) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const hexRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// ---------------------------------------------------------------- the sidecar itself

test("health is open; everything else needs the secret", async () => {
  const h = await fetch(c.url + "/health");
  assert.equal(h.status, 200);
  assert.equal(((await h.json()) as { ok: boolean }).ok, true);
  for (const secret of [null, "wrong"]) {
    const r = await c.post("/render", { deck: exportDeck(), slide: "s_000001" }, { secret });
    assert.equal(r.status, 401);
    const body = (await r.json()) as { error: { code: string; message: string; hint: string } };
    assert.equal(body.error.code, "unauthorized");
    assert.ok(body.error.hint.includes("X-Converter-Secret"));
  }
});

test("errors say what happened and what to do", async () => {
  const slide = await c.post("/render", { deck: exportDeck(), slide: "s_nope00", assetBase: assets.base });
  assert.equal(slide.status, 404);
  assert.equal(((await slide.json()) as { error: { code: string } }).error.code, "slide_not_found");
  const fmt = await c.post("/export", { deck: exportDeck(), format: "docx" });
  assert.equal(fmt.status, 400);
  const body = (await fmt.json()) as { error: { code: string; hint: string } };
  assert.equal(body.error.code, "unsupported_format");
  assert.match(body.error.hint, /pptx/);
  const notJson = await fetch(c.url + "/export", { method: "POST", headers: { "x-converter-secret": c.secret }, body: "{" });
  assert.equal(notJson.status, 400);
});

// ---------------------------------------------------------------- images and pdf

test("render: one slide as PNG or JPG at the asked width, HTML elements running", async () => {
  const deck = exportDeck();
  deck.slides[2]!.skipped = false;
  const r = await c.post("/render", { deck, slide: "s_000003", width: 960, format: "png", assetBase: assets.base });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  const png = Buffer.from(await r.arrayBuffer());
  assert.deepEqual(pngSize(png), { width: 960, height: 540 });
  // the HTML element's script painted its canvas (#3b6e8f) inside the element (x 100..1000, y 560..980 at 1920)
  const html = deck.slides[2]!.elements.find((e) => e.kind === "html")!;
  let painted = false;
  for (let y = html.y + 60; y < html.y + 220 && !painted; y += 10) painted = close(await pixel(png, "image/png", Math.round((html.x + 60) / 2), Math.round(y / 2)), hexRgb("#3b6e8f"), 30);
  assert.ok(painted, "the HTML element's JS ran before the picture was taken");
  const j = await c.post("/render", { deck, slide: "s_000001", format: "jpg", assetBase: assets.base });
  assert.equal(j.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(jpgSize(Buffer.from(await j.arrayBuffer())), { width: 1920, height: 1080 });
});

test("pdf: one page per slide that isn't skipped, at the deck's size, with real text", async () => {
  const r = await exportAs("pdf");
  assert.equal(r.status, 200);
  assert.equal(r.type, "application/pdf");
  const file = join(tmp, "deck.pdf");
  writeFileSync(file, r.data);
  const info = execFileSync("/opt/homebrew/bin/pdfinfo", [file]).toString();
  assert.match(info, /Pages:\s+4/);
  assert.match(info, /Page size:\s+1440 x 810 pts/);
  const text = execFileSync("/opt/homebrew/bin/pdftotext", [file, "-"]).toString();
  for (const t of ["Every inline attribute", "Right aligned heading 3", "An indented bullet", "Silicon Present"]) assert.ok(text.includes(t), t);
  assert.ok(!text.includes("Region"), "the skipped slide (table) is left out");
});

test("png/jpg: a zip of every slide, or one slide", async () => {
  const z = await exportAs("png");
  assert.equal(z.type, "application/zip");
  assert.equal(z.ext, "zip");
  const zip = await JSZip.loadAsync(z.data);
  const names = Object.keys(zip.files).sort();
  assert.deepEqual(names, ["slide-01.png", "slide-02.png", "slide-03.png", "slide-04.png"]);
  const first = await zip.file("slide-01.png")!.async("nodebuffer");
  assert.deepEqual(pngSize(first), { width: 1920, height: 1080 });
  // slide 1's text box fill (#f4f4f5) under the text
  assert.ok(close(await pixel(first, "image/png", 1700, 900), [244, 244, 245], 12));
  const one = await exportAs("jpg", { slide: "s_000002", width: 640 });
  assert.equal(one.type, "image/jpeg");
  assert.deepEqual(jpgSize(one.data), { width: 640, height: 360 });
  // the rotated green round-rect on slide 2 (right of its centred text)
  assert.ok(close(await pixel(one.data, "image/jpeg", Math.round(520 / 3), Math.round(265 / 3)), hexRgb("#2f6b4f"), 30));
});

// ---------------------------------------------------------------- html

test("html: one self-contained file that plays the deck and opens back exactly", async () => {
  const deck = exportDeck();
  const r = await exportAs("html", {}, deck);
  assert.equal(r.status, 200);
  const html = r.data.toString("utf8");
  assert.ok(!html.includes("127.0.0.1"), "no asset URLs: everything is inside the file");
  // plays: arrow keys move through steps and slides, HTML elements run
  const file = join(tmp, "deck.html");
  writeFileSync(file, html);
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("requestfailed", (q) => errors.push(`request failed: ${q.url().slice(0, 60)}`));
  await page.goto("file://" + file);
  const state = () => page.evaluate(() => [(window as any).SiliconPresent.index, (window as any).SiliconPresent.step]);
  assert.deepEqual(await state(), [0, 0]);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  assert.deepEqual(await state(), [1, 0]);
  const imgOk = await page.evaluate(() => Array.from(document.querySelectorAll(".sp-frame")[1]!.querySelectorAll("img")).every((i) => i.complete && i.naturalWidth > 0));
  assert.ok(imgOk, "embedded pictures load");
  assert.deepEqual(errors, []);
  await page.close();
  // and opens back exactly, with the same asset bytes
  const back = await importThrough(c, "deck.html", r.data);
  assert.deepEqual(back.deck, normalizeDeck(deck));
  for (const [id, [file2]] of Object.entries(ASSET_FILES)) {
    const a = back.assets.find((x) => x.key === id)!;
    assert.deepEqual(Buffer.from(a.data, "base64"), fixture(file2), `asset ${id}`);
  }
});

// ---------------------------------------------------------------- pptx

const byId = (d: DeckJson) => new Map(d.slides.flatMap((s) => s.elements.map((e) => [e.id, e] as const)));
const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

test("pptx: native objects, notes, sections, hidden slides, transitions, groups", async () => {
  const r = await exportAs("pptx");
  assert.equal(r.status, 200);
  const zip = await JSZip.loadAsync(r.data);
  const files = Object.keys(zip.files);
  assert.equal(files.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length, 5);
  const slide = (n: number) => zip.file(`ppt/slides/slide${n}.xml`)!.async("string");
  assert.match(await slide(3), /<p:sld show="0"/);
  assert.match(await slide(2), /<p:push dir="l"\/>/);
  assert.match(await slide(1), /p14:dur="400"><p:fade\/>/);
  assert.match(await slide(2), /<p:grpSp>/, "the two grouped shapes are a group");
  assert.match(await slide(3), /<a:tbl>/);
  assert.ok(files.some((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f)), "a native chart");
  assert.ok(files.some((f) => /^ppt\/media\/.*\.mp4$/.test(f)), "the webm video went in as mp4");
  assert.ok(files.some((f) => /^ppt\/notesSlides\//.test(f)));
  assert.match(await zip.file("ppt/presentation.xml")!.async("string"), /p14:section name="Appendix"/);
  for (const f of files.filter((x) => x.endsWith(".xml") || x.endsWith(".rels"))) assert.ok(!(await zip.file(f)!.async("string")).includes("undefined"), `${f} has no undefined`);
});

test("pptx round trip: text, positions, tables, charts, notes, master, groups survive", async () => {
  const orig = exportDeck();
  const r = await exportAs("pptx", {}, orig);
  const back = (await importThrough(c, "deck.pptx", r.data)).deck;
  assert.equal(back.slides.length, orig.slides.length);
  assert.deepEqual(back.slides.map((s) => s.skipped), orig.slides.map((s) => s.skipped));
  assert.deepEqual(back.slides.map((s) => s.notes), orig.slides.map((s) => s.notes));
  assert.deepEqual(back.slides.map((s) => s.section), ["Intro", null, null, "Appendix", null]);
  assert.deepEqual(back.slides.map((s) => s.transition), orig.slides.map((s) => s.transition));
  assert.deepEqual(back.slides.map((s) => s.hideMaster), orig.slides.map((s) => s.hideMaster));
  assert.deepEqual(back.master.elements.map((e) => e.id), orig.master.elements.map((e) => e.id), "the master comes back as the master");
  assert.equal(back.theme.name, orig.theme.name);
  assert.deepEqual(back.theme.colors, orig.theme.colors);
  assert.deepEqual(back.theme.fonts, orig.theme.fonts);
  assert.deepEqual(back.slides.map((s) => s.id), orig.slides.map((s) => s.id), "slide ids ride along as slide names");
  const got = byId(back);
  for (const s of orig.slides) {
    for (const e of s.elements) {
      const b = got.get(e.id);
      if (e.kind === "image" && !e.src) continue; // an empty image placeholder has nothing to export
      if (e.kind === "image" && e.fit === "contain") continue; // placed as its contained picture: checked by eye
      assert.ok(b, `${e.kind} ${e.id} on ${s.id} came back`);
      if (e.kind === "html") {
        assert.equal(b!.kind, "image", "an HTML element becomes a picture of itself");
      } else if (e.kind !== "shape" || e.shape !== "line") {
        assert.ok(near(b!.x, e.x) && near(b!.y, e.y) && near(b!.w, e.w) && near(b!.h, e.h), `${e.id} geometry ${[b!.x, b!.y, b!.w, b!.h]} vs ${[e.x, e.y, e.w, e.h]}`);
        assert.ok(near(b!.rotation, e.rotation, 0.5));
      }
      if (e.kind === "text" || e.kind === "shape") {
        assert.equal(b!.kind, e.kind, `${e.id} kind`);
        const bt = (b as TextElement).text;
        assert.equal(plain(bt), plain(e.text), `${e.id} text`);
        e.text.paragraphs.forEach((p, i) => {
          const bp = bt.paragraphs[i]!;
          assert.equal(bp.list, p.list, `${e.id} p${i} list`);
          assert.equal(bp.indent ?? 0, p.indent ?? 0, `${e.id} p${i} indent`);
          assert.equal(bp.align ?? (e.kind === "shape" ? "center" : "left"), p.align ?? (e.kind === "shape" ? "center" : "left"), `${e.id} p${i} align`);
          // inline formatting survives run by run (code becomes a monospace font in PowerPoint)
          // compared character by character, since runs with equal formatting merge
          const flags = (rr: Record<string, unknown>) => ["bold", "italic", "underline", "strike", "highlight", "link"].map((k) => (k === "bold" && p.heading ? null : k === "underline" && rr.link ? null : (rr[k] ?? null))).join(",");
          const perChar = (runs: Array<Record<string, unknown>>) => runs.flatMap((x) => [...String(x.text)].filter((ch) => ch.trim()).map(() => flags(x)));
          assert.deepEqual(perChar(bp.runs as never), perChar(p.runs as never), `${e.id} p${i} runs`);
        });
        if (e.kind === "shape") assert.equal((b as ShapeElement).shape, e.shape);
        if (e.style.fill) assert.equal(b!.style.fill?.slice(0, 7), e.style.fill);
      }
      if (e.kind === "table") {
        const bt = b as TableElement;
        assert.deepEqual(bt.cells.map((row) => row.map((x) => plain(x.text))), e.cells.map((row) => row.map((x) => plain(x.text))));
        assert.deepEqual(bt.cells.map((row) => row.map((x) => x.fill)), e.cells.map((row, ri) => row.map((x) => x.fill ?? (e.headerRow && ri === 0 ? bt.cells[0]![0]!.fill : null))));
        bt.colWidths.forEach((w, i) => assert.ok(near(w, e.colWidths[i]!), "column widths"));
      }
      if (e.kind === "chart") {
        const bc = (b as ChartElement).chart;
        assert.equal(bc.type, e.chart.type);
        assert.equal(bc.title, e.chart.title);
        assert.deepEqual(bc.labels, e.chart.labels);
        assert.deepEqual(bc.series.map((x) => [x.name, x.values]), e.chart.series.map((x) => [x.name, x.values]));
      }
      if (e.kind === "video" || e.kind === "audio") assert.equal(b!.kind, e.kind);
      assert.equal(b!.locked, e.locked, `${e.id} locked`);
      if (e.link && e.kind !== "html") assert.equal(b!.link, e.link, `${e.id} link`);
    }
  }
  // grouped elements are grouped again (with a fresh group id)
  const grouped = orig.slides[1]!.elements.filter((e) => e.group).map((e) => got.get(e.id)!);
  assert.ok(grouped.length === 2 && grouped[0]!.group && grouped[0]!.group === grouped[1]!.group);
});

// ---------------------------------------------------------------- odp, ppt, key

for (const fmt of ["odp", "ppt"]) {
  test(`${fmt}: made through LibreOffice and opens back with every slide and its text`, { skip: HAVE.soffice() ? false : "LibreOffice is not installed" }, async () => {
    const r = await exportAs(fmt);
    assert.equal(r.status, 200, r.data.toString().slice(0, 300));
    assert.equal(r.ext, fmt);
    const back = await importThrough(c, `deck.${fmt}`, r.data);
    assert.equal(back.status, 200);
    assert.equal(back.deck.slides.length, 5);
    assert.deepEqual(back.deck.slides.map((s) => s.skipped), [false, false, true, false, false]);
    const text = deckText(back.deck);
    for (const t of ["Every inline attribute", "Right aligned heading 3", "Shape text", "Region", "North", "Revenue"]) assert.ok(text.includes(t), t);
    if (fmt === "ppt") assert.match(r.warnings, /became a picture/, "media that .ppt can't hold is pictured");
  });
}

test("key: made through Keynote and opens back with every slide and its text", async () => {
  const r = await exportAs("key");
  if (!HAVE.keynote()) {
    assert.equal(r.status, 501);
    assert.equal((JSON.parse(r.data.toString()) as { error: { code: string } }).error.code, "keynote_unavailable");
    return;
  }
  assert.equal(r.status, 200, r.data.toString().slice(0, 300));
  assert.equal(r.type, "application/x-iwork-keynote-sffkey");
  const back = await importThrough(c, "deck.key", r.data);
  assert.equal(back.status, 200, JSON.stringify(back.error));
  assert.equal(back.deck.slides.length, 5);
  assert.deepEqual(back.deck.slides.map((s) => s.skipped), [false, false, true, false, false]);
  const text = deckText(back.deck);
  for (const t of ["Every inline attribute", "Right aligned heading 3", "Shape text", "Region", "North"]) assert.ok(text.includes(t), t);
  // charts go to Keynote as pictures (Keynote drops pptx charts on import)
  assert.ok(back.deck.slides[2]!.elements.filter((e: Element) => e.kind === "image").length >= 2);
});
