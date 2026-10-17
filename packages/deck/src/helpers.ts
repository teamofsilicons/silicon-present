import * as Y from "yjs";
import { MASTER, deckMap, docToJson, orderArray, readElement, readSlide, slidesMap } from "./doc";
import { newElementId, newGroupId, newSlideId, uniqueId } from "./ids";
import { layoutElements, type LayoutContent } from "./layouts";
import { DEFAULT_SIZE, normalizeDeck, normalizeRichText, normalizeTheme, richTextToPlain } from "./normalize";
import { applyOps, findAll, getElementMap, getSlideMap, getTextField } from "./ops";
import { setPlainText, setRichText } from "./richtext";
import type { DeckJson, Element, ElementInput, RichText, Size, Slide, SlideInput, Theme } from "./types";

// Typed helpers the web editor uses to read and change a deck. Each one is a single local transaction on the doc
// (so it's one undo step and one live update), built on the same ops the service runs for Silicons.

type Origin = unknown;

export function getSize(doc: Y.Doc): Size {
  return (deckMap(doc).get("size") as Size) ?? { ...DEFAULT_SIZE };
}

export function getTheme(doc: Y.Doc): Theme {
  return normalizeTheme(deckMap(doc).get("theme"));
}

export function slideIds(doc: Y.Doc): string[] {
  const seen = new Set<string>();
  const map = slidesMap(doc);
  return orderArray(doc)
    .toArray()
    .filter((id) => id !== MASTER && map.has(id) && !seen.has(id) && (seen.add(id), true));
}

export function getSlide(doc: Y.Doc, slideId: string): Slide {
  return readSlide(getSlideMap(doc, slideId));
}

export function getElement(doc: Y.Doc, slideId: string, elementId: string): Element {
  const e = readElement(getElementMap(doc, slideId, elementId));
  if (!e) throw new Error(`Element ${elementId} could not be read.`);
  return e;
}

export function setTheme(doc: Y.Doc, theme: Theme, origin?: Origin): void {
  applyOps(doc, [{ op: "update_deck", set: { theme } }], origin, { atomic: false });
}

export function setSize(doc: Y.Doc, size: Size, origin?: Origin): void {
  applyOps(doc, [{ op: "update_deck", set: { size } }], origin, { atomic: false });
}

/** Add a slide. With a layout and no elements, the layout's placeholders are added (filled from `content`). */
export function addSlide(
  doc: Y.Doc,
  slide: SlideInput = {},
  opts: { after?: string | null; content?: LayoutContent; origin?: Origin } = {},
): string {
  const input: SlideInput = { ...slide };
  if (!input.elements && input.layout) input.elements = layoutElements(input.layout, getTheme(doc), getSize(doc), opts.content);
  const after = opts.after === undefined ? slideIds(doc).at(-1) ?? null : opts.after;
  return applyOps(doc, [{ op: "add_slide", after, slide: input }], opts.origin, { atomic: false }).slides[0]!;
}

/** Copy a slide (new slide and element ids, group ids remapped) right after it. */
export function duplicateSlide(doc: Y.Doc, slideId: string, origin?: Origin): string {
  const s = getSlide(doc, slideId);
  const groups = new Map<string, string>();
  const elements = s.elements.map((e) => {
    const copy = structuredClone(e) as Element;
    copy.id = "";
    if (copy.group) {
      if (!groups.has(copy.group)) groups.set(copy.group, newGroupId());
      copy.group = groups.get(copy.group)!;
    }
    return copy as ElementInput;
  });
  return addSlide(doc, { ...s, id: undefined, elements }, { after: slideId, origin });
}

export function moveSlide(doc: Y.Doc, slideId: string, after: string | null, origin?: Origin): void {
  applyOps(doc, [{ op: "move_slide", slide: slideId, after }], origin, { atomic: false });
}

/** Move a slide to a 0-based position. */
export function moveSlideTo(doc: Y.Doc, slideId: string, index: number, origin?: Origin): void {
  const ids = slideIds(doc).filter((x) => x !== slideId);
  const i = Math.max(0, Math.min(ids.length, index));
  moveSlide(doc, slideId, i === 0 ? null : ids[i - 1]!, origin);
}

