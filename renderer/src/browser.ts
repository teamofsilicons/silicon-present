import { chromium, type Browser, type Page } from "playwright";
import type { DeckJson } from "@silicon-present/deck";
import { renderDeckHtml, renderSlideDocument, type RenderOptions } from "@silicon-present/render";
import { ConverterError } from "./errors";
import { assetPermission, networkRequest } from "./network";

// One shared headless Chromium (Playwright's, from ~/Library/Caches/ms-playwright) for screenshots, PDF and image work.

let browserP: Promise<Browser> | null = null;

export function browser(): Promise<Browser> {
  if (!browserP) {
    browserP = chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--font-render-hinting=none", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] }).catch((e) => {
      browserP = null;
      throw new ConverterError("chromium_unavailable", `Chromium could not start: ${e instanceof Error ? e.message : e}`, "Install Playwright's Chromium on the converter host (pnpm exec playwright install chromium).", 500);
    });
  }
  return browserP;
}

export async function closeBrowser(): Promise<void> {
  if (browserP) {
    const b = await browserP.catch(() => null);
    browserP = null;
    await b?.close();
  }
}

async function withPage<T>(opts: { width: number; height: number; scale?: number; assetUrl?: (id: string) => string }, fn: (page: Page) => Promise<T>): Promise<T> {
  const b = await browser();
  const ctx = await b.newContext({ viewport: { width: Math.round(opts.width), height: Math.round(opts.height) }, deviceScaleFactor: opts.scale ?? 1, serviceWorkers: "block",
    // Any Chromium networking path not intercepted below fails closed. HTTP is fulfilled by Node.
    proxy: { server: "http://127.0.0.1:0", bypass: "<-loopback>" } });
  try {
    const assetAllowed = assetPermission(opts.assetUrl);
    // Fulfil from our pinned transport. Never hand an approved URL back to Chromium for another DNS lookup.
    await ctx.route("**/*", async (route) => {
      const request = route.request();
      try {
        const response = await networkRequest(request.url(), { assetAllowed, method: request.method(), headers: request.headers(), body: request.postDataBuffer() });
        await route.fulfill({ status: response.status, headers: response.headers, body: response.data });
      } catch { await route.abort("blockedbyclient").catch(() => {}); }
    });
    await ctx.routeWebSocket("**/*", (socket) => socket.close());
    const page = await ctx.newPage();
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

/** Wait for fonts, images and media posters, then `extraMs` (so HTML elements run and settle). */
async function settle(page: Page, extraMs: number): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const imgs = Array.from(document.images).filter((i) => !i.complete);
    const vids = Array.from(document.querySelectorAll("video")).filter((v) => v.readyState < 2 && (v.getAttribute("src") || "").length > 0);
    await Promise.race([
      Promise.all([
        ...imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; })),
        ...vids.map((v) => new Promise((r) => { v.onloadeddata = v.onerror = r; })),
      ]),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  });
  if (extraMs > 0) await page.waitForTimeout(extraMs);
}

function hasLive(deck: DeckJson, slideIds: string[]): boolean {
  const ids = new Set(slideIds);
  const els = [...deck.master.elements, ...deck.slides.filter((s) => ids.has(s.id)).flatMap((s) => s.elements)];
  return els.some((e) => e.kind === "html" || e.kind === "video");
}

export interface ShotOptions {
  /** Output width in px (height follows the deck's aspect). */
  width?: number;
  format?: "png" | "jpg";
  /** ms to let HTML elements run first (default 1500 when the slide has HTML or video, else 0). */
  at?: number;
  assetUrl: (id: string) => string;
  quality?: number;
}

/** Screenshots of slides, each exactly as a Carbon would see it (final animation state). */
export async function screenshotSlides(deck: DeckJson, slideIds: string[], o: ShotOptions): Promise<Buffer[]> {
  const W = deck.size.width;
  const H = deck.size.height;
  const outW = Math.max(16, Math.min(7680, Math.round(o.width ?? W)));
  return withPage({ width: W, height: H, scale: outW / W, assetUrl: o.assetUrl }, async (page) => {
    const out: Buffer[] = [];
    for (const id of slideIds) {
      const ropts: RenderOptions = { assetUrl: o.assetUrl, media: "static", step: "all" };
      await page.setContent(renderSlideDocument(deck, id, ropts), { waitUntil: "load", timeout: 60_000 });
      await settle(page, o.at ?? (hasLive(deck, [id]) ? 1500 : 50));
      out.push(
        await page.screenshot({
          type: o.format === "jpg" ? "jpeg" : "png",
          quality: o.format === "jpg" ? (o.quality ?? 90) : undefined,
          clip: { x: 0, y: 0, width: W, height: H },
        }),
      );
    }
    return out;
  });
}

