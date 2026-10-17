/**
 * HTML elements run live and sandboxed (UNDERSTANDING.md "HTML elements"): the element's own JS runs and can load
 * from the internet (here a server on another origin), but it can't read the viewer's cookies or storage, can't reach
 * the page around it or the rest of the deck, can't call the service as the viewer, and can't open windows or
 * navigate the page.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { call, createDeck, edit, signedIn } from "./pages-support";
import { BASE } from "./support";
import { openDeck } from "./editor-support";

let server: Server;
let origin = "";

test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ value: `fetched from ${req.headers.host}` }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

test("an HTML element runs and fetches from the internet, but can't see the viewer or the page", async ({ browser }) => {
  const ada = await signedIn(browser, "carbon");
  const deck = await createDeck(ada.context, "Sandboxed");
  const slide = (await call<{ slides: Array<{ id: string }> }>(ada.context, "GET", `/v1/decks/${deck}/content?format=json`)).body.slides[0]!.id;
  const js = `
const out = {};
const tryIt = (name, fn) => { try { out[name] = fn(); } catch (e) { out[name] = "blocked:" + e.name; } };
tryIt("cookie", () => document.cookie);
tryIt("storage", () => localStorage.getItem("secret"));
tryIt("parent", () => parent.document.title);
tryIt("top", () => top.location.href);
tryIt("popup", () => String(window.open("about:blank")));
const show = () => { document.getElementById("out").textContent = JSON.stringify(out); };
show();
Promise.all([
  fetch(${JSON.stringify(origin)} + "/data").then(r => r.json()).then(j => { out.fetched = j.value; }).catch(e => { out.fetched = "failed:" + e; }),
  fetch(${JSON.stringify(`${BASE}/api/v1/me`)}).then(r => { out.me = r.status; }).catch(e => { out.me = "failed"; }),
]).then(() => { out.done = true; show(); });`;
  await edit(ada.context, deck, [{ op: "add_element", slide, element: { id: "e_sandbx", kind: "html", x: 100, y: 100, w: 1700, h: 800, html: '<pre id="out">starting</pre>', css: "pre{font:28px monospace;white-space:pre-wrap}", js } }]);
  await ada.context.addCookies([{ name: "visible_cookie", value: "the-viewers-secret", url: BASE }]);
  await openDeck(ada.page, deck);
  await ada.page.evaluate(() => localStorage.setItem("secret", "the-viewers-secret"));

  const frame = ada.page.frameLocator('[data-element-id="e_sandbx"] iframe');
  await expect(frame.locator("#out")).toContainText('"done":true', { timeout: 20_000 });
  const out = JSON.parse((await frame.locator("#out").textContent())!) as Record<string, unknown>;
  expect(out.fetched).toBe(`fetched from ${new URL(origin).host}`);
  expect(String(out.cookie)).toMatch(/^blocked:SecurityError$/);
  expect(String(out.storage)).toMatch(/^blocked:SecurityError$/);
  expect(String(out.parent)).toMatch(/^blocked:/);
  expect(String(out.top)).toMatch(/^blocked:/);
  expect(out.popup).toBe("null");
  // A call to this site's API from inside the element is not the viewer's: no session cookie goes with it.
  expect(out.me).not.toBe(200);
  // The page around it is untouched, and the element's frame is sandboxed without same-origin.
  await expect(ada.page.locator('[data-element-id="e_sandbx"] iframe')).toHaveAttribute("sandbox", "allow-scripts");
  expect(await ada.page.evaluate(() => localStorage.getItem("secret"))).toBe("the-viewers-secret");
  await ada.context.close();
});
