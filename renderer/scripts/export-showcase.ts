// Visual check: a showcase deck (every layout, a chart, a table, a picture) in one theme exported to pptx.
// Usage: tsx scripts/export-showcase.ts <outDir> <themeName>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { THEMES } from "@silicon-present/deck";
import { exportDeck as doExport } from "../src/export/index";
import { closeBrowser } from "../src/browser";
import { showcaseDeck } from "../../packages/render/test/samples";
import { startAssetServer } from "../test/helpers";
const [out, themeName] = [process.argv[2]!, process.argv[3] ?? "Paper"];
mkdirSync(out, { recursive: true });
const { base, server } = await startAssetServer();
const deck = showcaseDeck(THEMES.find((t) => t.name === themeName)!);
for (const format of ["pptx", "pdf"]) {
  const r = await doExport({ deck, format, assetBase: base });
  writeFileSync(join(out, `showcase.${r.ext}`), r.data);
}
server.close();
await closeBrowser();
