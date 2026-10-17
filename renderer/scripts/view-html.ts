// Visual check: open an exported HTML deck in Chromium, screenshot each slide through its player. Usage: tsx scripts/view-html.ts <file.html> <outPrefix>
import { chromium } from "playwright";
const [file, out] = [process.argv[2]!, process.argv[3]!];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
const errors: string[] = [];
p.on("pageerror", (e) => errors.push(e.message));
p.on("requestfailed", (r) => errors.push("request failed: " + r.url().slice(0, 80)));
await p.goto("file://" + file);
await p.waitForTimeout(1500);
const count = await p.evaluate(() => (window as any).SiliconPresent.count);
for (let i = 0; i < count; i++) {
  await p.evaluate((i) => (window as any).SiliconPresent.go(i, 99), i);
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${out}-${i + 1}.png` });
}
// arrow keys from the start
await p.evaluate(() => (window as any).SiliconPresent.go(0, 0));
for (let k = 0; k < 3; k++) await p.keyboard.press("ArrowRight");
console.log("count", count, "after 3 rights", await p.evaluate(() => [(window as any).SiliconPresent.index, (window as any).SiliconPresent.step]), "errors", errors);
await b.close();
