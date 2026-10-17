import { XMLParser } from "fast-xml-parser";
import { posix } from "node:path";

// A small ordered XML tree over fast-xml-parser (order matters: z-order of shapes, runs inside paragraphs).

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

type Raw = Record<string, unknown>;

function convert(arr: Raw[]): XNode[] {
  const out: XNode[] = [];
  for (const obj of arr) {
    const attrs = (obj[":@"] as Record<string, string>) ?? {};
    for (const key of Object.keys(obj)) {
      if (key === ":@") continue;
      if (key === "#text") {
        out.push({ name: "#text", attrs: {}, children: [], text: String(obj[key]) });
        continue;
      }
      out.push({ name: key, attrs: { ...attrs }, children: convert((obj[key] as Raw[]) ?? []), text: "" });
    }
  }
  return out;
}

export function parseXml(xml: string): XNode {
  const nodes = convert(parser.parse(xml) as Raw[]);
  const root = nodes.find((n) => n.name !== "#text" && !n.name.startsWith("?"));
  return root ?? { name: "#empty", attrs: {}, children: [], text: "" };
}

export const EMPTY: XNode = { name: "#empty", attrs: {}, children: [], text: "" };

/** First child with this name (names include the prefix, e.g. "p:sp"). */
export function child(n: XNode | undefined | null, name: string): XNode | undefined {
  return n?.children.find((c) => c.name === name);
}

export function kids(n: XNode | undefined | null, name?: string): XNode[] {
  if (!n) return [];
  return name ? n.children.filter((c) => c.name === name) : n.children.filter((c) => c.name !== "#text");
}

/** Follow a path of child names. */
export function path(n: XNode | undefined | null, ...names: string[]): XNode | undefined {
  let cur: XNode | undefined | null = n;
  for (const nm of names) {
    cur = child(cur, nm);
    if (!cur) return undefined;
  }
  return cur ?? undefined;
}

/** Depth-first search for the first descendant with this name. */
export function find(n: XNode | undefined | null, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const c of n.children) {
    if (c.name === name) return c;
    const f = find(c, name);
    if (f) return f;
  }
  return undefined;
}

export function findAll(n: XNode | undefined | null, name: string, out: XNode[] = []): XNode[] {
  if (!n) return out;
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

export function attr(n: XNode | undefined | null, name: string): string | undefined {
  return n?.attrs[name];
}

export function num(n: XNode | undefined | null, name: string, d?: number): number | undefined {
  const v = n?.attrs[name];
  if (v === undefined) return d;
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

export function textOf(n: XNode | undefined | null): string {
  if (!n) return "";
  if (n.name === "#text") return n.text;
  return n.children.map(textOf).join("");
}

/** Resolve a relationship target against the part that refers to it. */
export function resolvePart(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  return posix.normalize(posix.join(posix.dirname(fromPart), target));
}

export function relsPathFor(part: string): string {
  return posix.join(posix.dirname(part), "_rels", posix.basename(part) + ".rels");
}