/** The deck as a PDF, one page per (non-skipped) slide, in its final animation state. */
export async function deckPdf(deck: DeckJson, o: { assetUrl: (id: string) => string; at?: number; includeSkipped?: boolean }): Promise<Buffer> {
  const W = deck.size.width;
  const H = deck.size.height;
  return withPage({ width: W, height: H, assetUrl: o.assetUrl }, async (page) => {
    await page.setContent(renderDeckHtml(deck, { mode: "print", assetUrl: o.assetUrl, media: "static", includeSkipped: o.includeSkipped }), { waitUntil: "load", timeout: 120_000 });
    await settle(page, o.at ?? (hasLive(deck, deck.slides.map((s) => s.id)) ? 1500 : 50));
    await page.emulateMedia({ media: "screen" });
    return page.pdf({ width: `${W}px`, height: `${H}px`, printBackground: true, preferCSSPageSize: true, margin: { top: "0", right: "0", bottom: "0", left: "0" } });
  });
}

/** A transparent PNG of one element (unrotated) as it renders, e.g. an HTML element for formats that can't run HTML. */
export async function elementPicture(deck: DeckJson, slideId: string, elementId: string, o: { assetUrl: (id: string) => string; at?: number; scale?: number }): Promise<Buffer> {
  const slide = deck.slides.find((s) => s.id === slideId) ?? (slideId === "master" ? { id: "master", elements: deck.master.elements } : null);
  const el = slide?.elements.find((e) => e.id === elementId);
  if (!el) throw new ConverterError("element_not_found", `There is no element ${elementId} on slide ${slideId}.`, "Read the deck again for current ids.");
  const tmp: DeckJson = {
    ...deck,
    master: { elements: [] },
    slides: [{ id: "s_pic000", layout: "blank", background: null, skipped: false, section: null, hideMaster: true, transition: null, notes: "", elements: [{ ...el, x: 0, y: 0, rotation: 0, animation: null, link: null }] }],
  };
  const w = Math.max(1, Math.ceil(el.w));
  const h = Math.max(1, Math.ceil(el.h));
  return withPage({ width: Math.max(w, 1), height: Math.max(h, 1), scale: o.scale ?? 1, assetUrl: o.assetUrl }, async (page) => {
    await page.setContent(renderSlideDocument(tmp, "s_pic000", { assetUrl: o.assetUrl, media: "static", transparent: true }), { waitUntil: "load", timeout: 60_000 });
    await settle(page, o.at ?? (el.kind === "html" || el.kind === "video" ? 1500 : 50));
    return page.screenshot({ type: "png", omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  });
}

/** Decode any image the browser can (svg, webp, avif, gif...) and give back PNG bytes plus natural size. Optionally crop (fractions 0..1 of each side). */
export async function toPng(data: Buffer, contentType: string, crop?: { l: number; t: number; r: number; b: number }, maxSide = 4096): Promise<{ png: Buffer; width: number; height: number }> {
  return withPage({ width: 64, height: 64 }, async (page) => {
    const url = `data:${contentType};base64,${data.toString("base64")}`;
    const res = await page.evaluate(
      async ({ url, crop, maxSide }) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        let nw = img.naturalWidth || 1024;
        let nh = img.naturalHeight || 768;
        const c = crop ?? { l: 0, t: 0, r: 0, b: 0 };
        const sx = nw * c.l;
        const sy = nh * c.t;
        const sw = Math.max(1, nw * (1 - c.l - c.r));
        const sh = Math.max(1, nh * (1 - c.t - c.b));
        const k = Math.min(1, maxSide / Math.max(sw, sh));
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(sw * k));
        cv.height = Math.max(1, Math.round(sh * k));
        cv.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
        return { b64: cv.toDataURL("image/png").split(",")[1]!, width: cv.width, height: cv.height };
      },
      { url, crop: crop ?? null, maxSide },
    );
    return { png: Buffer.from(res.b64, "base64"), width: res.width, height: res.height };
  });
}
