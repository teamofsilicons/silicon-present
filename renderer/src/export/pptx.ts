import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import { luminance, mix, seriesPalette } from "@silicon-present/deck";
import type { Chart, DeckJson, Element, RichText, Run, Slide, Theme } from "@silicon-present/deck";
import { BODY_SIZE, HEADING_SIZES, TABLE_SIZE } from "@silicon-present/render";
import type { FetchSrc } from "../assets";
import { elementPicture, toPng } from "../browser";
import { extForType, imageSize, sniffType } from "../media";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FFMPEG, HAVE, jobDir } from "../config";
import { run } from "../proc";

// Deck -> .pptx with native objects: text runs, preset shapes, tables, charts, pictures, video/audio, notes,
// sections, hidden slides and transitions. HTML elements (which PowerPoint can't run) become a picture of the element
// as it renders, so no slide comes out blank. Element animations are not written (PowerPoint's timing XML is out of
// scope for now); everything else round-trips through our importer.

const PX_PER_IN = 144; // 1920 px = 13.333 in, PowerPoint's 16:9
const inch = (px: number) => px / PX_PER_IN;
const pt = (px: number) => Math.round((px / 2) * 100) / 100; // 1 px = 0.5 pt

export function hex(c: unknown, fallback?: string): string | undefined {
  if (typeof c !== "string") return fallback;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
  if (!m) return fallback;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  return h.toUpperCase();
}

const SHAPE_MAP: Record<string, string> = {
  rect: "rect",
  "round-rect": "roundRect",
  ellipse: "ellipse",
  triangle: "triangle",
  "right-triangle": "rtTriangle",
  diamond: "diamond",
  pentagon: "pentagon",
  hexagon: "hexagon",
  octagon: "octagon",
  star: "star5",
  "arrow-right": "rightArrow",
  "arrow-left": "leftArrow",
  "arrow-up": "upArrow",
  "arrow-down": "downArrow",
  chevron: "chevron",
  line: "line",
  callout: "wedgeRoundRectCallout",
  heart: "heart",
  cloud: "cloud",
  plus: "plus",
};

interface Ctx {
  deck: DeckJson;
  theme: Theme;
  fetchSrc: FetchSrc;
  assetUrl: (id: string) => string;
  slideIndex: Map<string, number>;
  warnings: string[];
  chartsAsPictures?: boolean;
  mediaAsPictures?: boolean;
}

function runOptions(r: Run, para: { heading?: number }, ctx: Ctx, defaults: { size: number; color: string; font: string }) {
  const o: Record<string, unknown> = {};
  const size = r.size ?? (para.heading ? HEADING_SIZES[para.heading as 1 | 2 | 3] : defaults.size);
  o.fontSize = pt(size);
  o.fontFace = r.code ? "Courier New" : (r.font ?? (para.heading ? ctx.theme.fonts.heading : defaults.font));
  o.color = hex(r.color, hex(defaults.color));
  if (r.bold || (para.heading && r.bold !== false)) o.bold = true;
  if (r.italic) o.italic = true;
  if (r.underline) o.underline = { style: "sng" };
  if (r.strike) o.strike = "sngStrike";
  if (r.highlight && hex(r.highlight)) o.highlight = hex(r.highlight);
  if (r.link) {
    if (r.link.startsWith("slide:")) {
      const n = ctx.slideIndex.get(r.link.slice(6));
      if (n) o.hyperlink = { slide: n };
    } else if (/^(https?:|mailto:)/.test(r.link)) o.hyperlink = { url: r.link };
  }
  return o;
}

/** pptxgenjs underlines every hyperlink unless told otherwise; keep the run's own underline setting. */
function keepUnderline(o: Record<string, unknown>): Record<string, unknown> {
  if (o.hyperlink && !o.underline) o.underline = { style: "none" };
  return o;
}

