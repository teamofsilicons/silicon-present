import { luminance, mix } from "@silicon-present/deck";
import type { DeckJson, Element, Slide, Theme, Transition } from "@silicon-present/deck";
import { chartSvg } from "./chart";
import { BODY_SIZE, SLIDE_CSS, TABLE_SIZE } from "./css";
import { color, cssUrl, escapeHtml, fontName, fontStack, linkHref, mediaSrc, n, optColor } from "./safe";
import { shapeGeometry } from "./shapes";
import { richTextHtml } from "./text";

// The one definition of how a slide looks. The web viewer, present mode, thumbnails, the screenshot/PDF renderer and
// HTML export all call these functions, so a slide looks the same everywhere.

export interface RenderOptions {
  /** Resolves "asset:<id>". Default: `/api/v1/assets/<id>` (the web's API proxy). */
  assetUrl?: (id: string) => string;
  /** Which click-step of the element animations to show: 0 = none clicked yet, "all" = final state (default). */
  step?: number | "all";
  /** Play the animations of the shown step (present mode) instead of showing its final state. Default false. */
  animate?: boolean;
  /** "live": HTML elements run in sandboxed iframes (default). "static": a quiet code placeholder (cheap thumbnails). */
  html?: "live" | "static";
  /** "interactive": media with controls and autoplay (default). "static": posters/first frames, no controls. */
  media?: "interactive" | "static";
  /** Element and text links are clickable. Default true. */
  links?: boolean;
  /** Draw empty images as placeholder boxes (the editor). Default false: empty images draw nothing. */
  placeholders?: boolean;
  /** Put a <style> with the base CSS and fonts inside the fragment. Default true. Pass false and add slideCss() and fontCss() once per page instead. */
  includeCss?: boolean;
  /** Load theme and text fonts from Google Fonts. Default true. */
  googleFonts?: boolean;
  /** Leave these element ids out (e.g. the element being edited in place). */
  hide?: string[];
  /** Render only these element ids, without background or master (used to picture one element). */
  only?: string[];
  /** No background (with `only`, to picture an element on transparency). */
  transparent?: boolean;
  /** Extra class on the slide root. */
  className?: string;
}

const defaultAssetUrl = (id: string) => `/api/v1/assets/${encodeURIComponent(id)}`;

export function resolveSrc(src: unknown, opts: RenderOptions): string | null {
  if (typeof src !== "string" || !src) return null;
  if (src.startsWith("asset:")) return (opts.assetUrl ?? defaultAssetUrl)(src.slice(6));
  return mediaSrc(src);
}

// ---------------------------------------------------------------- animations

export interface StepInfo {
  step: number;
  /** Delay from the start of its step, in ms (after-previous / with-previous chains). */
  delay: number;
  duration: number;
  keyframes: string;
}

/** Click-steps of a slide's element animations: how many clicks the slide has, and when each element appears. */
export function slideSteps(slide: Slide): { steps: number; elements: Map<string, StepInfo> } {
  const animated = slide.elements
    .map((e, z) => ({ e, z }))
    .filter(({ e }) => e.animation)
    .sort((a, b) => n(a.e.animation!.order) - n(b.e.animation!.order) || a.z - b.z);
  const elements = new Map<string, StepInfo>();
  let step = 0;
  let prevStart = 0;
  let prevEnd = 0;
  for (const { e } of animated) {
    const a = e.animation!;
    const duration = Math.max(1, n(a.duration, 500));
    const delay = Math.max(0, n(a.delay, 0));
    let start: number;
    if (a.trigger === "click") {
      step++;
      prevEnd = 0;
      start = delay;
    } else if (a.trigger === "after-previous") start = prevEnd + delay; // after everything so far in this step
    else start = prevStart + delay; // with the previous one
    prevStart = start;
    prevEnd = Math.max(prevEnd, start + duration);
    elements.set(e.id, { step, delay: start, duration, keyframes: keyframesFor(a.effect, a.direction) });
  }
  return { steps: step, elements };
}

function keyframesFor(effect: string, direction?: string): string {
  // direction is the way the motion goes: fly-in "up" rises from below, wipe "right" reveals left to right
  switch (effect) {
    case "appear":
      return "sp-appear";
    case "fade":
      return "sp-fade";
    case "zoom":
      return "sp-zoom";
    case "rise":
      return "sp-rise";
    case "fly-in":
      return `sp-fly-${["up", "down", "left", "right"].includes(direction ?? "") ? direction : "up"}`;
    case "wipe":
      return `sp-wipe-${["up", "down", "left", "right"].includes(direction ?? "") ? direction : "right"}`;
    default:
      return "sp-fade";
  }
}

