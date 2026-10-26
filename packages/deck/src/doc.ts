import * as Y from "yjs";
import { normalizeDeck, normalizeElement, normalizeRichText, normalizeSlide, normalizeTheme, normalizeSize, normalizeCell, canonicalValue, stringValue, tableCount } from "./normalize";
import { setPlainText, setRichText, yTextToRichText } from "./richtext";
import type { DeckInput, DeckJson, Element, RichText, Slide, SlideInput, TableCell } from "./types";

// Deck JSON <-> Yjs document, with the exact layout of docs/architecture.md ("Yjs layout").
//
// Y.Doc
//   "deck":   Y.Map   size, theme (plain JSON), version: 1
//   "order":  Y.Array<string>
//   "slides": Y.Map<slideId | "master", Y.Map>
//
// Keys are written in a fixed order (the order of the canonical JSON) so documents built from the same JSON look alike.

export const SCHEMA_VERSION = 1;
export const MASTER = "master";

const COMMON_KEYS = ["id", "kind", "x", "y", "w", "h", "rotation", "locked", "group", "link", "animation", "style"] as const;
const KIND_KEYS: Record<Element["kind"], string[]> = {
  text: ["text"],
  shape: ["shape", "text"],
  image: ["src", "alt", "fit"],
  video: ["src", "alt", "autoplay", "loop", "muted", "poster"],
  audio: ["src", "alt", "autoplay", "loop", "muted"],
  table: ["rows", "cols", "colWidths", "rowHeights", "headerRow", "cells"],
  chart: ["chart"],
  html: ["html", "css", "js"],
};
const RICH_FIELDS = new Set(["text"]);
const PLAIN_TEXT_FIELDS = new Set(["html", "css", "js"]);
const SLIDE_PLAIN_KEYS = ["layout", "background", "skipped", "section", "hideMaster", "transition"] as const;

export function elementKeys(kind: Element["kind"]): string[] {
  return [...COMMON_KEYS, ...KIND_KEYS[kind]];
}

export function deckMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("deck");
}
export function orderArray(doc: Y.Doc): Y.Array<string> {
  return doc.getArray<string>("order");
}
export function slidesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>("slides");
}

