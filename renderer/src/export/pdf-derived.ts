import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckJson } from "@silicon-present/deck";
import { deckPdf } from "../browser";
import { HAVE, PDFTOCAIRO, PDFTOTEXT, jobDir } from "../config";
import { ConverterError } from "../errors";
import { run } from "../proc";

/** Reuse the slide's print rendering so text, tables, charts and HTML keep their actual layout. */
export async function pdfDerivedExport(deck: DeckJson, format: "txt" | "svg", options: { assetUrl: (id: string) => string; at?: number }): Promise<Buffer> {
  const tool = format === "svg" ? "pdftocairo" : "pdftotext";
  if (!HAVE[tool]()) {
    throw new ConverterError("pdf_tools_missing", `${tool} is not installed on the converter host, so ${format.toUpperCase()} export is unavailable.`, `Install poppler on the converter host or set ${tool.toUpperCase()}_PATH.`, 501);
  }
  if (!deck.slides.length && format === "txt") return Buffer.alloc(0);
  const job = jobDir();
  try {
    const input = join(job.dir, "slides.pdf");
    const output = join(job.dir, `slides.${format}`);
    // Include skipped slides in plain text and allow an explicitly selected skipped slide as SVG.
    writeFileSync(input, await deckPdf(deck, { ...options, includeSkipped: true }));
    if (format === "svg") {
      // Cairo preserves paths and font outlines; this is a vector image, not a screenshot in an SVG wrapper.
      await run(PDFTOCAIRO, ["-svg", input, output], { what: "pdftocairo", timeoutMs: 60_000 });
    } else {
      await run(PDFTOTEXT, ["-layout", "-enc", "UTF-8", input, output], { what: "pdftotext", timeoutMs: 60_000 });
    }
    return readFileSync(output);
  } finally {
    job.cleanup();
  }
}
