import * as Y from "yjs";
import {
  MASTER,
  deepEqual,
  orderArray,
  readElement,
  slidesMap,
  deckMap,
  writeElement,
  writeSlide,
} from "./doc";
import { newElementId, newGroupId, newSlideId, uniqueId } from "./ids";
import { DeckError, normalizeElement, normalizeSlide, normalizeTheme, richTextFromPlain } from "./normalize";
import { attrsAt, setPlainText, setRichText } from "./richtext";
import { INLINE_ATTRS } from "./types";
import type { Element, ElementInput, RichText, Slide, SlideInput, Size, Theme } from "./types";

// Edit ops (docs/architecture.md, "Edit ops"), applied to a Y.Doc. All ops passed to applyOps run in one transaction,
// so the whole change appears at once. The same ops back the typed helpers the web editor uses.

export type Op =
  | { op: "update_deck"; set: { size?: Size; theme?: Theme } }
  | { op: "add_slide"; after?: string | null; slide: SlideInput }
  | {
      op: "update_slide";
      slide: string;
      set: Partial<Pick<Slide, "layout" | "background" | "skipped" | "section" | "hideMaster" | "transition" | "notes">>;
    }
  | { op: "move_slide"; slide: string; after: string | null }
  | { op: "delete_slide"; slide: string }
  | { op: "add_element"; slide: string; element: ElementInput; z?: number }
  | { op: "update_element"; slide: string; element: string; set: Record<string, unknown> }
  | { op: "replace_text"; slide: string; element?: string; field?: string; find: string; replace: string; all?: boolean }
  | { op: "reorder_element"; slide: string; element: string; to: "front" | "back" | "forward" | "backward" | number }
  | { op: "delete_element"; slide: string; element: string };

export interface OpsResult {
  /** Slide ids each op created (add_slide), in order. */
  slides: string[];
  /** Element ids each op created (add_element and elements inside add_slide), in order. */
  elements: string[];
  /** Every slide id the ops touched ("master" for the master). */
  touched: string[];
  /** How many passages replace_text replaced, summed. */
  replaced: number;
}

// ---------------------------------------------------------------- lookups

export function getSlideMap(doc: Y.Doc, slideId: string): Y.Map<unknown> {
  const m = slidesMap(doc).get(slideId);
  if (!(m instanceof Y.Map) || (slideId !== MASTER && !orderArray(doc).toArray().includes(slideId))) {
    throw new DeckError("slide_not_found", `There is no slide ${slideId} in this deck.`, "Read the deck again to get its current slide ids.");
  }
  return m;
}

export function getElementMap(doc: Y.Doc, slideId: string, elementId: string): Y.Map<unknown> {
  const s = getSlideMap(doc, slideId);
  const els = s.get("elements");
  const m = els instanceof Y.Map ? els.get(elementId) : undefined;
  if (!(m instanceof Y.Map)) {
    throw new DeckError(
      "element_not_found",
      `There is no element ${elementId} on slide ${slideId}.`,
      "Read the slide again to get its current element ids; the element may have been deleted.",
    );
  }
  return m as Y.Map<unknown>;
}

function elementOrderOf(slide: Y.Map<unknown>): Y.Array<string> {
  let order = slide.get("elementOrder");
  if (!(order instanceof Y.Array)) {
    order = new Y.Array<string>();
    slide.set("elementOrder", order);
  }
  return order as Y.Array<string>;
}

function elementsOf(slide: Y.Map<unknown>): Y.Map<Y.Map<unknown>> {
  let els = slide.get("elements");
  if (!(els instanceof Y.Map)) {
    els = new Y.Map();
    slide.set("elements", els);
  }
  return els as Y.Map<Y.Map<unknown>>;
}

/** All element ids in the deck (to keep new ids unique across slides, which makes comments and links simpler). */
function allElementIds(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  slidesMap(doc).forEach((s) => {
    const els = s.get("elements");
    if (els instanceof Y.Map) for (const k of els.keys()) ids.add(k);
  });
  return ids;
}

