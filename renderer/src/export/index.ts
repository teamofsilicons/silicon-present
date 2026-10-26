import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { normalizeDeck } from "@silicon-present/deck";
import type { DeckJson } from "@silicon-present/deck";
import { assetUrlFrom, makeFetcher } from "../assets";
import { deckPdf, screenshotSlides } from "../browser";
import { jobDir } from "../config";
import { ConverterError } from "../errors";
import { soffice } from "../office";
import { deckToPptx } from "./pptx";
import { pdfDerivedExport } from "./pdf-derived";

export const EXPORT_FORMATS = ["pptx", "odp", "pdf", "txt", "png", "jpg", "svg"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const CONTENT_TYPES: Record<string, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odp: "application/vnd.oasis.opendocument.presentation",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  zip: "application/zip",
};

export interface ExportRequest {
  deck: DeckJson;
  format: string;
  assetBase?: string;
  /** Required for SVG; png/jpg: one slide instead of a zip of all. */
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
    case "txt": {
      const data = await pdfDerivedExport(deck, "txt", { assetUrl, at: req.at });
      return { data, contentType: CONTENT_TYPES.txt!, ext: "txt", warnings: [] };
    }
    case "svg": {
      if (!req.slide) throw new ConverterError("slide_required", "SVG export needs a current slide.", "Choose a slide and try again, or supply its id as slide.");
      const slide = deck.slides.find(s => s.id === req.slide);
      if (!slide) throw new ConverterError("slide_not_found", `There is no slide ${req.slide} in this deck.`, "Read the deck again to get its current slide ids.", 404);
      const data = await pdfDerivedExport({ ...deck, slides: [slide] }, "svg", { assetUrl, at: req.at });
      return { data, contentType: CONTENT_TYPES.svg!, ext: "svg", warnings: [] };
    }
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
    case "pptx": {
      const r = await deckToPptx(deck, { fetchSrc, assetUrl });
      return { data: r.data, contentType: CONTENT_TYPES.pptx!, ext: "pptx", warnings: r.warnings };
    }
    case "odp": {
      const r = await deckToPptx(deck, { fetchSrc, assetUrl });
      const job = jobDir();
      try {
        const src = join(job.dir, "deck.pptx");
        writeFileSync(src, r.data);
        const out = await soffice(src, "odp", join(job.dir));
        return { data: readFileSync(out), contentType: CONTENT_TYPES.odp!, ext: "odp", warnings: r.warnings };
      } finally {
        job.cleanup();
      }
    }
  }
}
