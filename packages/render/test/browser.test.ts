// Renders in real Chromium: the HTML element sandbox, the deck player (steps, slides, links), and that slides load.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { normalizeDeck, THEMES } from "@silicon-present/deck";
import { renderDeckHtml, renderSlideDocument } from "../src/index";
import { contractDecks, testAssetUrl } from "./samples";

let browser: Browser;
let server: Server;
let base = "";
const pages = new Map<string, string>();

before(async () => {
  browser = await chromium.launch();
  server = createServer((req, res) => {
    const body = pages.get(req.url ?? "/") ?? "not found";
    res.writeHead(pages.has(req.url ?? "") ? 200 : 404, { "content-type": "text/html; charset=utf-8", "set-cookie": "session=secret-cookie; Path=/" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await browser.close();
  server.close();
});

test("an HTML element can't see the viewer's cookies, storage or page, but runs its own JS", async () => {
  const deck = normalizeDeck({
    theme: THEMES[0],
    slides: [
      {
        id: "s_aaaaaa",
        elements: [
          {
            kind: "html",
            x: 0,
            y: 0,
            w: 800,
            h: 400,
            html: '<div id="out">running</div>',
            js: `
              const r = {};
              try { r.parentCookie = parent.document.cookie; } catch (e) { r.parentCookie = "blocked"; }
              try { r.ownCookie = document.cookie; } catch (e) { r.ownCookie = "blocked"; }
              try { r.storage = localStorage.getItem("x"); } catch (e) { r.storage = "blocked"; }
              try { r.top = top.location.href; } catch (e) { r.top = "blocked"; }
              r.origin = String(self.origin);
              document.getElementById("out").textContent = "ran";
              parent.postMessage(r, "*");`,
          },
        ],
      },
    ],
  });
  pages.set("/sandbox", renderSlideDocument(deck, "s_aaaaaa", { googleFonts: false }) + `<script>window.__msgs=[];addEventListener("message",e=>window.__msgs.push(e.data))</script>`);
  const page = await browser.newPage();
  await page.goto(base + "/sandbox");
  await page.evaluate(() => localStorage.setItem("x", "viewer-secret"));
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __msgs: unknown[] }).__msgs.length > 0);
  const msg = (await page.evaluate(() => (window as unknown as { __msgs: unknown[] }).__msgs[0])) as Record<string, string>;
  assert.equal(msg.parentCookie, "blocked");
  assert.equal(msg.ownCookie, "blocked");
  assert.equal(msg.storage, "blocked");
  assert.equal(msg.top, "blocked");
  assert.equal(msg.origin, "null");
  const frameText = await page.frames()[1]!.textContent("#out");
  assert.equal(frameText, "ran");
  await page.close();
});

test("the deck player: click-steps, slide changes, skipped slides, slide links", async () => {
  const deck = contractDecks()["every-element"]!;
  pages.set("/player", renderDeckHtml(deck, { assetUrl: testAssetUrl, googleFonts: false }));
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(base + "/player");
  const state = () => page.evaluate(() => ({ i: (window as any).SiliconPresent.index, s: (window as any).SiliconPresent.step, at: document.querySelectorAll(".sp-frame")[(window as any).SiliconPresent.index].querySelector(".sp-slide")!.getAttribute("data-sp-at") }));
  assert.deepEqual(await state(), { i: 0, s: 0, at: "0" });
  // slide 1 has one click-step (fade); its element is hidden before the click
  const vis = () => page.evaluate(() => getComputedStyle(document.querySelector('.sp-frame .sp-el[data-sp-step="1"]')!).visibility);
  assert.equal(await vis(), "hidden");
  await page.keyboard.press("ArrowRight");
  assert.deepEqual(await state(), { i: 0, s: 1, at: "1" });
  assert.equal(await vis(), "visible");
  await page.keyboard.press("ArrowRight");
  assert.deepEqual((await state()).i, 1);
  for (let k = 0; k < 3; k++) await page.keyboard.press("ArrowRight");
  assert.deepEqual(await state(), { i: 1, s: 3, at: "3" });
  await page.keyboard.press("ArrowRight");
  // slide 3 is skipped, so the next frame is s_000004
  assert.equal(await page.evaluate(() => document.querySelectorAll(".sp-frame")[(window as any).SiliconPresent.index].getAttribute("data-slide")), "s_000004");
  await page.keyboard.press("ArrowLeft");
  assert.deepEqual(await state(), { i: 1, s: 3, at: "3" });
  assert.equal(await page.evaluate(() => (window as any).SiliconPresent.count), 4);
  await page.close();
});

test("every contract slide loads in Chromium without errors from our markup", async () => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const deck of Object.values(contractDecks())) {
    for (const s of deck.slides) {
      await page.setContent(renderSlideDocument(deck, s.id, { assetUrl: testAssetUrl, googleFonts: false }));
      const box = await page.locator(".sp-slide").boundingBox();
      assert.deepEqual([box!.width, box!.height], [1920, 1080]);
    }
  }
  assert.deepEqual(errors, []);
  await page.close();
});
