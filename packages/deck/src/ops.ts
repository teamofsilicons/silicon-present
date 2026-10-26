import * as Y from "yjs";
import { MASTER, deepEqual, orderArray, readElement, readSlide, readRich, slidesMap, deckMap, writeElement, writeSlide, elementKeys, existingMap, existingArray } from "./doc";
import { newElementId, newSlideId, uniqueId } from "./ids";
import { DeckError, normalizeElement, normalizeSlide, normalizeTheme, normalizeSize, richTextFromPlain, isObject, checkKeys, validUnicode, stringValue } from "./normalize";
import { setPlainText, setRichText, replaceTextRange, richTextToPieces } from "./richtext";
import type { Element, ElementInput, Slide, SlideInput, Size, Theme } from "./types";

export type Op =
  | { op: "update_deck"; set: { size?: Size | null; theme?: Partial<Theme> | null } }
  | { op: "add_slide"; after?: string | null; slide?: SlideInput | null }
  | { op: "update_slide"; slide: string; set: Partial<Pick<Slide, "layout" | "background" | "skipped" | "section" | "hideMaster" | "transition" | "notes">> }
  | { op: "move_slide"; slide: string; after?: string | null }
  | { op: "delete_slide"; slide: string }
  | { op: "add_element"; slide: string; element: ElementInput; z?: number | null }
  | { op: "update_element"; slide: string; element: string; set: Record<string, unknown> }
  | { op: "replace_text"; slide: string; element?: string | null; field?: string | null; find: string; replace: string; all?: boolean | null; matchCase?: boolean | null }
  | { op: "reorder_element"; slide: string; element: string; to: "front" | "back" | "forward" | "backward" | number }
  | { op: "delete_element"; slide: string; element: string };
export interface OpsResult { slides: string[]; elements: string[]; touched: string[]; replaced: number }
function fail(code: string, message: string, hint = "Read the current deck and use the documented edit op fields."): never { throw new DeckError(code, message, hint); }

