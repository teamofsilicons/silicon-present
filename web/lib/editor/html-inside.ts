/**
 * Editing the inside of an HTML element (its parts: a heading, an image, a box) by changing its source, never the DOM
 * its JS made. Every start tag of the element's `html` gets a number in source order; the edit frame
 * (app/sandbox/html-edit) draws the source with those numbers as `data-sp-part` attributes and names a part by its
 * number; each change here goes back into the source string with the smallest splice (one `style` attribute, one
 * part's content, one part removed), and is checked against the same change made on a parsed copy (DOMParser runs no
 * scripts). When the splice and the parsed change disagree (markup the scanner reads differently from a browser),
 * the parsed copy is written instead, or nothing when the source is a whole page that copy can't hold.
 *
 *   const marked = markParts(html);                     // what the edit frame draws
 *   const next = applyPartChange(html, { kind: "style", part: 3, set: { color: "#ff0000" } }, parseHtml);
 *
 * Everything that names a part or carries a value comes from the edit frame, which is untrusted: numbers are checked
 * against the source, style values against a short list of shapes, text is only ever set as text.
 */

export const PART_ATTR = "data-sp-part";

export interface Tag {
  /** Lower-case tag name. */
  name: string;
  /** Where the tag starts (`<`) and ends (after `>`) in the source. */
  start: number;
  end: number;
  /** Where the name ends: attributes start here. */
  nameEnd: number;
  close: boolean;
  selfClosing: boolean;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"]);

/** Reads one tag's end from `i` (just after its name), skipping quoted attribute values. */
function tagEnd(src: string, i: number): number {
  let quote = "";
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      // A quote only opens a value right after "=" (possibly with spaces); elsewhere it is part of a name.
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j]!)) j--;
      if (src[j] === "=") quote = ch;
    } else if (ch === ">") return i + 1;
  }
  return src.length;
}

/** Every start and end tag in source order, as an HTML parser tokenizes them (comments, doctypes and raw text skipped). */
export function scanTags(src: string): Tag[] {
  const tags: Tag[] = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src[lt + 1] === "!" || src[lt + 1] === "?") {
      const end = src.indexOf(">", lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    const close = src[lt + 1] === "/";
    const nameMatch = /^[a-zA-Z][^\s/>]*/.exec(src.slice(lt + (close ? 2 : 1), lt + (close ? 2 : 1) + 64));
    if (!nameMatch) {
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    const nameEnd = lt + (close ? 2 : 1) + nameMatch[0].length;
    const end = tagEnd(src, nameEnd);
    const selfClosing = !close && (VOID.has(name) || src[end - 2] === "/");
    tags.push({ name, start: lt, end, nameEnd, close, selfClosing });
    i = end;
    if (!close && RAW.has(name)) {
      // Raw text runs to the matching end tag, whatever it holds.
      const re = new RegExp(`</${name}[\\s/>]`, "ig");
      re.lastIndex = end;
      const found = re.exec(src);
      i = found ? found.index : src.length;
    }
  }
  return tags;
}

/** The source with every start tag numbered (`data-sp-part="n"`, n counting start tags from 0). */
export function markParts(src: string, tags = scanTags(src)): string {
  let out = "";
  let at = 0;
  let n = 0;
  for (const tag of tags) {
    if (tag.close) continue;
    out += `${src.slice(at, tag.nameEnd)} ${PART_ATTR}="${n++}"`;
    at = tag.nameEnd;
  }
  return out + src.slice(at);
}

/** The n-th start tag, its content and its end, or null when its end tag can't be found (left implied). */
export function partRange(tags: Tag[], n: number): { tag: Tag; innerStart: number; innerEnd: number; end: number } | null {
  const starts = tags.filter(t => !t.close);
  const tag = starts[n];
  if (!tag) return null;
  if (tag.selfClosing) return { tag, innerStart: tag.end, innerEnd: tag.end, end: tag.end };
  const from = tags.indexOf(tag);
  let depth = 0;
  for (let k = from + 1; k < tags.length; k++) {
    const t = tags[k]!;
    if (t.name !== tag.name) continue;
    if (!t.close) {
      if (!t.selfClosing) depth++;
    } else if (depth) depth--;
    else return { tag, innerStart: tag.end, innerEnd: t.start, end: t.end };
  }
  return null;
}

// ---- style attributes ----

/** Splits a style attribute's declarations (`;` outside quotes and brackets). */
function declarations(style: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let from = 0;
  for (let i = 0; i < style.length; i++) {
    const ch = style[i]!;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && !depth) {
      out.push(style.slice(from, i));
      from = i + 1;
    }
  }
  out.push(style.slice(from));
  return out.filter(d => d.trim());
}

