// Real-world decks: LibreOffice's own presentation templates (masters with custom shapes, gradients, groups, pictures,
// connectors). Each is opened through the converter, its first slide rendered with packages/render, and compared
// pixel by pixel with LibreOffice's own render of the original file.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, type Browser } from "playwright";
import { HAVE, SOFFICE } from "../src/config";
import { closeBrowser, screenshotSlides } from "../src/browser";
import { type Converter, importThrough, startConverter } from "./helpers";

const TEMPLATES = "/Applications/LibreOffice.app/Contents/Resources/template/common/presnt";
const NAMES = ["Beehive", "DNA", "Focus", "Forestbird", "Midnightblue", "Nature_Illustration", "Piano", "Vintage", "Yellow_Idea", "Blueprint_Plans"];
const available = HAVE.soffice() && existsSync(TEMPLATES);

let c: Converter;
let browser: Browser;
const tmp = mkdtempSync(join(tmpdir(), "sp-templates-"));

before(async () => {
  if (!available) return;
  [c, browser] = await Promise.all([startConverter(), chromium.launch()]);
});
after(async () => {
  if (!available) return;
  await Promise.all([c.stop(), browser.close(), closeBrowser()]);
  rmSync(tmp, { recursive: true, force: true });
});

/** Mean absolute difference per channel (0-255) between two images, scaled to the same size. */
async function difference(a: Buffer, b: Buffer): Promise<number> {
  const page = await browser.newPage();
  try {
    // a string, so the bundler's helpers (tsx adds __name to inner functions) never reach the page
    const script = `(async () => {
      const W = 240, out = [];
      let H = 0;
      for (const src of ${JSON.stringify([`data:image/png;base64,${a.toString("base64")}`, `data:image/png;base64,${b.toString("base64")}`])}) {
        const im = new Image();
        im.src = src;
        await im.decode();
        if (!H) H = Math.round((W * im.naturalHeight) / im.naturalWidth);
        const cv = document.createElement("canvas");
        cv.width = W;
        cv.height = H;
        const g = cv.getContext("2d");
        g.drawImage(im, 0, 0, W, H);
        out.push(g.getImageData(0, 0, W, H).data);
      }
      let sum = 0;
      for (let i = 0; i < out[0].length; i += 4) sum += Math.abs(out[0][i] - out[1][i]) + Math.abs(out[0][i + 1] - out[1][i + 1]) + Math.abs(out[0][i + 2] - out[1][i + 2]);
      return sum / ((out[0].length / 4) * 3);
    })()`;
    return (await page.evaluate(script)) as number;
  } finally {
    await page.close();
  }
}

for (const name of NAMES) {
  test(`template ${name}: opens and looks like LibreOffice's own render`, { skip: available ? false : "LibreOffice and its templates are not installed" }, async (t) => {
    const file = join(TEMPLATES, `${name}.otp`);
    const r = await importThrough(c, `${name}.otp`, readFileSync(file));
    assert.equal(r.status, 200, JSON.stringify(r.error));
    // every picture the deck uses came back
    const keys = new Set(r.assets.map((a) => a.key));
    for (const m of JSON.stringify(r.deck).matchAll(/"asset:([A-Za-z0-9_-]+)"/g)) assert.ok(keys.has(m[1]!), `asset ${m[1]} returned`);
    assert.ok(!JSON.stringify(r.deck).includes('"region:'), "every region was pictured");
    // ours
    const map = new Map(r.assets.map((a) => [a.key, `data:${a.contentType};base64,${a.data}`]));
    const [ours] = await screenshotSlides(r.deck, [r.deck.slides[0]!.id], { width: 480, assetUrl: (id) => map.get(id) ?? "", at: 0 });
    // LibreOffice's
    const dir = join(tmp, name);
    execFileSync(SOFFICE, [`-env:UserInstallation=file://${join(tmp, "lo-profile")}`, "--headless", "--convert-to", "pdf", "--outdir", dir, file], { stdio: "ignore" });
    execFileSync("/opt/homebrew/bin/pdftoppm", ["-f", "1", "-l", "1", "-scale-to-x", "480", "-scale-to-y", "-1", "-png", "-singlefile", join(dir, `${name}.pdf`), join(dir, "lo")]);
    const theirs = readFileSync(join(dir, "lo.png"));
    const diff = await difference(ours!, theirs);
    t.diagnostic(`mean difference ${diff.toFixed(2)} of 255 per channel`);
    assert.ok(diff < 6, `${name}: mean difference ${diff.toFixed(1)} of 255 per channel`);
  });
}
