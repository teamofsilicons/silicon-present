import * as Y from "yjs";
import { cleanInlineAttrs, cleanParagraphAttrs, normalizeRichText, validUnicode, DeckError } from "./normalize";
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

/** Write rich text using the same minimal diff as every other rich-text writer. */
export function writeRichText(text: Y.Text, rt: RichText): void {
  setRichText(text, rt);
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

export interface TextChunk { kind: "keep" | "delete" | "insert"; text: string }

/** Deterministic, bounded LCS diff over Unicode code points. Never splits a surrogate pair. */
export function textDiff(before: string, after: string): TextChunk[] {
  const a = Array.from(before), b = Array.from(after), out: TextChunk[] = [];
  const push = (kind: TextChunk["kind"], chars: string) => {
    if (!chars) return;
    const last = out.at(-1); if (last?.kind === kind) last.text += chars; else out.push({ kind, text: chars });
  };
  let p = 0, s = 0;
  while (p < Math.min(a.length, b.length) && a[p] === b[p]) p++;
  while (s < Math.min(a.length, b.length) - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  push("keep", a.slice(0, p).join(""));
  const x = a.slice(p, a.length - s), y = b.slice(p, b.length - s);
  if (x.length > 2000 || y.length > 2000) { push("delete", x.join("")); push("insert", y.join("")); }
  else {
    const width = y.length + 1, lcs = new Uint16Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * width + j] = x[i] === y[j] ? 1 + lcs[(i + 1) * width + j + 1]! : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { push("keep", x[i++]!); j++; }
      else if (i < x.length && (j === y.length || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) push("delete", x[i++]!);
      else push("insert", y[j++]!);
    }
  }
  push("keep", s ? a.slice(a.length - s).join("") : "");
  return out;
}

function assertText(value: string): void {
  if (!validUnicode(value)) throw new DeckError("invalid_value", "Text contains half a surrogate pair.", "Replace it with a complete Unicode character.");
}
function insertPieces(text: Y.Text, at: number, chars: string, attributes: Attrs[], start = 0): void {
  let begin = 0, offset = 0, key = "";
  for (const cp of chars) {
    const next = attrKey(attributes[start + offset] ?? {});
    if (offset && next !== key) { text.insert(at + begin, chars.slice(begin, offset), { ...attributes[start + begin] }); begin = offset; }
    key = next; offset += cp.length;
  }
  if (offset > begin) text.insert(at + begin, chars.slice(begin), { ...attributes[start + begin] });
}

function removeEmbeds(text: Y.Text): void {
  let at = 0;
  const indexes: number[] = [];
  for (const op of text.toDelta() as DeltaOp[]) {
    if (typeof op.insert === "string") at += op.insert.length;
    else { indexes.push(at); at++; }
  }
  for (const index of indexes.reverse()) text.delete(index, 1);
}

/** Change characters by the shared code-point diff and set exactly the target attributes. */
export function setRichText(text: Y.Text, rt: RichText): void {
  const normalized = normalizeRichText(rt, true);
  removeEmbeds(text);
  const cur = charsWithAttrs(currentPieces(text));
  const target = charsWithAttrs(richTextToPieces(normalized));
  let old = 0, at = 0;
  for (const chunk of textDiff(cur.chars, target.chars)) {
    if (chunk.kind === "delete") { text.delete(at, chunk.text.length); old += chunk.text.length; }
    else if (chunk.kind === "insert") { insertPieces(text, at, chunk.text, target.attrs, at); at += chunk.text.length; }
    else {
      for (const cp of chunk.text) {
        const ca = cur.attrs[old] ?? {}, ta = target.attrs[at] ?? {};
        if (attrKey(ca) !== attrKey(ta)) {
          const change: Attrs = {};
          for (const k of Object.keys(ca)) if (!(k in ta)) change[k] = null;
          for (const [k, v] of Object.entries(ta)) if (ca[k] !== v) change[k] = v;
          text.format(at, cp.length, change);
        }
        old += cp.length; at += cp.length;
      }
    }
  }
}

/** Change plain text through the same code-point diff used for rich text. */
export function setPlainText(text: Y.Text, value: string): void {
  assertText(value);
  removeEmbeds(text);
  let at = 0;
  for (const chunk of textDiff(text.toString(), value)) {
    if (chunk.kind === "delete") text.delete(at, chunk.text.length);
    else { if (chunk.kind === "insert") text.insert(at, chunk.text, {}); at += chunk.text.length; }
  }
  // Plain text never carries formatting, even when repairing a malformed field.
  for (const op of text.toDelta() as DeltaOp[]) {
    if (op.attributes && Object.keys(op.attributes).length) {
      const clear = Object.fromEntries(Object.keys(op.attributes).map(k => [k, null]));
      text.format(0, text.length, clear);
    }
  }
}

/** Replace one matched passage; equal characters retain their original CRDT identities and formatting. */
export function replaceTextRange(text: Y.Text, index: number, length: number, replacement: string, rich: boolean): void {
  assertText(replacement);
  removeEmbeds(text);
  const old = charsWithAttrs(currentPieces(text));
  const passage = old.chars.slice(index, index + length);
  assertText(passage);
  const end = index + length;
  let pos = index, at = index;
  let deleted: { start: number; end: number } | undefined;
  for (const chunk of textDiff(passage, replacement)) {
    if (chunk.kind === "keep") { pos += chunk.text.length; at += chunk.text.length; deleted = undefined; }
    else if (chunk.kind === "delete") { deleted = { start: pos, end: pos + chunk.text.length }; text.delete(at, chunk.text.length); pos += chunk.text.length; }
    else {
      let inline: Attrs = {}, para: Attrs = {};
      if (rich) {
        let source = -1;
        if (deleted) for (let i = deleted.start; i < deleted.end; i++) if (old.chars[i] !== "\n") { source = i; break; }
        if (source < 0) for (let i = Math.min(pos - 1, end - 1); i >= index; i--) if (old.chars[i] !== "\n") { source = i; break; }
        if (source < 0) for (let i = pos; i < end; i++) if (old.chars[i] !== "\n") { source = i; break; }
        inline = cleanInlineAttrs(old.attrs[source] ?? {});
        const newline = old.chars.indexOf("\n", pos);
        para = cleanParagraphAttrs(old.attrs[newline] ?? {});
      }
      const inserted = Array.from({ length: chunk.text.length }, (_, i) => chunk.text[i] === "\n" ? para : inline);
      insertPieces(text, at, chunk.text, inserted);
      at += chunk.text.length; deleted = undefined;
    }
  }
  if (!rich) setPlainText(text, text.toString());
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
