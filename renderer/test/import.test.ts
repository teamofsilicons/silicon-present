// Every import, through the running converter, against the committed fixtures (built by test/make-fixtures.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { DeckJson, Element, TextElement, ShapeElement, TableElement, ChartElement, ImageElement } from "@silicon-present/deck";
import { HAVE } from "../src/config";
import { type Converter, deckText, fixture, importThrough, plain, startConverter } from "./helpers";

let c: Converter;
before(async () => {
  c = await startConverter();
});
after(async () => {
  await c.stop();
});

const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;
const kinds = (els: Element[]) => els.map((e) => (e.kind === "shape" ? `shape:${e.shape}` : e.kind));
const assetKeys = (d: DeckJson) => new Set([...JSON.stringify(d).matchAll(/"asset:([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));

function assetsResolve(r: { deck: DeckJson; assets: Array<{ key: string; data: string }> }) {
  const keys = new Set(r.assets.map((a) => a.key));
  for (const k of assetKeys(r.deck)) assert.ok(keys.has(k), `asset ${k} referenced but not returned`);
  for (const a of r.assets) assert.ok(Buffer.from(a.data, "base64").length > 0, `asset ${a.key} is empty`);
}

test("pptx: structure, sections, hidden slides, transitions, notes", async () => {
  const r = await importThrough(c, "rich.pptx");
  assert.equal(r.status, 200);
  const d = r.deck;
  assert.deepEqual(d.size, { width: 1920, height: 1080 });
  assert.equal(d.title, "Rich fixture deck");
  assert.equal(d.slides.length, 8);
  assert.deepEqual(d.slides.map((s) => s.skipped), [false, false, false, false, false, false, true, false]);
  assert.equal(d.slides[0]!.section, "Intro");
  assert.equal(d.slides[7]!.section, "End");
  assert.deepEqual(d.slides[2]!.transition, { type: "fade", duration: 1000 });
  assert.deepEqual(d.slides[7]!.transition, { type: "push", duration: 750, direction: "up" });
  assert.equal(d.slides[0]!.notes, "Welcome everyone.\nThis is the second line of the notes.");
  assert.equal(d.slides[1]!.notes, "Talk about lists.");
  assert.deepEqual(d.slides[2]!.background, { color: "#f3f5f0" });
  assert.deepEqual(d.theme.fonts, { heading: "Georgia", body: "Arial" });
  assetsResolve(r);
});

test("pptx: placeholders inherit position and style; runs keep their formatting", async () => {
  const d = (await importThrough(c, "rich.pptx")).deck;
  const s1 = d.slides[0]!;
  // the layout's decoration (a bar along the bottom) is drawn under the slide
  assert.deepEqual(kinds(s1.elements), ["shape:rect", "text", "text"]);
  const title = s1.elements[1] as TextElement;
  assert.ok(near(title.x, 0.8 * 144) && near(title.y, 2.2 * 144) && near(title.w, 11.7 * 144), "title placed from the layout placeholder");
  assert.deepEqual(title.text.paragraphs[0]!.runs[0], { text: "Rich fixture deck", bold: true, color: "#1b1b1f", size: 96, font: "Georgia" });
  const runs = (s1.elements[2] as TextElement).text.paragraphs[0]!.runs;
  const by = (t: string) => runs.find((r) => r.text.startsWith(t))!;
  assert.equal(by("Bold").bold, true);
  assert.equal(by("italic").italic, true);
  assert.equal(by("underline").underline, true);
  assert.equal(by("red").color, "#e5484d");
  assert.equal(by("big").size, 72);
  assert.equal(by("mono").font, "Courier New");
  assert.equal(by("highlight").highlight, "#ffff00");
  assert.equal(by("link").link, "https://teamofsilicons.com");
  assert.equal((s1.elements[2] as TextElement).text.paragraphs[0]!.align, "center");
});

test("pptx: bullets, numbering, indent, boxed text", async () => {
  const s2 = (await importThrough(c, "rich.pptx")).deck.slides[1]!;
  const list = s2.elements[1] as TextElement;
  assert.deepEqual(
    list.text.paragraphs.map((p) => [p.list, p.indent ?? 0, plain({ paragraphs: [p] })]),
    [
      ["bullet", 0, "First bullet"],
      ["bullet", 1, "Nested bullet"],
      ["ordered", 0, "Step one"],
      ["ordered", 0, "Step two"],
    ],
  );
  const box = s2.elements[2] as ShapeElement;
  assert.equal(box.kind, "shape");
  assert.equal(box.style.fill, "#fff3d6");
  assert.equal(box.style.stroke, "#b4532a");
  assert.equal(box.text.paragraphs[0]!.align, "right");
});

test("pptx: shapes with fills, lines, rotation, rounded corners", async () => {
  const s3 = (await importThrough(c, "rich.pptx")).deck.slides[2]!;
  assert.deepEqual(kinds(s3.elements), ["shape:rect", "shape:ellipse", "shape:round-rect", "shape:arrow-right", "shape:star", "shape:line", "shape:diamond"]);
  const [rect, , rounded, arrow, , line] = s3.elements as ShapeElement[];
  assert.equal(rect!.style.fill, "#2f6b4f");
  assert.equal(rect!.style.stroke, "#1c2a22");
  assert.ok(near(rect!.style.strokeWidth!, 6, 0.1));
  assert.equal(plain(rounded!.text), "Rounded");
  assert.ok(rounded!.style.radius! > 0);
  assert.equal(arrow!.rotation, 30);
  assert.ok(near(line!.w, 4 * 144) && line!.h === 0);
});

test("pptx: table cells, fills and grid", async () => {
  const t = (await importThrough(c, "rich.pptx")).deck.slides[3]!.elements.find((e) => e.kind === "table") as TableElement;
  assert.equal(t.rows, 3);
  assert.equal(t.cols, 3);
  assert.deepEqual(t.cells.map((r) => r.map((cell) => plain(cell.text))), [["Region", "Q3", "Q4"], ["North", "12", "18"], ["South", "9", "11"]]);
  assert.equal(t.cells[0]![0]!.fill, "#dde6ff");
  assert.equal(t.cells[2]![1]!.fill, "#e8f3ec");
  assert.equal(t.cells[1]![1]!.fill, null);
  assert.deepEqual(t.colWidths, [432, 360, 360]);
  assert.equal(t.cells[0]![0]!.text.paragraphs[0]!.runs[0]!.bold, true);
});

test("pptx: charts become chart JSON", async () => {
  const charts = (await importThrough(c, "rich.pptx")).deck.slides[4]!.elements as ChartElement[];
  assert.deepEqual(charts.map((e) => e.chart.type), ["column", "pie", "line"]);
  assert.deepEqual(charts[0]!.chart.labels, ["Q1", "Q2", "Q3", "Q4"]);
  assert.deepEqual(charts[0]!.chart.series.map((s) => [s.name, s.values, s.color]), [["2025", [10, 12.5, 9, 14], "#3b6e8f"], ["2026", [12, 15, 13, 18], "#e2614b"]]);
  assert.equal(charts[0]!.chart.title, "Revenue");
  assert.equal(charts[0]!.chart.legend, true);
  assert.deepEqual(charts[1]!.chart.labels, ["North", "South", "East"]);
  assert.deepEqual(charts[1]!.chart.series[0]!.values, [50, 30, 20]);
  assert.equal(charts[2]!.chart.legend, false);
});

test("pptx: pictures, links, video with poster, audio", async () => {
  const r = await importThrough(c, "rich.pptx");
  const s6 = r.deck.slides[5]!;
  assert.deepEqual(kinds(s6.elements), ["image", "image", "video", "audio"]);
  const [pic, stretched, video, audio] = s6.elements as [ImageElement, ImageElement, Element & { kind: "video" }, Element & { kind: "audio" }];
  assert.equal(pic.link, "https://example.com");
  assert.equal(pic.alt, "Fixture picture");
  assert.equal(pic.fit, "contain", "a picture that keeps its aspect ratio");
  assert.equal(stretched.fit, "fill", "a stretched picture stays stretched");
  const asset = (src: string) => r.assets.find((a) => `asset:${a.key}` === src)!;
  assert.equal(asset(pic.src).contentType, "image/png");
  assert.equal(asset(stretched.src).contentType, "image/jpeg");
  assert.equal(asset(video.src).contentType, "video/mp4");
  assert.ok(video.poster && asset(video.poster).contentType.startsWith("image/"));
  assert.equal(asset(audio.src).contentType, "audio/wav");
});

test("pptx: groups are flattened with a shared group id and real positions; unmodelled parts become pictures", async () => {
  const r = await importThrough(c, "rich.pptx");
  const s8 = r.deck.slides[7]!;
  const grouped = s8.elements.filter((e) => e.group);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0]!.group, grouped[1]!.group);
  // children at (1in, 1in) and (3.5in, 1in), 2 x 1 in, inside a group drawn at (1in, 3in) at half scale
  assert.deepEqual(grouped.map((e) => [e.x, e.y, e.w, e.h]), [[144, 432, 144, 72], [324, 432, 144, 72]]);
  const pictures = s8.elements.filter((e) => e.kind === "image") as ImageElement[];
  assert.equal(pictures.length, 2, "the custom shape and the unknown object");
  for (const p of pictures) {
    const a = r.assets.find((x) => `asset:${x.key}` === p.src)!;
    assert.equal(a.contentType, "image/png");
    const png = Buffer.from(a.data, "base64");
    assert.ok(Math.abs(png.readUInt32BE(16) - p.w) <= 2, "the picture is cut at the element's size");
  }
  assert.ok(r.notes.some((n) => /Custom shape/.test(n)));
});

for (const ext of ["odp", "ppt"]) {
  test(`${ext}: opens through LibreOffice with text, shapes, colours, table and charts`, { skip: HAVE.soffice() ? false : "LibreOffice is not installed" }, async () => {
    const r = await importThrough(c, `rich.${ext}`);
    assert.equal(r.status, 200, JSON.stringify(r.error));
    const d = r.deck;
    assert.equal(d.slides.length, 8);
    assert.equal(d.slides[6]!.skipped, true);
    const text = deckText(d);
    for (const t of ["Rich fixture deck", "Lists and boxes", "First bullet", "Step two", "Boxed text, right aligned", "Region", "South", "Revenue", "Hidden slide", "After the group"]) assert.ok(text.includes(t), `${t} is there`);
    // shape colours survive (LibreOffice's theme-colour links are removed before converting)
    const fills = d.slides[2]!.elements.map((e) => e.style.fill);
    assert.ok(fills.includes("#2f6b4f") && fills.includes("#c2733d") && fills.includes("#e2614b"), JSON.stringify(fills));
    const t = d.slides[3]!.elements.find((e) => e.kind === "table") as TableElement;
    assert.equal(t.cells[0]![0]!.fill, "#dde6ff");
    const charts = d.slides[4]!.elements.filter((e) => e.kind === "chart") as ChartElement[];
    assert.equal(charts.length, 3);
    assert.deepEqual(charts[0]!.chart.series[1]!.values, [12, 15, 13, 18]);
    assert.ok(d.slides[5]!.elements.some((e) => e.kind === "image"));
    assetsResolve(r);
  });
}

test("key: opens through Keynote (or LibreOffice) with its text, shapes and table", { skip: HAVE.keynote() || HAVE.soffice() ? false : "neither Keynote nor LibreOffice is installed" }, async () => {
  const r = await importThrough(c, "rich.key");
  assert.equal(r.status, 200, JSON.stringify(r.error));
  const d = r.deck;
  assert.equal(d.slides.length, 8);
  assert.equal(d.slides[6]!.skipped, true);
  const text = deckText(d);
  for (const t of ["Rich fixture deck", "Lists and boxes", "First bullet", "Region", "South", "Hidden slide", "After the group"]) assert.ok(text.includes(t), `${t} is there`);
  const fills = d.slides[2]!.elements.map((e) => e.style.fill);
  assert.ok(fills.includes("#2f6b4f"), JSON.stringify(fills));
  // Keynote dropped the pptxgenjs charts when it made this .key (its own import), so slide 5 is empty in the file
  assert.ok(d.slides[5]!.elements.filter((e) => e.kind === "image").length >= 2);
  assetsResolve(r);
});

test("pdf: one slide per page, page picture as background, page text in notes", async () => {
  const r = await importThrough(c, "rich.pdf");
  assert.equal(r.status, 200);
  assert.equal(r.deck.slides.length, 8);
  for (const s of r.deck.slides) {
    assert.ok(s.background && "image" in s.background);
    assert.equal(s.elements.length, 0);
  }
  assert.match(r.deck.slides[0]!.notes, /Rich fixture deck/);
  assert.match(r.deck.slides[3]!.notes, /Region/);
  const bg = r.deck.slides[0]!.background as { image: string };
  const a = r.assets.find((x) => `asset:${x.key}` === bg.image)!;
  assert.equal(Buffer.from(a.data, "base64").readUInt32BE(16), 1920);
});

test("html: any other page becomes one full-slide live HTML element", async () => {
  const r = await importThrough(c, "page.html");
  assert.equal(r.deck.title, "A live page");
  assert.equal(r.deck.slides.length, 1);
  const e = r.deck.slides[0]!.elements[0]!;
  assert.equal(e.kind, "html");
  assert.deepEqual([e.x, e.y, e.w, e.h], [0, 0, 1920, 1080]);
  assert.match((e as { html: string }).html, /setInterval/);
});

for (const [file, kind, ct] of [
  ["picture.png", "image", "image/png"],
  ["picture.jpg", "image", "image/jpeg"],
  ["picture.svg", "image", "image/svg+xml"],
  ["pixel.gif", "image", "image/gif"],
  ["clip.webm", "video", "video/webm"],
  ["clip.mp4", "video", "video/mp4"],
  ["tone.mp3", "audio", "audio/mpeg"],
  ["tone.wav", "audio", "audio/wav"],
] as const) {
  test(`${file}: one slide with the ${kind}`, async () => {
    const r = await importThrough(c, file);
    assert.equal(r.status, 200);
    assert.equal(r.deck.slides.length, 1);
    const e = r.deck.slides[0]!.elements[0]!;
    assert.equal(e.kind, kind);
    assert.equal(r.assets[0]!.contentType, ct);
    assert.deepEqual(Buffer.from(r.assets[0]!.data, "base64"), fixture(file));
    if (file === "picture.png" || file === "picture.svg") assert.deepEqual([e.x, e.y, e.w, e.h], [0, 0, 1920, 1080], "a 16:9 picture fills the slide");
  });
}

for (const file of ["font.ttf", "font.woff2"]) {
  test(`${file}: the font becomes the deck's theme font`, async () => {
    const r = await importThrough(c, file);
    assert.equal(r.status, 200);
    // the family name inside the font file (this static instance calls itself "Fraunces SemiBold")
    assert.equal(r.deck.theme.fonts.heading, "Fraunces SemiBold");
    assert.equal(r.deck.theme.fonts.body, "Fraunces SemiBold");
    assert.deepEqual(r.deck.theme.customFonts, [{ family: "Fraunces SemiBold", src: `asset:${r.assets[0]!.key}` }]);
  });
}

test("files Silicon Present can't open get a clear error", async () => {
  const r = await c.post("/import", { filename: "notes.txt", data: Buffer.from("hello").toString("base64") });
  assert.equal(r.status, 415);
  const body = (await r.json()) as { error: { code: string; message: string; hint: string } };
  assert.equal(body.error.code, "unsupported_file");
  assert.ok(body.error.message && body.error.hint);
  const bad = await c.post("/import", { filename: "broken.pptx", data: Buffer.from("PK\x03\x04 not really").toString("base64") });
  assert.equal(bad.status, 422);
  assert.equal(((await bad.json()) as { error: { code: string } }).error.code, "unreadable_file");
});
