import * as Y from "yjs";
import { cleanInlineAttrs, cleanParagraphAttrs, normalizeRichText } from "./normalize";
import { INLINE_ATTRS, PARAGRAPH_ATTRS } from "./types";
import type { Paragraph, RichText, Run } from "./types";

// Rich text <-> Y.Text (Quill-style deltas, docs/architecture.md "Rich text").
// Character runs carry inline attributes; each paragraph ends with "\n" whose attributes are the paragraph's.
// A trailing run without a closing "\n" reads as a last paragraph without attributes; writing always closes every
// paragraph with "\n". Empty rich text ({ paragraphs: [] }) is an empty Y.Text.

type Attrs = Record<string, unknown>;
interface DeltaOp {
  insert?: unknown;
  attributes?: Attrs;
}

const INLINE = new Set<string>(INLINE_ATTRS);
const PARA = new Set<string>(PARAGRAPH_ATTRS);

function pick(attrs: Attrs | undefined, keys: Set<string>): Attrs {
  const out: Attrs = {};
  if (!attrs) return out;
  for (const [k, v] of Object.entries(attrs)) if (keys.has(k) && v !== null && v !== undefined) out[k] = v;
  return out;
}

/** Read a Y.Text (or its delta) as RichText. */
export function yTextToRichText(text: Y.Text): RichText {
  return deltaToRichText(text.toDelta() as DeltaOp[]);
}

export function deltaToRichText(delta: DeltaOp[]): RichText {
  const paragraphs: Paragraph[] = [];
  let runs: Run[] = [];
  for (const op of delta) {
    if (typeof op.insert !== "string") continue; // embeds are not part of the format
    const parts = op.insert.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) {
        paragraphs.push({ ...(cleanParagraphAttrs(pick(op.attributes, PARA)) as object), runs });
        runs = [];
      }
      if (part.length) runs.push({ ...(cleanInlineAttrs(pick(op.attributes, INLINE)) as object), text: part });
    });
  }
  if (runs.length) paragraphs.push({ runs });
  return normalizeRichText({ paragraphs });
}

/** Rich text as a flat list of [chars, attributes] pieces, exactly what goes into the Y.Text. */
export function richTextToPieces(rt: RichText): Array<[string, Attrs]> {
  const pieces: Array<[string, Attrs]> = [];
  for (const p of normalizeRichText(rt).paragraphs) {
    for (const r of p.runs) {
      const { text, ...attrs } = r;
      pieces.push([text, attrs]);
    }
    const { runs: _runs, ...pattrs } = p;
    pieces.push(["\n", pattrs]);
  }
  return pieces;
}

export function richTextToDelta(rt: RichText): DeltaOp[] {
  return richTextToPieces(rt).map(([insert, attributes]) => (Object.keys(attributes).length ? { insert, attributes } : { insert }));
}

/** Write rich text into an empty (or about to be emptied) Y.Text. */
export function writeRichText(text: Y.Text, rt: RichText): void {
  if (text.length) text.delete(0, text.length);
  let i = 0;
  for (const [chars, attrs] of richTextToPieces(rt)) {
    text.insert(i, chars, { ...attrs });
    i += chars.length;
  }
}

function attrKey(a: Attrs): string {
  const keys = Object.keys(a).filter((k) => a[k] !== null && a[k] !== undefined).sort();
  return keys.map((k) => k + "=" + JSON.stringify(a[k])).join("&");
}

function charsWithAttrs(pieces: Array<[string, Attrs]>): { chars: string; attrs: Attrs[] } {
  let chars = "";
  const attrs: Attrs[] = [];
  for (const [s, a] of pieces) {
    chars += s;
    for (let i = 0; i < s.length; i++) attrs.push(a);
  }
  return { chars, attrs };
}

function currentPieces(text: Y.Text): Array<[string, Attrs]> {
  return (text.toDelta() as DeltaOp[])
    .filter((op) => typeof op.insert === "string")
    .map((op) => [op.insert as string, { ...(op.attributes ?? {}) }]);
}

function commonEnds(a: string, b: string): [number, number] {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return [p, s];
}

/**
 * Change a Y.Text to hold `rt` through a minimal diff: the common start and end of the characters stay (so others'
 * concurrent typing there survives), only the middle is replaced, and formatting is changed only where it differs.
 */
export function setRichText(text: Y.Text, rt: RichText): void {
  const cur = charsWithAttrs(currentPieces(text));
  const target = charsWithAttrs(richTextToPieces(rt));
  const [p, s] = commonEnds(cur.chars, target.chars);
  const delLen = cur.chars.length - p - s;
  if (delLen > 0) text.delete(p, delLen);
  // insert the new middle, piece by piece with explicit attributes
  let i = p;
  const end = target.chars.length - s;
  while (i < end) {
    let j = i + 1;
    const k = attrKey(target.attrs[i]!);
    while (j < end && attrKey(target.attrs[j]!) === k) j++;
    text.insert(i, target.chars.slice(i, j), { ...target.attrs[i]! });
    i = j;
  }
  // fix formatting in the kept start and end
  const fix = (curStart: number, tgtStart: number, len: number) => {
    let a = 0;
    while (a < len) {
      const ca = cur.attrs[curStart + a]!;
      const ta = target.attrs[tgtStart + a]!;
      if (attrKey(ca) === attrKey(ta)) {
        a++;
        continue;
      }
      let b = a + 1;
      while (
        b < len &&
        attrKey(cur.attrs[curStart + b]!) === attrKey(ca) &&
        attrKey(target.attrs[tgtStart + b]!) === attrKey(ta)
      )
        b++;
      const change: Attrs = {};
      for (const key of Object.keys(ca)) if (!(key in ta)) change[key] = null;
      for (const [key, v] of Object.entries(ta)) if (ca[key] !== v) change[key] = v;
      text.format(tgtStart + a, b - a, change);
      a = b;
    }
  };
  fix(0, 0, p);
  fix(cur.chars.length - s, target.chars.length - s, s);
}

/** Change a plain Y.Text (notes, html, css, js) to `value` through a minimal diff. */
export function setPlainText(text: Y.Text, value: string): void {
  const cur = text.toString();
  if (cur === value) return;
  const [p, s] = commonEnds(cur, value);
  const delLen = cur.length - p - s;
  if (delLen > 0) text.delete(p, delLen);
  const ins = value.slice(p, value.length - s);
  if (ins) text.insert(p, ins);
}

/** Attributes in effect at a character of a Y.Text (used to keep formatting when replacing a passage). */
export function attrsAt(text: Y.Text, index: number): Attrs {
  let pos = 0;
  for (const op of text.toDelta() as DeltaOp[]) {
    const len = typeof op.insert === "string" ? op.insert.length : 1;
    if (index < pos + len) return { ...(op.attributes ?? {}) };
    pos += len;
  }
  return {};
}
