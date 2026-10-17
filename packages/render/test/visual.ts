// Visual check: renders every sample deck through Playwright Chromium to PNG so a Carbon or Silicon can look at them.
// Run: pnpm --filter @silicon-present/render visual [outDir]   (default: $TMPDIR/silicon-present-render-visual)
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { renderSlideDocument } from "../src/index";
import { allShowcases, contractDecks, testAssetUrl } from "./samples";

const out = process.argv[2] ?? join(tmpdir(), "silicon-present-render-visual");
mkdirSync(out, { recursive: true });
const only = process.argv[3];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 0.5 });
const decks = { ...contractDecks(), ...allShowcases() };
for (const [name, deck] of Object.entries(decks)) {
  if (only && !name.includes(only)) continue;
  for (const [i, s] of deck.slides.entries()) {
    await page.setContent(renderSlideDocument(deck, s.id, { assetUrl: testAssetUrl, media: "static" }), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    const file = join(out, `${name}-${i + 1}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
}
await browser.close();
