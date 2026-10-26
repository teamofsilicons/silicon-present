import { THEMES, newElementId, newSlideId, normalizeDeck } from "@silicon-present/deck";
import type { Animation, DeckJson, ElementInput, Paragraph, SlideInput } from "@silicon-present/deck";
import { BODY_SIZE, TABLE_SIZE } from "@silicon-present/render";
import { browser } from "../browser";
import { extForType, sniffType } from "../media";
import { assetPermission, networkRequest } from "../network";
import { measurePage, type PageItem, type PageLive, type PagePara, type PageResult } from "./html-page";
import type { ImportedAsset } from "./pptx";

// A web page that holds slides (Claude Design / Claude Slides exports, reveal.js, pages of .slide or same-size
// sections) -> a deck of native elements. The page runs in the converter's Chromium with the same network isolation as
// every render (each request goes through the DNS-pinned transport in network.ts), its scripts get a time limit, and
// html-page.ts measures every slide where it rendered. What can't be native (canvas, SVG, scripted widgets, frames,
// CSS effects) stays live as an HTML element over exactly that part. No slides found: null, and the caller keeps the
// page as one full-slide HTML element.

export interface HtmlDeck {
  deck: DeckJson;
  assets: ImportedAsset[];
  notes: string[];
}

const DOC_URL = "https://html-import.present.invalid/";
const DECK_W = 1920;
const LOAD_MS = 20_000;
const MEASURE_MS = 45_000;

interface Loaded {
  data: Buffer;
  contentType: string;
}

