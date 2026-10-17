// Shared test helpers: fixture paths, sample decks, a tiny asset server standing in for the service.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDeck, THEMES } from "@silicon-present/deck";
import type { DeckJson } from "@silicon-present/deck";

const here = dirname(fileURLToPath(import.meta.url));
export const FIX = join(here, "fixtures");
export const CONTRACT = join(here, "..", "..", "fixtures", "contract");

export function fixture(name: string): Buffer {
  return readFileSync(join(FIX, name));
}

export function contractDeck(name: string): DeckJson {
  return JSON.parse(readFileSync(join(CONTRACT, `${name}.json`), "utf8"));
}

export function contractNames(): string[] {
  return readdirSync(CONTRACT).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
}

/** Asset ids used by the contract decks, served from the fixtures. */
export const ASSET_FILES: Record<string, [string, string]> = {
  Img1aaaaaaaa: ["picture.png", "image/png"],
  Vid1aaaaaaaa: ["clip.webm", "video/webm"],
  Aud1aaaaaaaa: ["tone.mp3", "audio/mpeg"],
  "7Fq2mP9xRtA1": ["font.woff2", "font/woff2"],
};

export async function startAssetServer(): Promise<{ base: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const id = decodeURIComponent((req.url ?? "").replace(/^\/assets\//, "").split("?")[0]!);
    hits.push(id);
    const f = ASSET_FILES[id];
    if (!f) {
      res.writeHead(404).end("no such asset");
      return;
    }
    const body = fixture(f[0]);
    res.writeHead(200, { "content-type": f[1], "content-length": body.length });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/assets/{id}?sig=test`, server, hits };
}

/** A deck that uses every kind of element with real assets, for export tests. */
export function exportDeck(): DeckJson {
  const d = contractDeck("every-element");
  // the external example.com picture can't be fetched in tests; point it at an asset instead
  for (const s of d.slides) for (const e of s.elements) if (e.kind === "image" && e.src.startsWith("https://")) e.src = "asset:Img1aaaaaaaa";
  return normalizeDeck({ ...d, title: "Export test deck", theme: { ...d.theme, customFonts: [{ family: "Brand Sans", src: "asset:7Fq2mP9xRtA1" }] } });
}

export { THEMES };

// ---------------------------------------------------------------- the sidecar as a process

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer as netServer } from "node:net";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = netServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export interface Converter {
  url: string;
  secret: string;
  proc: ChildProcess;
  stop(): Promise<void>;
  post(path: string, body: unknown, opts?: { secret?: string | null }): Promise<Response>;
}

/** Start the converter (src/server.ts) on a free ephemeral port with a fresh secret, as the service would run it. */
export async function startConverter(): Promise<Converter> {
  const port = await freePort();
  const secret = randomBytes(16).toString("hex");
  const proc = spawn(process.execPath, ["--import", "tsx", join(here, "..", "src", "server.ts")], {
    env: { ...process.env, CONVERTER_PORT: String(port), CONVERTER_SECRET: secret },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout!.on("data", (d) => (log += d));
  proc.stderr!.on("data", (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url + "/health");
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 150 || proc.exitCode !== null) throw new Error(`converter did not start: ${log}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url,
    secret,
    proc,
    async stop() {
      if (proc.exitCode !== null) return;
      const done = new Promise((r) => proc.once("exit", r));
      proc.kill("SIGTERM");
      await done;
    },
    post(path, body, opts = {}) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const sec = opts.secret === undefined ? secret : opts.secret;
      if (sec !== null) headers["x-converter-secret"] = sec;
      return fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) });
    },
  };
}

export function pngSize(b: Buffer): { width: number; height: number } {
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

export function jpgSize(b: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < b.length) {
    const marker = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error("no SOF");
}

/** Import a fixture file through the running converter. */
export async function importThrough(c: Converter, filename: string, data: Buffer = fixture(filename)) {
  const r = await c.post("/import", { filename, data: data.toString("base64") });
  const body = (await r.json()) as { deck: DeckJson; assets: Array<{ key: string; filename: string; contentType: string; data: string }>; notes: string[]; error?: { code: string } };
  return { status: r.status, ...body };
}

export function plain(rt: { paragraphs: Array<{ runs: Array<{ text: string }> }> } | undefined): string {
  return (rt?.paragraphs ?? []).map((p) => p.runs.map((r) => r.text).join("")).join("\n");
}

/** All text of a deck (slides in order, elements, table cells), for "is the text still there" checks. */
export function deckText(d: DeckJson): string {
  const out: string[] = [];
  const els = (list: DeckJson["slides"][number]["elements"]) => {
    for (const e of list) {
      if (e.kind === "text" || e.kind === "shape") out.push(plain(e.text));
      if (e.kind === "table") for (const row of e.cells) for (const c of row) out.push(plain(c.text));
      if (e.kind === "chart") out.push(e.chart.title ?? "", ...e.chart.labels, ...e.chart.series.map((s) => s.name));
    }
  };
  els(d.master.elements);
  for (const s of d.slides) els(s.elements);
  return out.join("\n");
}
