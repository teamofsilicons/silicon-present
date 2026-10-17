import JSZip from "jszip";
import { mix, newElementId, newGroupId, newSlideId, normalizeDeck } from "@silicon-present/deck";
import type { Chart, DeckJson, Element, ElementInput, Paragraph, RichText, Run, Slide, Theme } from "@silicon-present/deck";
import { ConverterError } from "../errors";
import { extOf, imageSize, sniffType, typeForExt } from "../media";
import { EMPTY, attr, child, find, findAll, kids, num, parseXml, path, relsPathFor, resolvePart, textOf, type XNode } from "./xml";

// Native .pptx importer. Reads the package (presentation, slides, layouts, masters, theme, charts, notes, media) and
// builds deck JSON: text with runs and paragraph attributes (inherited from placeholders, layouts, masters and the
// presentation's default text style), preset shapes with fills and lines, pictures, tables, charts, video/audio,
// backgrounds, notes, sections, hidden slides and transitions. Group shapes are flattened (children keep a shared
// `group` id and their real position). Anything it can't model (SmartArt, OLE objects, ink, 3D, custom geometry,
// unknown graphic data, pictures browsers can't show) is returned as a "region" so the caller can replace it with a
// picture of that part cut from LibreOffice's render of the slide. Nothing is dropped.

