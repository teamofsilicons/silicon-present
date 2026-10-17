import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import JSZip from "jszip";
import { join } from "node:path";
import { THEMES, newElementId, newSlideId, normalizeDeck } from "@silicon-present/deck";
import type { DeckJson, ElementInput, SlideInput } from "@silicon-present/deck";
import { DECK_ASSETS_ID, DECK_JSON_ID, type EmbeddedAsset } from "@silicon-present/render";
import { HAVE, PDFINFO, PDFTOPPM, PDFTOTEXT, jobDir } from "../config";
import { ConverterError } from "../errors";
import { extOf, fontFamily, imageSize, sniffType } from "../media";
import { keyToPptx, soffice, sofficePdfAllSlides } from "../office";
import { run } from "../proc";
import { importPptx, type ImportedAsset, type PptxImport } from "./pptx";

// Any supported file -> { deck, assets }. Assets come back as { key, filename, contentType, data (base64) } and the
// deck refers to them as "asset:<key>"; the service stores them and swaps keys for real asset ids.

export interface ImportRequest {
  filename: string;
  contentType?: string;
  /** base64 */
  data: string;
}

export interface ImportResponse {
  deck: DeckJson;
  assets: Array<{ key: string; filename: string; contentType: string; data: string }>;
  /** What was turned into a picture or otherwise approximated, for the Carbon or Silicon to know. */
  notes: string[];
}

const SLIDES = ["pptx", "ppsx", "potx", "pptm", "ppt", "pps", "pot", "odp", "otp", "key", "pdf", "html", "htm"];

function out(deck: DeckJson, assets: ImportedAsset[], notes: string[] = []): ImportResponse {
  return { deck, assets: assets.map((a) => ({ key: a.key, filename: a.filename, contentType: a.contentType, data: a.data.toString("base64") })), notes };
}

function titleFrom(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Untitled";
}

/** Replace each region the parser couldn't model with a picture cut from LibreOffice's PDF render of that slide. */
async function fillRegions(imp: PptxImport, pptxPath: string, dir: string): Promise<string[]> {
  if (!imp.regions.length) return [];
  const notes: string[] = [];
  if (!HAVE.soffice() || !HAVE.pdftoppm()) {
    for (const r of imp.regions) notes.push(`Slide ${r.slideIndex + 1}: ${r.why} could not be pictured because LibreOffice or pdftoppm is missing on the converter host.`);
    return notes;
  }
  const pdf = await sofficePdfAllSlides(pptxPath, dir);
  const dpi = (imp.deck.size.width * 72) / imp.pageWidthPt;
  let n = 0;
  for (const r of imp.regions) {
    const base = join(dir, `region-${++n}`);
    await run(
      PDFTOPPM,
      ["-f", String(r.slideIndex + 1), "-l", String(r.slideIndex + 1), "-r", String(dpi), "-x", String(Math.max(0, Math.floor(r.x))), "-y", String(Math.max(0, Math.floor(r.y))), "-W", String(Math.ceil(r.w)), "-H", String(Math.ceil(r.h)), "-png", "-singlefile", pdf, base],
      { what: "pdftoppm", timeoutMs: 60_000 },
    );
    const data = readFileSync(base + ".png");
    const key = `a${imp.assets.length + 1}`;
    imp.assets.push({ key, filename: `slide-${r.slideIndex + 1}-picture-${n}.png`, contentType: "image/png", data });
    for (const s of imp.deck.slides) {
      const el = s.elements.find((e) => e.id === r.elementId);
      if (el && el.kind === "image") el.src = `asset:${key}`;
    }
    notes.push(`Slide ${r.slideIndex + 1}: ${r.why}.`);
  }
  return notes;
}

async function fromPptxFile(pptxPath: string, dir: string, title: string): Promise<ImportResponse> {
  const imp = await importPptx(readFileSync(pptxPath));
  const notes = await fillRegions(imp, pptxPath, dir);
  if (!imp.deck.title) imp.deck.title = title;
  return out(imp.deck, imp.assets, notes);
}

