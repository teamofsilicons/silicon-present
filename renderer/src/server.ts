// The converter sidecar: internal only, bound to 127.0.0.1, every request carries X-Converter-Secret.
//   GET  /health
//   POST /render  { deck, slide, width?, format?: "png"|"jpg", at?, assetBase }      -> image
//   POST /export  { deck, format, assetBase, slide?, width?, at? }                     -> file
//   POST /import  { filename, contentType, data (base64) }                             -> { deck, assets }
// Errors: {"error": {"code", "message", "hint"}} with a fitting status. No telemetry: nothing is logged but startup
// and failures.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { normalizeDeck } from "@silicon-present/deck";
import { assetUrlFrom } from "./assets";
import { browser, closeBrowser, screenshotSlides } from "./browser";
import { HAVE, HOST, MAX_BODY, PORT, SECRET, cleanupWorkDir } from "./config";
import { ConverterError, asConverterError } from "./errors";
import { CONTENT_TYPES, exportDeck } from "./export/index";
import { importFile } from "./import/index";

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new ConverterError("too_large", `The request is larger than ${Math.round(MAX_BODY / 1048576)} MB.`, "Split the file or raise CONVERTER_MAX_BODY.", 413);
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ConverterError("invalid_json", "The request body is not valid JSON.", "Send a JSON body with Content-Type: application/json.");
  }
}

function send(res: ServerResponse, status: number, body: Buffer | string, type: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body), "cache-control": "no-store", ...extra });
  res.end(body);
}

function sendError(res: ServerResponse, e: ConverterError) {
  send(res, e.status, JSON.stringify(e.toJSON()), "application/json");
}

function authorized(req: IncomingMessage): boolean {
  const got = Buffer.from(String(req.headers["x-converter-secret"] ?? ""));
  const want = Buffer.from(SECRET);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function makeServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, JSON.stringify({ ok: true, libreoffice: HAVE.soffice(), pdftoppm: HAVE.pdftoppm(), keynote: HAVE.keynote() }), "application/json");
      }
      if (!authorized(req)) {
        throw new ConverterError("unauthorized", "The converter secret is missing or wrong.", "Send the X-Converter-Secret header with the value of CONVERTER_SECRET.", 401);
      }
      if (req.method !== "POST") throw new ConverterError("method_not_allowed", `${req.method} is not supported here.`, "Use POST /render, /export or /import.", 405);
      const body = await readJson(req);
      if (url.pathname === "/render") {
        const deck = normalizeDeck((body.deck ?? {}) as never);
        const slide = String(body.slide ?? "");
        if (!deck.slides.some((s) => s.id === slide)) throw new ConverterError("slide_not_found", `There is no slide ${slide} in this deck.`, "Read the deck again to get its current slide ids.", 404);
        const format = body.format === "jpg" || body.format === "jpeg" ? "jpg" : "png";
        const [img] = await screenshotSlides(deck, [slide], {
          format,
          width: body.width ? Number(body.width) : undefined,
          at: body.at !== undefined ? Number(body.at) : undefined,
          assetUrl: assetUrlFrom(body.assetBase as string | undefined),
        });
        return send(res, 200, img!, CONTENT_TYPES[format]!);
      }
      if (url.pathname === "/export") {
        const r = await exportDeck(body as never);
        const extra: Record<string, string> = { "x-export-extension": r.ext };
        if (r.warnings.length) extra["x-converter-warnings"] = encodeURIComponent(r.warnings.join(" | ")).slice(0, 4000);
        return send(res, 200, r.data, r.contentType, extra);
      }
      if (url.pathname === "/import") {
        const r = await importFile(body as never);
        return send(res, 200, JSON.stringify(r), "application/json");
      }
      throw new ConverterError("not_found", `There is no ${url.pathname} endpoint.`, "Use /render, /export, /import or /health.", 404);
    } catch (e) {
      const err = asConverterError(e);
      if (err.status >= 500) console.error(`[converter] ${req.method} ${url.pathname}: ${err.code}: ${err.message}`);
      sendError(res, err);
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!SECRET) {
    console.error("CONVERTER_SECRET is not set, so the converter would accept anyone's requests. Set it (the service sends the same value) and start again.");
    process.exit(1);
  }
  const server = makeServer();
  server.requestTimeout = 15 * 60_000;
  server.listen(PORT, HOST, () => {
    console.log(`Silicon Present converter on http://${HOST}:${PORT}`);
    void browser(); // warm Chromium
  });
  const stop = async () => {
    server.close();
    await closeBrowser();
    cleanupWorkDir();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