/** Existing root access without creating roots; decoded generic roots are specialized only when present. */
export function existingMap(doc: Y.Doc, name: string): Y.Map<unknown> | undefined {
  const value = doc.share.get(name);
  return value?.constructor === Y.AbstractType ? doc.getMap(name) : value instanceof Y.Map ? value : undefined;
}
export function existingArray(doc: Y.Doc, name: string): Y.Array<string> | undefined {
  const value = doc.share.get(name);
  return value?.constructor === Y.AbstractType ? doc.getArray<string>(name) : value instanceof Y.Array ? value : undefined;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function clone<T>(v: T): T {
  return canonicalValue(v) as T;
}

// ---------------------------------------------------------------- reading

export function readRich(v: unknown): RichText {
  return v instanceof Y.Text ? yTextToRichText(v) : stringValue(v) !== undefined ? normalizeRichText(v) : { paragraphs: [] };
}

function readPlain(v: unknown): string {
  return v instanceof Y.Text ? v.toString() : stringValue(v) ?? "";
}

export function readElement(m: Y.Map<unknown>, mapKey?: string): Element | null {
  const kind = m.get("kind") as Element["kind"];
  if (typeof kind !== "string" || !Object.hasOwn(KIND_KEYS, kind)) return null;
  const raw: Record<string, unknown> = {};
  for (const key of elementKeys(kind)) {
    const v = m.get(key);
    if (v === undefined) continue;
    if (RICH_FIELDS.has(key)) raw[key] = readRich(v);
    else if (PLAIN_TEXT_FIELDS.has(key)) raw[key] = readPlain(v);
    else if (key === "cells") raw[key] = readCells(v, m.get("rows") as number, m.get("cols") as number);
    else raw[key] = clone(v);
  }
  if (kind === "table") {
    const cells = raw.cells as TableCell[][];
    raw.rows = cells.length; raw.cols = cells[0]?.length ?? 2;
  }
  raw.id = mapKey ?? (typeof raw.id === "string" && raw.id ? raw.id : "e_missing");
  return normalizeElement(raw as unknown as Element);
}

function readCells(v: unknown, rows: number, cols: number): TableCell[][] {
  const out: TableCell[][] = [];
  const cells = v instanceof Y.Map ? (v as Y.Map<Y.Map<unknown>>) : null;
  let inferredRows = 0, inferredCols = 0;
  if (cells) for (const key of cells.keys()) {
    const match = /^(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(key);
    if (match) { inferredRows = Math.max(inferredRows, Math.min(100, Number(match[1]) + 1)); inferredCols = Math.max(inferredCols, Math.min(100, Number(match[2]) + 1)); }
  }
  rows = tableCount(rows, inferredRows); cols = tableCount(cols, inferredCols);
  for (let r = 0; r < rows; r++) {
    const row: TableCell[] = [];
    for (let c = 0; c < cols; c++) {
      const cell = cells?.get(`${r}:${c}`);
      if (cell instanceof Y.Map) {
        const fill = cell.get("fill");
        row.push(normalizeCell({ text: readRich(cell.get("text")), fill: clone(fill) }));
      } else row.push({ text: { paragraphs: [] }, fill: null });
    }
    out.push(row);
  }
  return out;
}

function readElements(slide: Y.Map<unknown>): Element[] {
  const els = slide.get("elements");
  const order = slide.get("elementOrder");
  if (!(els instanceof Y.Map)) return [];
  const ids: string[] = order instanceof Y.Array ? (order.toArray() as string[]) : [];
  const seen = new Set<string>();
  const out: Element[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || seen.has(id)) continue; // concurrent reorders can leave an id twice; the first wins
    seen.add(id);
    const m = els.get(id);
    if (m instanceof Y.Map) {
      const e = readElement(m as Y.Map<unknown>, id);
      if (e) out.push(e);
    }
  }
  return out;
}

export function readSlide(m: Y.Map<unknown>, mapKey?: string): Slide {
  const raw: Record<string, unknown> = { id: mapKey ?? (typeof m.get("id") === "string" ? m.get("id") : "s_missing") };
  for (const k of SLIDE_PLAIN_KEYS) raw[k] = clone(m.get(k));
  raw.notes = readPlain(m.get("notes"));
  const slide = normalizeSlide(raw as SlideInput);
  slide.elements = readElements(m);
  return slide;
}

/** The deck as canonical JSON. `meta` adds the id/title/version that live outside the document. */
export function docToJson(doc: Y.Doc, meta: { id?: string; title?: string; version?: number } = {}): DeckJson {
  const deck = existingMap(doc, "deck");
  const slides = existingMap(doc, "slides");
  const order = existingArray(doc, "order")?.toArray() ?? [];
  const out: DeckJson = {
    ...(meta.id !== undefined ? { id: meta.id } : {}),
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    ...(meta.version !== undefined ? { version: meta.version } : {}),
    size: normalizeSize(clone(deck?.get("size"))),
    theme: normalizeTheme(clone(deck?.get("theme"))),
    master: { elements: [] },
    slides: [],
  };
  const master = slides?.get(MASTER);
  if (master instanceof Y.Map) out.master.elements = readElements(master);
  const seen = new Set<string>();
  for (const id of order) {
    if (typeof id !== "string" || seen.has(id) || id === MASTER) continue;
    seen.add(id);
    const m = slides?.get(id);
    if (m instanceof Y.Map) out.slides.push(readSlide(m, id));
  }
  return out;
}

// ---------------------------------------------------------------- writing

function setIfChanged(m: Y.Map<unknown>, key: string, value: unknown): void {
  const cur = m.get(key);
  if (cur instanceof Y.AbstractType || !deepEqual(cur, value)) m.set(key, clone(value));
}

function writeRichField(m: Y.Map<unknown>, key: string, rt: RichText): void {
  const cur = m.get(key);
  if (cur instanceof Y.Text) setRichText(cur, rt);
  else {
    const t = new Y.Text();
    m.set(key, t);
    setRichText(t, rt);
  }
}

function writePlainField(m: Y.Map<unknown>, key: string, value: string): void {
  const cur = m.get(key);
  if (cur instanceof Y.Text) setPlainText(cur, value);
  else {
    const t = new Y.Text();
    m.set(key, t);
    setPlainText(t, value);
  }
}

function writeCells(m: Y.Map<unknown>, cells: TableCell[][]): void {
  let map = m.get("cells");
  if (!(map instanceof Y.Map)) {
    map = new Y.Map();
    m.set("cells", map);
  }
  const cm = map as Y.Map<Y.Map<unknown>>;
  const want = new Set<string>();
  cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      const key = `${r}:${c}`;
      want.add(key);
      let cmap = cm.get(key);
      if (!(cmap instanceof Y.Map)) {
        cmap = new Y.Map();
        cm.set(key, cmap);
      }
      for (const name of Array.from(cmap.keys())) if (!["text", "fill"].includes(name)) cmap.delete(name);
      writeRichField(cmap, "text", cell.text);
      setIfChanged(cmap, "fill", cell.fill ?? null);
    }),
  );
  for (const key of Array.from(cm.keys())) if (!want.has(key)) cm.delete(key);
}

/** Write one element's fields into its Y.Map, changing only what differs. */
export function writeElement(m: Y.Map<unknown>, el: Element): void {
  const e = el as unknown as Record<string, unknown>;
  const allowed = new Set(elementKeys(el.kind));
  for (const key of Array.from(m.keys())) if (!allowed.has(key)) m.delete(key);
  for (const key of elementKeys(el.kind)) {
    const v = e[key];
    if (RICH_FIELDS.has(key)) writeRichField(m, key, v as RichText);
    else if (PLAIN_TEXT_FIELDS.has(key)) writePlainField(m, key, v as string);
    else if (key === "cells") writeCells(m, v as TableCell[][]);
    else setIfChanged(m, key, v === undefined ? null : v);
  }
}