/** The Y.Text behind a text field, for binding an editor directly: "text", "notes", "html", "css", "js", "cell:r:c". */
export function getTextField(doc: Y.Doc, slideId: string, elementId: string | null | undefined, field = "text"): Y.Text {
  if (!elementId || field === "notes") {
    const s = getSlideMap(doc, slideId);
    const t = s.get("notes");
    if (t instanceof Y.Text) return t;
    const nt = new Y.Text();
    s.set("notes", nt);
    return nt;
  }
  const m = getElementMap(doc, slideId, elementId);
  const cell = /^cell:(\d+):(\d+)$/.exec(field);
  if (cell) {
    const cells = m.get("cells");
    const c = cells instanceof Y.Map ? cells.get(`${cell[1]}:${cell[2]}`) : undefined;
    if (!(c instanceof Y.Map)) {
      throw new DeckError("cell_not_found", `The table has no cell ${cell[1]}:${cell[2]}.`, "Rows and columns count from 0; read the table to see its size.");
    }
    return c.get("text") as Y.Text;
  }
  const t = m.get(field);
  if (!(t instanceof Y.Text)) {
    throw new DeckError(
      "field_not_found",
      `Element ${elementId} has no text field "${field}".`,
      "Text and shapes have \"text\", HTML elements have \"html\", \"css\" and \"js\", tables have \"cell:r:c\".",
    );
  }
  return t;
}

// ---------------------------------------------------------------- ops

function insertSlide(doc: Y.Doc, slide: Slide, after: string | null | undefined): void {
  const order = orderArray(doc);
  const ids = order.toArray();
  let index = ids.length;
  if (after === null) index = 0;
  else if (after !== undefined) {
    const i = ids.indexOf(after);
    if (i < 0) throw new DeckError("slide_not_found", `There is no slide ${after} to put the new slide after.`, "Use an existing slide id, or null to make it the first slide.");
    index = i + 1;
  }
  const m = new Y.Map<unknown>();
  slidesMap(doc).set(slide.id, m);
  writeSlide(m, slide);
  order.insert(index, [slide.id]);
}