function propOf(declaration: string): string {
  const colon = declaration.indexOf(":");
  return (colon < 0 ? declaration : declaration.slice(0, colon)).trim().toLowerCase();
}

/** One property's value in a style attribute (the last one wins, as in CSS), or null. */
export function styleValue(style: string, prop: string): string | null {
  let value: string | null = null;
  for (const d of declarations(style)) if (propOf(d) === prop) value = d.slice(d.indexOf(":") + 1).replace(/!important\s*$/i, "").trim();
  return value;
}

/** The style attribute with these properties set (null removes one); the others stay exactly as written. */
export function setStyleValues(style: string, set: Record<string, string | null>): string {
  const kept = declarations(style).filter(d => !(propOf(d) in set)).map(d => d.trim());
  for (const [prop, value] of Object.entries(set)) if (value !== null) kept.push(`${prop}: ${value}`);
  return kept.join("; ");
}

// ---- values the edit frame and the toolbar may write ----

/** Colours as the toolbar writes them: hex, rgb(a)/hsl(a) of plain numbers, `transparent`, or a CSS colour name. */
export function safeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(v) && [4, 5, 7, 9].includes(v.length)) return v;
  if (/^(rgb|hsl)a?\(\s*[-\d.%\s,/]+\)$/i.test(v) && v.length < 64) return v;
  if (/^[a-zA-Z]{3,24}$/.test(v)) return v.toLowerCase();
  return null;
}

/** The properties a part's style may get, each with what its value may be. */
const STYLE_VALUES: Record<string, (value: string) => boolean> = {
  color: v => safeColor(v) === v,
  "background-color": v => safeColor(v) === v,
  "font-size": v => /^\d{1,4}(\.\d{1,2})?px$/.test(v),
  "font-weight": v => /^(normal|bold|[1-9]00)$/.test(v),
  "font-style": v => /^(normal|italic)$/.test(v),
  translate: v => /^-?\d{1,5}(\.\d)?px -?\d{1,5}(\.\d)?px$/.test(v),
};

/** Keeps only the style changes the toolbar can make (unknown properties and odd values are dropped). */
export function safeStyleSet(set: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!set || typeof set !== "object") return out;
  for (const [prop, value] of Object.entries(set as Record<string, unknown>)) {
    const check = STYLE_VALUES[prop];
    if (!check) continue;
    if (value === null) out[prop] = null;
    else if (typeof value === "string" && check(value)) out[prop] = value;
  }
  return out;
}

/**
 * A part's `translate` moved by dx, dy (px), from what the style attribute says now (the `translate` property, so the
 * part's own `transform` stays as written). Null when it already has a translate that isn't in px (a `50%` is kept).
 */
export function movedTranslate(style: string, dx: number, dy: number): string | null {
  const now = styleValue(style, "translate") ?? "";
  const m = /^(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?$/.exec(now);
  if (!m && now && now !== "none") return null;
  const x = (m ? Number(m[1]) : 0) + dx;
  const y = (m ? Number(m[2] ?? 0) : 0) + dy;
  const r = (v: number) => Math.round(Math.max(-99999, Math.min(99999, v)) * 10) / 10;
  return `${r(x)}px ${r(y)}px`;
}

// ---- changes ----

export type PartChange =
  | { kind: "style"; part: number; set: Record<string, string | null> }
  | { kind: "move"; part: number; dx: number; dy: number }
  | { kind: "text"; part: number; texts: string[] }
  | { kind: "delete"; part: number };

export type ParseHtml = (html: string) => Document;

/** A DOMParser in the browser: parsing never runs the source's scripts or loads anything. */
export const parseHtml: ParseHtml = html => new DOMParser().parseFromString(html, "text/html");

/** How the element's html is parsed: as the body of its page, exactly as the live element's page has it. */
function parseBody(parse: ParseHtml, html: string): Document {
  return parse(`<!doctype html><html><head></head><body>${html}</body></html>`);
}

const SKIP_TEXT = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

/** A part's text nodes in order (not those of scripts or styles inside it): what the edit frame reports when typing. */
export function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walk = (node: Node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) out.push(child as Text);
      else if (child.nodeType === 1 && !SKIP_TEXT.has((child as Element).tagName)) walk(child);
    }
  };
  walk(root);
  return out;
}