async function fromPdf(path: string, dir: string, title: string): Promise<ImportResponse> {
  if (!HAVE.pdftoppm()) throw new ConverterError("pdf_tools_missing", "pdftoppm is not installed on the converter host, so PDFs can't be opened.", "Install poppler (brew install poppler) on the converter host.", 501);
  const info = (await run(PDFINFO, [path], { what: "pdfinfo", timeoutMs: 30_000 })).stdout;
  const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? 0);
  const m = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info);
  const wPt = Number(m?.[1] ?? 960);
  const hPt = Number(m?.[2] ?? 540);
  if (!pages) throw new ConverterError("empty_pdf", "The PDF has no pages.", "Check the file and try again.", 422);
  const width = 1920;
  const height = Math.round((width * hPt) / wPt);
  await run(PDFTOPPM, ["-scale-to-x", String(width), "-scale-to-y", "-1", "-png", path, join(dir, "page")], { what: "pdftoppm", timeoutMs: 600_000 });
  const files = readdirSync(dir).filter((f) => /^page-\d+\.png$/.test(f)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
  const assets: ImportedAsset[] = [];
  const slides: SlideInput[] = [];
  for (const [i, f] of files.entries()) {
    const key = `a${i + 1}`;
    assets.push({ key, filename: `page-${i + 1}.png`, contentType: "image/png", data: readFileSync(join(dir, f)) });
    let text = "";
    try {
      text = (await run(PDFTOTEXT, ["-layout", "-f", String(i + 1), "-l", String(i + 1), path, "-"], { what: "pdftotext", timeoutMs: 60_000 })).stdout;
    } catch {
      text = "";
    }
    // the page text goes in the notes (so it can be read and searched), lines trimmed of layout padding
    const notes = text.split("\n").map((l) => l.replace(/\s+$/, "").replace(/^\s+/, "")).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\f/g, "").trim();
    slides.push({ id: newSlideId(), layout: "blank", background: { image: `asset:${key}`, fit: "cover" }, notes, elements: [] });
  }
  const deck = normalizeDeck({ title, size: { width, height }, theme: THEMES[0], master: { elements: [] }, slides });
  return out(deck, assets);
}

function fromHtml(html: string, title: string): ImportResponse {
  // our own export: the deck JSON (and its assets) are embedded, so it opens exactly as it was
  const deckM = new RegExp(`<script[^>]*id="${DECK_JSON_ID}"[^>]*>([\\s\\S]*?)</script>`).exec(html);
  if (deckM) {
    const deck = JSON.parse(deckM[1]!) as DeckJson;
    const assetsM = new RegExp(`<script[^>]*id="${DECK_ASSETS_ID}"[^>]*>([\\s\\S]*?)</script>`).exec(html);
    const map = assetsM ? (JSON.parse(assetsM[1]!) as Record<string, EmbeddedAsset>) : {};
    const assets: ImportedAsset[] = Object.entries(map).map(([key, a]) => ({ key, filename: a.filename, contentType: a.contentType, data: Buffer.from(a.data, "base64") }));
    return out(normalizeDeck(deck), assets);
  }
  // any other page: one slide that is the page, running live
  const pageTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  const body = html.replace(/^\s*<!doctype[^>]*>/i, "");
  const deck = normalizeDeck({
    title: pageTitle || title,
    theme: THEMES[0],
    slides: [{ id: newSlideId(), layout: "blank", elements: [{ id: newElementId(), kind: "html", x: 0, y: 0, w: 1920, h: 1080, html: body, css: "", js: "" }] }],
  });
  return out(deck, []);
}

function fromMedia(data: Buffer, ct: string, filename: string, title: string): ImportResponse {
  const key = "a1";
  const assets: ImportedAsset[] = [{ key, filename, contentType: ct, data }];
  const W = 1920;
  const H = 1080;
  let el: ElementInput;
  if (ct.startsWith("image/")) {
    const size = imageSize(data, ct) ?? { width: W, height: H };
    const k = Math.min(W / size.width, H / size.height, 1e9);
    const w = Math.round(size.width * k);
    const h = Math.round(size.height * k);
    el = { id: newElementId(), kind: "image", x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h, src: `asset:${key}`, alt: title, fit: "contain" };
  } else if (ct.startsWith("video/")) {
    el = { id: newElementId(), kind: "video", x: 0, y: 0, w: W, h: H, src: `asset:${key}`, alt: title, autoplay: false, loop: false, muted: false, poster: null };
  } else {
    el = { id: newElementId(), kind: "audio", x: 660, y: 490, w: 600, h: 100, src: `asset:${key}`, alt: title, autoplay: false, loop: false, muted: false };
  }
  const deck = normalizeDeck({ title, theme: THEMES[0], slides: [{ id: newSlideId(), layout: "blank", elements: [el] }] });
  return out(deck, assets);
}