export function deleteSlide(doc: Y.Doc, slideId: string, origin?: Origin): void {
  applyOps(doc, [{ op: "delete_slide", slide: slideId }], origin, { atomic: false });
}

export function updateSlide(
  doc: Y.Doc,
  slideId: string,
  set: Partial<Pick<Slide, "layout" | "background" | "skipped" | "section" | "hideMaster" | "transition" | "notes">>,
  origin?: Origin,
): void {
  applyOps(doc, [{ op: "update_slide", slide: slideId, set }], origin, { atomic: false });
}

export function setNotes(doc: Y.Doc, slideId: string, notes: string, origin?: Origin): void {
  doc.transact(() => setPlainText(getTextField(doc, slideId, null, "notes"), notes), origin);
}

/** Add an element (on a slide or "master"); z = index back to front, default in front. Returns its id. */
export function addElement(doc: Y.Doc, slideId: string, element: ElementInput, z?: number, origin?: Origin): string {
  return applyOps(doc, [{ op: "add_element", slide: slideId, element, z }], origin, { atomic: false }).elements[0]!;
}

export function updateElement(doc: Y.Doc, slideId: string, elementId: string, set: Record<string, unknown>, origin?: Origin): void {
  applyOps(doc, [{ op: "update_element", slide: slideId, element: elementId, set }], origin, { atomic: false });
}

/** Update several elements in one transaction (drag of a multi-selection, align, distribute). */
export function updateElements(doc: Y.Doc, slideId: string, changes: Array<{ id: string; set: Record<string, unknown> }>, origin?: Origin): void {
  applyOps(
    doc,
    changes.map((c) => ({ op: "update_element" as const, slide: slideId, element: c.id, set: c.set })),
    origin,
    { atomic: false },
  );
}

export function deleteElements(doc: Y.Doc, slideId: string, elementIds: string[], origin?: Origin): void {
  applyOps(
    doc,
    elementIds.map((id) => ({ op: "delete_element" as const, slide: slideId, element: id })),
    origin,
    { atomic: false },
  );
}

export function reorderElement(doc: Y.Doc, slideId: string, elementId: string, to: "front" | "back" | "forward" | "backward" | number, origin?: Origin): void {
  applyOps(doc, [{ op: "reorder_element", slide: slideId, element: elementId, to }], origin, { atomic: false });
}

/** Copy elements on the same slide (or onto another), offset by `offset` px. Returns the new ids. */
export function duplicateElements(
  doc: Y.Doc,
  slideId: string,
  elementIds: string[],
  opts: { toSlide?: string; offset?: number; origin?: Origin } = {},
): string[] {
  const offset = opts.offset ?? 24;
  const groups = new Map<string, string>();
  const ops = elementIds.map((id) => {
    const e = structuredClone(getElement(doc, slideId, id)) as Element;
    if (e.group) {
      if (!groups.has(e.group)) groups.set(e.group, newGroupId());
      e.group = groups.get(e.group)!;
    }
    const { id: _id, ...rest } = e;
    return { op: "add_element" as const, slide: opts.toSlide ?? slideId, element: { ...rest, x: e.x + offset, y: e.y + offset, locked: false } as ElementInput };
  });
  return applyOps(doc, ops, opts.origin, { atomic: false }).elements;
}

/** Replace an element's rich text (text and shape elements). Plain strings become one paragraph per line. */
export function setElementText(doc: Y.Doc, slideId: string, elementId: string, text: RichText | string, origin?: Origin): void {
  doc.transact(() => setRichText(getTextField(doc, slideId, elementId, "text"), normalizeRichText(text)), origin);
}

export function setCellText(doc: Y.Doc, slideId: string, elementId: string, r: number, c: number, text: RichText | string, origin?: Origin): void {
  doc.transact(() => setRichText(getTextField(doc, slideId, elementId, `cell:${r}:${c}`), normalizeRichText(text)), origin);
}

