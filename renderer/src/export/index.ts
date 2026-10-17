import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { normalizeDeck } from "@silicon-present/deck";
import type { DeckJson } from "@silicon-present/deck";
import { renderDeckHtml, type EmbeddedAsset } from "@silicon-present/render";
import { assetUrlFrom, makeFetcher } from "../assets";
import { deckPdf, screenshotSlides } from "../browser";
import { jobDir } from "../config";
import { ConverterError } from "../errors";
import { extForType, sniffType } from "../media";
import { pptxToKey, soffice } from "../office";
import { deckToPptx } from "./pptx";

export const EXPORT_FORMATS = ["pptx", "ppt", "key", "odp", "pdf", "html", "png", "jpg"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const CONTENT_TYPES: Record<string, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  key: "application/x-iwork-keynote-sffkey",
  odp: "application/vnd.oasis.opendocument.presentation",
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  zip: "application/zip",
};

export interface ExportRequest {
  deck: DeckJson;
  format: string;
  assetBase?: string;
  /** png/jpg: one slide instead of a zip of all. */
  slide?: string;
  width?: number;
  at?: number;
}

export interface ExportResult {
  data: Buffer;
  contentType: string;
  /** file extension of what was produced (zip for whole-deck images) */
  ext: string;
  warnings: string[];
}

/** Every asset the deck references, fetched, for embedding into an HTML export. */
async function collectAssets(deck: DeckJson, assetBase: string | undefined): Promise<Record<string, EmbeddedAsset>> {
  const ids = new Set<string>();
  JSON.stringify(deck).replace(/"asset:([A-Za-z0-9_-]+)"/g, (_, id: string) => {
    ids.add(id);
    return "";
  });
  const fetchSrc = makeFetcher(assetBase);
  const out: Record<string, EmbeddedAsset> = {};
  for (const id of ids) {
    try {
      const f = await fetchSrc(`asset:${id}`);
      const ct = f.contentType !== "application/octet-stream" ? f.contentType : sniffType(f.data);
      out[id] = { filename: `${id}.${extForType(ct)}`, contentType: ct, data: f.data.toString("base64") };
    } catch {
      // an asset that can't be fetched is left out; the page shows nothing there instead of failing the export
    }
  }
  return out;
}

export async function exportDeck(req: ExportRequest): Promise<ExportResult> {
  const format = String(req.format ?? "").toLowerCase().replace(/^\./, "") as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) {
    throw new ConverterError("unsupported_format", `"${req.format}" is not a format Silicon Present exports.`, `Use one of: ${EXPORT_FORMATS.join(", ")}.`);
  }
  if (!req.deck || !Array.isArray(req.deck.slides)) {
    throw new ConverterError("invalid_deck", "The request has no deck JSON.", "Send { deck, format, assetBase } with the deck as the API returns it.");
  }
  const deck = normalizeDeck(req.deck);
  const assetUrl = assetUrlFrom(req.assetBase);
  const fetchSrc = makeFetcher(req.assetBase);
  const visible = deck.slides.filter((s) => !s.skipped);
  switch (format) {
    case "pdf": {
      if (!visible.length) throw new ConverterError("nothing_to_export", "Every slide in this deck is skipped, so the PDF would be empty.", "Unskip at least one slide.");
      return { data: await deckPdf(deck, { assetUrl, at: req.at }), contentType: CONTENT_TYPES.pdf!, ext: "pdf", warnings: [] };
    }
    case "png":
    case "jpg": {
      if (req.slide) {
        if (!deck.slides.some((s) => s.id === req.slide)) throw new ConverterError("slide_not_found", `There is no slide ${req.slide} in this deck.`, "Read the deck again to get its current slide ids.", 404);
        const [img] = await screenshotSlides(deck, [req.slide], { format, width: req.width, at: req.at, assetUrl });
        return { data: img!, contentType: CONTENT_TYPES[format]!, ext: format, warnings: [] };
      }
      const imgs = await screenshotSlides(deck, visible.map((s) => s.id), { format, width: req.width, at: req.at, assetUrl });
      const zip = new JSZip();
      imgs.forEach((img, i) => zip.file(`slide-${String(i + 1).padStart(2, "0")}.${format}`, img));
      return { data: await zip.generateAsync({ type: "nodebuffer" }), contentType: CONTENT_TYPES.zip!, ext: "zip", warnings: [] };
    }
    case "html": {
      const assets = await collectAssets(deck, req.assetBase);
      const html = renderDeckHtml(deck, { embedDeck: true, assets, assetUrl, title: deck.title });
      return { data: Buffer.from(html, "utf8"), contentType: CONTENT_TYPES.html!, ext: "html", warnings: [] };
    }
    case "pptx": {
      const r = await deckToPptx(deck, { fetchSrc, assetUrl });
      return { data: r.data, contentType: CONTENT_TYPES.pptx!, ext: "pptx", warnings: r.warnings };
    }
    case "ppt":
    case "odp":
    case "key": {
      // .ppt can't hold embedded media (LibreOffice drops it), Keynote drops pptx charts: pictures instead
      const r = await deckToPptx(deck, { fetchSrc, assetUrl, chartsAsPictures: format === "key", mediaAsPictures: format === "ppt" });
      const job = jobDir();
      try {
        const src = join(job.dir, "deck.pptx");
        writeFileSync(src, r.data);
        if (format === "key") {
          const k = await pptxToKey(src, join(job.dir, "deck.key"));
          return { data: readFileSync(k.path), contentType: CONTENT_TYPES.key!, ext: "key", warnings: [...r.warnings, ...k.warnings] };
        }
        const out = await soffice(src, format, join(job.dir));
        return { data: readFileSync(out), contentType: CONTENT_TYPES[format]!, ext: format, warnings: r.warnings };
      } finally {
        job.cleanup();
      }
    }
  }
}
