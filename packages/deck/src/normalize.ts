import { newElementId, newSlideId } from "./ids";
import { DEFAULT_THEME } from "./themes";
import { INLINE_ATTRS, PARAGRAPH_ATTRS, LAYOUTS, SHAPES } from "./types";
import type { DeckInput, DeckJson, Element, ElementInput, Paragraph, RichText, Run, Slide, SlideInput, TableCell, Theme, Size } from "./types";

export const DEFAULT_SIZE = { width: 1920, height: 1080 };
export const ELEMENT_KINDS = ["text", "shape", "image", "video", "audio", "table", "chart", "html"] as const;
const BASE_KEYS = ["id", "kind", "x", "y", "w", "h", "rotation", "locked", "group", "link", "animation", "style"];
export const KIND_KEYS: Record<Element["kind"], string[]> = {
  text: ["text"], shape: ["shape", "text"], image: ["src", "alt", "fit"],
  video: ["src", "alt", "autoplay", "loop", "muted", "poster"], audio: ["src", "alt", "autoplay", "loop", "muted"],
  table: ["rows", "cols", "colWidths", "rowHeights", "headerRow", "cells"], chart: ["chart"], html: ["html", "css", "js"],
};
export const SLIDE_KEYS = ["id", "layout", "background", "skipped", "section", "hideMaster", "transition", "notes", "elements"];
export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}
function bad(strict: boolean, message: string, code = "invalid_value"): void {
  if (strict) throw new DeckError(code, message, "Use the documented canonical deck fields and values.");
}
export function checkKeys(value: Record<string, unknown>, keys: readonly string[], strict = true): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) bad(strict, `The field "${key}" is not allowed here.`, "invalid_field");
}
export function validUnicode(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const n = s.charCodeAt(++i); if (!(n >= 0xdc00 && n <= 0xdfff)) return false; }
    else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
