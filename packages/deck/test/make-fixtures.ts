// Writes the cross-language contract fixtures into fixtures/contract/ at the repo root:
//   <name>.json        canonical deck JSON (every key present, as docToJson returns it)
//   <name>.ts.yupdate  Y.encodeStateAsUpdate of jsonToDoc(<name>.json) built by this TS package (clientID 1)
// The Rust crate (crates/present-deck) adds <name>.rust.yupdate built from the same JSON; test/contract.test.ts
// checks that those decode to exactly <name>.json.
//
// Run: pnpm --filter @silicon-present/deck exec tsx test/make-fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { THEMES, docToJson, jsonToDoc, normalizeDeck, SHAPES } from "../src/index";
import type { DeckInput, DeckJson, Element, ElementInput, RichText } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
export const CONTRACT_DIR = join(here, "..", "..", "..", "fixtures", "contract");

const base = { rotation: 0, locked: false, group: null, link: null, animation: null, style: {} };
const p = (text: string, attrs: Record<string, unknown> = {}): RichText => ({ paragraphs: [{ ...attrs, runs: text ? [{ text }] : [] }] });

let n = 0;
const eid = () => "e_" + (n++).toString(36).padStart(6, "0");

function slide(id: string, elements: ElementInput[], extra: Record<string, unknown> = {}) {
  return { id, layout: "blank", background: null, skipped: false, section: null, hideMaster: false, transition: null, notes: "", elements, ...extra };
}