/** Rich text as pptxgenjs text runs, one paragraph per breakLine. */
export function textRuns(rt: RichText, ctx: Ctx, defaults: { size: number; color: string; font: string; align?: string }): PptxGenJS.TextProps[] {
  const out: PptxGenJS.TextProps[] = [];
  const paras = rt.paragraphs;
  paras.forEach((p, pi) => {
    const popts: Record<string, unknown> = {};
    // always explicit: pptxgenjs otherwise carries the previous paragraph's alignment over
    popts.align = p.align ?? defaults.align ?? "left";
    if (p.list === "bullet") popts.bullet = true;
    if (p.list === "ordered") popts.bullet = { type: "number" };
    if (p.indent) popts.indentLevel = p.indent;
    if (p.lineHeight) popts.lineSpacingMultiple = p.lineHeight;
    else if (p.heading) popts.lineSpacingMultiple = 1.1;
    const last = pi === paras.length - 1;
    const pieces: Array<{ text: string; r: Run; soft: boolean }> = [];
    for (const r of p.runs) r.text.split(" ").forEach((t, i) => pieces.push({ text: t, r, soft: i > 0 }));
    if (!pieces.length) pieces.push({ text: "", r: { text: "" }, soft: false });
    pieces.forEach((pc, i) => {
      const o: Record<string, unknown> = keepUnderline({ ...popts, ...runOptions(pc.r, p, ctx, defaults) });
      if (pc.soft) o.softBreakBefore = true;
      if (i === pieces.length - 1 && !last) o.breakLine = true;
      out.push({ text: pc.text, options: o as PptxGenJS.TextPropsOptions });
    });
  });
  return out;
}

/**
 * pptxgenjs only creates the relationship for run-level hyperlinks in addText (a shape-level one comes out as
 * r:id="rIdundefined", which Keynote refuses to open), so an element's link goes on each of its runs instead.
 */
function linkRuns(runs: PptxGenJS.TextProps[], e: Element, ctx: Ctx): PptxGenJS.TextProps[] {
  const link = linkOpt(e, ctx).hyperlink;
  if (!link) return runs;
  for (const r of runs) {
    const o = (r.options ?? {}) as Record<string, unknown>;
    if (!o.hyperlink && r.text) {
      o.hyperlink = { ...(link as object) };
      keepUnderline(o);
    }
    r.options = o as PptxGenJS.TextPropsOptions;
  }
  return runs;
}

function boxOpts(e: Element, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const o: Record<string, unknown> = { x: inch(e.x), y: inch(e.y), w: inch(Math.max(1, e.w)), h: inch(Math.max(e.kind === "shape" && (e as { shape: string }).shape === "line" ? 0 : 1, e.h)), objectName: e.id, ...extra };
  if (e.rotation) o.rotate = e.rotation;
  return o;
}

function linkOpt(e: Element, ctx: Ctx): Record<string, unknown> {
  if (!e.link) return {};
  if (e.link.startsWith("slide:")) {
    const n = ctx.slideIndex.get(e.link.slice(6));
    return n ? { hyperlink: { slide: n } } : {};
  }
  return /^(https?:|mailto:)/.test(e.link) ? { hyperlink: { url: e.link } } : {};
}

function lineOpt(e: Element, ctx: Ctx, forceColor?: string): Record<string, unknown> {
  const s = e.style ?? {};
  const color = hex(s.stroke) ?? forceColor;
  if (!color) return {};
  return { line: { color, width: pt(s.strokeWidth ?? (forceColor ? 4 : 2)) } };
  void ctx;
}

async function imageData(src: string, ctx: Ctx): Promise<{ data: string; width: number; height: number } | null> {
  try {
    const f = await ctx.fetchSrc(src);
    let ct = sniffType(f.data);
    if (ct === "application/octet-stream") ct = f.contentType;
    let size = imageSize(f.data, ct);
    let data = f.data;
    if (!["image/png", "image/jpeg", "image/gif"].includes(ct) || !size) {
      // PowerPoint can't show svg/webp/avif everywhere: rasterize through Chromium
      const png = await toPng(f.data, ct);
      data = png.png;
      ct = "image/png";
      size = { width: png.width, height: png.height };
    }
    return { data: `${ct};base64,${data.toString("base64")}`, width: size.width, height: size.height };
  } catch (err) {
    ctx.warnings.push(`Image ${src} could not be fetched (${err instanceof Error ? err.message : err}); it was left out.`);
    return null;
  }
}