function applyOne(doc: Y.Doc, op: Op, res: OpsResult): void {
  const touch = (id: string) => {
    if (!res.touched.includes(id)) res.touched.push(id);
  };
  switch (op.op) {
    case "update_deck": {
      const deck = deckMap(doc);
      if (op.set.size) deck.set("size", { width: Number(op.set.size.width), height: Number(op.set.size.height) });
      if (op.set.theme) deck.set("theme", normalizeTheme(op.set.theme));
      return;
    }
    case "add_slide": {
      const taken = new Set(slidesMap(doc).keys());
      const elIds = allElementIds(doc);
      const input = { ...op.slide };
      if (input.id && taken.has(input.id)) {
        throw new DeckError("slide_exists", `A slide with id ${input.id} already exists.`, "Leave the id out and one is generated.");
      }
      const slide = normalizeSlide(
        input,
        () => uniqueId(newSlideId, taken),
        () => {
          const id = uniqueId(newElementId, elIds);
          elIds.add(id);
          return id;
        },
      );
      insertSlide(doc, slide, op.after);
      res.slides.push(slide.id);
      res.elements.push(...slide.elements.map((e) => e.id));
      touch(slide.id);
      return;
    }
    case "update_slide": {
      const m = getSlideMap(doc, op.slide);
      const set = op.set as Record<string, unknown>;
      for (const [k, v] of Object.entries(set)) {
        if (k === "notes") setPlainText(getTextField(doc, op.slide, null, "notes"), String(v ?? ""));
        else if (["layout", "background", "skipped", "section", "hideMaster", "transition"].includes(k)) {
          if (!deepEqual(m.get(k), v)) m.set(k, v === undefined ? null : JSON.parse(JSON.stringify(v)));
        } else {
          throw new DeckError("invalid_field", `"${k}" is not a slide field that can be set.`, "Set layout, background, skipped, section, hideMaster, transition or notes.");
        }
      }
      touch(op.slide);
      return;
    }
    case "move_slide": {
      getSlideMap(doc, op.slide);
      const order = orderArray(doc);
      const from = order.toArray().indexOf(op.slide);
      order.delete(from, 1);
      const ids = order.toArray();
      let to = 0;
      if (op.after !== null && op.after !== undefined) {
        const i = ids.indexOf(op.after);
        if (i < 0) throw new DeckError("slide_not_found", `There is no slide ${op.after} to move after.`, "Use an existing slide id, or null to make it the first slide.");
        to = i + 1;
      }
      order.insert(to, [op.slide]);
      touch(op.slide);
      return;
    }
    case "delete_slide": {
      getSlideMap(doc, op.slide);
      const order = orderArray(doc);
      const ids = order.toArray();
      for (let i = ids.length - 1; i >= 0; i--) if (ids[i] === op.slide) order.delete(i, 1);
      slidesMap(doc).delete(op.slide);
      touch(op.slide);
      return;
    }
    case "add_element": {
      const s = getSlideMap(doc, op.slide);
      const taken = allElementIds(doc);
      if (op.element.id && taken.has(op.element.id as string)) {
        throw new DeckError("element_exists", `An element with id ${String(op.element.id)} already exists.`, "Leave the id out and one is generated.");
      }
      const el = normalizeElement(op.element, () => uniqueId(newElementId, taken));
      const m = new Y.Map<unknown>();
      elementsOf(s).set(el.id, m);
      writeElement(m, el);
      const order = elementOrderOf(s);
      const z = op.z === undefined ? order.length : Math.max(0, Math.min(order.length, Math.round(op.z)));
      order.insert(z, [el.id]);
      res.elements.push(el.id);
      touch(op.slide);
      return;
    }
    case "update_element": {
      const m = getElementMap(doc, op.slide, op.element);
      const cur = readElement(m);
      if (!cur) throw new DeckError("element_unreadable", `Element ${op.element} could not be read.`, "Delete it and add it again.");
      if ("kind" in op.set && op.set.kind !== cur.kind) {
        throw new DeckError("kind_change", "An element's kind can't be changed.", "Delete the element and add a new one of the kind you want.");
      }
      if ("id" in op.set && op.set.id !== cur.id) {
        throw new DeckError("id_change", "An element's id can't be changed.", "Leave id out of set.");
      }
      const merged: Record<string, unknown> = { ...cur, ...op.set };
      if (op.set.style && typeof op.set.style === "object") merged.style = op.set.style; // style is replaced whole
      if ((op.set.rows !== undefined || op.set.cols !== undefined) && op.set.cells === undefined && cur.kind === "table") {
        // resizing a table keeps the cells that still fit; widths/heights are re-spread unless given
        if (op.set.colWidths === undefined && op.set.cols !== undefined && op.set.cols !== cur.cols) delete merged.colWidths;
        if (op.set.rowHeights === undefined && op.set.rows !== undefined && op.set.rows !== cur.rows) delete merged.rowHeights;
      }
      if (op.set.w !== undefined && cur.kind === "table" && op.set.colWidths === undefined) {
        const k = Number(op.set.w) / Math.max(1, cur.w);
        merged.colWidths = cur.colWidths.map((x) => x * k);
      }
      if (op.set.h !== undefined && cur.kind === "table" && op.set.rowHeights === undefined) {
        const k = Number(op.set.h) / Math.max(1, cur.h);
        merged.rowHeights = cur.rowHeights.map((x) => x * k);
      }
      writeElement(m, normalizeElement(merged as unknown as Element));
      touch(op.slide);
      return;
    }
    case "replace_text": {
      const field = op.field ?? (op.element ? "text" : "notes");
      const t = getTextField(doc, op.slide, op.element, field);
      res.replaced += replaceInText(t, op.find, op.replace, !!op.all, field === "text" || field.startsWith("cell:"));
      touch(op.slide);
      return;
    }
    case "reorder_element": {
      const s = getSlideMap(doc, op.slide);
      getElementMap(doc, op.slide, op.element);
      const order = elementOrderOf(s);
      const ids = order.toArray();
      const from = ids.indexOf(op.element);
      let to: number;
      if (op.to === "front") to = ids.length - 1;
      else if (op.to === "back") to = 0;
      else if (op.to === "forward") to = Math.min(ids.length - 1, from + 1);
      else if (op.to === "backward") to = Math.max(0, from - 1);
      else to = Math.max(0, Math.min(ids.length - 1, Math.round(Number(op.to))));
      if (from === to) return;
      order.delete(from, 1);
      order.insert(to, [op.element]);
      touch(op.slide);
      return;
    }
    case "delete_element": {
      const s = getSlideMap(doc, op.slide);
      getElementMap(doc, op.slide, op.element);
      const order = elementOrderOf(s);
      const ids = order.toArray();
      for (let i = ids.length - 1; i >= 0; i--) if (ids[i] === op.element) order.delete(i, 1);
      elementsOf(s).delete(op.element);
      touch(op.slide);
      return;
    }
    default:
      throw new DeckError("unknown_op", `"${(op as { op: string }).op}" is not an edit op.`, "Use update_deck, add_slide, update_slide, move_slide, delete_slide, add_element, update_element, replace_text, reorder_element or delete_element.");
  }
}