export function setCode(doc: Y.Doc, slideId: string, elementId: string, field: "html" | "css" | "js", value: string, origin?: Origin): void {
  doc.transact(() => setPlainText(getTextField(doc, slideId, elementId, field), value), origin);
}

/** Group elements so they move together. Returns the group id. */
export function groupElements(doc: Y.Doc, slideId: string, elementIds: string[], origin?: Origin): string {
  const group = newGroupId();
  updateElements(doc, slideId, elementIds.map((id) => ({ id, set: { group } })), origin);
  return group;
}

/** Ungroup every element in the given group (or the groups of the given element ids). */
export function ungroup(doc: Y.Doc, slideId: string, groupOrElementIds: string | string[], origin?: Origin): void {
  const s = getSlide(doc, slideId);
  const groups = new Set<string>();
  if (typeof groupOrElementIds === "string") groups.add(groupOrElementIds);
  else for (const e of s.elements) if (groupOrElementIds.includes(e.id) && e.group) groups.add(e.group);
  const ids = s.elements.filter((e) => e.group && groups.has(e.group)).map((e) => e.id);
  updateElements(doc, slideId, ids.map((id) => ({ id, set: { group: null } })), origin);
}

/** Every element id that moves with `elementId` (itself plus its group). */
export function groupMembers(slide: Slide, elementId: string): string[] {
  const e = slide.elements.find((x) => x.id === elementId);
  if (!e) return [];
  if (!e.group) return [e.id];
  return slide.elements.filter((x) => x.group === e.group).map((x) => x.id);
}

/** Move elements by dx/dy. Locked elements stay put. */
export function moveElements(doc: Y.Doc, slideId: string, elementIds: string[], dx: number, dy: number, origin?: Origin): void {
  const s = getSlide(doc, slideId);
  const changes = s.elements
    .filter((e) => elementIds.includes(e.id) && !e.locked)
    .map((e) => ({ id: e.id, set: { x: e.x + dx, y: e.y + dy } }));
  updateElements(doc, slideId, changes, origin);
}

// ---------------------------------------------------------------- geometry (pure)

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function boundsOf(boxes: Box[]): Box {
  if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const bt = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: bt - y };
}

export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";

/** New x/y for each element so they line up: to the selection's bounds, or to `to` (e.g. the slide) when given or when only one element is selected. */
export function alignElements<T extends Box & { id: string }>(els: T[], mode: AlignMode, to?: Box): Array<{ id: string; set: { x?: number; y?: number } }> {
  const b = to ?? boundsOf(els);
  return els.map((e) => {
    switch (mode) {
      case "left":
        return { id: e.id, set: { x: b.x } };
      case "center":
        return { id: e.id, set: { x: b.x + (b.w - e.w) / 2 } };
      case "right":
        return { id: e.id, set: { x: b.x + b.w - e.w } };
      case "top":
        return { id: e.id, set: { y: b.y } };
      case "middle":
        return { id: e.id, set: { y: b.y + (b.h - e.h) / 2 } };
      case "bottom":
        return { id: e.id, set: { y: b.y + b.h - e.h } };
    }
  });
}

/** Spread three or more elements evenly between the first and last. */
export function distributeElements<T extends Box & { id: string }>(els: T[], axis: "horizontal" | "vertical"): Array<{ id: string; set: { x?: number; y?: number } }> {
  if (els.length < 3) return [];
  const key = axis === "horizontal" ? "x" : "y";
  const len = axis === "horizontal" ? "w" : "h";
  const sorted = [...els].sort((a, b) => a[key] - b[key]);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const total = last[key] + last[len] - first[key];
  const used = sorted.reduce((s, e) => s + e[len], 0);
  const gap = (total - used) / (sorted.length - 1);
  let pos = first[key];
  return sorted.map((e) => {
    const out = { id: e.id, set: { [key]: pos } as { x?: number; y?: number } };
    pos += e[len] + gap;
    return out;
  });
}

// ---------------------------------------------------------------- find and replace