async function addImage(slide: PptxGenJS.Slide, e: Element & { kind: "image" }, ctx: Ctx) {
  if (!e.src) return;
  const img = await imageData(e.src, ctx);
  if (!img) return;
  const s = e.style ?? {};
  const base: Record<string, unknown> = { data: img.data, altText: e.alt || undefined, ...linkOpt(e, ctx) };
  if (s.opacity !== undefined && s.opacity < 1) base.transparency = Math.round((1 - s.opacity) * 100);
  if (e.rotation) base.rotate = e.rotation;
  base.objectName = e.id;
  if (e.fit === "cover") {
    slide.addImage({ ...base, x: inch(e.x), y: inch(e.y), w: inch(img.width), h: inch(img.height), sizing: { type: "cover", w: inch(e.w), h: inch(e.h) } } as PptxGenJS.ImageProps);
  } else if (e.fit === "contain") {
    const k = Math.min(e.w / img.width, e.h / img.height);
    const w = img.width * k;
    const h = img.height * k;
    slide.addImage({ ...base, x: inch(e.x + (e.w - w) / 2), y: inch(e.y + (e.h - h) / 2), w: inch(w), h: inch(h) } as PptxGenJS.ImageProps);
  } else slide.addImage({ ...base, x: inch(e.x), y: inch(e.y), w: inch(e.w), h: inch(e.h) } as PptxGenJS.ImageProps);
}

async function addPicture(slide: PptxGenJS.Slide, e: Element, slideId: string, ctx: Ctx) {
  const png = await elementPicture(ctx.deck, slideId, e.id, { assetUrl: ctx.assetUrl });
  slide.addImage({ data: `image/png;base64,${png.toString("base64")}`, ...boxOpts(e), altText: e.kind === "html" ? "HTML element (picture of how it rendered)" : undefined } as PptxGenJS.ImageProps);
}

const PPT_VIDEO = new Set(["video/mp4", "video/quicktime", "video/x-m4v"]);
const PPT_AUDIO = new Set(["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav", "audio/wave", "audio/aac"]);

