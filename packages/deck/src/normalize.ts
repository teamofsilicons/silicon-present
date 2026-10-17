import { newElementId, newSlideId } from "./ids";
import { DEFAULT_THEME } from "./themes";
import { INLINE_ATTRS, PARAGRAPH_ATTRS } from "./types";
import type {
  DeckInput,
  DeckJson,
  Element,
  ElementInput,
  Paragraph,
  RichText,
  Run,
  Slide,
  SlideInput,
  TableCell,
  Theme,
} from "./types";

// Canonical JSON. docToJson always returns, and jsonToDoc always writes, every key listed here, with these defaults
// for anything missing, so the TS and Rust deck models agree on one shape (see docs/architecture.md, "Canonical JSON").
//
// Plain JSON values (style, animation, transition, chart, background, size, theme) keep exactly the keys they were
// given, minus keys whose value is undefined.

export const DEFAULT_SIZE = { width: 1920, height: 1080 };

export function emptyRichText(): RichText {
  return { paragraphs: [] };
}

/** Drop false / null / undefined attributes and indent 0; drop empty runs; merge neighbours with equal attributes. */
export function normalizeRichText(rt: unknown): RichText {
  const src = rt as RichText | null | undefined;
  if (!src || !Array.isArray(src.paragraphs)) {
    if (typeof rt === "string") return richTextFromPlain(rt);
    return emptyRichText();
  }
  const paragraphs: Paragraph[] = [];
  for (const p of src.paragraphs) {
    const para: Paragraph = { ...cleanParagraphAttrs(p as unknown as Record<string, unknown>), runs: [] };
    const runs: Run[] = [];
    for (const r of p.runs ?? []) {
      const pieces = String(r.text ?? "").split("\n");
      pieces.forEach((piece, i) => {
        if (i > 0) {
          // A "\n" inside a run starts a new paragraph with the same paragraph attributes.
          para.runs = mergeRuns(runs.splice(0));
          paragraphs.push({ ...para });
          para.runs = [];
        }
        if (piece.length) runs.push({ ...cleanInlineAttrs(r as unknown as Record<string, unknown>), text: piece });
      });
    }
    para.runs = mergeRuns(runs);
    paragraphs.push(para);
  }
  return { paragraphs };
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && sameAttrs(last, r)) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

export function sameAttrs(a: Record<string, unknown> | Run, b: Record<string, unknown> | Run): boolean {
  const ka = Object.keys(a).filter((k) => k !== "text" && k !== "runs");
  const kb = Object.keys(b).filter((k) => k !== "text" && k !== "runs");
  if (ka.length !== kb.length) return false;
  return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

export function cleanInlineAttrs(r: Record<string, unknown>): Omit<Run, "text"> {
  const out: Record<string, unknown> = {};
  for (const k of INLINE_ATTRS) {
    const v = r[k];
    if (v === undefined || v === null || v === false || v === "") continue;
    out[k] = v;
  }
  return out as Omit<Run, "text">;
}

export function cleanParagraphAttrs(p: Record<string, unknown>): Omit<Paragraph, "runs"> {
  const out: Record<string, unknown> = {};
  for (const k of PARAGRAPH_ATTRS) {
    const v = p[k];
    if (v === undefined || v === null || v === false || v === "") continue;
    if (k === "indent" && v === 0) continue;
    out[k] = v;
  }
  return out as Omit<Paragraph, "runs">;
}

/** Plain text (lines separated by "\n") as rich text, one paragraph per line. */
export function richTextFromPlain(text: string, para: Omit<Paragraph, "runs"> = {}, run: Omit<Run, "text"> = {}): RichText {
  if (text === "") return { paragraphs: [{ ...para, runs: [] }] };
  return {
    paragraphs: text.split("\n").map((line) => ({ ...para, runs: line ? [{ ...run, text: line }] : [] })),
  };
}

/** The characters of a rich text, paragraphs joined by "\n". */
export function richTextToPlain(rt: RichText | null | undefined): string {
  if (!rt) return "";
  return rt.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
}

function stripUndefined<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stripUndefined) as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) out[k] = stripUndefined(x);
  return out as T;
}

function num(v: unknown, d: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

function str(v: unknown, d: string): string {
  return typeof v === "string" ? v : d;
}

function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}

function nullable<T>(v: unknown): T | null {
  return v === undefined || v === null ? null : (stripUndefined(v) as T);
}

export function normalizeCell(c: unknown): TableCell {
  const cell = (c ?? {}) as Partial<TableCell> | string;
  if (typeof cell === "string") return { text: richTextFromPlain(cell), fill: null };
  return { text: normalizeRichText(cell.text), fill: typeof cell.fill === "string" ? cell.fill : null };
}

