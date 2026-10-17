// Sample decks and assets for render tests and the visual check.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { THEMES, layoutElements, normalizeDeck } from "@silicon-present/deck";
import type { DeckJson, ElementInput, Theme } from "@silicon-present/deck";

const here = dirname(fileURLToPath(import.meta.url));
export const CONTRACT_DIR = join(here, "..", "..", "..", "fixtures", "contract");

export function contractDecks(): Record<string, DeckJson> {
  const out: Record<string, DeckJson> = {};
  for (const f of readdirSync(CONTRACT_DIR).filter((x) => x.endsWith(".json"))) out[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(CONTRACT_DIR, f), "utf8"));
  return out;
}

const PICTURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6d365"/><stop offset="1" stop-color="#fda085"/></linearGradient></defs>
<rect width="1600" height="900" fill="url(#g)"/><circle cx="1180" cy="300" r="140" fill="#fff6e0"/>
<path d="M0 700 L380 420 L640 620 L960 360 L1600 760 L1600 900 L0 900 Z" fill="#7a4e3b" opacity=".85"/>
<path d="M0 780 L420 560 L820 760 L1240 540 L1600 820 L1600 900 L0 900 Z" fill="#3e2a22"/></svg>`;

export const PICTURE_DATA_URL = "data:image/svg+xml;base64," + Buffer.from(PICTURE_SVG).toString("base64");

/** Test asset resolver: every image asset is the sample picture. */
export function testAssetUrl(id: string): string {
  if (id.startsWith("Img")) return PICTURE_DATA_URL;
  return `data:application/octet-stream;base64,`;
}

/** A realistic deck in a theme: every layout, a chart, a table, an image, animations. */
export function showcaseDeck(theme: Theme): DeckJson {
  const size = { width: 1920, height: 1080 };
  const L = (layout: string, content: Parameters<typeof layoutElements>[3]) => layoutElements(layout, theme, size, content);
  const slides: Array<{ layout: string; elements: ElementInput[]; notes?: string; transition?: unknown }> = [
    { layout: "title", elements: L("title", { title: "Quarterly review", subtitle: `${theme.name} theme · October 2026` }) },
    {
      layout: "title-body",
      elements: L("title-body", { title: "What changed", body: ["Revenue grew 18% quarter on quarter", "Two new markets opened", "Churn fell to 2.1%", "Hiring plan is on track"] }),
    },
    { layout: "two-columns", elements: L("two-columns", { title: "Plan", left: ["Ship the editor", "Open the CLI"], right: ["Present mode", "Comments everywhere"] }) },
    { layout: "section", elements: L("section", { title: "Numbers", subtitle: "Where the quarter landed" }) },
    {
      layout: "title-only",
      elements: [
        ...L("title-only", { title: "Revenue by quarter" }),
        { kind: "chart", x: 140, y: 290, w: 1000, h: 700, chart: { type: "column", labels: ["Q1", "Q2", "Q3", "Q4"], series: [{ name: "2025", values: [12, 15, 14, 19] }, { name: "2026", values: [16, 19, 22, 26] }], legend: true } },
        {
          kind: "table",
          x: 1200,
          y: 330,
          w: 580,
          h: 400,
          headerRow: true,
          rows: 4,
          cols: 2,
          cells: [
            [{ text: "Market" }, { text: "Share" }],
            [{ text: "North" }, { text: "41%" }],
            [{ text: "South" }, { text: "33%" }],
            [{ text: "West" }, { text: "26%" }],
          ].map((r) => r.map((c) => ({ text: { paragraphs: [{ runs: [{ text: c.text }] }] }, fill: null }))),
          animation: { effect: "fade", trigger: "click", order: 1, duration: 500, delay: 0 },
        },
      ],
    },
    { layout: "image-caption", elements: L("image-caption", { image: "asset:Img1aaaaaaaa", caption: "The view from the new office" }) },
  ];
  return normalizeDeck({ title: `${theme.name} showcase`, size, theme, master: { elements: [] }, slides: slides as never });
}

export function allShowcases(): Record<string, DeckJson> {
  const out: Record<string, DeckJson> = {};
  for (const t of THEMES) out[`showcase-${t.name.toLowerCase()}`] = showcaseDeck(t);
  return out;
}