/** Media PowerPoint and Keynote can play: as is, or re-encoded with ffmpeg (webm/ogg/...), or null if neither. */
async function playableMedia(data: Buffer, ct: string, kind: "video" | "audio"): Promise<{ data: Buffer; ct: string } | null> {
  if ((kind === "video" ? PPT_VIDEO : PPT_AUDIO).has(ct)) return { data, ct };
  if (!HAVE.ffmpeg()) return null;
  const job = jobDir();
  try {
    const inPath = join(job.dir, `in.${extForType(ct)}`);
    writeFileSync(inPath, data);
    const outPath = join(job.dir, kind === "video" ? "out.mp4" : "out.mp3");
    const args =
      kind === "video"
        ? ["-y", "-loglevel", "error", "-i", inPath, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", "-movflags", "+faststart", outPath]
        : ["-y", "-loglevel", "error", "-i", inPath, "-vn", "-c:a", "libmp3lame", "-q:a", "4", outPath];
    await run(FFMPEG, args, { what: "ffmpeg", timeoutMs: 300_000 });
    return { data: readFileSync(outPath), ct: kind === "video" ? "video/mp4" : "audio/mpeg" };
  } catch {
    return null;
  } finally {
    job.cleanup();
  }
}

async function addMedia(slide: PptxGenJS.Slide, e: Element & { kind: "video" | "audio" }, ctx: Ctx, slideId: string) {
  if (!e.src) return;
  try {
    const fetched = await ctx.fetchSrc(e.src);
    let ct0 = sniffType(fetched.data);
    if (ct0 === "application/octet-stream") ct0 = fetched.contentType;
    const playable = ctx.mediaAsPictures ? null : await playableMedia(fetched.data, ct0, e.kind);
    if (!playable) {
      // the closest thing: the poster (or a picture of the element) where the media was
      ctx.warnings.push(
        ctx.mediaAsPictures
          ? `${e.kind === "video" ? "Video" : "Audio"} ${e.src} became a picture: this format can't hold media.`
          : `${e.kind === "video" ? "Video" : "Audio"} ${e.src} is ${ct0}, which PowerPoint and Keynote can't play, and ffmpeg isn't available to convert it; a picture was used instead.`,
      );
      if (e.kind === "video" && e.poster) {
        const p = await imageData(e.poster, ctx);
        if (p) {
          slide.addImage({ data: p.data, ...boxOpts(e) } as PptxGenJS.ImageProps);
          return;
        }
      }
      await addPicture(slide, e, slideId, ctx);
      return;
    }
    const f = { data: playable.data };
    const ct = playable.ct;
    const extn = (ct.split("/")[1] ?? "mp4").replace("mpeg", "mp3").replace("quicktime", "mov").replace("x-", "");
    const opts: Record<string, unknown> = { type: e.kind, data: `${ct};base64,${f.data.toString("base64")}`, extn, ...boxOpts(e) };
    delete opts.rotate;
    if (e.kind === "video" && e.poster) {
      const p = await imageData(e.poster, ctx);
      if (p) opts.cover = "data:" + p.data;
    }
    slide.addMedia(opts as unknown as PptxGenJS.MediaProps);
  } catch (err) {
    ctx.warnings.push(`Media ${e.src} could not be fetched; a picture of it was used instead.`);
    await addPicture(slide, e, slideId, ctx);
    void err;
  }
}

function chartType(pptx: PptxGenJS, t: Chart["type"]): PptxGenJS.CHART_NAME {
  const C = pptx.ChartType;
  return ({ bar: C.bar, column: C.bar, line: C.line, area: C.area, pie: C.pie, donut: C.doughnut, scatter: C.scatter } as Record<string, PptxGenJS.CHART_NAME>)[t] ?? C.bar;
}

function addChart(pptx: PptxGenJS, slide: PptxGenJS.Slide, e: Element & { kind: "chart" }, ctx: Ctx) {
  const c = e.chart;
  const palette = seriesPalette(ctx.theme);
  const used = new Set(c.series.map((s) => s.color?.toLowerCase()).filter(Boolean));
  const free = palette.filter((p) => !used.has(p.toLowerCase()));
  let k = 0;
  const colors = c.series.map((s) => hex(s.color) ?? hex(free[k++ % free.length])!);
  const pie = c.type === "pie" || c.type === "donut";
  let data: Array<{ name: string; labels?: string[]; values: number[] }>;
  if (c.type === "scatter") {
    const xs = c.labels.map((l, i) => (Number.isFinite(Number(l)) ? Number(l) : i + 1));
    data = [{ name: "X", values: xs }, ...c.series.map((s) => ({ name: s.name, values: s.values }))];
  } else data = c.series.map((s) => ({ name: s.name, labels: c.labels, values: s.values }));
  if (pie) data = data.slice(0, 1);
  const text = hex(ctx.theme.colors.text)!;
  const muted = hex(mix(ctx.theme.colors.text, ctx.theme.colors.background, 0.35))!;
  const opts: Record<string, unknown> = {
    ...boxOpts(e),
    barDir: c.type === "bar" ? "bar" : "col",
    barGrouping: "clustered",
    showLegend: !!c.legend,
    legendPos: "b",
    legendColor: text,
    legendFontFace: ctx.theme.fonts.body,
    legendFontSize: 12,
    showTitle: !!c.title,
    title: c.title,
    titleColor: text,
    titleFontFace: ctx.theme.fonts.body,
    titleFontSize: 16,
    chartColors: pie ? palette.slice(0, Math.max(1, c.labels.length)).map((p) => hex(p)!) : colors,
    catAxisLabelColor: muted,
    valAxisLabelColor: muted,
    catAxisLabelFontFace: ctx.theme.fonts.body,
    valAxisLabelFontFace: ctx.theme.fonts.body,
    valGridLine: { color: hex(mix(ctx.theme.colors.text, ctx.theme.colors.background, 0.88)), size: 1 },
    lineSize: 2,
    lineDataSymbol: c.type === "line" ? "circle" : "none",
    lineDataSymbolSize: 6,
    showPercent: pie,
    showValue: false,
    dataLabelColor: "FFFFFF",
    holeSize: 58,
    objectName: e.id,
  };
  if (c.type === "scatter") opts.lineSize = 0;
  slide.addChart(chartType(pptx, c.type), data as never, opts as PptxGenJS.IChartOpts);
}

function addTable(slide: PptxGenJS.Slide, e: Element & { kind: "table" }, ctx: Ctx) {
  const s = e.style ?? {};
  const border = { type: "solid", pt: pt(s.strokeWidth ?? 2), color: hex(s.stroke) ?? hex(mix(ctx.theme.colors.text, ctx.theme.colors.background, 0.78)) };
  const headerFill = hex(mix(ctx.theme.colors.accent, ctx.theme.colors.background, 0.88));
  const rows = e.cells.map((row, r) =>
    row.map((cell) => {
      const header = e.headerRow && r === 0;
      const runs = textRuns(cell.text, ctx, { size: TABLE_SIZE, color: ctx.theme.colors.text, font: ctx.theme.fonts.body });
      if (header) for (const run of runs) (run.options as Record<string, unknown>).bold = true;
      const fill = hex(cell.fill) ?? (header ? headerFill : undefined);
      return {
        text: runs.length ? runs : "",
        options: { border: [border, border, border, border], valign: "middle", margin: [5, 8, 5, 8], ...(fill ? { fill: { color: fill } } : {}) },
      };
    }),
  );
  const totalW = e.colWidths.reduce((a, b) => a + b, 0) || 1;
  const totalH = e.rowHeights.reduce((a, b) => a + b, 0) || 1;
  slide.addTable(rows as PptxGenJS.TableRow[], {
    x: inch(e.x),
    y: inch(e.y),
    w: inch(e.w),
    colW: e.colWidths.map((c) => inch((c / totalW) * e.w)),
    rowH: e.rowHeights.map((r) => inch((r / totalH) * e.h)),
    objectName: e.id,
    autoPage: false,
  } as PptxGenJS.TableProps);
}

async function addElement(pptx: PptxGenJS, slide: PptxGenJS.Slide, e: Element, slideId: string, ctx: Ctx) {
  const s = e.style ?? {};
  const t = ctx.theme;
  switch (e.kind) {
    case "text": {
      const runs = linkRuns(textRuns(e.text, ctx, { size: BODY_SIZE, color: t.colors.text, font: t.fonts.body }), e, ctx);
      const o: Record<string, unknown> = {
        ...boxOpts(e),
        isTextBox: true,
        valign: s.verticalAlign === "middle" ? "middle" : s.verticalAlign === "bottom" ? "bottom" : "top",
        // an array, because pptxgenjs skips a plain 0 and PowerPoint's default inset would apply
        margin: [pt(s.padding ?? 0), pt(s.padding ?? 0), pt(s.padding ?? 0), pt(s.padding ?? 0)],
        fit: "none",
        wrap: true,
        paraSpaceBefore: 0,
        paraSpaceAfter: 0,
      };
      if (hex(s.fill)) o.fill = { color: hex(s.fill), ...(s.opacity !== undefined && s.opacity < 1 ? { transparency: Math.round((1 - s.opacity) * 100) } : {}) };
      Object.assign(o, lineOpt(e, ctx));
      if (s.radius) {
        o.shape = pptx.ShapeType.roundRect;
        o.rectRadius = inch(s.radius);
      }
      if (s.shadow) o.shadow = { type: "outer", blur: 12, offset: 4, angle: 90, opacity: 0.2, color: "000000" };
      slide.addText(runs.length ? runs : "", o as PptxGenJS.TextPropsOptions);
      return;
    }
    case "shape": {
      const geom = SHAPE_MAP[e.shape] ?? "rect";
      const isLine = geom === "line";
      const fill = isLine ? undefined : (hex(s.fill) ?? (s.stroke && !s.fill ? undefined : hex(t.colors.accent)));
      const fillStr = fill ? `#${fill}` : "none";
      const textColor = fill && luminance(fillStr) < 0.4 ? "#ffffff" : t.colors.text;
      const o: Record<string, unknown> = {
        ...boxOpts(e),
        shape: geom,
        valign: s.verticalAlign === "top" ? "top" : s.verticalAlign === "bottom" ? "bottom" : "middle",
        align: "center",
        margin: [pt(s.padding ?? 16), pt(s.padding ?? 16), pt(s.padding ?? 16), pt(s.padding ?? 16)],
        fit: "none",
      };
      o.fill = fill ? { color: fill, ...(s.opacity !== undefined && s.opacity < 1 ? { transparency: Math.round((1 - s.opacity) * 100) } : {}) } : { type: "none" };
      Object.assign(o, lineOpt(e, ctx, isLine ? hex(t.colors.text) : undefined));
      if (!o.line) o.line = { type: "none" };
      if (e.shape === "round-rect" || (e.shape === "rect" && s.radius)) o.rectRadius = inch(s.radius ?? Math.min(e.w, e.h) * 0.16);
      if (s.shadow) o.shadow = { type: "outer", blur: 12, offset: 4, angle: 90, opacity: 0.2, color: "000000" };
      const hasText = e.text.paragraphs.some((p) => p.runs.length);
      if (hasText && !isLine) {
        const runs = linkRuns(textRuns(e.text, ctx, { size: BODY_SIZE, color: textColor, font: t.fonts.body, align: "center" }), e, ctx);
        slide.addText(runs, o as PptxGenJS.TextPropsOptions);
      } else slide.addShape(geom as PptxGenJS.SHAPE_NAME, { ...o, ...linkOpt(e, ctx) } as PptxGenJS.ShapeProps);
      return;
    }
    case "image":
      return addImage(slide, e, ctx);
    case "video":
    case "audio":
      return addMedia(slide, e, ctx, slideId);
    case "table":
      return addTable(slide, e, ctx);
    case "chart":
      // Keynote drops pptx charts on import, so decks headed for Keynote get a picture of the chart instead
      if (ctx.chartsAsPictures) return addPicture(slide, e, slideId, ctx);
      return addChart(pptx, slide, e, ctx);
    case "html":
      return addPicture(slide, e, slideId, ctx);
  }
}

const TRANSITION_XML: Record<string, (dir: string) => string> = {
  fade: () => "<p:fade/>",
  push: (d) => `<p:push dir="${d}"/>`,
  wipe: (d) => `<p:wipe dir="${d}"/>`,
  zoom: () => "<p:zoom/>",
  cover: (d) => `<p:cover dir="${d}"/>`,
};

function transitionXml(t: NonNullable<Slide["transition"]>): string {
  const dir = { left: "l", right: "r", up: "u", down: "d" }[t.direction ?? "left"] ?? "l";
  const inner = (TRANSITION_XML[t.type] ?? TRANSITION_XML.fade!)(dir);
  const spd = t.duration <= 400 ? "fast" : t.duration <= 750 ? "med" : "slow";
  return (
    `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
    `<mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14"><p:transition spd="${spd}" p14:dur="${Math.round(t.duration)}">${inner}</p:transition></mc:Choice>` +
    `<mc:Fallback><p:transition spd="${spd}">${inner}</p:transition></mc:Fallback></mc:AlternateContent>`
  );
}

const EMU_PER_PX = 914400 / PX_PER_IN;

/**
 * Wrap each group's shapes in a <p:grpSp> (pptxgenjs can't make groups). Only groups whose members sit next to each
 * other in z-order can be wrapped without changing the stacking; others stay loose (their elements are all there).
 */
function wrapGroups(xml: string, s: Slide): string {
  const groups = new Map<string, Element[]>();
  for (const e of s.elements) if (e.group) groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
  if (![...groups.values()].some((g) => g.length > 1)) return xml;
  const open = xml.indexOf("<p:spTree>");
  const close = xml.lastIndexOf("</p:spTree>");
  if (open < 0 || close < 0) return xml;
  const inner = xml.slice(open + "<p:spTree>".length, close);
  const blocks = [...inner.matchAll(/<p:(sp|pic|graphicFrame|cxnSp)>[\s\S]*?<\/p:\1>/g)].map((m) => ({ text: m[0], start: m.index!, name: /<p:cNvPr[^>]*name="([^"]*)"/.exec(m[0])?.[1] ?? "" }));
  let out = inner;
  let n = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ids = new Set(members.map((e) => e.id));
    const idx = blocks.map((b, i) => (ids.has(b.name) ? i : -1)).filter((i) => i >= 0);
    if (idx.length !== members.length || idx[idx.length - 1]! - idx[0]! !== idx.length - 1) continue;
    const x = Math.min(...members.map((e) => e.x));
    const y = Math.min(...members.map((e) => e.y));
    const w = Math.max(...members.map((e) => e.x + e.w)) - x;
    const h = Math.max(...members.map((e) => e.y + e.h)) - y;
    const E = (v: number) => Math.round(v * EMU_PER_PX);
    const body = idx.map((i) => blocks[i]!.text).join("");
    const grp =
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${9000 + ++n}" name="Group ${n}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="${E(x)}" y="${E(y)}"/><a:ext cx="${E(w)}" cy="${E(h)}"/><a:chOff x="${E(x)}" y="${E(y)}"/><a:chExt cx="${E(w)}" cy="${E(h)}"/></a:xfrm></p:grpSpPr>` +
      body +
      `</p:grpSp>`;
    out = out.replace(body, grp);
  }
  return xml.slice(0, open + "<p:spTree>".length) + out + xml.slice(close);
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The deck's theme colours and name in the pptx theme (pptxgenjs only sets the fonts). */
function themeXml(xml: string, theme: Theme): string {
  const c = theme.colors;
  const palette = seriesPalette(theme);
  const slots: Record<string, string> = {
    dk1: c.text,
    lt1: c.background,
    dk2: c.muted,
    lt2: mix(c.text, c.background, 0.92),
    accent1: c.accent,
    accent2: c.accent2,
    accent3: c.accent3,
    accent4: palette[4]!,
    accent5: palette[5]!,
    accent6: palette[6]!,
    hlink: c.accent,
    folHlink: c.accent2,
  };
  let out = xml.replace(/(<a:theme\b[^>]*\bname=")[^"]*"/, `$1${escXml(theme.name)}"`);
  for (const [slot, col] of Object.entries(slots)) {
    const h = hex(col);
    if (h) out = out.replace(new RegExp(`<a:${slot}>[\\s\\S]*?</a:${slot}>`), `<a:${slot}><a:srgbClr val="${h}"/></a:${slot}>`);
  }
  return out;
}

/** Locked elements keep PowerPoint from moving, resizing or rotating them too. */
function lockXml(xml: string, s: Slide): string {
  const locked = new Set(s.elements.filter((e) => e.locked).map((e) => e.id));
  if (!locked.size) return xml;
  const locks = 'noMove="1" noResize="1" noRot="1"';
  return xml.replace(/<p:(sp|pic|graphicFrame|cxnSp)>[\s\S]*?<\/p:\1>/g, (block) => {
    const name = /<p:cNvPr[^>]*name="([^"]*)"/.exec(block)?.[1] ?? "";
    if (!locked.has(name)) return block;
    return block
      .replace(/<p:cNvSpPr\/>/, `<p:cNvSpPr><a:spLocks ${locks}/></p:cNvSpPr>`)
      .replace(/<p:cNvSpPr([^>]*)>(?!<a:spLocks)/, `<p:cNvSpPr$1><a:spLocks ${locks}/>`)
      .replace(/<a:picLocks([^/]*)\/>/, `<a:picLocks$1 ${locks}/>`)
      .replace(/<p:cNvGraphicFramePr\/>/, `<p:cNvGraphicFramePr><a:graphicFrameLocks ${locks}/></p:cNvGraphicFramePr>`);
  });
}