/** Fill every canonical key of an element. Unknown keys are dropped. */
export function normalizeElement(input: ElementInput | Element, makeId: () => string = newElementId): Element {
  const e = input as Record<string, unknown>;
  const kind = e.kind as Element["kind"];
  const base = {
    id: typeof e.id === "string" && e.id ? e.id : makeId(),
    kind,
    x: num(e.x, 0),
    y: num(e.y, 0),
    w: num(e.w, 400),
    h: num(e.h, 200),
    rotation: num(e.rotation, 0),
    locked: bool(e.locked, false),
    group: typeof e.group === "string" ? e.group : null,
    link: typeof e.link === "string" ? e.link : null,
    animation: nullable<Element["animation"]>(e.animation),
    style: (e.style && typeof e.style === "object" ? stripUndefined(e.style) : {}) as Element["style"],
  };
  switch (kind) {
    case "text":
      return { ...base, kind, text: normalizeRichText(e.text) };
    case "shape":
      return { ...base, kind, shape: str(e.shape, "rect"), text: normalizeRichText(e.text) };
    case "image":
      return { ...base, kind, src: str(e.src, ""), alt: str(e.alt, ""), fit: (str(e.fit, "contain") as "contain") };
    case "video":
      return {
        ...base,
        kind,
        src: str(e.src, ""),
        alt: str(e.alt, ""),
        autoplay: bool(e.autoplay, false),
        loop: bool(e.loop, false),
        muted: bool(e.muted, false),
        poster: typeof e.poster === "string" ? e.poster : null,
      };
    case "audio":
      return {
        ...base,
        kind,
        src: str(e.src, ""),
        alt: str(e.alt, ""),
        autoplay: bool(e.autoplay, false),
        loop: bool(e.loop, false),
        muted: bool(e.muted, false),
      };
    case "table": {
      const cellsIn = Array.isArray(e.cells) ? (e.cells as unknown[][]) : [];
      const rows = Math.max(1, Math.round(num(e.rows, cellsIn.length || 2)));
      const cols = Math.max(1, Math.round(num(e.cols, Math.max(0, ...cellsIn.map((r) => (Array.isArray(r) ? r.length : 0))) || 2)));
      const cells: TableCell[][] = [];
      for (let r = 0; r < rows; r++) {
        const row: TableCell[] = [];
        for (let c = 0; c < cols; c++) row.push(normalizeCell(cellsIn[r]?.[c] ?? { text: emptyRichText(), fill: null }));
        cells.push(row);
      }
      const colWidths = fitArray(e.colWidths, cols, base.w);
      const rowHeights = fitArray(e.rowHeights, rows, base.h);
      return { ...base, kind, rows, cols, colWidths, rowHeights, headerRow: bool(e.headerRow, false), cells };
    }
    case "chart": {
      const c = (e.chart ?? {}) as Record<string, unknown>;
      const chart = stripUndefined({
        ...c,
        type: str(c.type, "column"),
        labels: Array.isArray(c.labels) ? c.labels.map(String) : [],
        series: Array.isArray(c.series)
          ? (c.series as Record<string, unknown>[]).map((s) => stripUndefined({ ...s, name: str(s.name, ""), values: Array.isArray(s.values) ? s.values.map((v) => num(v, 0)) : [] }))
          : [],
        legend: bool(c.legend, true),
      }) as unknown as import("./types").Chart;
      return { ...base, kind, chart };
    }
    case "html":
      return { ...base, kind, html: str(e.html, ""), css: str(e.css, ""), js: str(e.js, "") };
    default:
      throw new DeckError("unknown_element_kind", `The element kind "${String(kind)}" is not one Silicon Present knows.`, "Use one of: text, shape, image, video, audio, table, chart, html.");
  }
}

function fitArray(v: unknown, n: number, total: number): number[] {
  const arr = Array.isArray(v) ? v.map((x) => num(x, 0)) : [];
  if (arr.length === n) return arr;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(arr[i] ?? total / n);
  return out;
}

export function normalizeSlide(input: SlideInput | Slide, makeId: () => string = newSlideId, makeElementId: () => string = newElementId): Slide {
  const s = input as Record<string, unknown>;
  return {
    id: typeof s.id === "string" && s.id ? s.id : makeId(),
    layout: str(s.layout, "blank"),
    background: nullable<Slide["background"]>(s.background),
    skipped: bool(s.skipped, false),
    section: typeof s.section === "string" ? s.section : null,
    hideMaster: bool(s.hideMaster, false),
    transition: nullable<Slide["transition"]>(s.transition),
    notes: str(s.notes, ""),
    elements: (Array.isArray(s.elements) ? (s.elements as ElementInput[]) : []).map((el) => normalizeElement(el, makeElementId)),
  };
}

export function normalizeTheme(t: unknown): Theme {
  const th = (t ?? {}) as Partial<Theme>;
  const d = DEFAULT_THEME;
  return stripUndefined({
    ...th,
    name: str(th.name, d.name),
    fonts: { ...d.fonts, ...(th.fonts ?? {}) },
    colors: { ...d.colors, ...(th.colors ?? {}) },
    customFonts: Array.isArray(th.customFonts) ? th.customFonts : [],
  }) as Theme;
}

export function normalizeDeck(input: DeckInput): DeckJson {
  const out: DeckJson = {
    size: input.size ? stripUndefined(input.size) : { ...DEFAULT_SIZE },
    theme: normalizeTheme(input.theme),
    master: { elements: (input.master?.elements ?? []).map((e) => normalizeElement(e)) },
    slides: (input.slides ?? []).map((s) => normalizeSlide(s)),
  };
  if (input.id !== undefined) out.id = input.id;
  if (input.title !== undefined) out.title = input.title;
  if (input.version !== undefined) out.version = input.version;
  return out;
}

/** Errors from the deck model, in the same shape the service returns: what happened, why, what to do. */
export class DeckError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint: string,
  ) {
    super(message);
    this.name = "DeckError";
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, hint: this.hint } };
  }
}