export function getSlideMap(doc: Y.Doc, slideId: string, allowMaster = true): Y.Map<unknown> {
  if (!allowMaster && slideId === MASTER) fail("invalid_op", "This op cannot target the master.");
  const m = existingMap(doc, "slides")?.get(slideId);
  if (!(m instanceof Y.Map) || (slideId !== MASTER && !existingArray(doc, "order")?.toArray().includes(slideId))) fail("slide_not_found", `There is no slide ${slideId} in this deck.`);
  return m;
}
export function getElementMap(doc: Y.Doc, slideId: string, elementId: string): Y.Map<unknown> {
  const s = getSlideMap(doc, slideId), els = s.get("elements"), m = els instanceof Y.Map ? els.get(elementId) : undefined;
  const order = s.get("elementOrder");
  if (!(m instanceof Y.Map) || !(order instanceof Y.Array) || !order.toArray().includes(elementId) || !readElement(m, elementId)) fail("element_not_found", `There is no element ${elementId} on slide ${slideId}.`);
  return m;
}
function elementOrderOf(slide: Y.Map<unknown>): Y.Array<string> {
  const old = slide.get("elementOrder"); if (old instanceof Y.Array) return old;
  const order = new Y.Array<string>(); slide.set("elementOrder", order); return order;
}
function elementsOf(slide: Y.Map<unknown>): Y.Map<Y.Map<unknown>> {
  const old = slide.get("elements"); if (old instanceof Y.Map) return old;
  const els = new Y.Map<Y.Map<unknown>>(); slide.set("elements", els); return els;
}
function allElementIds(doc: Y.Doc): Set<string> {
  const out = new Set<string>();
  if (doc.share.has("slides")) slidesMap(doc).forEach(s => { if (!(s instanceof Y.Map)) return; const els = s.get("elements"); if (els instanceof Y.Map) for (const key of els.keys()) out.add(key); });
  return out;
}
function visibleElements(slide: Y.Map<unknown>): string[] { return readSlide(slide).elements.map(e => e.id); }
function removeAll(order: Y.Array<string>, id: string): void { const ids = order.toArray(); for (let i = ids.length - 1; i >= 0; i--) if (ids[i] === id) order.delete(i, 1); }
interface Target { slide: string; element: string | null; field: string; rich: boolean; value: string }
function fieldOwner(doc: Y.Doc, slideId: string, elementId: string | null | undefined, field: string, create: boolean): { map: Y.Map<unknown> | undefined; key: string; rich: boolean } {
  if (!elementId) {
    if (field !== "notes" || slideId === MASTER) fail("invalid_op", "Only a regular slide's notes can be named without an element.");
    return { map: getSlideMap(doc, slideId, false), key: "notes", rich: false };
  }
  if (field === "notes") fail("invalid_op", "Notes belong to a slide, not an element.");
  const map = getElementMap(doc, slideId, elementId), el = readElement(map, elementId)!;
  const cell = /^cell:(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(field);
  if (cell && el.kind === "table") {
    const r = Number(cell[1]), c = Number(cell[2]);
    if (r >= el.rows || c >= el.cols) fail("cell_not_found", `The table has no cell ${r}:${c}.`);
    let cells = map.get("cells");
    if (!(cells instanceof Y.Map)) { if (!create) return { map: undefined, key: "text", rich: true }; cells = new Y.Map(); map.set("cells", cells); }
    let owner = (cells as Y.Map<unknown>).get(`${r}:${c}`);
    if (!(owner instanceof Y.Map)) { if (!create) return { map: undefined, key: "text", rich: true }; owner = new Y.Map(); (cells as Y.Map<unknown>).set(`${r}:${c}`, owner); (owner as Y.Map<unknown>).set("fill", null); }
    return { map: owner as Y.Map<unknown>, key: "text", rich: true };
  }
  if ((field === "text" && (el.kind === "text" || el.kind === "shape")) || (["html", "css", "js"].includes(field) && el.kind === "html")) return { map, key: field, rich: field === "text" };
  fail("field_not_found", `Element ${elementId} has no text field "${field}".`);
}
/** Pure lookup. A missing or malformed field is reported; only ensureTextField repairs it during a write. */
export function getTextField(doc: Y.Doc, slideId: string, elementId: string | null | undefined, field = "text"): Y.Text {
  const owner = fieldOwner(doc, slideId, elementId, field, false), t = owner.map?.get(owner.key);
  if (!(t instanceof Y.Text)) fail("field_not_found", `The ${field} field has no Y.Text.`);
  return t;
}
/** Writers repair a malformed text field using exactly the text a reader sees there. */
export function ensureTextField(doc: Y.Doc, slideId: string, elementId: string | null | undefined, field = "text"): Y.Text {
  const owner = fieldOwner(doc, slideId, elementId, field, true), old = owner.map?.get(owner.key);
  if (old instanceof Y.Text) return old;
  const t = new Y.Text(); owner.map!.set(owner.key, t);
  if (owner.rich) setRichText(t, readRich(old)); else setPlainText(t, stringValue(old) ?? "");
  return t;
}
function readTarget(doc: Y.Doc, slide: string, element: string | null, field: string): Target {
  const owner = fieldOwner(doc, slide, element, field, false), value = owner.map?.get(owner.key);
  return { slide, element, field, rich: owner.rich, value: value instanceof Y.Text ? value.toString() : owner.rich ? richTextToPieces(readRich(value)).map(([s]) => s).join("") : stringValue(value) ?? "" };
}
function textTargets(doc: Y.Doc, op: Extract<Op, { op: "replace_text" }>): Target[] {
  const slide = getSlideMap(doc, op.slide);
  if (op.field != null) return [readTarget(doc, op.slide, op.element ?? null, op.field)];
  const out: Target[] = [];
  if (!op.element && op.slide !== MASTER) out.push(readTarget(doc, op.slide, null, "notes"));
  const elements = op.element ? [readElement(getElementMap(doc, op.slide, op.element), op.element)!] : readSlide(slide, op.slide).elements;
  for (const e of elements) {
    let fields: string[] = [];
    if (e.kind === "text" || e.kind === "shape") fields = ["text"];
    else if (e.kind === "html") fields = ["html", "css", "js"];
    else if (e.kind === "table") fields = e.cells.flatMap((row, r) => row.map((_, c) => `cell:${r}:${c}`));
    for (const field of fields) out.push(readTarget(doc, op.slide, e.id, field));
  }
  return out;
}
const SHAPES: Record<string, string[]> = {
  update_deck: ["op", "set"], add_slide: ["op", "after", "slide"], update_slide: ["op", "slide", "set"], move_slide: ["op", "slide", "after"], delete_slide: ["op", "slide"], add_element: ["op", "slide", "element", "z"], update_element: ["op", "slide", "element", "set"], replace_text: ["op", "slide", "element", "field", "find", "replace", "all", "matchCase"], reorder_element: ["op", "slide", "element", "to"], delete_element: ["op", "slide", "element"],
};
function validateOp(raw: unknown): Op {
  if (!isObject(raw) || typeof raw.op !== "string" || !Object.hasOwn(SHAPES, raw.op)) fail("invalid_op", "Expected a known edit op object.");
  const op = raw.op;
  for (const key of Object.keys(raw)) if (!SHAPES[op]!.includes(key)) fail("invalid_op", `The ${op} op does not take ${key}.`);
  const string = (key: string, nonempty = true) => { const v = raw[key]; if (typeof v !== "string" || !validUnicode(v) || (nonempty && !v)) fail("invalid_op", `${key} must be ${nonempty ? "a non-empty" : "a"} Unicode string.`); };
  if (!["add_slide", "update_deck"].includes(op)) string("slide");
  if (["update_element", "reorder_element", "delete_element"].includes(op)) string("element");
  if (["update_deck", "update_slide", "update_element"].includes(op) && !isObject(raw.set)) fail("invalid_op", "set must be an object.");
  if (op === "add_element" && !isObject(raw.element)) fail("invalid_op", "element must be an object.");
  if (op === "add_slide" && raw.slide != null && !isObject(raw.slide)) fail("invalid_op", "slide must be an object.");
  if (raw.after != null) string("after");
  if (raw.after === MASTER || (["update_slide", "move_slide", "delete_slide"].includes(op) && raw.slide === MASTER)) fail("invalid_op", "The master cannot be used by slide ops or as after.");
  const whole = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (op === "add_element" && raw.z != null && !whole(raw.z)) fail("invalid_op", "z must be a whole number at least zero.");
  if (op === "reorder_element" && !(["front", "back", "forward", "backward"].includes(raw.to as string) || whole(raw.to))) fail("invalid_op", "to must be a position or a whole number at least zero.");
  if (op === "move_slide" && raw.after === raw.slide) fail("invalid_op", "A slide cannot move after itself.");
  if (op === "replace_text") {
    string("find"); string("replace", false);
    if (raw.element != null) string("element"); if (raw.field != null) string("field", false);
    for (const key of ["all", "matchCase"]) if (raw[key] != null && typeof raw[key] !== "boolean") fail("invalid_op", `${key} must be true or false.`);
    if (raw.field != null && ((raw.field !== "notes" && raw.element == null) || (raw.field === "notes" && (raw.element != null || raw.slide === MASTER)))) fail("invalid_op", "The requested field does not belong to that target.");
  }
  return { ...raw } as Op;
}
function checkAfter(doc: Y.Doc, after: string | null | undefined): void { if (after != null) getSlideMap(doc, after, false); }
function placeSlide(doc: Y.Doc, id: string, after: string | null | undefined): void {
  const order = orderArray(doc); removeAll(order, id);
  order.insert(after === null ? 0 : after === undefined ? order.length : order.toArray().indexOf(after) + 1, [id]);
}
function placeElement(slide: Y.Map<unknown>, id: string, index: number): void {
  const ids = visibleElements(slide).filter(x => x !== id), anchor = ids[index];
  const order = elementOrderOf(slide); removeAll(order, id);
  order.insert(anchor === undefined ? order.length : order.toArray().indexOf(anchor), [id]);
}
function applyOne(doc: Y.Doc, op: Op, res: OpsResult): void {
  const touch = (id: string) => { if (!res.touched.includes(id)) res.touched.push(id); };
  switch (op.op) {
    case "update_deck": {
      checkKeys(op.set, ["size", "theme"]);
      const size = "size" in op.set ? normalizeSize(op.set.size, true) : undefined;
      const theme = "theme" in op.set ? normalizeTheme(op.set.theme, true) : undefined;
      const deck = deckMap(doc);
      if (size && !deepEqual(deck.get("size"), size)) deck.set("size", size);
      if (theme && !deepEqual(deck.get("theme"), theme)) deck.set("theme", theme);
      return;
    }
    case "add_slide": {
      checkAfter(doc, op.after);
      const taken = new Set(slidesMap(doc).keys()), existing = allElementIds(doc), reserved = new Set(existing);
      const input = op.slide ?? {};
      if (typeof input.id === "string" && taken.has(input.id)) fail(input.id === MASTER ? "reserved_id" : "slide_exists", `Slide ${input.id} already exists.`);
      if (Array.isArray(input.elements)) for (const e of input.elements) if (isObject(e) && typeof e.id === "string") reserved.add(e.id);
      const slide = normalizeSlide(input, () => uniqueId(newSlideId, taken), () => { const id = uniqueId(newElementId, reserved); reserved.add(id); return id; }, true);
      for (const e of slide.elements) if (existing.has(e.id)) fail("element_exists", `Element ${e.id} already exists in the deck.`);
      const m = new Y.Map<unknown>(); slidesMap(doc).set(slide.id, m); writeSlide(m, slide); placeSlide(doc, slide.id, op.after);
      op.slide = slide; res.slides.push(slide.id); res.elements.push(...slide.elements.map(e => e.id)); touch(slide.id); return;
    }
    case "update_slide": {
      const m = getSlideMap(doc, op.slide, false); checkKeys(op.set, ["layout", "background", "skipped", "section", "hideMaster", "transition", "notes"]);
      const next = normalizeSlide({ ...readSlide(m, op.slide), ...op.set }, undefined, undefined, true);
      writeSlide(m, next); touch(op.slide); return;
    }
    case "move_slide": getSlideMap(doc, op.slide, false); checkAfter(doc, op.after); placeSlide(doc, op.slide, op.after); touch(op.slide); return;
    case "delete_slide": getSlideMap(doc, op.slide, false); removeAll(orderArray(doc), op.slide); slidesMap(doc).delete(op.slide); touch(op.slide); return;
    case "add_element": {
      const s = getSlideMap(doc, op.slide), taken = allElementIds(doc);
      if (typeof op.element.id === "string" && taken.has(op.element.id)) fail("element_exists", `Element ${op.element.id} already exists in the deck.`);
      const el = normalizeElement(op.element, () => uniqueId(newElementId, taken), true), count = visibleElements(s).length;
      const m = new Y.Map<unknown>(); elementsOf(s).set(el.id, m); writeElement(m, el); placeElement(s, el.id, Math.min(count, op.z ?? count));
      op.element = el; res.elements.push(el.id); touch(op.slide); return;
    }
    case "update_element": {
      const m = getElementMap(doc, op.slide, op.element), cur = readElement(m, op.element)!;
      checkKeys(op.set, elementKeys(cur.kind));
      if (("id" in op.set && op.set.id !== cur.id) || ("kind" in op.set && op.set.kind !== cur.kind)) fail("invalid_field", "An element's id and kind cannot be changed.");
      const merged: Record<string, unknown> = { ...cur, ...op.set };
      if ((cur.kind === "text" || cur.kind === "shape") && (typeof op.set.text === "string" || typeof op.set.text === "number")) {
        const value = stringValue(op.set.text); if (value === undefined) fail("invalid_value", "The text is not valid Unicode text.");
        const first = cur.text.paragraphs[0], { runs: _runs, ...para } = first ?? { runs: [] }, { text: _text, ...run } = first?.runs[0] ?? { text: "" };
        merged.text = richTextFromPlain(value, para, run);
      }
      if (cur.kind === "table") {
        const grid = Array.isArray(op.set.cells) ? op.set.cells : undefined;
        merged.rows = op.set.rows ?? (grid ? grid.length || 2 : cur.rows);
        merged.cols = op.set.cols ?? (grid ? Math.max(0, ...grid.map(r => Array.isArray(r) ? r.length : 0)) || 2 : cur.cols);
        const dimensions = normalizeElement({ ...cur, rows: merged.rows, cols: merged.cols, cells: [], colWidths: null, rowHeights: null } as unknown as Element, undefined, true);
        if (dimensions.kind !== "table") fail("invalid_value", "Expected a table.");
        const { rows, cols } = dimensions; merged.rows = rows; merged.cols = cols;
        if (op.set.cells === undefined) merged.cells = cur.cells.slice(0, rows).map(row => row.slice(0, cols));
        if (op.set.cells === null) merged.cells = [];
        for (const [countKey, spanKey, widthsKey] of [["rows", "h", "rowHeights"], ["cols", "w", "colWidths"]] as const) {
          if (op.set[widthsKey] !== undefined) continue;
          if (merged[countKey] !== cur[countKey]) merged[widthsKey] = null;
          else if (op.set[spanKey] !== undefined) {
            // Geometry is validated before scaling so null resets to its actual default, never to zero.
            const next = normalizeElement({ ...cur, [spanKey]: op.set[spanKey] }, undefined, true);
            merged[widthsKey] = cur[spanKey] === 0 ? null : cur[widthsKey].map(x => x * (next[spanKey] / cur[spanKey]));
          }
        }
      }
      writeElement(m, normalizeElement(merged as unknown as Element, undefined, true)); touch(op.slide); return;
    }
    case "replace_text": {
      const targets = textTargets(doc, op), matches = targets.map(t => ({ target: t, hits: findMatches(t.value, op.find, op.matchCase ?? true) }));
      const total = matches.reduce((n, x) => n + x.hits.length, 0);
      if (!total) { const near = targets.map(t => closestMatch(t.value, op.find)).find(Boolean); fail("text_not_found", `The passage "${op.find}" was not found.`, near ? `The closest passage is "${near}". Copy the exact passage.` : "Read the current text and copy the exact passage."); }
      if (total > 1 && !op.all) fail("text_ambiguous", `The passage "${op.find}" appears ${total} times.`, "Include more surrounding text, or set all to true.");
      for (const { target: t, hits } of matches) if (hits.length) { const text = ensureTextField(doc, t.slide, t.element, t.field); for (const hit of hits.reverse()) replaceTextRange(text, hit.index, hit.length, op.replace, t.rich); }
      res.replaced += total; touch(op.slide); return;
    }
    case "reorder_element": {
      const s = getSlideMap(doc, op.slide); getElementMap(doc, op.slide, op.element);
      const ids = visibleElements(s), from = ids.indexOf(op.element);
      const to = op.to === "front" ? ids.length - 1 : op.to === "back" ? 0 : op.to === "forward" ? from + 1 : op.to === "backward" ? from - 1 : op.to;
      placeElement(s, op.element, Math.max(0, Math.min(ids.length - 1, to))); touch(op.slide); return;
    }
    case "delete_element": { const s = getSlideMap(doc, op.slide); getElementMap(doc, op.slide, op.element); removeAll(elementOrderOf(s), op.element); elementsOf(s).delete(op.element); touch(op.slide); return; }
  }
}
function atIndex<T>(i: number, f: () => T): T {
  try { return f(); } catch (e) { if (e instanceof DeckError) throw new DeckError(e.code, `Op ${i}: ${e.message}`, e.hint); throw e; }
}
/** Validate the whole batch before merging it. atomic:false preserves local UndoManager transactions after preflight. */
export function applyOps(doc: Y.Doc, ops: Op[], origin?: unknown, opts: { atomic?: boolean } = {}): OpsResult {
  if (!Array.isArray(ops)) fail("invalid_op", "ops must be a list.");
  const prepared = ops.map((op, i) => atIndex(i, () => validateOp(op)));
  const result = (): OpsResult => ({ slides: [], elements: [], touched: [], replaced: 0 });
  const res = result(), scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
    scratch.transact(() => prepared.forEach((op, i) => atIndex(i, () => applyOne(scratch, op, res))));
    if (opts.atomic === false) doc.transact(() => { const local = result(); prepared.forEach((op, i) => atIndex(i, () => applyOne(doc, op, local))); }, origin);
    else Y.applyUpdate(doc, Y.encodeStateAsUpdate(scratch, Y.encodeStateVector(doc)), origin);
    return res;
  } finally { scratch.destroy(); }
}