function stepCss(slideId: string, steps: number): string {
  if (!steps && steps !== 0) return "";
  const scope = `.sp-slide[data-sp-slide="${cssIdent(slideId)}"]`;
  const rules: string[] = [];
  for (let k = 0; k <= steps; k++) {
    const hidden: string[] = [];
    for (let j = k + 1; j <= steps; j++) hidden.push(`${scope}[data-sp-at="${k}"] .sp-el[data-sp-step="${j}"]`);
    if (hidden.length) rules.push(`${hidden.join(",")}{visibility:hidden}`);
    rules.push(
      `${scope}[data-sp-at="${k}"][data-sp-animate="1"] .sp-el[data-sp-step="${k}"]>.sp-in{animation:var(--sp-anim) var(--sp-dur) cubic-bezier(.2,.7,.2,1) var(--sp-delay) both}`,
    );
  }
  return rules.join("\n");
}

function cssIdent(s: string): string {
  return String(s).replace(/[^A-Za-z0-9_-]/g, "");
}

// ---------------------------------------------------------------- transitions

export interface TransitionCss {
  /** CSS animation for the slide coming in (put it above the outgoing one). */
  in: string;
  /** CSS animation for the slide going out, or "" to leave it still underneath. */
  out: string;
  duration: number;
}

/** The CSS animations present mode applies when moving to a slide with this transition. */
export function transitionCss(t: Transition | null | undefined): TransitionCss | null {
  if (!t) return null;
  const d = Math.max(50, Math.min(10000, n(t.duration, 500)));
  const dir = ["left", "right", "up", "down"].includes(t.direction ?? "") ? t.direction! : "left";
  const ease = "cubic-bezier(.4,0,.2,1)";
  const anim = (name: string) => `${name} ${d}ms ${ease} both`;
  switch (t.type) {
    case "fade":
      return { in: anim("sp-tr-fade-in"), out: "", duration: d };
    case "zoom":
      return { in: anim("sp-tr-zoom-in"), out: anim("sp-tr-zoom-out"), duration: d };
    case "push":
      return { in: anim(`sp-tr-push-${dir}-in`), out: anim(`sp-tr-push-${dir}-out`), duration: d };
    case "cover":
      return { in: anim(`sp-tr-push-${dir}-in`), out: "", duration: d };
    case "wipe":
      return { in: anim(`sp-tr-wipe-${dir === "left" || dir === "right" || dir === "up" || dir === "down" ? dir : "right"}-in`), out: "", duration: d };
    default:
      return { in: anim("sp-tr-fade-in"), out: "", duration: d };
  }
}

// ---------------------------------------------------------------- fonts

const SYSTEM_FONTS = new Set(
  [
    "arial", "helvetica", "helvetica neue", "times", "times new roman", "georgia", "verdana", "tahoma", "trebuchet ms", "courier", "courier new",
    "system-ui", "sans-serif", "serif", "monospace", "calibri", "calibri light", "cambria", "candara", "consolas", "constantia", "corbel",
    "segoe ui", "segoe ui light", "aptos", "aptos display", "menlo", "monaco", "sf pro", "sf pro display", "sf mono", "-apple-system", "impact",
    "comic sans ms", "palatino", "garamond", "book antiqua", "century gothic", "franklin gothic", "gill sans", "optima", "futura", "avenir",
    "avenir next", "lucida grande", "symbol", "wingdings", "brand sans",
  ],
);

/** Every font family a deck uses (theme fonts, text runs). */
export function deckFonts(deck: DeckJson, slides: Slide[] = deck.slides): string[] {
  const set = new Set<string>([deck.theme.fonts.heading, deck.theme.fonts.body]);
  const visit = (els: Element[]) => {
    for (const e of els) {
      const rts = e.kind === "text" || e.kind === "shape" ? [e.text] : e.kind === "table" ? e.cells.flat().map((c) => c.text) : [];
      for (const rt of rts) for (const p of rt.paragraphs) for (const r of p.runs) if (r.font) set.add(r.font);
    }
  };
  visit(deck.master.elements);
  for (const s of slides) visit(s.elements);
  return [...set].filter(Boolean);
}