/** Load the page in an isolated context, measure its slides. Throws when the page can't be loaded or measured in time. */
async function measure(html: string): Promise<{ result: PageResult | null; title: string; cache: Map<string, Loaded> }> {
  const b = await browser();
  // The same isolation as browser.ts withPage: every request is fulfilled by the pinned transport, anything else fails.
  const ctx = await b.newContext({ viewport: { width: DECK_W, height: 1080 }, deviceScaleFactor: 1, serviceWorkers: "block", acceptDownloads: false, proxy: { server: "http://127.0.0.1:0", bypass: "<-loopback>" } });
  const cache = new Map<string, Loaded>();
  try {
    const assetAllowed = assetPermission(undefined);
    await ctx.route("**/*", async (route) => {
      const request = route.request();
      try {
        if (request.url() === DOC_URL) return await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
        const response = await networkRequest(request.url(), { assetAllowed, method: request.method(), headers: request.headers(), body: request.postDataBuffer() });
        const ct = (response.headers["content-type"] ?? "").split(";")[0]!.trim();
        if (request.method() === "GET" && response.status >= 200 && response.status < 300 && /^(image|video|audio)\//.test(ct)) cache.set(request.url(), { data: response.data, contentType: ct });
        await route.fulfill({ status: response.status, headers: response.headers, body: response.data });
      } catch {
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    await ctx.routeWebSocket("**/*", (socket) => socket.close());
    const page = await ctx.newPage();
    await page.goto(DOC_URL, { waitUntil: "load", timeout: LOAD_MS }).catch(async (e) => {
      // a page that never finishes loading is still measured as far as it got
      if (!(await withLimit(page.evaluate(() => !!document.body), 3_000, "the page").catch(() => false))) throw new Error(`the page did not load within ${LOAD_MS / 1000} s (${e instanceof Error ? e.message.split("\n")[0] : e})`);
    });
    await page.waitForTimeout(600); // let the deck's own scripts lay it out
    const title = await withLimit(page.title(), 5_000, "reading the title").catch(() => "");
    // tsx wraps named functions in __name(); give the page a local one
    const src = `(() => { const __name = (f) => f; return (${measurePage.toString()})(${JSON.stringify({ deckWidth: DECK_W, maxSlides: 500, bodySize: BODY_SIZE, tableSize: TABLE_SIZE })}); })()`;
    const result = (await withLimit(page.evaluate(src), MEASURE_MS, "measuring the slides")) as PageResult | null;
    return { result, title, cache };
  } finally {
    await ctx.close().catch(() => {});
  }
}

function withLimit<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error(`${what} took longer than ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(timer));
}

function fromDataUrl(src: string): Loaded | null {
  const m = /^data:([^;,]+)?((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(src);
  if (!m) return null;
  return { contentType: m[1] ?? "application/octet-stream", data: m[3] ? Buffer.from(m[4]!, "base64") : Buffer.from(decodeURIComponent(m[4]!)) };
}

/**
 * Open an HTML file as a deck of native elements, or null when it has no slides to find. Throws when the page couldn't
 * be loaded or measured (the caller falls back to one live HTML element and says why).
 */
export async function importHtmlDeck(html: string, fallbackTitle: string): Promise<HtmlDeck | null> {
  const { result, title, cache } = await measure(html);
  if (!result || !result.slides.length) return null;
  const assets: ImportedAsset[] = [];
  const notes: string[] = [];
  const byRef = new Map<string, string | null>();
  // a picture's bytes: what the page loaded, a data: URL, or fetched again through the pinned transport
  const assetFor = async (src: string, base: string): Promise<string | null> => {
    if (byRef.has(src)) return byRef.get(src)!;
    let got: Loaded | null = src.startsWith("data:") ? fromDataUrl(src) : (cache.get(src) ?? null);
    if (!got && /^https?:/.test(src)) {
      try {
        const res = await networkRequest(src, { assetAllowed: assetPermission(undefined) });
        if (res.status >= 200 && res.status < 300) got = { data: res.data, contentType: (res.headers["content-type"] ?? "").split(";")[0]!.trim() };
      } catch {
        got = null;
      }
    }
    let ref: string | null = null;
    if (got && got.data.length) {
      const key = `a${assets.length + 1}`;
      const sniffed = sniffType(got.data);
      const contentType = sniffed !== "application/octet-stream" ? sniffed : got.contentType || "application/octet-stream";
      const name = (/^https?:/.test(src) ? decodeURIComponent(new URL(src).pathname.split("/").pop() ?? "") : "").replace(/[^\w.-]+/g, "-");
      assets.push({ key, filename: name && /\.\w+$/.test(name) ? name : `${base}-${assets.length + 1}.${extForType(contentType)}`, contentType, data: got.data });
      ref = `asset:${key}`;
    } else if (/^https?:/.test(src) && !src.startsWith(DOC_URL)) ref = src; // public and reachable later, maybe
    byRef.set(src, ref);
    return ref;
  };

  const H = Math.round((DECK_W * result.slides[0]!.height) / result.slides[0]!.width) || 1080;
  const slides: SlideInput[] = [];
  const fonts = new Map<string, number>();
  const textColors = new Map<string, number>();
  const bgColors = new Map<string, number>();
  const count = (m: Map<string, number>, k: string | undefined, n = 1) => k && m.set(k, (m.get(k) ?? 0) + n);
  const rich = (paras: PagePara[]) => ({
    paragraphs: paras.map((p) => {
      for (const r of p.runs) {
        count(fonts, r.font, r.text.length);
        count(textColors, r.color, r.text.length);
      }
      return p as Paragraph;
    }),
  });

  for (const [i, s] of result.slides.entries()) {
    const n = i + 1;
    const elements: ElementInput[] = [];
    const live = new Map<string, number>();
    const html = (l: PageLive, it: { x: number; y: number; w: number; h: number }) => {
      live.set(l.why, (live.get(l.why) ?? 0) + 1);
      return { kind: "html", x: it.x, y: it.y, w: it.w, h: it.h, html: l.html, css: l.css, js: l.js };
    };
    // reveal.js fragments: each one appears on a click, in its index order
    const frags = [...new Set(s.items.map((it) => it.frag).filter((f): f is number => f !== undefined))];
    const fragOrder = new Map(frags.map((f, k) => [f, k + 1]));
    const seen = new Set<number>();
    for (const it of s.items) {
      const common: Record<string, unknown> = { id: newElementId(), x: it.x, y: it.y, w: it.w, h: it.h };
      const style: Record<string, unknown> = {};
      if (it.opacity !== undefined) style.opacity = it.opacity;
      if (it.link) common.link = it.link;
      if (it.frag !== undefined) {
        const anim: Animation = { effect: "fade", trigger: seen.has(it.frag) ? "with-previous" : "click", order: fragOrder.get(it.frag) ?? 1, duration: 500, delay: 0 };
        seen.add(it.frag);
        common.animation = anim;
      }
      const el = await toElement(it, common, style, n);
      if (el) elements.push(el);
    }
    async function toElement(it: PageItem, common: Record<string, unknown>, style: Record<string, unknown>, n: number): Promise<ElementInput | null> {
      switch (it.t) {
        case "text":
          return { ...common, kind: "text", style, text: rich(it.paras) } as ElementInput;
        case "shape":
          if (it.fill) style.fill = it.fill;
          if (it.stroke) {
            style.stroke = it.stroke;
            style.strokeWidth = it.strokeWidth;
          }
          if (it.radius) style.radius = it.radius;
          if (it.shadow) style.shadow = true;
          return { ...common, kind: "shape", shape: it.shape, style, text: { paragraphs: [] } } as ElementInput;
        case "image": {
          const src = await assetFor(it.src, `slide-${n}-image`);
          if (!src) {
            notes.push(`Slide ${n}: the picture ${it.src.startsWith("data:") ? "(an inline data URL)" : it.src} could not be loaded, so it was left out.`);
            return null;
          }
          if (it.radius) style.radius = it.radius;
          return { ...common, kind: "image", src, alt: it.alt, fit: it.fit, style } as ElementInput;
        }
        case "media": {
          const src = await assetFor(it.src, `slide-${n}-${it.kind}`);
          if (!src) return { ...common, ...html(it.fallback, it) } as ElementInput;
          const poster = it.poster ? await assetFor(it.poster, `slide-${n}-poster`) : null;
          return { ...common, kind: it.kind, src, alt: "", autoplay: it.autoplay, loop: it.loop, muted: it.muted, ...(it.kind === "video" ? { poster } : {}), style } as ElementInput;
        }
        case "table":
          if (it.fill) style.fill = it.fill;
          if (it.stroke) style.stroke = it.stroke;
          style.strokeWidth = it.strokeWidth;
          return { ...common, kind: "table", rows: it.rows, cols: it.cols, colWidths: it.colWidths, rowHeights: it.rowHeights, headerRow: it.headerRow, cells: it.cells.map((row) => row.map((c) => ({ text: rich(c.paras), fill: c.fill ?? null }))), style } as ElementInput;
        case "html":
          return { ...common, ...html(it, it), style } as ElementInput;
      }
    }
    const background: SlideInput["background"] = s.background.image
      ? await assetFor(s.background.image, `slide-${n}-background`).then((src) => (src ? { image: src, fit: s.background.fit ?? "cover" } : s.background.color ? { color: s.background.color } : null))
      : s.background.color
        ? { color: s.background.color }
        : null;
    if (background && "color" in background) count(bgColors, background.color);
    if (live.size) notes.push(`Slide ${n}: ${[...live].map(([why, k]) => (k > 1 ? `${why} (${k})` : why)).join(", ")} stayed live HTML.`);
    slides.push({ id: newSlideId(), layout: "blank", background, notes: s.notes, elements });
  }

  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
  const base = THEMES[0]!;
  const font = top(fonts);
  const theme = {
    ...base,
    name: "Imported",
    fonts: font ? { heading: font, body: font } : base.fonts,
    colors: { ...base.colors, ...(top(bgColors) ? { background: top(bgColors)!.slice(0, 7) } : {}), ...(top(textColors) ? { text: top(textColors)!.slice(0, 7) } : {}) },
  };
  const deck = normalizeDeck({ title: title.trim() || fallbackTitle, size: { width: DECK_W, height: H }, theme, master: { elements: [] }, slides });
  notes.unshift(`Opened ${result.slides.length} slide${result.slides.length === 1 ? "" : "s"} from the page (${result.how}).`);
  return { deck, assets, notes };
}
