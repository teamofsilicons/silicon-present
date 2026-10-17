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