/**
 * Apply ops as one transaction. If any op fails, a DeckError is thrown and the document is left unchanged:
 * the ops first run on a scratch copy, and only the finished change is merged into `doc`.
 * Pass `{ atomic: false }` to edit `doc` directly (faster, and the transaction is a normal local one for undo),
 * accepting that ops before a failing one stay applied.
 */
export function applyOps(doc: Y.Doc, ops: Op[], origin?: unknown, opts: { atomic?: boolean } = {}): OpsResult {
  const res: OpsResult = { slides: [], elements: [], touched: [], replaced: 0 };
  if (opts.atomic === false) {
    doc.transact(() => {
      for (const op of ops) applyOne(doc, op, res);
    }, origin);
    return res;
  }
  const scratch = new Y.Doc();
  scratch.clientID = doc.clientID;
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
  scratch.transact(() => {
    for (const op of ops) applyOne(scratch, op, res);
  });
  const update = Y.encodeStateAsUpdate(scratch, Y.encodeStateVector(doc));
  Y.applyUpdate(doc, update, origin);
  scratch.destroy();
  return res;
}

// ---------------------------------------------------------------- text search

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

/** Replace a passage in a Y.Text, keeping the formatting of the first replaced character. Returns the count. */
export function replaceInText(t: Y.Text, find: string, replace: string, all: boolean, rich: boolean): number {
  const s = t.toString();
  const hits = findAll(s, find);
  if (hits.length === 0) {
    const near = closestMatch(s, find);
    throw new DeckError(
      "text_not_found",
      `The passage "${find}" is not in that text.`,
      near ? `The closest passage is "${near}". Copy the exact passage, including spaces and punctuation.` : "Read the text again and copy the exact passage, including spaces and punctuation.",
    );
  }
  if (hits.length > 1 && !all) {
    throw new DeckError(
      "text_ambiguous",
      `The passage "${find}" appears ${hits.length} times in that text.`,
      "Include more of the surrounding text so it matches once, or set all to replace every one.",
    );
  }
  for (let k = hits.length - 1; k >= 0; k--) {
    const at = hits[k]!;
    const keep: Record<string, unknown> = {};
    if (rich) {
      const a = attrsAt(t, at);
      for (const key of INLINE_ATTRS) if (a[key] !== undefined && a[key] !== null) keep[key] = a[key];
    }
    t.delete(at, find.length);
    if (replace) {
      if (rich) t.insert(at, replace, keep);
      else t.insert(at, replace);
    }
  }
  return hits.length;
}