export function fixtures(): Record<string, DeckJson> {
  n = 0;
  const out: Record<string, DeckInput> = {};

  out.minimal = {
    size: { width: 1920, height: 1080 },
    theme: THEMES[0]!,
    master: { elements: [] },
    slides: [slide("s_000001", [])],
  };

  const richBody: RichText = {
    paragraphs: [
      { heading: 1, align: "center", runs: [{ text: "Every " }, { text: "inline", bold: true }, { text: " attribute" }] },
      {
        runs: [
          { text: "bold", bold: true },
          { text: " italic", italic: true },
          { text: " underline", underline: true },
          { text: " strike", strike: true },
          { text: " colour", color: "#e5484d" },
          { text: " highlight", highlight: "#fff3a3" },
          { text: " size", size: 56 },
          { text: " font", font: "Fraunces" },
          { text: " link", link: "https://teamofsilicons.com", underline: true },
          { text: " code", code: true },
          { text: " all", bold: true, italic: true, underline: true, color: "#2f5bea", size: 44, font: "Inter" },
        ],
      },
      { list: "bullet", runs: [{ text: "A bullet" }] },
      { list: "bullet", indent: 1, runs: [{ text: "An indented bullet" }] },
      { list: "ordered", runs: [{ text: "First" }] },
      { list: "ordered", runs: [{ text: "Second" }] },
      { list: "ordered", indent: 2, lineHeight: 1.6, runs: [{ text: "Nested, taller lines" }] },
      { align: "right", heading: 3, runs: [{ text: "Right aligned heading 3" }] },
      { align: "justify", heading: 2, runs: [{ text: "Justified heading 2" }] },
      { runs: [] },
      { runs: [{ text: "Soft break and émoji 🎉 and ünïcödé" }] },
    ],
  };

  const everyStyle = { fill: "#f4f4f5", stroke: "#1b1b1f", strokeWidth: 3, radius: 16, opacity: 0.9, shadow: true, padding: 24, verticalAlign: "middle" };

  out["every-element"] = {
    size: { width: 1920, height: 1080 },
    theme: { ...THEMES[1]!, customFonts: [{ family: "Brand Sans", src: "asset:7Fq2mP9xRtA1" }] },
    master: {
      elements: [
        { ...base, id: eid(), kind: "text", x: 80, y: 1010, w: 600, h: 50, text: p("Silicon Present · master footer", { align: "left" }), style: { opacity: 0.6 } },
        { ...base, id: eid(), kind: "shape", shape: "ellipse", x: 1820, y: 1000, w: 40, h: 40, text: { paragraphs: [] }, style: { fill: "#b4532a" } },
      ],
    },
    slides: [
      slide(
        "s_000001",
        [
          { ...base, id: eid(), kind: "text", x: 100, y: 80, w: 1720, h: 900, text: richBody, style: everyStyle, animation: { effect: "fade", trigger: "click", order: 1, duration: 500, delay: 0 } },
        ],
        { layout: "title-body", notes: "Speaker notes\nwith two lines", section: "Intro", transition: { type: "fade", duration: 400 } },
      ),
      slide(
        "s_000002",
        [
          { ...base, id: eid(), kind: "shape", shape: "round-rect", x: 100, y: 100, w: 500, h: 300, rotation: 12.5, locked: true, group: "g_000001", link: "slide:s_000003", text: p("Shape text", { align: "center" }), style: { fill: "#2f6b4f", stroke: "#1c2a22", strokeWidth: 4, radius: 32 }, animation: { effect: "fly-in", trigger: "click", order: 1, duration: 600, delay: 100, direction: "left" } },
          { ...base, id: eid(), kind: "shape", shape: "arrow-right", x: 650, y: 150, w: 300, h: 200, group: "g_000001", text: { paragraphs: [] }, style: {}, animation: { effect: "zoom", trigger: "with-previous", order: 2, duration: 400, delay: 0 } },
          { ...base, id: eid(), kind: "image", x: 1000, y: 100, w: 800, h: 450, src: "asset:Img1aaaaaaaa", alt: "A sample picture", fit: "cover", link: "https://example.com", animation: { effect: "rise", trigger: "after-previous", order: 3, duration: 500, delay: 200 } },
          { ...base, id: eid(), kind: "image", x: 1000, y: 600, w: 380, h: 380, src: "https://example.com/logo.png", alt: "", fit: "contain", style: { radius: 24, shadow: true } },
          { ...base, id: eid(), kind: "image", x: 1420, y: 600, w: 380, h: 380, src: "", alt: "Image placeholder", fit: "fill", animation: { effect: "wipe", trigger: "click", order: 4, duration: 700, delay: 0, direction: "up" } },
          { ...base, id: eid(), kind: "video", x: 100, y: 500, w: 640, h: 360, src: "asset:Vid1aaaaaaaa", alt: "A clip", autoplay: true, loop: true, muted: true, poster: "asset:Img1aaaaaaaa", animation: { effect: "appear", trigger: "click", order: 5, duration: 0, delay: 0 } },
          { ...base, id: eid(), kind: "audio", x: 760, y: 900, w: 200, h: 80, src: "asset:Aud1aaaaaaaa", alt: "Narration", autoplay: false, loop: false, muted: false },
        ],
        { layout: "blank", background: { color: "#f3efe6" }, hideMaster: true, transition: { type: "push", duration: 600, direction: "left" } },
      ),
      slide(
        "s_000003",
        [
          {
            ...base,
            id: eid(),
            kind: "table",
            x: 100,
            y: 100,
            w: 900,
            h: 400,
            rows: 3,
            cols: 3,
            colWidths: [300, 300, 300],
            rowHeights: [120, 140, 140],
            headerRow: true,
            cells: [
              [
                { text: p("Region", { align: "left" }), fill: null },
                { text: { paragraphs: [{ runs: [{ text: "Q3", bold: true }] }] }, fill: null },
                { text: p("Q4"), fill: "#ffe9d6" },
              ],
              [
                { text: p("North"), fill: null },
                { text: p("12"), fill: null },
                { text: p("18", { align: "right" }), fill: null },
              ],
              [
                { text: { paragraphs: [] }, fill: null },
                { text: p("9"), fill: "#e8f3ec" },
                { text: { paragraphs: [{ runs: [{ text: "11", italic: true }] }, { runs: [{ text: "(est.)", size: 24 }] }] }, fill: null },
              ],
            ],
            style: { stroke: "#7d7468", strokeWidth: 2 },
          },
          {
            ...base,
            id: eid(),
            kind: "chart",
            x: 1050,
            y: 100,
            w: 770,
            h: 500,
            chart: {
              type: "column",
              title: "Revenue",
              labels: ["Q1", "Q2", "Q3", "Q4"],
              series: [
                { name: "2025", values: [10, 12.5, 9, 14], color: "#3b6e8f" },
                { name: "2026", values: [12, 15, 13, 18] },
              ],
              legend: true,
            },
          },
          {
            ...base,
            id: eid(),
            kind: "html",
            x: 100,
            y: 560,
            w: 900,
            h: 420,
            html: '<div class="pulse">Live HTML</div>\n<canvas id="c" width="300" height="100"></canvas>',
            css: ".pulse { font: 600 48px system-ui; color: #b4532a; animation: p 1s infinite alternate; }\n@keyframes p { to { opacity: .4 } }",
            js: "const c = document.getElementById('c').getContext('2d');\nc.fillStyle = '#3b6e8f';\nc.fillRect(0, 0, 300, 100);",
            style: { radius: 12 },
          },
        ],
        { layout: "title-only", skipped: true, background: { image: "asset:Img1aaaaaaaa", fit: "contain" }, transition: { type: "wipe", duration: 500, direction: "up" } },
      ),
      slide("s_000004", [], { layout: "section", section: "Appendix", transition: { type: "zoom", duration: 300 } }),
      slide("s_000005", [], { layout: "blank", transition: { type: "cover", duration: 700, direction: "down" }, notes: "" }),
    ],
  };

  out.shapes = {
    size: { width: 1920, height: 1080 },
    theme: THEMES[3]!,
    master: { elements: [] },
    slides: [
      slide(
        "s_000001",
        SHAPES.map((shape, i) => ({
          ...base,
          id: eid(),
          kind: "shape",
          shape,
          x: 80 + (i % 5) * 360,
          y: 60 + Math.floor(i / 5) * 250,
          w: 300,
          h: shape === "line" ? 0 : 200,
          text: p(shape, { align: "center" }),
          style: i % 3 === 0 ? { fill: "#3a5a80" } : i % 3 === 1 ? { fill: "#ffffff", stroke: "#3a5a80", strokeWidth: 4 } : {},
        })),
      ),
    ],
  };

  const chartTypes = ["bar", "column", "line", "area", "pie", "donut", "scatter"] as const;
  out.charts = {
    size: { width: 1920, height: 1080 },
    theme: THEMES[5]!,
    master: { elements: [] },
    slides: [
      slide(
        "s_000001",
        chartTypes.map((type, i) => ({
          ...base,
          id: eid(),
          kind: "chart",
          x: 40 + (i % 4) * 470,
          y: 40 + Math.floor(i / 4) * 520,
          w: 450,
          h: 480,
          chart:
            type === "scatter"
              ? { type, title: "Scatter", labels: ["1", "2", "3", "4", "5"], series: [{ name: "y", values: [3, 5, 2, 8, 6] }, { name: "z", values: [1, 2, 4, 3, 7] }], legend: true }
              : type === "pie" || type === "donut"
                ? { type, title: type, labels: ["North", "South", "East", "West"], series: [{ name: "Share", values: [40, 25, 20, 15] }], legend: true }
                : { type, title: type, labels: ["Jan", "Feb", "Mar", "Apr", "May"], series: [{ name: "A", values: [5, 7, 3, 9, 6] }, { name: "B", values: [2, 4, 6, 5, 8] }], legend: i % 2 === 0 },
        })),
      ),
    ],
  };

  const res: Record<string, DeckJson> = {};
  for (const [k, v] of Object.entries(out)) res[k] = normalizeDeck(v);
  return res;
}

export function tsUpdate(json: DeckJson): Uint8Array {
  return Y.encodeStateAsUpdate(jsonToDoc(json, { clientID: 1 }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(CONTRACT_DIR, { recursive: true });
  for (const [name, json] of Object.entries(fixtures())) {
    // sanity: the JSON is canonical (round trips through a document unchanged)
    const back = docToJson(jsonToDoc(json));
    if (JSON.stringify(back) !== JSON.stringify(json)) throw new Error(`${name} is not canonical`);
    writeFileSync(join(CONTRACT_DIR, `${name}.json`), JSON.stringify(json, null, 2) + "\n");
    writeFileSync(join(CONTRACT_DIR, `${name}.ts.yupdate`), tsUpdate(json));
    console.log(`wrote ${name}.json and ${name}.ts.yupdate`);
  }
}

export type { Element };