export function numberValue(v: unknown): number | undefined {
  if (typeof v === "bigint") v = Number(v);
  if (typeof v === "string") {
    if (!/^[\x20\t\r\n]*-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?[\x20\t\r\n]*$/.test(v)) return undefined;
    v = Number(v);
  }
  return typeof v === "number" && Number.isFinite(v) ? (v === 0 ? 0 : v) : undefined;
}
export function stringValue(v: unknown): string | undefined {
  if (typeof v === "bigint") v = Number(v);
  if (typeof v === "number" && Number.isFinite(v)) { const s = String(v); return /[eE]/.test(s) ? undefined : s; }
  return typeof v === "string" && validUnicode(v) ? v : undefined;
}
function num(v: unknown, d: number, strict = false, accept: (n: number) => boolean = () => true): number {
  if (v == null) return d;
  const n = numberValue(v);
  if (n !== undefined && accept(n)) return n;
  bad(strict, "Expected a finite number in the field's allowed range."); return d;
}
function str(v: unknown, d: string, strict = false): string {
  if (v == null) return d;
  const s = stringValue(v); if (s !== undefined) return s;
  bad(strict, "Expected text or a finite number expressible without an exponent."); return d;
}
function bool(v: unknown, d: boolean, strict = false): boolean {
  if (v == null) return d;
  if (typeof v === "boolean") return v;
  bad(strict, "Expected true or false."); return d;
}
function obj(v: unknown, strict = false): Record<string, unknown> {
  if (v == null) return {};
  if (isObject(v)) return v;
  bad(strict, "Expected a JSON object."); return {};
}
function list(v: unknown, strict = false): unknown[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  bad(strict, "Expected a list."); return [];
}
function en(v: unknown, values: readonly string[], d: string, strict = false): string {
  if (v == null) return d;
  if (typeof v === "string" && values.includes(v)) return v;
  bad(strict, `Expected one of: ${values.join(", ")}.`); return d;
}
/** Copy a JSON value, using float64 for every number. Shared Y types are never treated as plain values. */
export function canonicalValue(v: unknown, strict = false): unknown {
  if (typeof v === "number" || typeof v === "bigint") {
    const n = numberValue(v); if (n !== undefined) return n;
    bad(strict, "JSON numbers must be finite."); return null;
  }
  if (typeof v === "string") { if (validUnicode(v)) return v; bad(strict, "Text contains half a surrogate pair."); return ""; }
  if (v === null || typeof v === "boolean" || v === undefined) return v;
  if (Array.isArray(v)) return v.map(x => canonicalValue(x, strict) ?? null);
  if (isObject(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => {
    if (!validUnicode(k)) bad(strict, "An object key contains half a surrogate pair.");
    return [k, canonicalValue(x, strict)];
  }));
  bad(strict, "Expected a JSON value."); return undefined;
}
function objectValue(v: unknown, strict: boolean): Record<string, unknown> { return canonicalValue(obj(v, strict), strict) as Record<string, unknown>; }
function nullableObject(v: unknown, strict: boolean): Record<string, unknown> | null {
  if (v == null) return null;
  if (!isObject(v)) { bad(strict, "Expected an object or null."); return null; }
  return objectValue(v, strict);
}
function nullableString(v: unknown, strict: boolean): string | null {
  if (v == null) return null;
  const s = stringValue(v); if (s !== undefined) return s;
  bad(strict, "Expected text or null."); return null;
}
function id(v: unknown, make: () => string, strict: boolean): string {
  if (v == null || v === "") return make();
  if (typeof v === "string" && validUnicode(v)) return v;
  bad(strict, "An id must be a non-empty string."); return make();
}
export function emptyRichText(): RichText { return { paragraphs: [] }; }
export function sameAttrs(a: Record<string, unknown> | Run, b: Record<string, unknown> | Run): boolean {
  const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>;
  const keys = Object.keys(aa).filter(k => k !== "text" && k !== "runs");
  return keys.length === Object.keys(bb).filter(k => k !== "text" && k !== "runs").length && keys.every(k => aa[k] === bb[k]);
}
function attrs(value: Record<string, unknown>, keys: readonly string[], strict: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = value[k];
    if (v == null || v === false || v === "" || (k === "indent" && numberValue(v) === 0)) continue;
    let n: unknown;
    if (["bold", "italic", "underline", "strike", "code"].includes(k)) n = v === true ? true : undefined;
    else if (["color", "highlight", "font", "link"].includes(k)) n = stringValue(v) || undefined;
    else if (k === "align") n = ["left", "center", "right", "justify"].includes(v as string) ? v : undefined;
    else if (k === "list") n = ["bullet", "ordered"].includes(v as string) ? v : undefined;
    else {
      const x = numberValue(v);
      if (x !== undefined && x > 0 && (!(k === "indent" || k === "heading") || (Number.isInteger(x) && x <= (k === "indent" ? 8 : 3)))) n = x;
    }
    if (n === undefined) bad(strict, `The ${k} attribute has an invalid value.`); else out[k] = n;
  }
  return out;
}
export function cleanInlineAttrs(v: Record<string, unknown>): Omit<Run, "text"> { return attrs(v, INLINE_ATTRS, false); }
export function cleanParagraphAttrs(v: Record<string, unknown>): Omit<Paragraph, "runs"> { return attrs(v, PARAGRAPH_ATTRS, false); }
export function normalizeRichText(value: unknown, strict = false): RichText {
  if (value == null) return emptyRichText();
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    const text = stringValue(value);
    if (text !== undefined) return richTextFromPlain(text);
    bad(strict, "Expected valid Unicode text or a number expressible without an exponent."); return emptyRichText();
  }
  const rt = obj(value, strict); checkKeys(rt, ["paragraphs"], strict);
  const paragraphs: Paragraph[] = [];
  for (const raw of list(rt.paragraphs, strict)) {
    const p = obj(raw, strict); checkKeys(p, ["runs", ...PARAGRAPH_ATTRS], strict);
    const pattrs = attrs(p, PARAGRAPH_ATTRS, strict);
    let runs: Run[] = [];
    const push = () => { paragraphs.push({ ...pattrs, runs }); runs = []; };
    for (const rawRun of list(p.runs, strict)) {
      if (rawRun == null) continue;
      const r = obj(rawRun, strict); checkKeys(r, ["text", ...INLINE_ATTRS], strict);
      const ra = attrs(r, INLINE_ATTRS, strict);
      str(r.text, "", strict).split("\n").forEach((piece, i) => {
        if (i) push();
        if (piece) { const run = { ...ra, text: piece }; const prev = runs.at(-1); if (prev && sameAttrs(prev, run)) prev.text += piece; else runs.push(run); }
      });
    }
    push();
  }
  return { paragraphs };
}
export function richTextFromPlain(text: string, para: Omit<Paragraph, "runs"> = {}, run: Omit<Run, "text"> = {}): RichText {
  return { paragraphs: text.split("\n").map(line => ({ ...para, runs: line ? [{ ...run, text: line }] : [] })) };
}
export function richTextToPlain(rt: RichText | null | undefined): string { return rt ? rt.paragraphs.map(p => p.runs.map(r => r.text).join("")).join("\n") : ""; }
export function normalizeCell(value: unknown, strict = false): TableCell {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return { text: normalizeRichText(value, strict), fill: null };
  const c = obj(value, strict); checkKeys(c, ["text", "fill"], strict);
  return { text: normalizeRichText(c.text, strict), fill: nullableString(c.fill, strict) };
}
export function tableCount(v: unknown, d: number): number { return num(v, Math.max(1, Math.min(100, d || 2)), false, n => Number.isInteger(n) && n >= 1 && n <= 100); }
function dimension(v: unknown, d: number, strict: boolean): number { return num(v, Math.max(1, Math.min(100, d || 2)), strict, n => Number.isInteger(n) && n >= 1 && n <= 100); }
function fitArray(v: unknown, n: number, total: number, strict: boolean): number[] {
  const fallback = () => Array(n).fill(total / n) as number[];
  if (v == null) return fallback();
  if (!Array.isArray(v) || v.length !== n || v.some(x => numberValue(x) === undefined)) { bad(strict, `Expected exactly ${n} numbers.`); return fallback(); }
  return v.map(x => numberValue(x)!);
}
export function normalizeElement(input: ElementInput | Element, makeId: () => string = newElementId, strict = false): Element {
  const e = obj(input, strict);
  let kind = e.kind as Element["kind"];
  if (!ELEMENT_KINDS.includes(kind)) { bad(strict, "The element kind is missing or unknown.", "unknown_element_kind"); kind = "text"; }
  checkKeys(e, [...BASE_KEYS, ...KIND_KEYS[kind]], strict);
  const base = { id: id(e.id, makeId, strict), kind, x: num(e.x, 0, strict), y: num(e.y, 0, strict), w: num(e.w, 400, strict), h: num(e.h, 200, strict), rotation: num(e.rotation, 0, strict), locked: bool(e.locked, false, strict), group: nullableString(e.group, strict), link: nullableString(e.link, strict), animation: nullableObject(e.animation, strict) as Element["animation"], style: objectValue(e.style, strict) };
  switch (kind) {
    case "text": return { ...base, kind, text: normalizeRichText(e.text, strict) };
    case "shape": return { ...base, kind, shape: en(e.shape, SHAPES, "rect", strict), text: normalizeRichText(e.text, strict) };
    case "image": return { ...base, kind, src: str(e.src, "", strict), alt: str(e.alt, "", strict), fit: en(e.fit, ["cover", "contain", "fill"], "contain", strict) as "contain" };
    case "video": case "audio": {
      const media = { ...base, kind, src: str(e.src, "", strict), alt: str(e.alt, "", strict), autoplay: bool(e.autoplay, false, strict), loop: bool(e.loop, false, strict), muted: bool(e.muted, false, strict) };
      return kind === "video" ? { ...media, kind, poster: nullableString(e.poster, strict) } : { ...media, kind };
    }
    case "table": {
      const grid = list(e.cells, strict).map(row => list(row, strict));
      const rows = dimension(e.rows, grid.length, strict), cols = dimension(e.cols, Math.max(0, ...grid.map(r => r.length)), strict);
      if (grid.length > rows || grid.some(r => r.length > cols)) bad(strict, "The cell grid is larger than the table.");
      const cells = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => normalizeCell(grid[r]?.[c], strict)));
      return { ...base, kind, rows, cols, cells, colWidths: fitArray(e.colWidths, cols, base.w, strict), rowHeights: fitArray(e.rowHeights, rows, base.h, strict), headerRow: bool(e.headerRow, false, strict) };
    }
    case "chart": {
      const c = objectValue(e.chart, strict);
      const chart = { ...c, type: en(c.type, ["bar", "column", "line", "area", "pie", "donut", "scatter"], "column", strict), labels: list(c.labels, strict).map(x => str(x, "", strict)), series: list(c.series, strict).map(raw => { const s = objectValue(raw, strict); return { ...s, name: str(s.name, "", strict), values: list(s.values, strict).map(v => num(v, 0, strict)) }; }), legend: bool(c.legend, true, strict) };
      return { ...base, kind, chart: chart as import("./types").Chart };
    }
    case "html": return { ...base, kind, html: str(e.html, "", strict), css: str(e.css, "", strict), js: str(e.js, "", strict) };
  }
}
function elements(value: unknown, make: () => string, strict: boolean): Element[] {
  const out: Element[] = [], seen = new Set<string>();
  for (const raw of list(value, strict)) {
    if (!isObject(raw)) { bad(strict, "Each element must be an object."); continue; }
    if (!ELEMENT_KINDS.includes(raw.kind as Element["kind"])) { bad(strict, "The element kind is missing or unknown.", "unknown_element_kind"); continue; }
    const e = normalizeElement(raw as ElementInput, make, strict);
    if (seen.has(e.id)) { bad(strict, `Element id ${e.id} is repeated.`, "duplicate_id"); continue; }
    seen.add(e.id); out.push(e);
  }
  return out;
}
export function normalizeSlide(input: SlideInput | Slide, makeId: () => string = newSlideId, makeElementId: () => string = newElementId, strict = false): Slide {
  const s = obj(input, strict); checkKeys(s, SLIDE_KEYS, strict);
  const slideId = id(s.id, makeId, strict);
  if (slideId === "master") bad(strict, "A slide cannot be called master.", "reserved_id");
  return { id: slideId, layout: en(s.layout, LAYOUTS, "blank", strict), background: nullableObject(s.background, strict) as Slide["background"], skipped: bool(s.skipped, false, strict), section: nullableString(s.section, strict), hideMaster: bool(s.hideMaster, false, strict), transition: nullableObject(s.transition, strict) as Slide["transition"], notes: str(s.notes, "", strict), elements: elements(s.elements, makeElementId, strict) };
}
export function normalizeTheme(value: unknown, strict = false): Theme {
  const t = objectValue(value, strict), fonts = objectValue(t.fonts, strict), colors = objectValue(t.colors, strict);
  return { ...t, name: str(t.name, DEFAULT_THEME.name, strict), fonts: { ...fonts, heading: str(fonts.heading, DEFAULT_THEME.fonts.heading, strict), body: str(fonts.body, DEFAULT_THEME.fonts.body, strict) }, colors: { ...colors, ...Object.fromEntries(Object.entries(DEFAULT_THEME.colors).map(([k, d]) => [k, str(colors[k], d, strict)])) }, customFonts: list(t.customFonts, strict) } as unknown as Theme;
}
export function normalizeSize(value: unknown, strict = false): Size {
  const s = obj(value, strict); checkKeys(s, ["width", "height"], strict);
  return { width: num(s.width, DEFAULT_SIZE.width, strict, n => n > 0), height: num(s.height, DEFAULT_SIZE.height, strict, n => n > 0) };
}
export function normalizeDeck(input: DeckInput, strict = false): DeckJson {
  if (!isObject(input)) bad(strict, "A deck must be a JSON object.");
  const d = obj(input, strict); checkKeys(d, ["id", "title", "version", "size", "theme", "master", "slides"], strict);
  const master = obj(d.master, strict); checkKeys(master, ["elements"], strict);
  const ids = new Set<string>(), allIds = new Set<string>();
  // Reserve explicitly provided ids before generating any, including ids on later slides.
  const reserve = (value: unknown) => { if (isObject(value) && typeof value.id === "string") allIds.add(value.id); };
  for (const raw of list(d.slides)) { reserve(raw); if (isObject(raw)) list(raw.elements).forEach(reserve); }
  list(master.elements).forEach(reserve);
  const make = (fn: () => string) => { let value: string; do value = fn(); while (allIds.has(value)); allIds.add(value); return value; };
  const slides: Slide[] = [];
  for (const raw of list(d.slides, strict)) {
    if (!isObject(raw)) { bad(strict, "Each slide must be an object."); continue; }
    if (raw.id === "master") { bad(strict, "A slide cannot be called master.", "reserved_id"); continue; }
    const s = normalizeSlide(raw as SlideInput, () => make(newSlideId), () => make(newElementId), strict);
    if (ids.has(s.id)) { bad(strict, `Slide id ${s.id} is repeated.`, "duplicate_id"); continue; }
    ids.add(s.id); slides.push(s);
  }
  const out: DeckJson = { size: normalizeSize(d.size, strict), theme: normalizeTheme(d.theme, strict), master: { elements: elements(master.elements, () => make(newElementId), strict) }, slides };
  if (typeof d.id === "string") out.id = d.id;
  if (typeof d.title === "string") out.title = d.title;
  if (typeof d.version === "number" && Number.isFinite(d.version)) out.version = d.version;
  return out;
}
export class DeckError extends Error {
  constructor(public code: string, message: string, public hint: string) { super(message); this.name = "DeckError"; }
  toJSON() { return { error: { code: this.code, message: this.message, hint: this.hint } }; }
}