/** Write groups, transitions, hidden flags, locks and theme colours into the generated XML (pptxgenjs has none). */
async function postProcess(buf: Buffer, slides: Slide[], theme: Theme): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  for (const name of Object.keys(zip.files).filter((f) => /^ppt\/theme\/theme\d+\.xml$/.test(f))) {
    zip.file(name, themeXml(await zip.file(name)!.async("string"), theme));
  }
  for (const [i, s] of slides.entries()) {
    const path = `ppt/slides/slide${i + 1}.xml`;
    const f = zip.file(path);
    if (!f) continue;
    let xml = lockXml(wrapGroups(await f.async("string"), s), s);
    // the slide's id rides along as the slide name, so slide links and ids survive a round trip
    xml = xml.replace(/<p:cSld(\s+name="[^"]*")?>/, `<p:cSld name="${s.id}">`);
    if (s.skipped && !/<p:sld[^>]*\sshow="0"/.test(xml)) xml = xml.replace(/<p:sld(\s|>)/, '<p:sld show="0"$1');
    // pptxgenjs marks audio as <a:videoFile>; PowerPoint wants <a:audioFile> for audio relationships
    const rels = await zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`)?.async("string");
    if (rels) {
      for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Type="[^"]*\/audio"|Type="[^"]*\/audio"[^>]*Id="(rId\d+)"/g)) {
        const rid = m[1] ?? m[2];
        xml = xml.replace(`<a:videoFile r:link="${rid}"/>`, `<a:audioFile r:link="${rid}"/>`);
      }
    }
    if (s.transition) {
      const tx = transitionXml(s.transition);
      if (xml.includes("</p:clrMapOvr>")) xml = xml.replace("</p:clrMapOvr>", `</p:clrMapOvr>${tx}`);
      else xml = xml.replace("</p:cSld>", `</p:cSld>${tx}`);
    }
    zip.file(path, xml);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function deckToPptx(deck: DeckJson, opts: { fetchSrc: FetchSrc; assetUrl: (id: string) => string; chartsAsPictures?: boolean; mediaAsPictures?: boolean }): Promise<{ data: Buffer; warnings: string[] }> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "SILICON", width: inch(deck.size.width), height: inch(deck.size.height) });
  pptx.layout = "SILICON";
  pptx.title = deck.title ?? "Slides";
  pptx.company = "";
  pptx.author = "Silicon Present"; // the importer reads the theme's muted colour back from dk2 for these
  pptx.subject = "";
  pptx.theme = { headFontFace: deck.theme.fonts.heading, bodyFontFace: deck.theme.fonts.body };
  const ctx: Ctx = {
    deck,
    theme: deck.theme,
    fetchSrc: opts.fetchSrc,
    assetUrl: opts.assetUrl,
    slideIndex: new Map(deck.slides.map((s, i) => [s.id, i + 1])),
    warnings: [],
    chartsAsPictures: opts.chartsAsPictures,
    mediaAsPictures: opts.mediaAsPictures,
  };
  let section: string | null = null;
  for (const s of deck.slides) {
    if (s.section) {
      section = s.section;
      pptx.addSection({ title: s.section });
    }
    const slide = pptx.addSlide(section ? { sectionTitle: section } : undefined);
    const bg = s.background;
    if (bg && "image" in bg) {
      const img = await imageData(bg.image, ctx);
      if (img) slide.background = { data: img.data };
      else slide.background = { color: hex(deck.theme.colors.background)! };
    } else slide.background = { color: hex(bg && "color" in bg ? bg.color : deck.theme.colors.background, hex(deck.theme.colors.background))! };
    if (s.hideMaster === false) for (const e of deck.master.elements) await addElement(pptx, slide, e, "master", ctx);
    for (const e of s.elements) await addElement(pptx, slide, e, s.id, ctx);
    if (s.notes) slide.addNotes(s.notes);
  }
  const raw = (await pptx.write({ outputType: "nodebuffer", compression: true })) as Buffer;
  return { data: await postProcess(raw, deck.slides, deck.theme), warnings: ctx.warnings };
}