export interface ImportedAsset {
  key: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface Region {
  slideIndex: number;
  /** id of the placeholder image element to fill with the picture */
  elementId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  why: string;
}

export interface PptxImport {
  deck: DeckJson;
  assets: ImportedAsset[];
  regions: Region[];
  /** Slide size in points (for cropping regions out of a PDF render). */
  pageWidthPt: number;
  pageHeightPt: number;
}

type Rels = Map<string, { target: string; type: string; external: boolean }>;

interface Part {
  path: string;
  xml: XNode;
  rels: Rels;
}

interface ThemeInfo {
  colors: Record<string, string>;
  major: string;
  minor: string;
  name: string;
}

interface Ctx {
  zip: JSZip;
  k: number; // px per EMU
  ptPx: number; // px per pt
  theme: ThemeInfo;
  clrMap: Record<string, string>;
  assets: ImportedAsset[];
  assetByPart: Map<string, string>;
  regions: Region[];
  usedIds: Set<string>;
  slideIdByPart: Map<string, string>;
  pendingSlideLinks: Array<{ set: (v: string) => void; part: string }>;
  defaultTextStyle: XNode | undefined;
  /** the shape name each element id came from (to recognise our own exported ids) */
  nameOf: Map<string, string>;
}

const NS_TABLE = "http://schemas.openxmlformats.org/drawingml/2006/table";
const NS_CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart";

// ---------------------------------------------------------------- package helpers

async function readText(zip: JSZip, p: string): Promise<string | null> {
  const f = zip.file(p);
  return f ? f.async("string") : null;
}

async function readRels(zip: JSZip, part: string): Promise<Rels> {
  const rels: Rels = new Map();
  const xml = await readText(zip, relsPathFor(part));
  if (!xml) return rels;
  for (const r of kids(parseXml(xml), "Relationship")) {
    const external = attr(r, "TargetMode") === "External";
    const target = attr(r, "Target") ?? "";
    rels.set(attr(r, "Id") ?? "", { target: external ? target : resolvePart(part, target), type: attr(r, "Type") ?? "", external });
  }
  return rels;
}

const partCache = new WeakMap<JSZip, Map<string, Promise<Part | null>>>();
function loadPart(zip: JSZip, p: string): Promise<Part | null> {
  let m = partCache.get(zip);
  if (!m) partCache.set(zip, (m = new Map()));
  if (!m.has(p)) {
    m.set(
      p,
      (async () => {
        const xml = await readText(zip, p);
        if (xml === null) return null;
        return { path: p, xml: parseXml(xml), rels: await readRels(zip, p) };
      })(),
    );
  }
  return m.get(p)!;
}

function relOfType(rels: Rels, type: string): string | undefined {
  for (const r of rels.values()) if (r.type.endsWith("/" + type)) return r.target;
  return undefined;
}

// ---------------------------------------------------------------- colours

function hexToRgb(h: string): [number, number, number] {
  const x = h.replace("#", "");
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]: number[]): string {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v!))).toString(16).padStart(2, "0")).join("");
}
function rgbToHsl([r, g, b]: number[]): [number, number, number] {
  const R = r! / 255, G = g! / 255, B = b! / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb([h, s, l]: number[]): [number, number, number] {
  if (s === 0) return [l! * 255, l! * 255, l! * 255];
  const f = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l! < 0.5 ? l! * (1 + s!) : l! + s! - l! * s!;
  const p = 2 * l! - q;
  return [f(p, q, h! + 1 / 3) * 255, f(p, q, h!) * 255, f(p, q, h! - 1 / 3) * 255];
}

const PRESET: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", gray: "#808080", grey: "#808080", darkGray: "#a9a9a9", lightGray: "#d3d3d3", orange: "#ffa500", purple: "#800080" };

export interface Color {
  hex: string;
  alpha: number;
}

/** Resolve the colour element inside `n` (srgbClr, schemeClr, sysClr, prstClr, scrgbClr, hslClr) with its modifiers. */
function colorIn(n: XNode | undefined, ctx: Ctx, phClr?: string): Color | null {
  if (!n) return null;
  const c = n.children.find((x) => ["a:srgbClr", "a:schemeClr", "a:sysClr", "a:prstClr", "a:scrgbClr", "a:hslClr"].includes(x.name));
  if (!c) return null;
  let hex: string | undefined;
  switch (c.name) {
    case "a:srgbClr":
      hex = "#" + (attr(c, "val") ?? "000000").toLowerCase();
      break;
    case "a:sysClr":
      hex = "#" + (attr(c, "lastClr") ?? (attr(c, "val") === "window" ? "ffffff" : "000000")).toLowerCase();
      break;
    case "a:prstClr":
      hex = PRESET[attr(c, "val") ?? ""] ?? "#000000";
      break;
    case "a:scrgbClr":
      hex = rgbToHex([num(c, "r", 0)! / 1000 * 2.55, num(c, "g", 0)! / 1000 * 2.55, num(c, "b", 0)! / 1000 * 2.55]);
      break;
    case "a:hslClr":
      hex = rgbToHex(hslToRgb([num(c, "hue", 0)! / 21600000, num(c, "sat", 0)! / 100000, num(c, "lum", 0)! / 100000]));
      break;
    case "a:schemeClr": {
      let v = attr(c, "val") ?? "tx1";
      if (v === "phClr") {
        hex = phClr ?? ctx.theme.colors.dk1;
        break;
      }
      v = ctx.clrMap[v] ?? v;
      hex = ctx.theme.colors[v] ?? "#000000";
      break;
    }
  }
  let rgb = hexToRgb(hex ?? "#000000");
  let alpha = 1;
  for (const m of c.children) {
    const val = num(m, "val", 100000)! / 100000;
    switch (m.name) {
      case "a:lumMod": {
        const hsl = rgbToHsl(rgb);
        hsl[2] = hsl[2] * val;
        rgb = hslToRgb(hsl);
        break;
      }
      case "a:lumOff": {
        const hsl = rgbToHsl(rgb);
        hsl[2] = Math.min(1, hsl[2] + val);
        rgb = hslToRgb(hsl);
        break;
      }
      case "a:tint":
        rgb = rgb.map((x) => x + (255 - x) * (1 - val)) as [number, number, number];
        break;
      case "a:shade":
        rgb = rgb.map((x) => x * val) as [number, number, number];
        break;
      case "a:satMod": {
        const hsl = rgbToHsl(rgb);
        hsl[1] = Math.min(1, hsl[1] * val);
        rgb = hslToRgb(hsl);
        break;
      }
      case "a:alpha":
        alpha = val;
        break;
    }
  }
  return { hex: rgbToHex(rgb), alpha };
}

function colorStr(c: Color | null): string | undefined {
  if (!c) return undefined;
  if (c.alpha < 0.999) return c.hex + Math.round(c.alpha * 255).toString(16).padStart(2, "0");
  return c.hex;
}

type Fill = { kind: "none" } | { kind: "color"; color: Color } | { kind: "image"; rId: string; node: XNode };

function fillOf(spPr: XNode | undefined, ctx: Ctx, phClr?: string): Fill | undefined {
  if (!spPr) return undefined;
  for (const c of spPr.children) {
    if (c.name === "a:noFill") return { kind: "none" };
    if (c.name === "a:solidFill") {
      const col = colorIn(c, ctx, phClr);
      if (col) return { kind: "color", color: col };
    }
    if (c.name === "a:gradFill") {
      const stops = findAll(c, "a:gs").map((g) => colorIn(g, ctx, phClr)).filter(Boolean) as Color[];
      if (stops.length) {
        // a gradient becomes its middle colour (the format has no gradients)
        const a = stops[0]!, b = stops[stops.length - 1]!;
        return { kind: "color", color: { hex: mix(a.hex, b.hex, 0.5), alpha: a.alpha } };
      }
    }
    if (c.name === "a:pattFill") {
      const col = colorIn(child(c, "a:fgClr"), ctx, phClr);
      if (col) return { kind: "color", color: col };
    }
    if (c.name === "a:blipFill") {
      const rId = attr(child(c, "a:blip"), "r:embed");
      if (rId) return { kind: "image", rId, node: c };
    }
  }
  return undefined;
}

/** Fill from the shape's style (p:style/a:fillRef) when spPr has none. */
function styleFill(sp: XNode, ctx: Ctx): Fill | undefined {
  const ref = path(sp, "p:style", "a:fillRef");
  if (!ref || num(ref, "idx", 0) === 0) return undefined;
  const col = colorIn(ref, ctx);
  return col ? { kind: "color", color: col } : undefined;
}

function lineOf(spPr: XNode | undefined, sp: XNode, ctx: Ctx): { color?: string; width?: number } | null | undefined {
  const ln = child(spPr, "a:ln");
  if (ln) {
    if (child(ln, "a:noFill")) return null;
    const fillNode = child(ln, "a:solidFill") ?? child(ln, "a:gradFill");
    const ref = path(sp, "p:style", "a:lnRef");
    // a line with no fill of its own and no style line is invisible (Keynote writes <a:ln w=".."/> on every text box)
    const col = fillNode ? (colorIn(fillNode, ctx) ?? colorIn(find(fillNode, "a:gs"), ctx)) : ref && num(ref, "idx", 0)! > 0 ? colorIn(ref, ctx) : null;
    if (!col) return null;
    const w = num(ln, "w");
    return { color: colorStr(col), width: w !== undefined ? w * ctx.k : 12700 * ctx.k };
  }
  const ref = path(sp, "p:style", "a:lnRef");
  if (ref && num(ref, "idx", 0)! > 0) {
    const col = colorIn(ref, ctx);
    if (col) return { color: colorStr(col), width: 12700 * ctx.k };
  }
  return undefined;
}

// ---------------------------------------------------------------- geometry

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

function xfrmOf(n: XNode | undefined): { off: [number, number]; ext: [number, number]; rot: number; flipH: boolean; flipV: boolean; chOff?: [number, number]; chExt?: [number, number] } | null {
  if (!n) return null;
  const off = child(n, "a:off");
  const ext = child(n, "a:ext");
  if (!off || !ext) return null;
  const chOff = child(n, "a:chOff");
  const chExt = child(n, "a:chExt");
  return {
    off: [num(off, "x", 0)!, num(off, "y", 0)!],
    ext: [num(ext, "cx", 0)!, num(ext, "cy", 0)!],
    rot: num(n, "rot", 0)! / 60000,
    flipH: attr(n, "flipH") === "1",
    flipV: attr(n, "flipV") === "1",
    chOff: chOff ? [num(chOff, "x", 0)!, num(chOff, "y", 0)!] : undefined,
    chExt: chExt ? [num(chExt, "cx", 0)!, num(chExt, "cy", 0)!] : undefined,
  };
}

/** Maps child EMU coordinates of a group to slide EMU coordinates. */
interface Transform {
  apply(x: number, y: number, w: number, h: number, rot: number): { x: number; y: number; w: number; h: number; rot: number };
}

const IDENTITY: Transform = { apply: (x, y, w, h, rot) => ({ x, y, w, h, rot }) };

function groupTransform(xf: NonNullable<ReturnType<typeof xfrmOf>>, parent: Transform): Transform {
  const sx = xf.chExt && xf.chExt[0] ? xf.ext[0] / xf.chExt[0] : 1;
  const sy = xf.chExt && xf.chExt[1] ? xf.ext[1] / xf.chExt[1] : 1;
  const chOff = xf.chOff ?? [0, 0];
  return {
    apply(x, y, w, h, rot) {
      // into the group's frame (unrotated)
      let nx = xf.off[0] + (x - chOff[0]) * sx;
      let ny = xf.off[1] + (y - chOff[1]) * sy;
      const nw = w * sx;
      const nh = h * sy;
      let nrot = rot;
      if (xf.rot) {
        // rotate the child's centre around the group's centre
        const gcx = xf.off[0] + xf.ext[0] / 2;
        const gcy = xf.off[1] + xf.ext[1] / 2;
        const cx = nx + nw / 2 - gcx;
        const cy = ny + nh / 2 - gcy;
        const a = (xf.rot * Math.PI) / 180;
        const rx = cx * Math.cos(a) - cy * Math.sin(a);
        const ry = cx * Math.sin(a) + cy * Math.cos(a);
        nx = gcx + rx - nw / 2;
        ny = gcy + ry - nh / 2;
        nrot += xf.rot;
      }
      return parent.apply(nx, ny, nw, nh, nrot);
    },
  };
}

// ---------------------------------------------------------------- text

interface LevelProps {
  p: Record<string, string>;
  bullet?: "none" | "bullet" | "ordered";
  lnSpcPct?: number;
  r: Record<string, string>;
  color?: Color | null;
  font?: string;
}

function levelProps(lvl: XNode | undefined, ctx: Ctx): LevelProps | null {
  if (!lvl) return null;
  const out: LevelProps = { p: { ...lvl.attrs }, r: {} };
  if (child(lvl, "a:buNone")) out.bullet = "none";
  else if (child(lvl, "a:buAutoNum")) out.bullet = "ordered";
  else if (child(lvl, "a:buChar") || child(lvl, "a:buBlip")) out.bullet = "bullet";
  const spc = path(lvl, "a:lnSpc", "a:spcPct");
  if (spc) out.lnSpcPct = num(spc, "val", 100000)! / 100000;
  const def = child(lvl, "a:defRPr");
  if (def) {
    out.r = { ...def.attrs };
    const col = colorIn(child(def, "a:solidFill"), ctx);
    if (col) out.color = col;
    const latin = attr(child(def, "a:latin"), "typeface");
    if (latin) out.font = latin;
  }
  return out;
}

function mergeLevel(a: LevelProps, b: LevelProps | null): LevelProps {
  if (!b) return a;
  return {
    p: { ...a.p, ...b.p },
    bullet: b.bullet ?? a.bullet,
    lnSpcPct: b.lnSpcPct ?? a.lnSpcPct,
    r: { ...a.r, ...b.r },
    color: b.color !== undefined ? b.color : a.color,
    font: b.font ?? a.font,
  };
}

/** lstStyle-like nodes (a:lstStyle, p:titleStyle, p:bodyStyle, a:defaultTextStyle) from general to specific. */
type StyleChain = Array<XNode | undefined>;

function levelFromChain(chain: StyleChain, level: number, ctx: Ctx): LevelProps {
  let acc: LevelProps = { p: {}, r: {} };
  for (const st of chain) {
    if (!st) continue;
    acc = mergeLevel(acc, levelProps(child(st, "a:defPPr"), ctx));
    acc = mergeLevel(acc, levelProps(child(st, `a:lvl${level + 1}pPr`), ctx));
  }
  return acc;
}

function resolveFont(tf: string | undefined, ctx: Ctx): string | undefined {
  if (!tf) return undefined;
  if (tf.startsWith("+mj")) return ctx.theme.major;
  if (tf.startsWith("+mn")) return ctx.theme.minor;
  return tf;
}

interface TextResult {
  rt: RichText;
}

function runFrom(text: string, rPr: XNode | undefined, base: LevelProps, ctx: Ctx, fontScale: number, part: Part, defaultColor: Color | null): Run | null {
  if (!text) return null;
  const r: Run = { text };
  const a = { ...base.r, ...(rPr?.attrs ?? {}) };
  if (a.b === "1" || a.b === "true") r.bold = true;
  if (a.i === "1" || a.i === "true") r.italic = true;
  if (a.u && a.u !== "none") r.underline = true;
  if (a.strike && a.strike !== "noStrike") r.strike = true;
  const sz = Number(a.sz);
  r.size = Math.round((Number.isFinite(sz) && sz > 0 ? sz / 100 : 18) * ctx.ptPx * fontScale * 10) / 10;
  const col = colorIn(child(rPr, "a:solidFill"), ctx) ?? base.color ?? defaultColor;
  const c = colorStr(col ?? null);
  if (c) r.color = c;
  const hl = colorIn(child(rPr, "a:highlight"), ctx);
  if (hl) r.highlight = hl.hex;
  const font = resolveFont(attr(child(rPr, "a:latin"), "typeface") ?? base.font, ctx);
  if (font) r.font = font;
  const link = child(rPr, "a:hlinkClick");
  if (link) {
    const rel = part.rels.get(attr(link, "r:id") ?? "");
    const action = attr(link, "action") ?? "";
    if (rel && rel.external && /^(https?:|mailto:)/i.test(rel.target)) r.link = rel.target;
    else if (rel && action.includes("hlinksldjump")) ctx.pendingSlideLinks.push({ part: rel.target, set: (v) => (r.link = `slide:${v}`) });
  }
  return r;
}

/** A txBody as rich text, with paragraph and run properties resolved through the style chain. */
function readTxBody(txBody: XNode | undefined, chain: StyleChain, ctx: Ctx, part: Part, defaultColor: Color | null, fontScaleIn?: number): TextResult {
  const paragraphs: Paragraph[] = [];
  if (!txBody) return { rt: { paragraphs } };
  const bodyPr = child(txBody, "a:bodyPr");
  const autofit = child(bodyPr, "a:normAutofit");
  const fontScale = fontScaleIn ?? (autofit ? num(autofit, "fontScale", 100000)! / 100000 : 1);
  const fullChain = [...chain, child(txBody, "a:lstStyle")];
  for (const p of kids(txBody, "a:p")) {
    const pPr = child(p, "a:pPr");
    const level = Math.max(0, Math.min(8, num(pPr, "lvl", 0)!));
    const base = mergeLevel(levelFromChain(fullChain, level, ctx), levelProps(pPr, ctx));
    const para: Paragraph = { runs: [] };
    const algn = base.p.algn; // "l" is the default and stays implicit
    if (algn === "ctr") para.align = "center";
    else if (algn === "r") para.align = "right";
    else if (algn === "just" || algn === "dist") para.align = "justify";
    if (level) para.indent = level;
    if (base.bullet === "bullet") para.list = "bullet";
    if (base.bullet === "ordered") para.list = "ordered";
    if (base.lnSpcPct && Math.abs(base.lnSpcPct - 1) > 0.01) para.lineHeight = Math.round(base.lnSpcPct * 1.2 * 100) / 100;
    for (const r of p.children) {
      if (r.name === "a:r" || r.name === "a:fld") {
        const run = runFrom(textOf(child(r, "a:t")), child(r, "a:rPr"), base, ctx, fontScale, part, defaultColor);
        if (run) para.runs.push(run);
      } else if (r.name === "a:br") {
        const run = runFrom(" ", child(r, "a:rPr"), base, ctx, fontScale, part, defaultColor);
        if (run) para.runs.push(run);
      }
    }
    // an empty paragraph keeps its size through the end-of-paragraph properties
    if (!para.runs.length) {
      const end = child(p, "a:endParaRPr");
      if (para.list) delete para.list;
      void end;
    }
    paragraphs.push(para);
  }
  return { rt: { paragraphs } };
}

// ---------------------------------------------------------------- placeholders

interface Ph {
  type: string;
  idx?: string;
}

function phOf(nv: XNode | undefined): Ph | null {
  const ph = path(nv, "p:nvPr", "p:ph");
  if (!ph) return null;
  return { type: attr(ph, "type") ?? "obj", idx: attr(ph, "idx") };
}

function phNode(sp: XNode): XNode | undefined {
  return child(sp, "p:nvSpPr") ?? child(sp, "p:nvPicPr") ?? child(sp, "p:nvGraphicFramePr") ?? child(sp, "p:nvGrpSpPr") ?? child(sp, "p:nvCxnSpPr");
}

function findPh(part: Part | null, ph: Ph): XNode | undefined {
  if (!part) return undefined;
  const all = findAll(path(part.xml, "p:cSld", "p:spTree"), "p:sp");
  const withPh = all.map((sp) => ({ sp, ph: phOf(phNode(sp)) })).filter((x) => x.ph) as Array<{ sp: XNode; ph: Ph }>;
  if (ph.idx !== undefined) {
    const byIdx = withPh.find((x) => x.ph.idx === ph.idx);
    if (byIdx) return byIdx.sp;
  }
  const norm = (t: string) => (t === "ctrTitle" ? "title" : t === "subTitle" || t === "obj" ? "body" : t);
  return withPh.find((x) => x.ph.type === ph.type)?.sp ?? withPh.find((x) => norm(x.ph.type) === norm(ph.type))?.sp;
}

function masterStyleFor(master: Part | null, ph: Ph | null): XNode | undefined {
  const tx = path(master?.xml, "p:txStyles");
  if (!ph) return child(tx, "p:otherStyle");
  if (ph.type === "title" || ph.type === "ctrTitle") return child(tx, "p:titleStyle");
  if (["body", "subTitle", "obj", "tbl", "chart", "dgm", "media", "clipArt", "pic"].includes(ph.type)) return child(tx, "p:bodyStyle");
  return child(tx, "p:otherStyle");
}

// ---------------------------------------------------------------- shapes

const PRST: Record<string, string> = {
  rect: "rect",
  roundRect: "round-rect",
  snipRoundRect: "round-rect",
  round2SameRect: "round-rect",
  ellipse: "ellipse",
  triangle: "triangle",
  rtTriangle: "right-triangle",
  diamond: "diamond",
  pentagon: "pentagon",
  homePlate: "chevron",
  hexagon: "hexagon",
  octagon: "octagon",
  star5: "star",
  star4: "star",
  star6: "star",
  rightArrow: "arrow-right",
  leftArrow: "arrow-left",
  upArrow: "arrow-up",
  downArrow: "arrow-down",
  chevron: "chevron",
  line: "line",
  straightConnector1: "line",
  wedgeRectCallout: "callout",
  wedgeRoundRectCallout: "callout",
  wedgeEllipseCallout: "callout",
  cloudCallout: "cloud",
  heart: "heart",
  cloud: "cloud",
  plus: "plus",
  mathPlus: "plus",
  flowChartProcess: "rect",
  flowChartAlternateProcess: "round-rect",
  flowChartDecision: "diamond",
  flowChartConnector: "ellipse",
};

interface SlideBuild {
  elements: ElementInput[];
  slideIndex: number;
  part: Part;
  layout: Part | null;
  master: Part | null;
  group: string | null;
}

function takeId(name: string | undefined, ctx: Ctx): string {
  if (name && /^e_[0-9a-z]{6}$/.test(name) && !ctx.usedIds.has(name)) {
    ctx.usedIds.add(name);
    ctx.nameOf.set(name, name);
    return name;
  }
  let id = newElementId();
  while (ctx.usedIds.has(id)) id = newElementId();
  ctx.usedIds.add(id);
  if (name) ctx.nameOf.set(id, name);
  return id;
}

function px(ctx: Ctx, v: number): number {
  return Math.round(v * ctx.k * 100) / 100;
}

function boxFrom(xf: NonNullable<ReturnType<typeof xfrmOf>>, t: Transform, ctx: Ctx) {
  const r = t.apply(xf.off[0], xf.off[1], xf.ext[0], xf.ext[1], xf.rot);
  return { x: px(ctx, r.x), y: px(ctx, r.y), w: px(ctx, r.w), h: px(ctx, r.h), rotation: Math.round((((r.rot % 360) + 360) % 360) * 100) / 100 };
}

function addRegion(b: SlideBuild, ctx: Ctx, box: { x: number; y: number; w: number; h: number; rotation: number }, why: string, name?: string) {
  // the picture covers the rotated shape's bounding box, unrotated
  const a = (box.rotation * Math.PI) / 180;
  const bw = Math.abs(box.w * Math.cos(a)) + Math.abs(box.h * Math.sin(a));
  const bh = Math.abs(box.w * Math.sin(a)) + Math.abs(box.h * Math.cos(a));
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const r = { x: cx - bw / 2, y: cy - bh / 2, w: Math.max(1, bw), h: Math.max(1, bh) };
  const id = takeId(name, ctx);
  b.elements.push({ id, kind: "image", ...r, rotation: 0, src: "", alt: why, fit: "fill", group: b.group });
  ctx.regions.push({ slideIndex: b.slideIndex, elementId: id, ...r, why });
}

async function assetFor(ctx: Ctx, partPath: string, opts: { crop?: { l: number; t: number; r: number; b: number } } = {}): Promise<{ key: string; contentType: string; data: Buffer } | null> {
  const cacheKey = partPath + (opts.crop ? JSON.stringify(opts.crop) : "");
  const existing = ctx.assetByPart.get(cacheKey);
  if (existing) {
    const a = ctx.assets.find((x) => x.key === existing)!;
    return { key: a.key, contentType: a.contentType, data: a.data };
  }
  const f = ctx.zip.file(partPath);
  if (!f) return null;
  let data = await f.async("nodebuffer");
  let ct = sniffType(data, partPath);
  if (ct === "application/octet-stream") ct = typeForExt(extOf(partPath));
  let filename = partPath.split("/").pop()!;
  if (opts.crop && ct.startsWith("image/")) {
    const { toPng } = await import("../browser");
    const png = await toPng(data, ct, opts.crop);
    data = png.png;
    ct = "image/png";
    filename = filename.replace(/\.[^.]+$/, "") + "-cropped.png";
  }
  const key = `a${ctx.assets.length + 1}`;
  ctx.assets.push({ key, filename, contentType: ct, data });
  ctx.assetByPart.set(cacheKey, key);
  return { key, contentType: ct, data };
}

const BROWSER_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp", "image/x-icon"]);

function linkFor(nv: XNode | undefined, part: Part, ctx: Ctx, set: (v: string) => void): void {
  const h = path(nv, "p:cNvPr", "a:hlinkClick");
  if (!h) return;
  const rel = part.rels.get(attr(h, "r:id") ?? "");
  const action = attr(h, "action") ?? "";
  if (rel?.external && /^(https?:|mailto:)/i.test(rel.target)) set(rel.target);
  else if (rel && action.includes("hlinksldjump")) ctx.pendingSlideLinks.push({ part: rel.target, set: (v) => set(`slide:${v}`) });
}

async function readSp(sp: XNode, b: SlideBuild, t: Transform, ctx: Ctx, from: Part): Promise<void> {
  const nv = child(sp, "p:nvSpPr");
  const name = attr(path(nv, "p:cNvPr"), "name");
  if (attr(path(nv, "p:cNvPr"), "hidden") === "1") return;
  const ph = phOf(nv);
  const spPr = child(sp, "p:spPr");
  // placeholders inherit position, body properties and text styles from the layout and master
  const layoutPh = ph && from !== b.layout && from !== b.master ? findPh(b.layout, ph) : undefined;
  const masterPh = ph && from !== b.master ? findPh(b.master, ph) : undefined;
  const xf = xfrmOf(child(spPr, "a:xfrm")) ?? xfrmOf(path(layoutPh, "p:spPr", "a:xfrm")) ?? xfrmOf(path(masterPh, "p:spPr", "a:xfrm"));
  if (!xf) return;
  const box = boxFrom(xf, t, ctx);
  const prst = attr(child(spPr, "a:prstGeom"), "prst") ?? (child(spPr, "a:custGeom") ? "__custom" : "rect");
  const fill = fillOf(spPr, ctx) ?? styleFill(sp, ctx) ?? (ph ? fillOf(path(layoutPh, "p:spPr"), ctx) ?? fillOf(path(masterPh, "p:spPr"), ctx) : undefined);
  const line = lineOf(spPr, sp, ctx);
  const is3d = !!find(spPr, "a:sp3d") && (!!find(spPr, "a:bevelT") || num(find(spPr, "a:sp3d"), "extrusionH", 0)! > 0);
  if (prst === "__custom" || is3d || (!PRST[prst] && prst !== "rect")) {
    addRegion(b, ctx, box, prst === "__custom" ? "Custom shape (picture of how it looked)" : is3d ? "3D shape (picture of how it looked)" : `Shape "${prst}" (picture of how it looked)`, name);
    return;
  }
  // text: style chain general -> specific
  const chain: StyleChain = [];
  if (ph) chain.push(ctx.defaultTextStyle, masterStyleFor(b.master, ph), child(path(masterPh, "p:txBody"), "a:lstStyle"), child(path(layoutPh, "p:txBody"), "a:lstStyle"));
  // text that isn't in a placeholder follows the presentation's default text style (as PowerPoint does; the master's
  // otherStyle is for slide numbers, dates and footers, and Keynote sets it right-aligned)
  else chain.push(ctx.defaultTextStyle);
  const fontRef = path(sp, "p:style", "a:fontRef");
  const defaultColor = colorIn(fontRef, ctx) ?? { hex: ctx.theme.colors[ctx.clrMap.tx1 ?? "dk1"] ?? "#000000", alpha: 1 };
  const txBody = child(sp, "p:txBody");
  const bodyPr = child(txBody, "a:bodyPr") ?? EMPTY;
  const inheritedBodyPr = [path(masterPh, "p:txBody", "a:bodyPr"), path(layoutPh, "p:txBody", "a:bodyPr"), bodyPr];
  const bp = Object.assign({}, ...inheritedBodyPr.map((n) => n?.attrs ?? {})) as Record<string, string>;
  const autofit = inheritedBodyPr.map((n) => child(n, "a:normAutofit")).filter(Boolean).pop();
  const fontScale = autofit ? num(autofit, "fontScale", 100000)! / 100000 : 1;
  const { rt } = readTxBody(txBody, chain, ctx, from, defaultColor, fontScale);
  const style: Record<string, unknown> = {};
  const anchor = bp.anchor ?? "t";
  style.verticalAlign = anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : "top";
  const lIns = bp.lIns !== undefined ? Number(bp.lIns) : 91440;
  style.padding = Math.round(lIns * ctx.k * 10) / 10;
  if (fill?.kind === "color") style.fill = colorStr(fill.color);
  if (line && line.color) {
    style.stroke = line.color;
    if (line.width !== undefined) style.strokeWidth = Math.max(0.5, Math.round(line.width * 10) / 10);
  }
  if (find(spPr, "a:outerShdw")) style.shadow = true;
  const shape = PRST[prst] ?? "rect";
  const id = takeId(name, ctx);
  const el: Record<string, unknown> = { id, ...box, style, group: b.group };
  linkFor(nv, from, ctx, (v) => (el.link = v));
  if (fill?.kind === "image") {
    // a shape filled with a picture becomes a picture of that size
    const rel = from.rels.get(fill.rId);
    const asset = rel && !rel.external ? await assetFor(ctx, rel.target) : null;
    if (asset && BROWSER_IMAGES.has(asset.contentType)) {
      b.elements.push({ ...el, kind: "image", src: `asset:${asset.key}`, alt: name ?? "", fit: "cover", style: {} });
      if (rt.paragraphs.some((p) => p.runs.length)) b.elements.push({ ...el, id: takeId(undefined, ctx), kind: "text", text: rt, style: { verticalAlign: style.verticalAlign, padding: style.padding } });
      return;
    }
  }
  if (shape === "line" || (sp.name === "p:cxnSp")) {
    // lines: our line runs from top-left to bottom-right, so flipped lines become a rotated horizontal line
    const len = Math.hypot(box.w, box.h);
    const angle = (Math.atan2(xf.flipV !== xf.flipH ? -box.h : box.h, box.w) * 180) / Math.PI + box.rotation;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const lineStyle: Record<string, unknown> = { stroke: (line && line.color) ?? colorStr(defaultColor), strokeWidth: line?.width ?? 2 };
    b.elements.push({ ...el, kind: "shape", shape: "line", x: cx - len / 2, y: cy, w: len, h: 0, rotation: Math.round((((angle % 360) + 360) % 360) * 100) / 100, style: lineStyle, text: { paragraphs: [] } });
    return;
  }
  const isPlainBox = shape === "rect" && (!fill || fill.kind === "none") && (!line || !line.color);
  const isTextBox = attr(path(nv, "p:cNvSpPr"), "txBox") === "1";
  if (isPlainBox || (isTextBox && (shape === "rect" || shape === "round-rect"))) {
    if (shape === "round-rect") {
      const adj = find(child(spPr, "a:prstGeom"), "a:gd");
      const v = adj ? Number((attr(adj, "fmla") ?? "val 16667").replace("val ", "")) : 16667;
      style.radius = Math.round(Math.min(box.w, box.h) * (v / 100000) * 10) / 10;
    }
    b.elements.push({ ...el, kind: "text", text: rt });
    return;
  }
  // in a shape, our renderer centres paragraphs that don't say otherwise; OOXML's default is left, so say it
  for (const p of rt.paragraphs) if (!p.align) p.align = "left";
  if (!fill) style.fill = undefined;
  if (fill?.kind === "none") {
    delete style.fill;
    if (!style.stroke) style.fill = "transparent";
  }
  if (shape === "round-rect") {
    const adj = find(child(spPr, "a:prstGeom"), "a:gd");
    const v = adj ? Number((attr(adj, "fmla") ?? "val 16667").replace("val ", "")) : 16667;
    style.radius = Math.round(Math.min(box.w, box.h) * (v / 100000) * 10) / 10;
  }
  b.elements.push({ ...el, kind: "shape", shape, text: rt, style });
}

async function readPic(pic: XNode, b: SlideBuild, t: Transform, ctx: Ctx, from: Part): Promise<void> {
  const nv = child(pic, "p:nvPicPr");
  const name = attr(path(nv, "p:cNvPr"), "name");
  if (attr(path(nv, "p:cNvPr"), "hidden") === "1") return;
  const descr = attr(path(nv, "p:cNvPr"), "descr") ?? "";
  const ph = phOf(nv);
  const spPr = child(pic, "p:spPr");
  const layoutPh = ph ? findPh(b.layout, ph) : undefined;
  const xf = xfrmOf(child(spPr, "a:xfrm")) ?? xfrmOf(path(layoutPh, "p:spPr", "a:xfrm"));
  if (!xf) return;
  const box = boxFrom(xf, t, ctx);
  const blipFill = child(pic, "p:blipFill");
  const blip = child(blipFill, "a:blip");
  const rel = from.rels.get(attr(blip, "r:embed") ?? attr(blip, "r:link") ?? "");
  const src = child(blipFill, "a:srcRect");
  const crop = src
    ? { l: num(src, "l", 0)! / 100000, t: num(src, "t", 0)! / 100000, r: num(src, "r", 0)! / 100000, b: num(src, "b", 0)! / 100000 }
    : undefined;
  const hasCrop = crop && (crop.l > 0.001 || crop.t > 0.001 || crop.r > 0.001 || crop.b > 0.001);
  // media
  const nvPr = child(nv, "p:nvPr");
  const video = child(nvPr, "a:videoFile");
  const audio = child(nvPr, "a:audioFile");
  const p14media = find(nvPr, "p14:media");
  if (video || audio || p14media) {
    const mRel = from.rels.get(attr(p14media, "r:embed") ?? "") ?? from.rels.get(attr(video ?? audio, "r:link") ?? "");
    let srcRef = "";
    if (mRel?.external) srcRef = mRel.target;
    else if (mRel) {
      const a = await assetFor(ctx, mRel.target);
      if (a) srcRef = `asset:${a.key}`;
    }
    // audio or video: the element, then the r:link relationship type, then the bytes themselves
    const linkRel = from.rels.get(attr(video ?? audio, "r:link") ?? "");
    let kind: "audio" | "video" = audio ? "audio" : linkRel?.type.endsWith("/audio") ? "audio" : "video";
    if (!audio && !linkRel?.type.endsWith("/audio") && srcRef.startsWith("asset:")) {
      const a = ctx.assets.find((x) => `asset:${x.key}` === srcRef);
      if (a?.contentType.startsWith("audio/")) kind = "audio";
    }
    let poster: string | null = null;
    if (rel && !rel.external && kind === "video") {
      const p = await assetFor(ctx, rel.target);
      if (p && BROWSER_IMAGES.has(p.contentType)) poster = `asset:${p.key}`;
    }
    const id = takeId(name, ctx);
    if (kind === "video") b.elements.push({ id, kind: "video", ...box, src: srcRef, alt: descr, autoplay: false, loop: false, muted: false, poster, group: b.group });
    else b.elements.push({ id, kind: "audio", ...box, src: srcRef, alt: descr || "Audio", autoplay: false, loop: false, muted: false, group: b.group });
    return;
  }
  if (!rel) return;
  let srcRef: string;
  let ct = "";
  let natural: { width: number; height: number } | null = null;
  if (rel.external) srcRef = rel.target;
  else {
    const f = ctx.zip.file(rel.target);
    if (!f) return;
    const peek = await f.async("nodebuffer");
    ct = sniffType(peek, rel.target);
    if (!BROWSER_IMAGES.has(ct)) {
      // EMF/WMF/TIFF: browsers can't show these; use a picture of how it rendered
      addRegion(b, ctx, box, `Picture in ${ct.split("/")[1]} format (picture of how it looked)`, name);
      return;
    }
    const a = await assetFor(ctx, rel.target, { crop: hasCrop ? crop : undefined });
    if (!a) return;
    srcRef = `asset:${a.key}`;
    natural = imageSize(a.data, a.contentType);
  }
  // a picture that keeps its aspect ratio is "contain" (same look, and resizing keeps it undistorted); else "fill"
  let fit: "contain" | "fill" = "fill";
  if (natural && box.w > 0 && box.h > 0 && Math.abs(natural.width / natural.height - box.w / box.h) < 0.02 * (box.w / box.h)) fit = "contain";
  const id = takeId(name, ctx);
  const el: Record<string, unknown> = { id, kind: "image", ...box, src: srcRef, alt: descr, fit, group: b.group };
  const ln = lineOf(spPr, pic, ctx);
  const style: Record<string, unknown> = {};
  if (ln && ln.color) {
    style.stroke = ln.color;
    if (ln.width) style.strokeWidth = ln.width;
  }
  if (attr(child(spPr, "a:prstGeom"), "prst") === "ellipse") style.radius = Math.min(box.w, box.h) / 2;
  if (attr(child(spPr, "a:prstGeom"), "prst") === "roundRect") style.radius = Math.min(box.w, box.h) * 0.16;
  const alpha = num(child(blip, "a:alphaModFix"), "amt");
  if (alpha !== undefined) style.opacity = alpha / 100000;
  el.style = style;
  linkFor(nv, from, ctx, (v) => (el.link = v));
  b.elements.push(el as ElementInput);
}

async function readChartPart(ctx: Ctx, partPath: string): Promise<Chart | null> {
  const part = await loadPart(ctx.zip, partPath);
  if (!part) return null;
  const chartN = path(part.xml, "c:chart");
  const plot = child(chartN, "c:plotArea");
  if (!plot) return null;
  const kinds = ["c:barChart", "c:bar3DChart", "c:lineChart", "c:line3DChart", "c:areaChart", "c:area3DChart", "c:pieChart", "c:pie3DChart", "c:doughnutChart", "c:scatterChart", "c:ofPieChart"];
  const typed = plot.children.filter((c) => kinds.includes(c.name));
  if (!typed.length) return null;
  const first = typed[0]!;
  let type: Chart["type"] = "column";
  if (first.name.startsWith("c:bar")) type = attr(child(first, "c:barDir"), "val") === "bar" ? "bar" : "column";
  else if (first.name.startsWith("c:line")) type = "line";
  else if (first.name.startsWith("c:area")) type = "area";
  else if (first.name === "c:doughnutChart") type = "donut";
  else if (first.name.startsWith("c:pie") || first.name === "c:ofPieChart") type = "pie";
  else if (first.name === "c:scatterChart") type = "scatter";
  const cache = (n: XNode | undefined): string[] => {
    if (!n) return [];
    const c = find(n, "c:strCache") ?? find(n, "c:numCache") ?? find(n, "c:strLit") ?? find(n, "c:numLit") ?? find(n, "c:multiLvlStrCache");
    if (!c) return [];
    const count = num(child(c, "c:ptCount"), "val", 0)!;
    const out: string[] = new Array(count).fill("");
    // multi-level categories: the first level holds the innermost labels
    const pts = c.name === "c:multiLvlStrCache" ? kids(child(c, "c:lvl"), "c:pt") : kids(c, "c:pt");
    for (const pt of pts) out[num(pt, "idx", 0)!] = textOf(child(pt, "c:v"));
    return out;
  };
  let labels: string[] = [];
  const series: Chart["series"] = [];
  for (const t of typed) {
    for (const ser of kids(t, "c:ser")) {
      const tx = child(ser, "c:tx");
      const name = tx ? (cache(tx)[0] ?? textOf(child(tx, "c:v"))) : `Series ${series.length + 1}`;
      const cat = child(ser, type === "scatter" ? "c:xVal" : "c:cat");
      const val = child(ser, type === "scatter" ? "c:yVal" : "c:val");
      const cats = cache(cat);
      if (cats.length > labels.length) labels = cats;
      const values = cache(val).map((v) => (v === "" ? 0 : Number(v) || 0));
      const s: Chart["series"][number] = { name, values };
      const col = colorIn(path(ser, "c:spPr", "a:solidFill"), ctx);
      if (col && type !== "pie" && type !== "donut") s.color = col.hex;
      series.push(s);
    }
  }
  const chart: Chart = { type, labels, series, legend: !!child(chartN, "c:legend") };
  const titleN = child(chartN, "c:title");
  const autoDeleted = attr(child(chartN, "c:autoTitleDeleted"), "val") === "1";
  if (titleN) {
    const rich = find(titleN, "c:rich");
    const tt = rich ? findAll(rich, "a:t").map(textOf).join("") : cache(child(titleN, "c:tx"))[0];
    if (tt) chart.title = tt;
    else if (!autoDeleted && series.length === 1) chart.title = series[0]!.name;
  }
  return chart;
}

async function readGraphicFrame(gf: XNode, b: SlideBuild, t: Transform, ctx: Ctx, from: Part): Promise<void> {
  const nv = child(gf, "p:nvGraphicFramePr");
  const name = attr(path(nv, "p:cNvPr"), "name");
  const xf = xfrmOf(child(gf, "p:xfrm"));
  if (!xf) return;
  const box = boxFrom(xf, t, ctx);
  const gd = path(gf, "a:graphic", "a:graphicData");
  const uri = attr(gd, "uri") ?? "";
  if (uri === NS_TABLE) {
    const tbl = child(gd, "a:tbl");
    const cols = kids(child(tbl, "a:tblGrid"), "a:gridCol").map((c) => px(ctx, num(c, "w", 0)!));
    const rows = kids(tbl, "a:tr");
    const rowHeights = rows.map((r) => px(ctx, num(r, "h", 0)!));
    const cells = rows.map((r) =>
      kids(r, "a:tc").map((tc) => {
        if (attr(tc, "hMerge") === "1" || attr(tc, "vMerge") === "1") return { text: { paragraphs: [] }, fill: null };
        const { rt } = readTxBody(child(tc, "a:txBody"), [ctx.defaultTextStyle], ctx, from, { hex: ctx.theme.colors[ctx.clrMap.tx1 ?? "dk1"] ?? "#000000", alpha: 1 }, 1);
        const f = fillOf(child(tc, "a:tcPr"), ctx);
        return { text: rt, fill: f?.kind === "color" ? (colorStr(f.color) ?? null) : null };
      }),
    );
    const firstTc = find(tbl, "a:tcPr");
    const border = child(firstTc, "a:lnB") ?? child(firstTc, "a:lnL");
    const style: Record<string, unknown> = {};
    if (border && !child(border, "a:noFill")) {
      const c = colorIn(child(border, "a:solidFill"), ctx);
      if (c) style.stroke = c.hex;
      const w = num(border, "w");
      if (w !== undefined) style.strokeWidth = Math.max(0.5, w * ctx.k);
    }
    const total = rowHeights.reduce((a, c) => a + c, 0);
    b.elements.push({
      id: takeId(name, ctx),
      kind: "table",
      ...box,
      h: Math.max(box.h, total),
      rows: rows.length,
      cols: cols.length,
      colWidths: cols,
      rowHeights,
      headerRow: attr(child(tbl, "a:tblPr"), "firstRow") === "1",
      cells,
      style,
      group: b.group,
    });
    return;
  }
  if (uri === NS_CHART) {
    const rel = from.rels.get(attr(child(gd, "c:chart"), "r:id") ?? "");
    const chart = rel ? await readChartPart(ctx, rel.target) : null;
    if (chart) {
      b.elements.push({ id: takeId(name, ctx), kind: "chart", ...box, chart, group: b.group });
      return;
    }
  }
  addRegion(b, ctx, box, uri.includes("diagram") ? "SmartArt (picture of how it looked)" : uri.includes("ole") ? "Embedded object (picture of how it looked)" : "Object (picture of how it looked)", name);
}

async function readTree(nodes: XNode[], b: SlideBuild, t: Transform, ctx: Ctx, from: Part, opts: { skipPlaceholders?: boolean } = {}): Promise<void> {
  for (const n of nodes) {
    if (opts.skipPlaceholders && phOf(phNode(n))) continue;
    switch (n.name) {
      case "p:sp":
      case "p:cxnSp":
        await readSp(n, b, t, ctx, from);
        break;
      case "p:pic":
        await readPic(n, b, t, ctx, from);
        break;
      case "p:graphicFrame":
        await readGraphicFrame(n, b, t, ctx, from);
        break;
      case "p:grpSp": {
        const xf = xfrmOf(path(n, "p:grpSpPr", "a:xfrm"));
        const inner = xf ? groupTransform(xf, t) : t;
        const outerGroup = b.group;
        if (!b.group) b.group = newGroupId(); // nested groups flatten into the outermost group
        await readTree(kids(n), b, inner, ctx, from, opts);
        b.group = outerGroup;
        break;
      }
      case "mc:AlternateContent": {
        const pick = child(n, "mc:Fallback") ?? child(n, "mc:Choice");
        if (pick) await readTree(kids(pick), b, t, ctx, from, opts);
        break;
      }
      case "p:contentPart": {
        const xf = xfrmOf(child(n, "p14:xfrm"));
        if (xf) addRegion(b, ctx, boxFrom(xf, t, ctx), "Ink (picture of how it looked)");
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- slides

async function background(parts: Array<Part | null>, ctx: Ctx): Promise<Slide["background"]> {
  for (const p of parts) {
    const bg = path(p?.xml, "p:cSld", "p:bg");
    if (!bg || !p) continue;
    const bgPr = child(bg, "p:bgPr");
    if (bgPr) {
      const f = fillOf(bgPr, ctx);
      if (f?.kind === "color") return { color: f.color.hex };
      if (f?.kind === "image") {
        const rel = p.rels.get(f.rId);
        if (rel && !rel.external) {
          const a = await assetFor(ctx, rel.target);
          if (a && BROWSER_IMAGES.has(a.contentType)) return { image: `asset:${a.key}`, fit: "cover" };
        }
      }
      if (f?.kind === "none") return null;
    }
    const ref = child(bg, "p:bgRef");
    if (ref) {
      const c = colorIn(ref, ctx);
      if (c) return { color: c.hex };
    }
  }
  return null;
}

function transitionOf(sld: XNode): Slide["transition"] {
  let tr = child(sld, "p:transition");
  if (!tr) {
    for (const ac of kids(sld, "mc:AlternateContent")) {
      tr = find(child(ac, "mc:Choice"), "p:transition") ?? find(child(ac, "mc:Fallback"), "p:transition");
      if (tr) break;
    }
  }
  if (!tr) return null;
  const effect = kids(tr).find((k) => !k.name.endsWith("sndAc") && !k.name.endsWith("extLst"));
  if (!effect) return null; // timing only (Keynote writes one on every slide): no effect
  const spd = attr(tr, "spd") ?? "fast";
  const dur = num(tr, "p14:dur") ?? (spd === "slow" ? 1000 : spd === "med" ? 750 : 500);
  const dirMap: Record<string, "left" | "right" | "up" | "down"> = { l: "left", r: "right", u: "up", d: "down" };
  const name = effect?.name.replace(/^p\d*:/, "") ?? "fade";
  const dir = dirMap[attr(effect, "dir") ?? ""];
  if (!effect) return { type: "fade", duration: dur };
  if (name === "push") return { type: "push", duration: dur, direction: dir ?? "left" };
  if (name === "wipe") return { type: "wipe", duration: dur, direction: dir ?? "left" };
  if (name === "cover" || name === "pull") return { type: "cover", duration: dur, direction: dir ?? "left" };
  if (name === "zoom" || name === "newsflash") return { type: "zoom", duration: dur };
  return { type: "fade", duration: dur };
}

function layoutName(layout: Part | null): string {
  const type = attr(layout?.xml, "type") ?? "";
  return (
    ({ title: "title", obj: "title-body", tx: "title-body", twoObj: "two-columns", twoTxTwoObj: "two-columns", twoColTx: "two-columns", secHead: "section", titleOnly: "title-only", picTx: "image-caption", blank: "blank" } as Record<string, string>)[type] ?? "blank"
  );
}

async function notesOf(slide: Part, ctx: Ctx): Promise<string> {
  const notesPath = relOfType(slide.rels, "notesSlide");
  if (!notesPath) return "";
  const notes = await loadPart(ctx.zip, notesPath);
  if (!notes) return "";
  for (const sp of findAll(path(notes.xml, "p:cSld", "p:spTree"), "p:sp")) {
    const ph = phOf(child(sp, "p:nvSpPr"));
    if (ph?.type !== "body") continue;
    return kids(child(sp, "p:txBody"), "a:p")
      .map((p) => p.children.map((r) => (r.name === "a:r" || r.name === "a:fld" ? textOf(child(r, "a:t")) : r.name === "a:br" ? "\n" : "")).join(""))
      .join("\n")
      .replace(/\s+$/, "");
  }
  return "";
}

async function themeOf(zip: JSZip, master: Part | null): Promise<ThemeInfo> {
  const def: ThemeInfo = {
    name: "Imported",
    major: "Calibri Light",
    minor: "Calibri",
    colors: { dk1: "#000000", lt1: "#ffffff", dk2: "#44546a", lt2: "#e7e6e6", accent1: "#4472c4", accent2: "#ed7d31", accent3: "#a5a5a5", accent4: "#ffc000", accent5: "#5b9bd5", accent6: "#70ad47", hlink: "#0563c1", folHlink: "#954f72" },
  };
  const tp = master ? relOfType(master.rels, "theme") : undefined;
  const theme = tp ? await loadPart(zip, tp) : null;
  if (!theme) return def;
  const scheme = find(theme.xml, "a:clrScheme");
  for (const c of kids(scheme)) {
    const key = c.name.replace("a:", "");
    const s = child(c, "a:srgbClr");
    const sys = child(c, "a:sysClr");
    if (s) def.colors[key] = "#" + (attr(s, "val") ?? "000000").toLowerCase();
    else if (sys) def.colors[key] = "#" + (attr(sys, "lastClr") ?? "000000").toLowerCase();
  }
  def.major = attr(path(find(theme.xml, "a:majorFont"), "a:latin"), "typeface") || def.major;
  def.minor = attr(path(find(theme.xml, "a:minorFont"), "a:latin"), "typeface") || def.minor;
  def.name = attr(theme.xml, "name") ?? attr(scheme, "name") ?? def.name;
  return def;
}

function sameGeometry(a: ElementInput, b: ElementInput): boolean {
  return ["x", "y", "w", "h", "kind"].every((k) => JSON.stringify((a as Record<string, unknown>)[k]) === JSON.stringify((b as Record<string, unknown>)[k]));
}

export async function importPptx(data: Buffer): Promise<PptxImport> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new ConverterError("unreadable_file", "The file is not a valid PowerPoint (.pptx) package.", "Check the file isn't damaged or password protected, then try again.", 422);
  }
  const pres = await loadPart(zip, "ppt/presentation.xml");
  if (!pres) throw new ConverterError("unreadable_file", "The file has no ppt/presentation.xml, so it isn't a PowerPoint deck.", "Export it from PowerPoint, Keynote or Google Slides as .pptx and try again.", 422);
  const sz = child(pres.xml, "p:sldSz");
  const cx = num(sz, "cx", 12192000)!;
  const cy = num(sz, "cy", 6858000)!;
  const width = 1920;
  const k = width / cx;
  const height = Math.round(cy * k);
  const sldIds = kids(child(pres.xml, "p:sldIdLst"), "p:sldId");
  const firstSlidePart = sldIds.length ? pres.rels.get(attr(sldIds[0], "r:id") ?? "")?.target : undefined;
  const firstSlide = firstSlidePart ? await loadPart(zip, firstSlidePart) : null;
  const firstLayout = firstSlide ? await loadPart(zip, relOfType(firstSlide.rels, "slideLayout") ?? "") : null;
  const firstMaster = firstLayout ? await loadPart(zip, relOfType(firstLayout.rels, "slideMaster") ?? "") : await loadPart(zip, relOfType(pres.rels, "slideMaster") ?? "");
  const theme = await themeOf(zip, firstMaster);
  const clrMapNode = child(firstMaster?.xml, "p:clrMap");
  const ctx: Ctx = {
    zip,
    k,
    ptPx: width / (cx / 12700),
    theme,
    clrMap: { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2", ...(clrMapNode?.attrs ?? {}) },
    assets: [],
    assetByPart: new Map(),
    regions: [],
    usedIds: new Set(),
    slideIdByPart: new Map(),
    pendingSlideLinks: [],
    defaultTextStyle: child(pres.xml, "p:defaultTextStyle"),
    nameOf: new Map(),
  };
  // sections: p14:sectionLst in the presentation's extLst
  const sectionStart = new Map<string, string>();
  for (const sec of findAll(pres.xml, "p14:section")) {
    const first = find(sec, "p14:sldId");
    if (first) sectionStart.set(attr(first, "id") ?? "", attr(sec, "name") ?? "Section");
  }
  const slides: Slide[] = [];
  const masterDecorByPath = new Map<string, ElementInput[]>();
  const slideMasters: Array<string | null> = [];
  const layoutDecor = new Map<string, ElementInput[]>();
  const usedSlideIds = new Set<string>();
  const slideLayouts: Array<string | null> = [];
  for (const [i, sid] of sldIds.entries()) {
    const partPath = pres.rels.get(attr(sid, "r:id") ?? "")?.target;
    const part = partPath ? await loadPart(zip, partPath) : null;
    if (!part) continue;
    const layout = await loadPart(zip, relOfType(part.rels, "slideLayout") ?? "");
    const master = layout ? await loadPart(zip, relOfType(layout.rels, "slideMaster") ?? "") : firstMaster;
    // decks we exported carry the slide id as the slide's name
    const named = attr(child(part.xml, "p:cSld"), "name") ?? "";
    let id = /^s_[0-9a-z]{6}$/.test(named) && !usedSlideIds.has(named) ? named : newSlideId();
    while (usedSlideIds.has(id)) id = newSlideId();
    usedSlideIds.add(id);
    ctx.slideIdByPart.set(part.path, id);
    const b: SlideBuild = { elements: [], slideIndex: slides.length, part, layout, master, group: null };
    // each master's decorations (non-placeholder shapes), read once
    if (master && !masterDecorByPath.has(master.path)) {
      const mb: SlideBuild = { ...b, elements: [] };
      await readTree(kids(path(master.xml, "p:cSld", "p:spTree")), mb, IDENTITY, ctx, master, { skipPlaceholders: true });
      // decorations are copied onto many slides, so a part that would need a per-slide picture is left to the slides
      masterDecorByPath.set(master.path, mb.elements.filter((e) => !ctx.regions.some((r) => r.elementId === e.id)));
      ctx.regions = ctx.regions.filter((r) => !mb.elements.some((e) => e.id === r.elementId));
    }
    slideMasters.push(master?.path ?? null);
    if (layout && !layoutDecor.has(layout.path)) {
      const lb: SlideBuild = { ...b, elements: [] };
      await readTree(kids(path(layout.xml, "p:cSld", "p:spTree")), lb, IDENTITY, ctx, layout, { skipPlaceholders: true });
      layoutDecor.set(layout.path, lb.elements.filter((e) => !ctx.regions.some((r) => r.elementId === e.id)));
      ctx.regions = ctx.regions.filter((r) => !lb.elements.some((e) => e.id === r.elementId));
    }
    slideLayouts.push(layout?.path ?? null);
    await readTree(kids(path(part.xml, "p:cSld", "p:spTree")), b, IDENTITY, ctx, part);
    const showMaster = attr(part.xml, "showMasterSp") !== "0" && attr(layout?.xml, "showMasterSp") !== "0";
    const slide: Slide = {
      id,
      layout: layoutName(layout),
      background: await background([part, layout, master], ctx),
      skipped: attr(part.xml, "show") === "0",
      section: sectionStart.get(attr(sid, "id") ?? "") ?? null,
      hideMaster: !showMaster,
      transition: transitionOf(part.xml),
      notes: await notesOf(part, ctx),
      elements: b.elements as Element[],
    };
    slides.push(slide);
  }
  // The master most slides use becomes the deck's master. Slides on another master hide it and get that master's
  // decorations as their own elements; layout decorations are drawn under each slide that uses the layout.
  const useCount = new Map<string, number>();
  for (const m of slideMasters) if (m) useCount.set(m, (useCount.get(m) ?? 0) + 1);
  const primary = [...useCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const copy = (els: ElementInput[]) => els.map((e) => ({ ...e, id: takeId(undefined, ctx) }));
  slides.forEach((s, i) => {
    const own = slideMasters[i];
    const extra: ElementInput[] = [];
    if (own && own !== primary) {
      if (!s.hideMaster) extra.push(...copy(masterDecorByPath.get(own) ?? []));
      s.hideMaster = true;
    }
    const decor = slideLayouts[i] ? layoutDecor.get(slideLayouts[i]!) ?? [] : [];
    extra.push(...copy(decor));
    if (extra.length) s.elements = [...extra, ...s.elements] as Element[];
  });
  let masterElements: ElementInput[] = primary ? masterDecorByPath.get(primary) ?? [] : [];
  if (!masterElements.length && slides.length > 1) {
    // Decks we exported ourselves repeat the master on every slide that shows it: elements named with one of our
    // ids that appear on several slides with the same geometry go back into the master.
    const byName = new Map<string, Array<{ slide: Slide; el: Element }>>();
    for (const s of slides)
      for (const e of s.elements) {
        const nm = ctx.nameOf.get(e.id);
        if (!nm || !/^e_[0-9a-z]{6}$/.test(nm)) continue;
        if (!byName.has(nm)) byName.set(nm, []);
        byName.get(nm)!.push({ slide: s, el: e });
      }
    const hoist = [...byName.entries()].filter(([, l]) => l.length >= 2 && new Set(l.map((x) => x.slide)).size === l.length && l.every((x) => sameGeometry(x.el, l[0]!.el)));
    if (hoist.length) {
      const names = new Set(hoist.map(([nm]) => nm));
      const firstSlide = slides.find((s) => s.elements.some((e) => names.has(ctx.nameOf.get(e.id) ?? "")))!;
      masterElements = firstSlide.elements.filter((e) => names.has(ctx.nameOf.get(e.id) ?? "")).map((e) => ({ ...e, id: ctx.nameOf.get(e.id)! }));
      for (const s of slides) {
        const has = s.elements.filter((e) => names.has(ctx.nameOf.get(e.id) ?? ""));
        if (has.length === names.size) {
          s.elements = s.elements.filter((e) => !names.has(ctx.nameOf.get(e.id) ?? ""));
          s.hideMaster = false;
        } else s.hideMaster = true;
      }
      // the slide that kept the original ids now has them in the master; free nothing else
    }
  }
  // resolve slide links now that every slide has an id
  for (const l of ctx.pendingSlideLinks) {
    const id = ctx.slideIdByPart.get(l.part);
    if (id) l.set(id);
  }
  // when every bit of an element's text carries the same link, it's the element's link (that's how we export one)
  for (const s of [...slides, { elements: masterElements as Element[] }]) {
    for (const e of s.elements) {
      if ((e.kind !== "text" && e.kind !== "shape") || e.link) continue;
      const runs = (e.text?.paragraphs ?? []).flatMap((p) => p.runs).filter((r) => r.text.trim());
      const links = new Set(runs.map((r) => r.link ?? ""));
      if (runs.length && links.size === 1 && !links.has("")) {
        e.link = [...links][0]!;
        for (const p of e.text.paragraphs) for (const r of p.runs) delete r.link;
      }
    }
  }
  const themeOut: Theme = {
    name: theme.name,
    fonts: { heading: theme.major, body: theme.minor },
    colors: {
      background: theme.colors[ctx.clrMap.bg1 ?? "lt1"] ?? "#ffffff",
      text: theme.colors[ctx.clrMap.tx1 ?? "dk1"] ?? "#000000",
      accent: theme.colors.accent1 ?? "#4472c4",
      accent2: theme.colors.accent2 ?? "#ed7d31",
      accent3: theme.colors.accent3 ?? "#a5a5a5",
      muted: mix(theme.colors[ctx.clrMap.tx1 ?? "dk1"] ?? "#000000", theme.colors[ctx.clrMap.bg1 ?? "lt1"] ?? "#ffffff", 0.45),
    },
    customFonts: [],
  };
  const title = textOf(find((await loadPart(zip, "docProps/core.xml"))?.xml, "dc:title")) || undefined;
  const deck = normalizeDeck({ title, size: { width, height }, theme: themeOut, master: { elements: masterElements }, slides: slides as never });
  return { deck, assets: ctx.assets, regions: ctx.regions, pageWidthPt: cx / 12700, pageHeightPt: cy / 12700 };
}

export { sameGeometry };
