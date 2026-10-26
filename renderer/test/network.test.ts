import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type Server, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { normalizeDeck } from "@silicon-present/deck";
import { assetUrlFrom, makeFetcher } from "../src/assets";
import { closeBrowser, screenshotSlides } from "../src/browser";
import { assetPermission, networkRequest, publicAddress } from "../src/network";
import { fixture } from "./helpers";

after(closeBrowser);
async function serve(fn: RequestListener): Promise<{ server: Server; base: string }> {
  const server = createServer(fn);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function close(server: Server) { await new Promise<void>((resolve) => server.close(() => resolve())); }

test("private, mapped, reserved and alternate numeric IPs are not public", () => {
  for (const address of ["127.0.0.1", "0.0.0.0", "10.1.2.3", "169.254.169.254", "172.16.0.1", "192.168.0.1", "100.64.0.1", "198.18.0.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2001::123", "2002:7f00:1::"]) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
  assert.equal(publicAddress("2001:4860:4860::8888"), true);
});

test("Node media downloads block loopback and DNS aliases without making requests", async () => {
  let hits = 0;
  const { server, base } = await serve((_req, res) => { hits++; res.end("private"); });
  try {
    for (const url of [base + "/private", base.replace("127.0.0.1", "localhost") + "/private", base.replace("127.0.0.1", "2130706433") + "/private"]) {
      await assert.rejects(makeFetcher(undefined)(url), { code: "network_blocked" });
    }
    assert.equal(hits, 0);
  } finally { await close(server); }
});

test("only the exact trusted asset path is reachable; redirects are checked again", async () => {
  const hits: string[] = [];
  const { server, base } = await serve((req, res) => {
    hits.push(req.url!);
    if (req.url === "/assets/redirect") res.writeHead(302, { location: "/private" }).end();
    else res.end("asset");
  });
  try {
    const assetUrl = assetUrlFrom(base + "/assets/");
    const assetAllowed = assetPermission(assetUrl);
    assert.equal((await networkRequest(assetUrl("image"), { assetAllowed })).data.toString(), "asset");
    await assert.rejects(networkRequest(assetUrl("redirect"), { assetAllowed }), { code: "network_blocked" });
    await assert.rejects(networkRequest(base + "/private", { assetAllowed }), { code: "network_blocked" });
    await assert.rejects(networkRequest(assetUrl("image"), { assetAllowed, method: "POST", body: Buffer.from("side effect") }), { code: "network_blocked" });
    assert.deepEqual(hits, ["/assets/image", "/assets/redirect"]);
  } finally { await close(server); }
});

test("Chromium blocks private fetch, images, frames and WebSockets while rendering trusted assets", async () => {
  const hits: string[] = [];
  const { server, base } = await serve((req, res) => {
    hits.push(req.url!);
    res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" }).end(fixture("picture.png"));
  });
  try {
    const deck = normalizeDeck({ slides: [{ id: "s_safe", elements: [
      { id: "e_image", kind: "image", src: "asset:picture", w: 100, h: 100 },
      { id: "e_html", kind: "html", html: `<img src="${base}/private-image"><iframe src="${base}/private-frame"></iframe>`, css: `body { background-image: url(${base}/private-style) }`, js: `fetch('${base}/private-fetch', {method:'POST', body:'probe'}).catch(()=>{}); new WebSocket('${base.replace("http:", "ws:")}/private-socket');` },
    ] }] });
    const images = await screenshotSlides(deck, ["s_safe"], { width: 320, at: 100, assetUrl: assetUrlFrom(base + "/assets/") });
    assert.ok(images[0]!.length > 100);
    assert.ok(hits.includes("/assets/picture"));
    assert.ok(hits.every((hit) => hit === "/assets/picture"), JSON.stringify(hits));
  } finally { await close(server); }
});