function fromFont(data: Buffer, ct: string, filename: string, title: string): ImportResponse {
  const family = fontFamily(data) ?? title;
  const key = "a1";
  const base = THEMES[0]!;
  const theme = { ...base, name: `${base.name} with ${family}`, fonts: { heading: family, body: family }, customFonts: [{ family, src: `asset:${key}` }] };
  const deck = normalizeDeck({
    title: family,
    theme,
    slides: [
      {
        id: newSlideId(),
        layout: "title",
        elements: [
          { id: newElementId(), kind: "text", x: 140, y: 300, w: 1640, h: 280, style: { verticalAlign: "bottom" }, text: { paragraphs: [{ heading: 1, runs: [{ text: family }] }] } },
          { id: newElementId(), kind: "text", x: 140, y: 610, w: 1640, h: 240, text: { paragraphs: [{ runs: [{ text: "The quick brown fox jumps over the lazy dog. 0123456789" }] }, { runs: [{ text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz", italic: true }] }] } },
        ],
      },
    ],
  });
  return out(deck, [{ key, filename, contentType: ct, data }]);
}

/**
 * LibreOffice keeps "theme colour" links on ODP styles (loext:*-complex-color). When a shape overrides the colour of a
 * style that has such a link, LibreOffice's PPTX export writes the theme colour instead of the shape's real colour
 * (every shape comes out accent blue). The links add nothing to how the deck looks, so they are removed first.
 */
async function withoutThemeColorLinks(data: Buffer): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(data);
    for (const name of ["styles.xml", "content.xml"]) {
      const f = zip.file(name);
      if (!f) continue;
      const xml = await f.async("string");
      zip.file(name, xml.replace(/<loext:([a-z-]*complex-color)\b[^>]*\/>/g, "").replace(/<loext:([a-z-]*complex-color)\b[^>]*>[\s\S]*?<\/loext:\1>/g, ""));
    }
    const mimetype = await zip.file("mimetype")?.async("string");
    if (mimetype !== undefined) zip.file("mimetype", mimetype, { compression: "STORE" });
    return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  } catch {
    return data;
  }
}

export async function importFile(req: ImportRequest): Promise<ImportResponse> {
  if (!req || typeof req.data !== "string") {
    throw new ConverterError("invalid_request", "The request has no file data.", "Send { filename, contentType, data } with data as base64.");
  }
  const filename = String(req.filename || "file");
  const data = Buffer.from(req.data, "base64");
  if (!data.length) throw new ConverterError("empty_file", `${filename} is empty.`, "Check the file and send it again.");
  const title = titleFrom(filename);
  let ct = sniffType(data, filename);
  if (ct === "application/octet-stream" && req.contentType) ct = req.contentType.split(";")[0]!.trim();
  let ext = extOf(filename);
  if (!SLIDES.includes(ext)) {
    // name the format from what the bytes are
    ext = ({ "application/pdf": "pdf", "text/html": "html", "application/vnd.ms-powerpoint": "ppt", "application/vnd.oasis.opendocument.presentation": "odp", "application/x-iwork-keynote-sffkey": "key", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx" } as Record<string, string>)[ct] ?? ext;
  }
  const job = jobDir();
  try {
    if (["pptx", "ppsx", "potx", "pptm"].includes(ext)) {
      const p = join(job.dir, "in.pptx");
      writeFileSync(p, data);
      return await fromPptxFile(p, job.dir, title);
    }
    if (["ppt", "pps", "pot", "odp", "otp"].includes(ext)) {
      let p = join(job.dir, `in.${ext}`);
      writeFileSync(p, data);
      if (!["odp", "otp"].includes(ext)) {
        // .ppt goes through .odp first: LibreOffice's direct ppt -> pptx export loses table and shape colours to
        // theme links (see withoutThemeColorLinks)
        const odp = await soffice(p, "odp", join(job.dir));
        p = join(job.dir, "via.odp");
        writeFileSync(p, readFileSync(odp));
      }
      writeFileSync(p, await withoutThemeColorLinks(readFileSync(p)));
      const outDir = join(job.dir, "pptx");
      mkdirSync(outDir, { recursive: true });
      const pptx = await soffice(p, "pptx", outDir);
      return await fromPptxFile(pptx, job.dir, title);
    }
    if (ext === "key") {
      const p = join(job.dir, "in.key");
      writeFileSync(p, data);
      let pptx: string;
      const notes: string[] = [];
      try {
        // Keynote reads every .key version; LibreOffice only older ones
        const k = await keyToPptx(p, join(job.dir, "from-keynote.pptx"));
        pptx = k.path;
        notes.push(...k.warnings);
      } catch (e) {
        if (!HAVE.soffice()) throw e;
        notes.push(`Keynote was not available (${e instanceof Error ? e.message : e}); LibreOffice opened the file instead.`);
        pptx = await soffice(p, "pptx", join(job.dir));
      }
      const r = await fromPptxFile(pptx, job.dir, title);
      r.notes.unshift(...notes);
      return r;
    }
    if (ext === "pdf" || ct === "application/pdf") {
      const p = join(job.dir, "in.pdf");
      writeFileSync(p, data);
      return await fromPdf(p, job.dir, title);
    }
    if (ext === "html" || ext === "htm" || ct === "text/html") return fromHtml(data.toString("utf8"), title);
    if (ct.startsWith("image/") || ct.startsWith("video/") || ct.startsWith("audio/")) return fromMedia(data, ct, filename, title);
    if (ct.startsWith("font/")) return fromFont(data, ct, filename, title);
    throw new ConverterError(
      "unsupported_file",
      `${filename} is not a kind of file Silicon Present can open.`,
      "Open slides (.pptx, .ppt, .key, .odp, .pdf, .html), images, video, audio or fonts. For Google Slides, download the deck as .pptx first.",
      415,
    );
  } finally {
    job.cleanup();
  }
}