/** @font-face for custom fonts and @import for Google Fonts, for the given slides (default: all). */
export function fontCss(deck: DeckJson, opts: RenderOptions = {}, slides?: Slide[]): string {
  const out: string[] = [];
  const custom = new Set<string>();
  for (const f of deck.theme.customFonts ?? []) {
    const src = resolveSrc(f.src, opts);
    const fam = fontName(f.family);
    if (!src || !fam) continue;
    custom.add(f.family.toLowerCase());
    out.push(`@font-face{font-family:${fam};src:${cssUrl(src)};font-display:block}`);
  }
  if (opts.googleFonts !== false) {
    const imports = deckFonts(deck, slides)
      .filter((f) => !custom.has(f.toLowerCase()) && !SYSTEM_FONTS.has(f.toLowerCase()))
      .map((f) => `@import url("https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.replace(/[^\p{L}\p{N} ]/gu, "")).replace(/%20/g, "+")}:ital,wght@0,400;0,500;0,600;0,700;1,400;1,700&display=block");`);
    out.unshift(...imports); // @import must come first in a stylesheet
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- elements

function px(v: unknown): string {
  return `${n(v)}px`;
}

function boxCss(e: Element, theme: Theme, opts: { fillDefault?: string; border?: boolean } = {}): string[] {
  const s = e.style ?? {};
  const css: string[] = [];
  const fill = optColor(s.fill) ?? opts.fillDefault;
  if (fill) css.push(`background:${fill}`);
  if (opts.border !== false && s.stroke && n(s.strokeWidth, 0) !== 0) css.push(`border:${px(s.strokeWidth ?? 2)} solid ${color(s.stroke, theme.colors.text)}`);
  else if (opts.border !== false && s.stroke && s.strokeWidth === undefined) css.push(`border:2px solid ${color(s.stroke, theme.colors.text)}`);
  if (s.radius) css.push(`border-radius:${px(s.radius)}`);
  if (s.shadow) css.push("box-shadow:0 10px 30px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.08)");
  return css;
}

function textBlock(e: Element & { text: import("@silicon-present/deck").RichText }, theme: Theme, opts: RenderOptions, extra: { padding: string; align?: "center"; color?: string; va?: string }): string {
  const s = e.style ?? {};
  const va = s.verticalAlign ?? extra.va ?? "top";
  const css = [`padding:${extra.padding}`, `font-family:${fontStack(theme.fonts.body)}`, `font-size:${BODY_SIZE}px`, `line-height:1.25`, `color:${extra.color ?? theme.colors.text}`];
  if (extra.align) css.push(`text-align:${extra.align}`);
  return `<div class="sp-text sp-va-${va === "middle" || va === "bottom" ? va : "top"}" style="${escapeHtml(css.join(";"))}">${richTextHtml(e.text, theme, { links: opts.links })}</div>`;
}

function iconSvg(kind: "image" | "audio", c: string, size: number): string {
  if (kind === "audio")
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>`;
}

/** The srcdoc document of an HTML element: its HTML, CSS and JS, nothing else of the deck. */
export function htmlElementDoc(e: { html: string; css: string; js: string }, theme: Theme): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:${fontStack(theme.fonts.body)};color:${color(theme.colors.text, "#111")}}</style>` +
    `<style>${e.css ?? ""}</style></head><body>${e.html ?? ""}<script>${(e.js ?? "").replace(/<\/script/gi, "<\\/script")}</script></body></html>`
  );
}

function elementInner(e: Element, theme: Theme, opts: RenderOptions): string {
  const s = e.style ?? {};
  const w = Math.max(0, n(e.w));
  const h = Math.max(0, n(e.h));
  switch (e.kind) {
    case "text": {
      const css = boxCss(e, theme);
      const pad = s.padding !== undefined ? px(s.padding) : "0px";
      return `<div class="sp-in"${css.length ? ` style="${escapeHtml(css.join(";"))}"` : ""}>${textBlock(e, theme, opts, { padding: pad })}</div>`;
    }
    case "shape": {
      const geo = shapeGeometry(e.shape, w, h, s.radius);
      const isLine = geo.open;
      const fill = isLine ? "none" : (optColor(s.fill) ?? (s.stroke && !s.fill ? "none" : theme.colors.accent));
      const stroke = isLine ? color(s.stroke, theme.colors.text) : optColor(s.stroke);
      const sw = n(s.strokeWidth, isLine ? 4 : stroke ? 2 : 0);
      const shadow = s.shadow ? ' style="filter:drop-shadow(0 8px 18px rgba(0,0,0,.2))"' : "";
      const svgSize = isLine ? ` width="${n(Math.max(w, 1))}" height="${n(Math.max(h, 1))}" style="width:${n(Math.max(w, 1))}px;height:${n(Math.max(h, 1))}px${s.shadow ? ";filter:drop-shadow(0 8px 18px rgba(0,0,0,.2))" : ""}"` : shadow;
      const svg = `<svg class="sp-shape-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(Math.max(w, 1))} ${n(Math.max(h, 1))}" preserveAspectRatio="none"${svgSize}><path d="${geo.d}" fill="${fill}"${stroke && sw ? ` stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"${isLine ? ' stroke-linecap="round"' : ""} vector-effect="non-scaling-stroke"` : ""}/></svg>`;
      const hasText = e.text?.paragraphs?.some((p) => p.runs.length);
      if (!hasText) return `<div class="sp-in">${svg}</div>`;
      const pad = n(s.padding, 16);
      const t = geo.text;
      const padding = `${px(t.top + pad)} ${px(t.right + pad)} ${px(t.bottom + pad)} ${px(t.left + pad)}`;
      const textColor = fill !== "none" && luminance(fill) < 0.4 ? "#ffffff" : theme.colors.text;
      return `<div class="sp-in">${svg}${textBlock(e, theme, opts, { padding, align: "center", color: textColor, va: "middle" })}</div>`;
    }
    case "image": {
      const src = resolveSrc(e.src, opts);
      const css = [...boxCss(e, theme), "overflow:hidden"];
      if (!src) {
        if (!opts.placeholders) return `<div class="sp-in"></div>`;
        return `<div class="sp-in"><div class="sp-placeholder">${iconSvg("image", mix(theme.colors.text, theme.colors.background, 0.55), Math.min(96, Math.max(24, Math.min(w, h) * 0.25)))}</div></div>`;
      }
      const fit = e.fit === "cover" || e.fit === "fill" ? e.fit : "contain";
      return `<div class="sp-in" style="${escapeHtml(css.join(";"))}"><img class="sp-img" src="${escapeHtml(src)}" alt="${escapeHtml(e.alt)}" draggable="false" decoding="sync" referrerpolicy="no-referrer" style="object-fit:${fit}"></div>`;
    }
    case "video": {
      const src = resolveSrc(e.src, opts);
      const poster = resolveSrc(e.poster, opts);
      const css = [...boxCss(e, theme), "overflow:hidden"];
      if (!src && !poster) return opts.placeholders ? `<div class="sp-in"><div class="sp-placeholder"></div></div>` : `<div class="sp-in"></div>`;
      const live = opts.media !== "static";
      const attrs = [
        src ? `src="${escapeHtml(src)}"` : "",
        poster ? `poster="${escapeHtml(poster)}"` : "",
        "playsinline",
        live ? 'preload="metadata"' : 'preload="auto"',
        live && e.autoplay ? "autoplay" : "",
        live && e.loop ? "loop" : "",
        e.muted || (live && e.autoplay) ? "muted" : "",
        live ? "controls" : "",
        `aria-label="${escapeHtml(e.alt)}"`,
      ].filter(Boolean);
      return `<div class="sp-in" style="${escapeHtml(css.join(";"))}"><video class="sp-media" ${attrs.join(" ")}></video></div>`;
    }
    case "audio": {
      const src = resolveSrc(e.src, opts);
      const bg = optColor(s.fill) ?? mix(theme.colors.accent, theme.colors.background, 0.86);
      const fg = luminance(bg) < 0.4 ? "#ffffff" : theme.colors.text;
      const live = opts.media !== "static";
      const iconSize = Math.max(16, Math.min(h * 0.55, 64));
      const tag = src && live ? `<audio src="${escapeHtml(src)}" controls preload="metadata"${e.autoplay ? " autoplay" : ""}${e.loop ? " loop" : ""}${e.muted ? " muted" : ""} aria-label="${escapeHtml(e.alt)}"></audio>` : "";
      const label = !tag ? `<span style="font:500 ${n(Math.max(14, Math.min(h * 0.32, 32)))}px ${escapeHtml(fontStack(theme.fonts.body))};color:${fg};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.alt || "Audio")}</span>` : "";
      const css = [...boxCss(e, theme, { fillDefault: bg }), ...(s.radius === undefined ? ["border-radius:999px"] : [])];
      return `<div class="sp-in"><div class="sp-audio" style="${escapeHtml(css.join(";"))}">${iconSvg("audio", fg, iconSize)}${tag}${label}</div></div>`;
    }
    case "table": {
      const stroke = color(s.stroke, mix(theme.colors.text, theme.colors.background, 0.78));
      const sw = n(s.strokeWidth, 2);
      const totalW = e.colWidths.reduce((a, b) => a + Math.max(0, n(b)), 0) || 1;
      const totalH = e.rowHeights.reduce((a, b) => a + Math.max(0, n(b)), 0) || 1;
      const hk = h / totalH;
      const cols = e.colWidths.map((cw) => `<col style="width:${n((Math.max(0, n(cw)) / totalW) * 100)}%">`).join("");
      const headerFill = mix(theme.colors.accent, theme.colors.background, 0.88);
      const rows = e.cells
        .map((row, r) => {
          const rh = n(e.rowHeights[r], h / e.rows) * hk;
          const tds = row
            .map((cell) => {
              const fill = optColor(cell.fill) ?? (e.headerRow && r === 0 ? headerFill : null);
              const tdCss = [`border:${px(sw)} solid ${stroke}`, "padding:10px 16px"];
              if (fill) tdCss.push(`background:${fill}`);
              const inner = `<div class="sp-text" style="${escapeHtml(`font-family:${fontStack(theme.fonts.body)};font-size:${TABLE_SIZE}px;line-height:1.2;color:${theme.colors.text}${e.headerRow && r === 0 ? ";font-weight:600" : ""}`)}">${richTextHtml(cell.text, theme, { size: TABLE_SIZE, links: opts.links })}</div>`;
              return `<td style="${escapeHtml(tdCss.join(";"))}">${inner}</td>`;
            })
            .join("");
          return `<tr style="height:${px(rh)}">${tds}</tr>`;
        })
        .join("");
      const css = boxCss(e, theme, { border: false });
      return `<div class="sp-in"${css.length ? ` style="${escapeHtml(css.join(";"))}"` : ""}><table class="sp-table"><colgroup>${cols}</colgroup><tbody>${rows}</tbody></table></div>`;
    }
    case "chart": {
      const css = boxCss(e, theme);
      return `<div class="sp-in"${css.length ? ` style="${escapeHtml(css.join(";"))}"` : ""}>${chartSvg(e.chart, w, h, theme)}</div>`;
    }
    case "html": {
      const css = [...boxCss(e, theme), "overflow:hidden"];
      if (opts.html === "static") {
        const c = mix(theme.colors.text, theme.colors.background, 0.5);
        return `<div class="sp-in" style="${escapeHtml(css.join(";"))}"><div class="sp-html-ph" style="color:${c};background:${mix(theme.colors.text, theme.colors.background, 0.95)}">&lt;/&gt;</div></div>`;
      }
      // sandbox="allow-scripts" and nothing else: an opaque origin, so the element can never read the viewer's cookies,
      // storage or the page around it, never navigate the page or open popups; it can still fetch from the internet.
      return `<div class="sp-in" style="${escapeHtml(css.join(";"))}"><iframe class="sp-html" sandbox="allow-scripts" referrerpolicy="no-referrer" allow="" loading="eager" scrolling="no" title="HTML element" srcdoc="${escapeHtml(htmlElementDoc(e, theme))}"></iframe></div>`;
    }
    default:
      return `<div class="sp-in"></div>`;
  }
}

export function renderElementHtml(e: Element, theme: Theme, opts: RenderOptions = {}, step?: StepInfo): string {
  const css = [`left:${px(e.x)}`, `top:${px(e.y)}`, `width:${px(Math.max(0, n(e.w)))}`, `height:${px(Math.max(0, n(e.h)))}`];
  if (n(e.rotation)) css.push(`transform:rotate(${n(e.rotation)}deg)`);
  const op = e.style?.opacity;
  if (op !== undefined && op !== null && n(op, 1) < 1) css.push(`opacity:${Math.max(0, n(op, 1))}`);
  if (step) css.push(`--sp-anim:${step.keyframes}`, `--sp-dur:${step.duration}ms`, `--sp-delay:${step.delay}ms`);
  const href = opts.links !== false && e.kind !== "html" ? linkHref(e.link) : null;
  const link = href
    ? href.startsWith("#")
      ? `<a class="sp-link" href="${escapeHtml(href)}" data-sp-goto="${escapeHtml(href.slice(7))}" aria-label="Go to slide"></a>`
      : `<a class="sp-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(href)}"></a>`
    : "";
  return `<div class="sp-el sp-k-${e.kind}" data-sp-id="${escapeHtml(e.id)}"${step ? ` data-sp-step="${step.step}"` : ""} style="${escapeHtml(css.join(";"))}">${elementInner(e, theme, opts)}${link}</div>`;
}

// ---------------------------------------------------------------- slides

export function backgroundCss(deck: DeckJson, slide: Slide | null, opts: RenderOptions): string {
  const css = [`background-color:${color(deck.theme.colors.background, "#ffffff")}`];
  const bg = slide?.background;
  if (bg && "color" in bg) css[0] = `background-color:${color(bg.color, deck.theme.colors.background)}`;
  if (bg && "image" in bg) {
    const src = resolveSrc(bg.image, opts);
    if (src) css.push(`background-image:${cssUrl(src)}`, `background-size:${bg.fit === "contain" ? "contain" : "cover"}`);
  }
  return css.join(";");
}

function findSlide(deck: DeckJson, slideId: string): Slide {
  const s = deck.slides.find((x) => x.id === slideId);
  if (!s) throw new Error(`There is no slide ${slideId} in this deck. Read the deck again to get its current slide ids.`);
  return s;
}

/**
 * One slide as an HTML fragment: a deck.size box (1920 x 1080 by default) with the background, the master elements
 * (unless hideMaster), then the slide's elements back to front. Scale it with scaleToFit / a CSS transform.
 */
export function renderSlideHtml(deck: DeckJson, slideId: string, opts: RenderOptions = {}): string {
  const slide = findSlide(deck, slideId);
  const { width, height } = deck.size;
  const { steps, elements: stepMap } = slideSteps(slide);
  const at = opts.step === undefined || opts.step === "all" ? "all" : String(Math.max(0, Math.min(steps, Math.round(opts.step))));
  const hide = new Set(opts.hide ?? []);
  const only = opts.only ? new Set(opts.only) : null;
  const keep = (e: Element) => !hide.has(e.id) && (!only || only.has(e.id));
  const parts: string[] = [];
  if (opts.includeCss !== false) parts.push(`<style>${fontCss(deck, opts, [slide])}\n${SLIDE_CSS}</style>`);
  if (steps) parts.push(`<style>${stepCss(slide.id, steps)}</style>`);
  if (!opts.transparent && !only) parts.push(`<div class="sp-bg" style="${escapeHtml(backgroundCss(deck, slide, opts))}"></div>`);
  parts.push('<div class="sp-layer">');
  if (!slide.hideMaster && !only) for (const e of deck.master.elements) if (keep(e)) parts.push(renderElementHtml(e, deck.theme, opts));
  for (const e of slide.elements) if (keep(e)) parts.push(renderElementHtml(e, deck.theme, opts, stepMap.get(e.id)));
  parts.push("</div>");
  const cls = ["sp-slide", opts.className].filter(Boolean).join(" ");
  const rootCss = `width:${n(width)}px;height:${n(height)}px;font-family:${fontStack(deck.theme.fonts.body)};color:${color(deck.theme.colors.text, "#111")}${opts.transparent || only ? ";background:transparent" : ""}`;
  return `<div class="${escapeHtml(cls)}" data-sp-slide="${escapeHtml(slide.id)}" data-sp-steps="${steps}" data-sp-at="${at}" data-sp-animate="${opts.animate ? 1 : 0}" style="${escapeHtml(rootCss)}">${parts.join("")}</div>`;
}

/** A full HTML document showing one slide at its native size (for screenshots). */
export function renderSlideDocument(deck: DeckJson, slideId: string, opts: RenderOptions = {}): string {
  const slide = findSlide(deck, slideId);
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(deck.title ?? "Slide")}</title>` +
    `<style>${fontCss(deck, opts, [slide])}\n${SLIDE_CSS}\nhtml,body{margin:0;padding:0;background:${opts.transparent ? "transparent" : "#ffffff"};width:${n(deck.size.width)}px;height:${n(deck.size.height)}px;overflow:hidden}</style>` +
    `</head><body>${renderSlideHtml(deck, slideId, { ...opts, includeCss: false })}</body></html>`
  );
}

/** How to scale a deck.size slide into a box: the scale and the offsets that center it. */
export function scaleToFit(boxWidth: number, boxHeight: number, size: { width: number; height: number } = { width: 1920, height: 1080 }) {
  const scale = Math.max(0, Math.min(boxWidth / size.width, boxHeight / size.height));
  return { scale, width: size.width * scale, height: size.height * scale, offsetX: (boxWidth - size.width * scale) / 2, offsetY: (boxHeight - size.height * scale) / 2 };
}