function writeArray(arr: Y.Array<string>, ids: string[]): void {
  const cur = arr.toArray();
  if (deepEqual(cur, ids)) return;
  // Keep the common start and end; replace the middle. Ids are cheap strings; content lives in the maps.
  let p = 0;
  while (p < cur.length && p < ids.length && cur[p] === ids[p]) p++;
  let s = 0;
  while (s < cur.length - p && s < ids.length - p && cur[cur.length - 1 - s] === ids[ids.length - 1 - s]) s++;
  if (cur.length - p - s > 0) arr.delete(p, cur.length - p - s);
  const ins = ids.slice(p, ids.length - s);
  if (ins.length) arr.insert(p, ins);
}

/** Make a slide's (or the master's) elements match `elements` (back to front). */
export function writeElements(slide: Y.Map<unknown>, elements: Element[]): void {
  let els = slide.get("elements");
  if (!(els instanceof Y.Map)) {
    els = new Y.Map();
    slide.set("elements", els);
  }
  let order = slide.get("elementOrder");
  if (!(order instanceof Y.Array)) {
    order = new Y.Array<string>();
    slide.set("elementOrder", order);
  }
  const em = els as Y.Map<Y.Map<unknown>>;
  const want = new Set(elements.map((e) => e.id));
  for (const id of Array.from(em.keys())) if (!want.has(id)) em.delete(id);
  for (const el of elements) {
    let m = em.get(el.id);
    if (m instanceof Y.Map && m.get("kind") !== el.kind) {
      em.delete(el.id);
      m = undefined;
    }
    if (!(m instanceof Y.Map)) {
      m = new Y.Map();
      em.set(el.id, m);
    }
    writeElement(m, el);
  }
  writeArray(order as Y.Array<string>, elements.map((e) => e.id));
}

/** Write a slide's fields into its Y.Map, changing only what differs. */
export function writeSlide(m: Y.Map<unknown>, slide: Slide): void {
  const allowed = new Set(["id", ...SLIDE_PLAIN_KEYS, "notes", "elements", "elementOrder"]);
  for (const key of Array.from(m.keys())) if (!allowed.has(key)) m.delete(key);
  setIfChanged(m, "id", slide.id);
  for (const k of SLIDE_PLAIN_KEYS) setIfChanged(m, k, (slide as unknown as Record<string, unknown>)[k] ?? null);
  writePlainField(m, "notes", slide.notes ?? "");
  writeElements(m, slide.elements);
}

function writeMaster(slides: Y.Map<Y.Map<unknown>>, elements: Element[]): void {
  let m = slides.get(MASTER);
  if (!(m instanceof Y.Map)) {
    m = new Y.Map();
    slides.set(MASTER, m);
  }
  for (const key of Array.from(m.keys())) if (!["id", "elements", "elementOrder"].includes(key)) m.delete(key);
  setIfChanged(m, "id", MASTER);
  writeElements(m, elements);
}

/**
 * Reconcile a document to `json`: only what differs is changed (text through minimal diffs), all in one transaction.
 * Used to build a document from JSON, to apply a pushed folder, and to restore a version.
 */
export function applyJsonToDoc(doc: Y.Doc, input: DeckInput, origin?: unknown): void {
  const json = normalizeDeck(input, true);
  doc.transact(() => {
    const deck = deckMap(doc);
    for (const key of Array.from(deck.keys())) if (!["size", "theme", "version"].includes(key)) deck.delete(key);
    setIfChanged(deck, "size", json.size);
    setIfChanged(deck, "theme", json.theme);
    setIfChanged(deck, "version", SCHEMA_VERSION);
    const slides = slidesMap(doc);
    writeMaster(slides, json.master.elements);
    const ids = new Set(json.slides.map((s) => s.id));
    for (const id of Array.from(slides.keys())) if (id !== MASTER && !ids.has(id)) slides.delete(id);
    for (const s of json.slides) {
      let m = slides.get(s.id);
      if (!(m instanceof Y.Map)) {
        m = new Y.Map();
        slides.set(s.id, m);
      }
      writeSlide(m, s);
    }
    writeArray(orderArray(doc), json.slides.map((s) => s.id));
  }, origin);
}

/** A new Y.Doc holding `json`. Pass `clientID` for reproducible updates (tests, fixtures). */
export function jsonToDoc(json: DeckInput, opts: { clientID?: number } = {}): Y.Doc {
  const doc = new Y.Doc();
  if (opts.clientID !== undefined) doc.clientID = opts.clientID;
  applyJsonToDoc(doc, json);
  return doc;
}

/** Encode / decode helpers so callers don't need their own yjs import. */
export function encodeDoc(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

export function docFromUpdate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}