/** Literal non-overlapping matches, with lowercase mappings indexed back to complete original code points. */
export function findMatches(text: string, query: string, matchCase = true): Array<{ index: number; length: number }> {
  if (!query) return [];
  const fold = (s: string) => Array.from(s, cp => cp.toLowerCase()).join("");
  const needle = matchCase ? query : fold(query);
  let hay = "", original = 0;
  const boundaries = new Map<number, number>([[0, 0]]);
  for (const cp of text) { hay += matchCase ? cp : cp.toLowerCase(); original += cp.length; boundaries.set(hay.length, original); }
  const out: Array<{ index: number; length: number }> = [];
  let from = 0;
  while (from <= hay.length) {
    const at = hay.indexOf(needle, from); if (at < 0) break;
    const begin = boundaries.get(at), end = boundaries.get(at + needle.length);
    if (begin !== undefined && end !== undefined) { out.push({ index: begin, length: end - begin }); from = at + needle.length; }
    else from = at + 1;
  }
  return out;
}
function levenshtein(a: string, b: string): number {
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** The passage of `text` closest to `find` (for "did you mean" hints). */
export function closestMatch(text: string, find: string): string | null {
  if (!text || !find) return null;
  const n = find.length;
  let best: string | null = null;
  let bestD = Infinity;
  const step = text.length > 20000 ? Math.ceil(text.length / 20000) : 1;
  for (let i = 0; i <= Math.max(0, text.length - 1); i += step) {
    for (const len of [n - 1, n, n + 1]) {
      if (len <= 0 || i + len > text.length) continue;
      const cand = text.slice(i, i + len);
      const d = levenshtein(cand.toLowerCase(), find.toLowerCase());
      if (d < bestD) {
        bestD = d;
        best = cand;
      }
    }
  }
  return bestD <= Math.max(2, Math.ceil(n * 0.6)) ? best : null;
}

export function findAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

/** Replace matches with the same formatting-preserving diff as the edit op and web editor. */
export function replaceInText(t: Y.Text, find: string, replace: string, all: boolean, rich: boolean, matchCase = true): number {
  const hits = findMatches(t.toString(), find, matchCase);
  if (!hits.length) fail("text_not_found", `The passage "${find}" was not found.`);
  if (hits.length > 1 && !all) fail("text_ambiguous", `The passage "${find}" appears ${hits.length} times.`);
  for (const hit of hits.reverse()) replaceTextRange(t, hit.index, hit.length, replace, rich);
  return hits.length;
}
