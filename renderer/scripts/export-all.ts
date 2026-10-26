// Visual check: export the test deck to every format into a folder. Usage: tsx scripts/export-all.ts <outDir> [formats]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportDeck as doExport } from "../src/export/index";
import { closeBrowser } from "../src/browser";
import { exportDeck, startAssetServer } from "../test/helpers";
const out = process.argv[2]!;
mkdirSync(out, { recursive: true });
const { base, server } = await startAssetServer();
const deck = exportDeck();
for (const format of (process.argv[3] ?? "pptx,odp,pdf,txt,png,jpg").split(",")) {
  const t = Date.now();
  try {
    const r = await doExport({ deck, format, assetBase: base });
    writeFileSync(join(out, `deck.${r.ext}`), r.data);
    console.log(format, r.ext, r.data.length, `${Date.now() - t}ms`, r.warnings);
  } catch (e) {
    console.log(format, "FAILED", e);
  }
}
server.close();
await closeBrowser();
