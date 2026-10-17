// Visual check: import a file and render every slide to PNG (assets as data URLs). Usage: tsx scripts/view-import.ts <file> <outDir>
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importFile } from "../src/import/index";
import { closeBrowser, screenshotSlides } from "../src/browser";
const [f, outDir] = [process.argv[2]!, process.argv[3]!];
mkdirSync(outDir, { recursive: true });
const r = await importFile({ filename: f.split("/").pop()!, data: readFileSync(f).toString("base64") });
const map = new Map(r.assets.map((a) => [a.key, `data:${a.contentType};base64,${a.data}`]));
const imgs = await screenshotSlides(r.deck, r.deck.slides.map((s) => s.id), { width: 960, assetUrl: (id) => map.get(id) ?? "" });
imgs.forEach((b, i) => writeFileSync(join(outDir, `slide-${i + 1}.png`), b));
writeFileSync(join(outDir, "deck.json"), JSON.stringify(r.deck, null, 1));
console.log(r.notes);
await closeBrowser();