export interface TextHit {
  slide: string;
  /** null for speaker notes */
  element: string | null;
  field: string;
  index: number;
  length: number;
  /** the surrounding text, for a results list */
  context: string;
}

function eachTextField(deck: DeckJson, fn: (slide: string, element: string | null, field: string, text: string) => void) {
  const slides: Array<{ id: string; elements: Element[]; notes?: string }> = [{ id: MASTER, elements: deck.master.elements }, ...deck.slides];
  for (const s of slides) {
    for (const e of s.elements) {
      if (e.kind === "text" || e.kind === "shape") fn(s.id, e.id, "text", richTextToPlain(e.text));
      if (e.kind === "table") e.cells.forEach((row, r) => row.forEach((c, ci) => fn(s.id, e.id, `cell:${r}:${ci}`, richTextToPlain(c.text))));
    }
    if (s.notes) fn(s.id, null, "notes", s.notes);
  }
}

/** Find every occurrence of `query` in slide text, table cells and notes. */
export function findInDeck(deck: DeckJson, query: string, opts: { matchCase?: boolean } = {}): TextHit[] {
  const hits: TextHit[] = [];
  if (!query) return hits;
  const q = opts.matchCase ? query : query.toLowerCase();
  eachTextField(deck, (slide, element, field, text) => {
    const hay = opts.matchCase ? text : text.toLowerCase();
    for (const i of findAll(hay, q)) {
      hits.push({ slide, element, field, index: i, length: query.length, context: text.slice(Math.max(0, i - 30), i + query.length + 30) });
    }
  });
  return hits;
}

/** Replace every occurrence of `query` (case as given unless matchCase is false) in one transaction. Returns the count. */
export function replaceInDeck(doc: Y.Doc, query: string, replacement: string, opts: { matchCase?: boolean; origin?: Origin } = {}): number {
  const deck = docToJson(doc);
  const hits = findInDeck(deck, query, opts);
  let count = 0;
  doc.transact(() => {
    // Replace from the end of each field backwards so earlier indexes stay valid.
    const byField = new Map<string, TextHit[]>();
    for (const h of hits) {
      const k = `${h.slide}|${h.element ?? ""}|${h.field}`;
      if (!byField.has(k)) byField.set(k, []);
      byField.get(k)!.push(h);
    }
    for (const list of byField.values()) {
      const first = list[0]!;
      const t = getTextField(doc, first.slide, first.element, first.field);
      for (const h of [...list].sort((a, b) => b.index - a.index)) {
        const rich = h.field === "text" || h.field.startsWith("cell:");
        const attrs = rich ? inlineAttrsAt(t, h.index) : undefined;
        t.delete(h.index, h.length);
        if (replacement) {
          if (attrs) t.insert(h.index, replacement, attrs);
          else t.insert(h.index, replacement);
        }
        count++;
      }
    }
  }, opts.origin);
  return count;
}

function inlineAttrsAt(t: Y.Text, index: number): Record<string, unknown> {
  let pos = 0;
  for (const op of t.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>) {
    const len = typeof op.insert === "string" ? op.insert.length : 1;
    if (index < pos + len) {
      const a = { ...(op.attributes ?? {}) };
      for (const k of ["align", "list", "indent", "heading", "lineHeight"]) delete a[k];
      return a;
    }
    pos += len;
  }
  return {};
}

// ---------------------------------------------------------------- new decks

/** A new deck JSON with one title slide in the given theme. */
export function newDeckJson(opts: { theme?: Theme; size?: Size; title?: string; subtitle?: string } = {}): DeckJson {
  const theme = normalizeTheme(opts.theme);
  const size = opts.size ?? { ...DEFAULT_SIZE };
  const taken = new Set<string>();
  return normalizeDeck({
    size,
    theme,
    master: { elements: [] },
    slides: [
      {
        id: uniqueId(newSlideId, taken),
        layout: "title",
        background: null,
        skipped: false,
        section: null,
        hideMaster: false,
        transition: null,
        notes: "",
        elements: layoutElements("title", theme, size, { title: opts.title, subtitle: opts.subtitle }) as Element[],
      },
    ],
  });
}