function stripMarks(doc: Document) {
  for (const el of Array.from(doc.querySelectorAll(`[${PART_ATTR}]`))) el.removeAttribute(PART_ATTR);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** The tag's source with its style attribute replaced (or added, or removed when empty). */
function retagStyle(src: string, tag: Tag, style: string): string {
  const text = src.slice(tag.start, tag.end);
  const attrs = text.slice(tag.nameEnd - tag.start);
  const re = /(\s)style\s*=\s*("[^"]*"|'[^']*'|[^\s>"'=<`]+)|(\s)style(?=[\s/>])/gi;
  const value = style ? ` style="${escapeAttr(style)}"` : "";
  let done = false;
  const replaced = attrs.replace(re, () => {
    if (done) return "";
    done = true;
    return value;
  });
  if (done) return src.slice(tag.start, tag.nameEnd) + replaced;
  if (!value) return text;
  // Add it right after the name, so a `/>` or an unquoted last value is left as it was.
  return src.slice(tag.start, tag.nameEnd) + value + attrs;
}

const MAX_TEXT = 200_000;

/**
 * The element's html after one change to one part, or null when there's nothing to change (the part is gone, a value
 * isn't allowed) or it can't be written safely.
 */
export function applyPartChange(src: string, change: PartChange, parse: ParseHtml = parseHtml): string | null {
  if (!Number.isInteger(change.part) || change.part < 0) return null;
  const tags = scanTags(src);
  const doc = parseBody(parse, markParts(src, tags));
  const el = doc.querySelector(`[${PART_ATTR}="${change.part}"]`);
  const tag = tags.filter(t => !t.close)[change.part];
  if (!el || !tag || tag.name !== el.tagName.toLowerCase()) return null;
  // A source's own <html>/<head>/<body> are merged into the page's: they can be styled, never emptied or removed.
  const root = el === doc.documentElement || el === doc.body || el === doc.head;

  let spliced: string | null = null;
  if (change.kind === "style" || change.kind === "move") {
    const before = el.getAttribute("style") ?? "";
    const set = change.kind === "move"
      ? Number.isFinite(change.dx) && Number.isFinite(change.dy) ? { translate: movedTranslate(before, change.dx, change.dy) ?? "" } : {}
      : safeStyleSet(change.set);
    if (!Object.keys(set).length || set.translate === "") return null;
    const style = setStyleValues(before, set);
    if (style === before) return null;
    if (style) el.setAttribute("style", style);
    else el.removeAttribute("style");
    spliced = src.slice(0, tag.start) + retagStyle(src, tag, style) + src.slice(tag.end);
  } else if (change.kind === "text") {
    if (root || !Array.isArray(change.texts) || change.texts.some(t => typeof t !== "string")) return null;
    if (change.texts.reduce((n, t) => n + t.length, 0) > MAX_TEXT) return null;
    const nodes = textNodes(el);
    if (nodes.map(node => node.data).join("\u0000") === change.texts.join("\u0000") && nodes.length === change.texts.length) return null;
    if (nodes.length === change.texts.length) nodes.forEach((node, i) => { node.data = change.texts[i]!; });
    else el.textContent = change.texts.join("");
    const range = partRange(tags, change.part);
    if (range && !tag.selfClosing) {
      const inner = el.cloneNode(true) as Element;
      for (const marked of Array.from(inner.querySelectorAll(`[${PART_ATTR}]`))) marked.removeAttribute(PART_ATTR);
      spliced = src.slice(0, range.innerStart) + inner.innerHTML + src.slice(range.innerEnd);
    }
  } else if (change.kind === "delete") {
    if (root) return null;
    el.remove();
    const range = partRange(tags, change.part);
    if (range) spliced = src.slice(0, tag.start) + src.slice(range.end);
  } else return null;

  // The splice is right when a browser reads it exactly as the changed parse.
  stripMarks(doc);
  const expected = doc.documentElement.outerHTML;
  if (spliced !== null && parseBody(parse, spliced).documentElement.outerHTML === expected) return spliced;
  // A source that is a whole page keeps its <html>/<head>/<body> tags only in the source: don't lose them.
  if (tags.some(t => t.name === "html" || t.name === "head" || t.name === "body")) return null;
  return doc.body.innerHTML;
}

/** A computed colour from the edit frame (`rgb(…)`/`rgba(…)`) as hex for the colour picker; null when transparent. */
export function cssColorToHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(value.trim());
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  if (!(alpha > 0)) return null;
  const hex = [m[1], m[2], m[3]].map(n => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("");
  return `#${hex.toUpperCase()}${alpha < 1 ? Math.round(alpha * 255).toString(16).padStart(2, "0").toUpperCase() : ""}`;
}

/** The start tags' names in order: two sources with the same list number their parts the same way. */
export function partNames(src: string): string {
  return scanTags(src).filter(t => !t.close).map(t => t.name).join(" ");
}
