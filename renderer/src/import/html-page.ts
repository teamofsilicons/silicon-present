// The part of the HTML importer that runs inside Chromium: find the slides of a loaded page and measure everything on
// them in deck pixels. Playwright sends this function's source to the page, so it must not use anything from outside
// its own body (no imports, no module-level values); html.ts evaluates it with a local `__name` (tsx adds calls to it).

export interface PageRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  highlight?: string;
  size?: number;
  font?: string;
  link?: string;
}

export interface PagePara {
  align?: "center" | "right" | "justify";
  list?: "bullet" | "ordered";
  indent?: number;
  lineHeight?: number;
  runs: PageRun[];
}

interface Base {
  x: number;
  y: number;
  w: number;
  h: number;
  /** stacking: the z-index of the nearest positioned ancestor that sets one */
  z: number;
  opacity?: number;
  /** reveal.js fragment this came from (shown on click) */
  frag?: number;
  link?: string;
}

export type PageItem =
  | (Base & { t: "text"; paras: PagePara[] })
  | (Base & { t: "shape"; shape: "rect" | "ellipse"; fill?: string; stroke?: string; strokeWidth?: number; radius?: number; shadow?: boolean })
  | (Base & { t: "image"; src: string; fit: "cover" | "contain" | "fill"; radius?: number; alt: string })
  | (Base & { t: "media"; kind: "video" | "audio"; src: string; poster?: string; autoplay: boolean; loop: boolean; muted: boolean; fallback: PageLive })
  | (Base & { t: "table"; rows: number; cols: number; colWidths: number[]; rowHeights: number[]; cells: Array<Array<{ paras: PagePara[]; fill?: string }>>; headerRow: boolean; fill?: string; stroke?: string; strokeWidth: number })
  | (Base & PageLive & { t: "html" });

export interface PageLive {
  html: string;
  css: string;
  js: string;
  why: string;
}

export interface PageSlide {
  /** the slide's own layout size in CSS px */
  width: number;
  height: number;
  background: { color?: string; image?: string; fit?: "cover" | "contain" };
  items: PageItem[];
  notes: string;
}

export interface PageResult {
  /** how the slides were found, e.g. "reveal", "deck-stage", ".slide" */
  how: string;
  slides: PageSlide[];
}

/** Runs in the page. `null` when the page has no slide structure. */
export async function measurePage(opts: { deckWidth: number; maxSlides: number; bodySize: number; tableSize: number }): Promise<PageResult | null> {
  const W = opts.deckWidth;
  const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "LINK", "META", "TITLE", "HEAD", "BASE"]);
  const NOTES_SEL = "aside.notes, .notes, .speaker-notes, [data-speaker-notes]";
  const INTERACTIVE = new Set(["CANVAS", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "VIDEO", "AUDIO", "IFRAME", "svg", "OBJECT", "EMBED"]);
  const ATOMIC = new Set(["IMG", "svg", "CANVAS", "VIDEO", "AUDIO", "IFRAME", "OBJECT", "EMBED", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "TABLE", "MATH", "PICTURE"]);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const cs = (el: Element, pseudo?: string) => getComputedStyle(el, pseudo);

  // ------------------------------------------------------------ colours (any CSS colour, oklch included, to hex)
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const c2 = cv.getContext("2d", { willReadFrequently: true })!;
  const colors = new Map<string, string | null>();
  const hex = (v: string): string | null => {
    if (!v) return null;
    if (colors.has(v)) return colors.get(v)!;
    c2.clearRect(0, 0, 1, 1);
    c2.fillStyle = "#000";
    c2.fillStyle = v;
    c2.fillRect(0, 0, 1, 1);
    const d = c2.getImageData(0, 0, 1, 1).data;
    const h = (n: number) => n.toString(16).padStart(2, "0");
    const out = d[3]! < 2 ? null : `#${h(d[0]!)}${h(d[1]!)}${h(d[2]!)}${d[3]! < 253 ? h(d[3]!) : ""}`;
    colors.set(v, out);
    return out;
  };

  // ------------------------------------------------------------ finding the slides
  const rendered = (el: Element) => el.getClientRects().length > 0;
  const findSlides = (): { how: string; slides: Element[] } | null => {
    const reveal = document.querySelector(".reveal .slides");
    if (reveal) {
      const out: Element[] = [];
      for (const s of Array.from(reveal.children)) {
        if (s.tagName !== "SECTION") continue;
        const inner = Array.from(s.children).filter((c) => c.tagName === "SECTION");
        out.push(...(inner.length ? inner : [s]));
      }
      if (out.length) return { how: "reveal", slides: out };
    }
    const stage = document.querySelector("deck-stage");
    if (stage) {
      const kids = Array.from(stage.children).filter((c) => !SKIP.has(c.tagName) && !c.matches(NOTES_SEL));
      if (kids.length) return { how: "deck-stage", slides: kids };
    }
    const marked = Array.from(document.querySelectorAll(".slide, [data-slide]")).filter((el) => !el.parentElement?.closest(".slide, [data-slide]"));
    if (marked.length) return { how: ".slide", slides: marked };
    // siblings of one size and a slide's shape, as wide as half the window or more (pages of slides stacked or side by side)
    let best: Element[] | null = null;
    for (const p of Array.from(document.querySelectorAll("body, body *")).slice(0, 5000)) {
      const kids = Array.from(p.children).filter((c) => !SKIP.has(c.tagName) && rendered(c)) as HTMLElement[];
      if (kids.length < 2 || !(kids[0] instanceof HTMLElement)) continue;
      const w = kids[0].offsetWidth;
      const h = kids[0].offsetHeight;
      if (w < innerWidth * 0.45 || !h || w / h < 1.25 || w / h > 2.4) continue;
      if (!kids.every((k) => k instanceof HTMLElement && Math.abs(k.offsetWidth - w) <= 2 && Math.abs(k.offsetHeight - h) <= 2)) continue;
      if (!best || w * h > (best[0] as HTMLElement).offsetWidth * (best[0] as HTMLElement).offsetHeight) best = kids;
    }
    return best ? { how: "same-size pages", slides: best } : null;
  };
  const found = findSlides();
  if (!found) return null;
  const slides = found.slides.slice(0, opts.maxSlides);
  const slideSet = new Set(slides);

  // ------------------------------------------------------------ scripts and what they touch
  interface Script { el: HTMLScriptElement; inline: boolean; refs: Set<Element>; deck: boolean; dynamic: boolean }
  const scripts: Script[] = [];
  for (const el of Array.from(document.querySelectorAll("script"))) {
    const type = (el.getAttribute("type") ?? "").trim().toLowerCase();
    if (type && !["module", "text/javascript", "application/javascript", "text/babel"].includes(type)) continue;
    if (el.id === "sp-freeze") continue;
    const refs = new Set<Element>();
    const text = el.src ? "" : (el.textContent ?? "");
    for (const m of text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      const lit = m[2]!.trim();
      if (!lit || lit.length > 200 || lit.includes("${")) continue;
      const add = (list: ArrayLike<Element>) => {
        for (const e of Array.from(list)) refs.add(e);
      };
      try {
        if (/^[#.[][^\s]/.test(lit) || /^[a-z][\w-]*[#.[]/i.test(lit)) add(document.querySelectorAll(lit));
        else if (/^[\w-]+$/.test(lit)) {
          const byId = document.getElementById(lit);
          if (byId) refs.add(byId);
          if (INTERACTIVE.has(lit.toUpperCase()) || lit === "svg" || (lit.includes("-") && customElements.get(lit))) add(document.querySelectorAll(lit));
        }
      } catch {
        /* not a selector */
      }
    }
    const deck = [...refs].some((r) => slides.some((s) => r === s || r.contains(s))) || refs.has(document.body) || refs.has(document.documentElement);
    scripts.push({ el, inline: !el.src, refs, deck, dynamic: /addEventListener|onclick|onkey|requestAnimationFrame|setInterval|setTimeout|getContext|\.on\w+\s*=/.test(text) });
  }
  const pageScriptsIn = (root: Element): Script[] => scripts.filter((s) => s.inline && !s.deck && [...s.refs].some((r) => root.contains(r) || r.contains(root)));

  // Scripted widgets: what an interactive script touches on a slide stays live together, as one piece.
  const live = new Map<Element, string>();
  for (const s of scripts) {
    if (s.deck || !s.inline) continue;
    for (const slide of slides) {
      const refs = [...s.refs].filter((r) => r !== slide && slide.contains(r));
      if (!refs.length || !(s.dynamic || refs.some((r) => INTERACTIVE.has(r.tagName)))) continue;
      let root: Element = refs[0]!;
      for (const r of refs.slice(1)) while (!root.contains(r)) root = root.parentElement!;
      for (const r of root === slide ? refs : [root]) if (!live.has(r)) live.set(r, "a scripted widget");
    }
  }
  // Endless CSS animations keep moving only as HTML; read them before animations are frozen below.
  for (const slide of slides)
    for (const el of Array.from(slide.querySelectorAll("*"))) {
      const s = cs(el);
      if (s.animationName !== "none" && s.animationIterationCount.split(",").some((c) => c.trim() === "infinite")) live.set(el, live.get(el) ?? "a looping animation");
    }

  // ------------------------------------------------------------ page CSS, for what stays HTML
  interface Sheet { imports: string[]; rules: CSSRule[] }
  const sheet: Sheet = { imports: [], rules: [] };
  const allSheets = [...Array.from(document.styleSheets), ...((document as unknown as { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? [])];
  for (const s of allSheets) {
    if ((s.ownerNode as Element | null)?.id === "sp-freeze") continue;
    try {
      sheet.rules.push(...Array.from(s.cssRules));
    } catch {
      if (s.href) sheet.imports.push(`@import url(${JSON.stringify(s.href)});`);
    }
  }
  const customProps = [...new Set(sheet.rules.map((r) => r.cssText).join("\n").match(/--[\w-]+(?=\s*:)/g) ?? [])];
  const STRIP_PSEUDO = /::?(?:before|after|hover|focus|focus-visible|focus-within|active|visited|link|placeholder|selection|first-letter|first-line|marker|disabled|enabled|checked|backdrop|-webkit-[\w-]+|-moz-[\w-]+)(?![\w-])/g;
  // Chrome writes a shorthand holding var() (border: 2px solid var(--c)) as empty longhands. Those are filled in with
  // what they came to on an element the rule styles.
  const ruleText = (r: CSSStyleRule, match: Element | null): string => {
    const text = r.cssText;
    if (!/:\s*;/.test(text)) return text;
    const st = r.style;
    const pseudo = /::?(before|after)\b/.exec(r.selectorText)?.[0];
    const computed = match ? cs(match, pseudo) : null;
    const decls: string[] = [];
    for (let i = 0; i < st.length; i++) {
      const name = st.item(i);
      const v = st.getPropertyValue(name) || computed?.getPropertyValue(name) || "";
      if (v) decls.push(`${name}:${v}${st.getPropertyPriority(name) ? "!important" : ""}`);
    }
    return `${r.selectorText}{${decls.join(";")}}`;
  };
  const cssFor = (root: Element, chain: Element[]): string => {
    // the first element of the island (or a stand-in ancestor) a selector styles; `true` when it can't be told
    const hit = (sel: string): Element | true | null => {
      const s = sel.replace(STRIP_PSEUDO, "").trim() || "*";
      try {
        return root.matches(s) ? root : (root.querySelector(s) ?? chain.find((a) => a.matches(s)) ?? null);
      } catch {
        return true;
      }
    };
    const keep = (rules: CSSRule[]): string[] => {
      const out: string[] = [];
      for (const r of rules) {
        if (r instanceof CSSStyleRule) {
          const m = hit(r.selectorText);
          if (m) out.push(ruleText(r, m === true ? null : m));
        } else if (r instanceof CSSMediaRule || r instanceof CSSSupportsRule) {
          const inner = keep(Array.from(r.cssRules));
          if (inner.length) out.push(`@${r instanceof CSSMediaRule ? "media" : "supports"} ${r.conditionText}{${inner.join("\n")}}`);
        } else if (!(r instanceof CSSImportRule)) out.push(r.cssText);
        else out.push(r.cssText);
      }
      return out;
    };
    const imports = keep(sheet.rules.filter((r) => r instanceof CSSImportRule));
    return [...sheet.imports, ...imports, ...keep(sheet.rules.filter((r) => !(r instanceof CSSImportRule)))].join("\n");
  };

  // ------------------------------------------------------------ making every slide laid out and visible
  const ON = /^(active|is-active|present|current|is-current|visible|is-visible|show|shown|in-view|selected|slide--active|slide-active)$/i;
  const OFF = /^(past|future|hidden|is-hidden|inactive|offscreen|stack)$/i;
  const onAttrs: string[] = [];
  const onClasses: string[] = [];
  {
    const shown = slides.find((s) => rendered(s));
    if (shown) {
      for (const c of Array.from(shown.classList)) if (ON.test(c) && !slides.some((o) => o !== shown && o.classList.contains(c))) onClasses.push(c);
      for (const a of Array.from(shown.attributes))
        if (/active|current|present|visible|selected|shown/i.test(a.name) && !slides.some((o) => o !== shown && o.hasAttribute(a.name))) onAttrs.push(a.name, a.value);
    }
  }
  const force = (el: HTMLElement | SVGElement, prop: string, val: string) => el.style.setProperty(prop, val, "important");
  const prepare = (slide: Element) => {
    slide.removeAttribute("hidden");
    slide.removeAttribute("aria-hidden");
    for (const c of Array.from(slide.classList)) if (OFF.test(c)) slide.classList.remove(c);
    for (const c of onClasses) slide.classList.add(c);
    for (let i = 0; i < onAttrs.length; i += 2) slide.setAttribute(onAttrs[i]!, onAttrs[i + 1]!);
    if (found.how === "reveal") for (const f of Array.from(slide.querySelectorAll(".fragment"))) f.classList.add("visible");
    for (let el: Element | null = slide; el && el !== document.documentElement; el = el.parentElement) {
      if (!(el instanceof HTMLElement)) continue;
      const s = cs(el);
      if (s.display === "none") {
        const sib = Array.from(el.parentElement?.children ?? []).find((o) => o !== el && o.tagName === el!.tagName && cs(o).display !== "none");
        force(el, "display", sib ? cs(sib).display : "block");
      }
      if (s.visibility !== "visible") force(el, "visibility", "visible");
      if (s.opacity !== "1") force(el, "opacity", "1");
    }
  };
  // freeze animations and transitions at their end so what's measured is what the slide settles on
  const freeze = document.createElement("style");
  freeze.id = "sp-freeze";
  freeze.textContent = "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important}";
  document.head.appendChild(freeze);
  for (const s of slides) prepare(s);
  await Promise.race([
    (async () => {
      await document.fonts.ready;
      const imgs = slides.flatMap((s) => Array.from(s.querySelectorAll("img"))).filter((i) => !i.complete);
      for (const i of imgs) i.loading = "eager";
      await Promise.all(imgs.map((i) => new Promise((r) => { i.addEventListener("load", r); i.addEventListener("error", r); })));
    })(),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // ------------------------------------------------------------ notes
  let globalNotes: unknown[] = [];
  try {
    const j = document.querySelector('script#speaker-notes, script[type="application/json"][data-speaker-notes], script[type="application/json"]#notes');
    if (j) {
      const v = JSON.parse(j.textContent ?? "null");
      globalNotes = Array.isArray(v) ? v : Array.isArray(v?.notes) ? v.notes : [];
    }
  } catch {
    globalNotes = [];
  }
  const textOfNotes = (el: Element): string => {
    const parts: string[] = [];
    const walk = (n: Node) => {
      if (n.nodeType === 3) parts.push((n as Text).data.replace(/\s+/g, " "));
      else if (n instanceof Element) {
        const block = /^(P|DIV|LI|H[1-6]|BR|UL|OL|SECTION|BLOCKQUOTE)$/.test(n.tagName);
        if (block) parts.push("\n");
        n.childNodes.forEach(walk);
        if (block) parts.push("\n");
      }
    };
    walk(el);
    return parts.join("").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  };

  // ------------------------------------------------------------ measuring one slide
  const out: PageSlide[] = [];
  const blobs: Array<{ item: { src: string } ; url: string }> = [];
  for (const [si, slide] of slides.entries()) {
    prepare(slide); // again: a deck's own script may have hidden it while fonts loaded
    const S = slide.getBoundingClientRect();
    const lw = (slide as HTMLElement).offsetWidth || S.width;
    const lh = (slide as HTMLElement).offsetHeight || S.height;
    const items: PageItem[] = [];
    const notesParts: string[] = [];
    const g = globalNotes[si];
    if (typeof g === "string") notesParts.push(g);
    else if (g && typeof (g as { text?: unknown }).text === "string") notesParts.push((g as { text: string }).text);
    if (slide.getAttribute("data-notes")) notesParts.push(slide.getAttribute("data-notes")!);
    for (const n of Array.from(slide.querySelectorAll(NOTES_SEL))) notesParts.push(n.getAttribute("data-speaker-notes") || textOfNotes(n));
    if (!S.width || !S.height) {
      out.push({ width: lw, height: lh, background: {}, items, notes: notesParts.join("\n\n") });
      continue;
    }
    const sc = W / S.width; // deck px per screen px
    const D = (r: { left: number; top: number; width: number; height: number }) => ({ x: r2((r.left - S.left) * sc), y: r2((r.top - S.top) * sc), w: r2(r.width * sc), h: r2(r.height * sc) });
    // deck px per CSS px of an element's own layout: the slide's scale times every scale between it and the slide
    const kOf = (el: Element): number => {
      let k = (S.width / lw) * sc;
      for (let e: Element | null = el; e && e !== slide; e = e.parentElement) {
        const t = cs(e).transform;
        if (t && t !== "none") {
          const m = new DOMMatrix(t);
          k *= Math.hypot(m.a, m.b);
        }
      }
      return k;
    };
    const zOf = (el: Element): number => {
      for (let e: Element | null = el; e && e !== slide; e = e.parentElement) {
        const s = cs(e);
        if (s.position !== "static" && s.zIndex !== "auto") return Number(s.zIndex) || 0;
      }
      return 0;
    };
    const linkOf = (el: Element): string | undefined => {
      const a = el.closest("a[href]") as HTMLAnchorElement | null;
      return a && slide.contains(a) && /^(https?:|mailto:|tel:)/i.test(a.href) ? a.href : undefined;
    };
    interface Ctx { opacity: number; frag?: number }
    const push = (item: PageItem, el: Element, ctx: Ctx) => {
      if (item.w <= 0.5 && item.h <= 0.5 && item.t !== "shape") return;
      if (item.x > W || item.y > (W * lh) / lw || item.x + item.w < 0 || item.y + item.h < 0) return;
      if (ctx.opacity < 0.999) item.opacity = r2(ctx.opacity * (item.opacity ?? 1));
      if (ctx.frag !== undefined) item.frag = ctx.frag;
      item.z = zOf(el);
      items.push(item);
    };

    // ---- what stays HTML: the element, its CSS (selectors still match through stand-ins for its ancestors), its scripts
    const liveOf = (el: Element, why: string, boxOnly: boolean): PageLive & { x: number; y: number; w: number; h: number } => {
      const s = cs(el);
      const R = el.getBoundingClientRect();
      const m = new DOMMatrix(s.transform === "none" ? undefined : s.transform);
      const rotated = Math.abs(m.b) > 1e-3 || Math.abs(m.c) > 1e-3;
      const k = kOf(rotated || !(el instanceof HTMLElement) ? el.parentElement ?? el : el);
      const ow = el instanceof HTMLElement ? el.offsetWidth : (R.width * sc) / k;
      const oh = el instanceof HTMLElement ? el.offsetHeight : (R.height * sc) / k;
      const bw = (R.width * sc) / k; // the bounding box, in the element's CSS px
      const bh = (R.height * sc) / k;
      let pad = 0;
      if (s.boxShadow !== "none") for (const sh of s.boxShadow.split(/,(?![^(]*\))/)) {
        const nums = (sh.match(/-?[\d.]+px/g) ?? []).map(parseFloat);
        pad = Math.max(pad, Math.abs(nums[0] ?? 0) + Math.abs(nums[1] ?? 0) + (nums[2] ?? 0) + Math.max(0, nums[3] ?? 0));
      }
      pad = Math.ceil(pad);
      const clone = el.cloneNode(!boxOnly) as Element;
      for (const e of [clone, ...Array.from(clone.querySelectorAll("[data-sp-x]"))]) e.removeAttribute("data-sp-x");
      const rootCss: Array<[string, string]> = [
        ["position", "absolute"], ["left", `${r2(pad + (bw - ow) / 2)}px`], ["top", `${r2(pad + (bh - oh) / 2)}px`], ["right", "auto"], ["bottom", "auto"], ["margin", "0"],
        ["width", `${r2(ow)}px`], ["height", `${r2(oh)}px`], ["min-width", "0"], ["min-height", "0"], ["max-width", "none"], ["max-height", "none"], ["box-sizing", "border-box"],
      ];
      // its own scale and offset are in k and the box already; turning stays; an animation keeps its transforms
      if (s.animationName === "none") rootCss.push(["transform", rotated ? `matrix(${m.a},${m.b},${m.c},${m.d},0,0)` : "none"], ["transform-origin", "50% 50%"], ["translate", "none"], ["scale", "none"], ["rotate", "none"]);
      // inherited text styles and custom properties come from ancestors the island doesn't have
      for (const p of ["font-family", "font-size", "font-weight", "font-style", "color", "line-height", "letter-spacing", "word-spacing", "text-align", "text-transform", "white-space", "direction", "font-feature-settings", "font-variation-settings", "-webkit-font-smoothing"]) rootCss.push([p, s.getPropertyValue(p)]);
      for (const p of customProps) {
        const v = s.getPropertyValue(p);
        if (v) rootCss.push([p, v.trim()]);
      }
      if (boxOnly) {
        for (const p of ["background-color", "background-image", "background-size", "background-position", "background-repeat", "background-origin", "background-clip", "border-top", "border-right", "border-bottom", "border-left",
          "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius", "box-shadow", "filter", "backdrop-filter", "clip-path", "mask-image", "-webkit-mask-image", "mask-size", "-webkit-mask-size", "mask-position", "-webkit-mask-position", "mask-repeat", "-webkit-mask-repeat"])
          rootCss.push([p, s.getPropertyValue(p)]);
      }
      if (el instanceof HTMLCanvasElement && !pageScriptsIn(el).length) {
        // drawn by code the island won't have: keep what it showed
        try {
          rootCss.push(["background", `url(${el.toDataURL()}) center / 100% 100% no-repeat`]);
        } catch {
          /* tainted canvas */
        }
      }
      const style = (e: Element, list: Array<[string, string]>) => {
        const st = (e as HTMLElement).style;
        for (const [p, v] of list) if (v) st.setProperty(p, v, "important");
      };
      style(clone, rootCss);
      clone.setAttribute("data-sp-root", "");
      // <use href="#id"> points at drawings elsewhere in the page
      const defs: string[] = [];
      for (const u of Array.from(clone.querySelectorAll("use"))) {
        const ref = u.getAttribute("href") ?? u.getAttribute("xlink:href") ?? "";
        const target = ref.startsWith("#") ? document.getElementById(ref.slice(1)) : null;
        if (target && !el.contains(target)) defs.push(target.outerHTML);
      }
      // stand-ins for the ancestors (tag, id, class only), flattened so they add no layout of their own
      const chain: Element[] = [];
      for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) chain.push(a);
      let html = clone.outerHTML;
      for (const a of chain) {
        const tag = a.tagName.includes("-") || a.namespaceURI !== "http://www.w3.org/1999/xhtml" ? "div" : a.tagName.toLowerCase();
        const attrs = [a.id ? ` id="${a.id.replace(/"/g, "&quot;")}"` : "", a.getAttribute("class") ? ` class="${a.getAttribute("class")!.replace(/"/g, "&quot;")}"` : ""].join("");
        const flat = "display:block!important;position:static!important;margin:0!important;padding:0!important;border:0!important;width:auto!important;height:auto!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;background:none!important;box-shadow:none!important;transform:none!important;filter:none!important;opacity:1!important;visibility:visible!important;overflow:visible!important;clip-path:none!important;contain:none!important;animation:none!important";
        html = `<${tag}${attrs} data-sp-anc style="${flat}">${html}</${tag}>`;
      }
      const scale = `<div data-sp-scale style="position:absolute;left:0;top:0;width:${r2(bw + 2 * pad)}px;height:${r2(bh + 2 * pad)}px;transform:scale(${k});transform-origin:0 0">`;
      html = `${scale}${html}</div>`;
      if (defs.length) html += `<svg style="display:none" aria-hidden="true">${defs.join("")}</svg>`;
      let css = "html,body{margin:0!important;padding:0!important;background:transparent!important;border:0!important;overflow:hidden!important;transform:none!important;display:block!important}\n[data-sp-anc]::before,[data-sp-anc]::after{display:none!important}";
      let js = "";
      if (!boxOnly) {
        css = `${cssFor(el, [document.documentElement, document.body, ...chain])}\n${css}`;
        let own = pageScriptsIn(el);
        const needsAll = !own.length && (el instanceof HTMLCanvasElement ? false : el.tagName.includes("-") || el.querySelector("canvas") !== null);
        if (needsAll) own = scripts.filter((x) => x.inline && !x.deck);
        if (own.length) {
          // libraries from the page first, then the widget's own code, each in its own <script> so one failing doesn't stop the rest
          const shim = "<script>try{localStorage.length}catch(e){var m={};var s={getItem:function(k){return k in m?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}};try{Object.defineProperty(window,'localStorage',{value:s});Object.defineProperty(window,'sessionStorage',{value:s})}catch(e2){}}</script>";
          const tags = scripts.filter((x) => !x.inline || own.includes(x)).map((x) => {
            const type = x.el.getAttribute("type") === "module" ? ' type="module"' : "";
            return x.inline ? `<script${type}>${(x.el.textContent ?? "").replace(/<\/script/gi, "<\\/script")}</script>` : `<script${type} src="${x.el.src.replace(/"/g, "&quot;")}"></script>`;
          });
          html += shim + tags.join("");
        }
        const cls = (e: Element) => JSON.stringify(e.getAttribute("class") ?? "");
        if (document.documentElement.getAttribute("class") || document.body.getAttribute("class")) js = `document.documentElement.className=${cls(document.documentElement)};document.body.className=${cls(document.body)};`;
      }
      const box = D(R);
      return { html, css, js, why, x: r2(box.x - pad * k), y: r2(box.y - pad * k), w: r2(box.w + 2 * pad * k), h: r2(box.h + 2 * pad * k) };
    };

    // ---- why a part can't be native
    const whyLive = (el: Element, s: CSSStyleDeclaration): string | null => {
      const marked = live.get(el);
      if (marked) return marked;
      const t = el.tagName;
      if (t === "CANVAS") return "a canvas";
      if (el instanceof SVGElement) return "an SVG drawing";
      if (t === "IFRAME" || t === "OBJECT" || t === "EMBED") return "an embedded frame";
      if (t === "INPUT" || t === "SELECT" || t === "TEXTAREA" || t === "BUTTON") return "a form control";
      if (t === "MATH") return "a formula";
      if (t === "DETAILS" || t === "DIALOG") return "an interactive widget";
      if (t.includes("-") && !slideSet.has(el)) return `a custom element <${t.toLowerCase()}>`;
      if (Array.from(el.attributes).some((a) => /^on[a-z]+$/.test(a.name)) || el.hasAttribute("contenteditable")) return "a scripted widget";
      const m = new DOMMatrix(s.transform === "none" ? undefined : s.transform);
      if (Math.abs(m.b) > 1e-3 || Math.abs(m.c) > 1e-3 || s.rotate !== "none") return "a rotated part";
      if (/text/.test(s.getPropertyValue("-webkit-background-clip") || s.backgroundClip)) return "gradient text";
      if (s.writingMode !== "horizontal-tb") return "vertical text";
      const effects = s.filter !== "none" || s.mixBlendMode !== "normal" || s.clipPath !== "none" || (s.getPropertyValue("-webkit-mask-image") || "none") !== "none" || (s.getPropertyValue("mask-image") || "none") !== "none";
      if (effects && (el.children.length > 0 || t === "IMG" || Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim()))) return "a CSS effect (filter, mask or blend)";
      return null;
    };

    // ---- text
    const families = (s: CSSStyleDeclaration) => s.fontFamily.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
    const decoOf = (el: Element, block: Element) => {
      let u = false;
      let st = false;
      for (let a: Element | null = el; a; a = a.parentElement) {
        const l = cs(a).textDecorationLine;
        u ||= l.includes("underline");
        st ||= l.includes("line-through");
        if (a === block) break;
      }
      return { u, st };
    };
    const runStyle = (el: Element, s: CSSStyleDeclaration, block: Element, k: number): PageRun => {
      const run: PageRun = { text: "" };
      if ((parseInt(s.fontWeight, 10) || 400) >= 600) run.bold = true;
      if (s.fontStyle !== "normal") run.italic = true;
      const { u, st } = decoOf(el, block);
      if (u) run.underline = true;
      if (st) run.strike = true;
      const fill = hex(s.getPropertyValue("-webkit-text-fill-color"));
      const c = fill ?? hex(s.color);
      if (c) run.color = c;
      run.size = r2(parseFloat(s.fontSize) * k);
      const f = families(s);
      if (f) run.font = f;
      for (let a: Element | null = el; a && a !== block; a = a.parentElement) {
        const as = cs(a);
        if (as.display !== "inline") break;
        const bg = hex(as.backgroundColor);
        if (bg) {
          run.highlight = bg;
          break;
        }
      }
      const link = linkOf(el);
      if (link) run.link = link;
      return run;
    };
    const transform = (text: string, tt: string) =>
      tt === "uppercase" ? text.toUpperCase() : tt === "lowercase" ? text.toLowerCase() : tt === "capitalize" ? text.replace(/(^|[\s(“"'-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()) : text;
    // inline content -> one paragraph's runs, white space collapsed as CSS does
    const runsOf = (nodes: Node[], block: Element, k: number, withPseudo: { before: boolean; after: boolean }): PageRun[] => {
      const runs: PageRun[] = [];
      let space = true; // at a line start a collapsible space disappears
      const add = (raw: string, el: Element, s: CSSStyleDeclaration) => {
        let text = raw;
        const ws = s.whiteSpace;
        if (/^(pre|pre-wrap|break-spaces)$/.test(ws)) text = text.replace(/\r?\n/g, "\u2028");
        else if (ws === "pre-line") text = text.replace(/[ \t\f\r]+/g, " ").replace(/ ?\n ?/g, "\u2028");
        else text = text.replace(/[ \t\n\r\f]+/g, " ");
        if (space && text.startsWith(" ")) text = text.slice(1);
        if (!text) return;
        space = text.endsWith(" ") || text.endsWith("\u2028");
        runs.push({ ...runStyle(el, s, block, k), text: transform(text, s.textTransform) });
      };
      const pseudo = (el: Element, which: "::before" | "::after") => {
        const p = cs(el, which);
        const m = /^"((?:\\.|[^"\\])*)"$/.exec(p.content);
        if (!m || p.display === "none" || p.position === "absolute" || p.position === "fixed") return;
        add(m[1]!.replace(/\\(.)/g, "$1"), el, p);
      };
      const walk = (n: Node) => {
        if (n.nodeType === 3) {
          const pe = n.parentElement!;
          const s = cs(pe);
          if (s.visibility === "visible") add((n as Text).data, pe, s);
        } else if (n instanceof Element) {
          if (n.tagName === "BR") {
            runs.push({ ...runStyle(n.parentElement!, cs(n.parentElement!), block, k), text: "\u2028" });
            space = true;
            return;
          }
          if (SKIP.has(n.tagName) || cs(n).display === "none") return;
          pseudo(n, "::before");
          n.childNodes.forEach(walk);
          pseudo(n, "::after");
        }
      };
      if (withPseudo.before) pseudo(block, "::before");
      nodes.forEach(walk);
      if (withPseudo.after) pseudo(block, "::after");
      // trailing collapsible spaces go, and spaces next to a soft break
      for (let i = runs.length - 1; i >= 0; i--) {
        runs[i]!.text = runs[i]!.text.replace(/ +$/, "");
        if (runs[i]!.text) break;
      }
      for (const r of runs) r.text = r.text.replace(/ +\u2028/g, "\u2028").replace(/\u2028 +/g, "\u2028");
      return runs.filter((r) => r.text);
    };
    const paraOf = (block: Element, runs: PageRun[]): PagePara => {
      const s = cs(block);
      const p: PagePara = { runs };
      const ta = s.textAlign;
      if (ta === "center" || ta === "-webkit-center") p.align = "center";
      else if (ta === "right" || ta === "-webkit-right" || (ta === "end" && s.direction === "ltr")) p.align = "right";
      else if (ta === "justify") p.align = "justify";
      p.lineHeight = r2(lineHeightOf(block) / (parseFloat(s.fontSize) || 16));
      return p;
    };
    // a block's line height in CSS px ("normal" measured from a probe in its font)
    const lineHeights = new Map<string, number>();
    const lineHeightOf = (el: Element): number => {
      const s = cs(el);
      if (s.lineHeight !== "normal") return parseFloat(s.lineHeight);
      const key = `${s.fontFamily}|${s.fontSize}|${s.fontWeight}|${s.fontStyle}`;
      if (!lineHeights.has(key)) {
        const probe = document.createElement("span");
        probe.textContent = "Hg";
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;line-height:normal;font-family:${s.fontFamily};font-size:${s.fontSize};font-weight:${s.fontWeight};font-style:${s.fontStyle}`;
        document.body.appendChild(probe);
        lineHeights.set(key, probe.getBoundingClientRect().height || parseFloat(s.fontSize) * 1.2);
        probe.remove();
      }
      return lineHeights.get(key)!;
    };
    // how many lines some text rects sit on
    const lineCount = (rects: DOMRect[], lh: number): number => {
      const mids = rects.map((r) => r.top + r.height / 2).sort((a, b) => a - b);
      return mids.filter((m, i) => i === 0 || m - mids[i - 1]! > lh * 0.5).length;
    };
    const rectsOf = (nodes: Node[]): DOMRect[] => {
      const range = document.createRange();
      range.setStartBefore(nodes[0]!);
      range.setEndAfter(nodes[nodes.length - 1]!);
      return Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    };
    // Present draws text in a box whose own font size is the body size (cells: the table size), so a paragraph's
    // unitless line height also sizes that box's empty "strut". Line heights are given against the larger of the two,
    // and the baseline the strut pushes down is returned (deck px) to lift the element by. `gapped`: list items after
    // the first that Present spaces by .3em, taken out of their line height so the list keeps its length.
    const fit = (paras: PagePara[], block: Element, base: number, gapped: boolean[] = []): number => {
      const s = cs(block);
      const fs = (parseFloat(s.fontSize) || 16) * kOf(block);
      let shift = 0;
      for (const [i, p] of paras.entries()) {
        const sizes = p.runs.map((r) => r.size ?? fs);
        const lh = (p.lineHeight ?? 1.2) * fs;
        const big = Math.max(base, ...sizes);
        p.lineHeight = r2(Math.max(0.5, (lh - (gapped[i] ? 0.3 * base : 0)) / big));
        if (i === 0 && big === base) {
          c2.font = `${s.fontStyle} ${s.fontWeight} 100px ${s.fontFamily}`;
          const m = c2.measureText("Hg");
          shift = -((base - Math.max(...sizes, 1)) * ((m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 100)) / 2;
        }
      }
      return r2(shift);
    };
    // the box a text element needs: the block's content box across, the lines down (half-leading added back)
    const textBox = (block: Element, rects: DOMRect[], paras: PagePara[]) => {
      const s = cs(block);
      const B = block.getBoundingClientRect();
      const f = kOf(block) / sc; // screen px per CSS px
      const cl = B.left + (parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft)) * f;
      const cr = B.right - (parseFloat(s.borderRightWidth) + parseFloat(s.paddingRight)) * f;
      const minL = Math.min(...rects.map((r) => r.left));
      const maxR = Math.max(...rects.map((r) => r.right));
      const lh = lineHeightOf(block) * f;
      const top = Math.min(...rects.map((r) => r.top - (lh - r.height) / 2));
      const bottom = Math.max(...rects.map((r) => r.bottom + (lh - r.height) / 2));
      const lines = lineCount(rects, lh);
      const fontPx = Math.max(...paras.flatMap((p) => p.runs.map((r) => r.size ?? 0)), 1) / sc;
      // one line gets room to spare, so a slightly wider font elsewhere doesn't wrap it
      const slack = lines <= 1 && s.whiteSpace !== "normal" ? fontPx : lines <= 1 ? Math.max(fontPx * 0.6, (maxR - minL) * 0.06) : 1;
      const align = paras[0]?.align;
      let left: number;
      let right: number;
      if (align === "center") {
        const mid = cl + (cr - cl) / 2;
        const half = Math.max(cr - cl, maxR - minL) / 2 + slack / 2;
        left = mid - half;
        right = mid + half;
      } else if (align === "right") {
        right = Math.max(cr, maxR);
        left = Math.min(cl, minL) - slack;
      } else {
        left = Math.min(minL, Math.max(cl, minL - 1));
        right = Math.max(cr, maxR) + slack;
      }
      return D({ left, top, width: right - left, height: bottom - top });
    };
    const isInlineFlow = (n: Node): boolean => {
      if (n.nodeType === 3) return true;
      if (!(n instanceof Element) || SKIP.has(n.tagName)) return n.nodeType !== 1 || SKIP.has((n as Element).tagName);
      if (n.tagName === "BR") return true;
      if (ATOMIC.has(n.tagName) || n instanceof SVGElement || n.matches(NOTES_SEL)) return false;
      const s = cs(n);
      if (s.display === "none") return true;
      if (s.display !== "inline" || s.position === "absolute" || s.position === "fixed" || s.float !== "none") return false;
      if (whyLive(n, s)) return false;
      return Array.from(n.childNodes).every(isInlineFlow);
    };
    const hasText = (nodes: Node[]) =>
      nodes.some((n) => (n.nodeType === 3 && /\S/.test((n as Text).data)) || (n instanceof HTMLElement && !SKIP.has(n.tagName) && (n.tagName === "BR" || /\S/.test(n.innerText ?? ""))));

    const textItem = (block: Element, nodes: Node[], ctx: Ctx, whole: boolean) => {
      if (!hasText(nodes)) return;
      const rects = rectsOf(nodes);
      if (!rects.length) return;
      const runs = runsOf(nodes, block, kOf(block), { before: whole, after: whole });
      if (!runs.length) return;
      const paras = [paraOf(block, runs)];
      const box = textBox(block, rects, paras);
      box.y = r2(box.y + fit(paras, block, opts.bodySize));
      push({ t: "text", ...box, z: 0, paras }, block, ctx);
    };

    // ---- lists: one text element with a paragraph per item
    const listStyle = (li: Element): "bullet" | "ordered" | undefined => {
      const t = cs(li).listStyleType;
      if (t === "none" || cs(li).display !== "list-item") return undefined;
      return /disc|circle|square|"/.test(t) ? "bullet" : "ordered";
    };
    const simpleList = (list: Element): boolean =>
      Array.from(list.children).every((li) => {
        if (li.tagName !== "LI") return false;
        const s = cs(li);
        if (s.display === "none") return true;
        if (hex(s.backgroundColor) || s.backgroundImage !== "none" || parseFloat(s.borderTopWidth) || parseFloat(s.borderBottomWidth) || parseFloat(s.borderLeftWidth)) return false;
        return Array.from(li.childNodes).every((c) => isInlineFlow(c) || (c instanceof Element && /^(UL|OL)$/.test(c.tagName) && simpleList(c)) || (c instanceof Element && c.tagName === "P" && Array.from(c.childNodes).every(isInlineFlow)));
      });
    const listItem = (list: Element, ctx: Ctx) => {
      const paras: PagePara[] = [];
      const rects: DOMRect[] = [];
      const gapped: boolean[] = [];
      let firstLi: Element | null = null;
      const visit = (l: Element, depth: number) => {
        for (const li of Array.from(l.children)) {
          if (cs(li).display === "none") continue;
          const inline = Array.from(li.childNodes).filter((c) => !(c instanceof Element && /^(UL|OL)$/.test(c.tagName)));
          const flat = inline.flatMap((c) => (c instanceof Element && c.tagName === "P" ? [...Array.from(c.childNodes), document.createTextNode(" ")] : [c]));
          if (hasText(inline)) {
            firstLi ??= li;
            const p = paraOf(li, runsOf(flat, li, kOf(li), { before: listStyle(li) === undefined, after: false }));
            const kind = listStyle(li);
            if (kind) p.list = kind;
            if (depth) p.indent = depth;
            const own = rectsOf(inline);
            const lh = lineHeightOf(li) * (kOf(li) / sc);
            gapped.push(!!kind && !!paras[paras.length - 1]?.list && lineCount(own, lh) <= 1);
            paras.push(p);
            rects.push(...own);
          }
          for (const c of Array.from(li.children)) if (/^(UL|OL)$/.test(c.tagName)) visit(c, depth + 1);
        }
      };
      visit(list, 0);
      if (!paras.length || !rects.length || !firstLi) return;
      const box = textBox(firstLi, rects, paras);
      box.y = r2(box.y + fit(paras, firstLi, opts.bodySize, gapped));
      // the renderer puts the marker in a gutter of 1.1em before the text
      if (paras[0]!.list) {
        const gutter = 1.1 * (paras[0]!.runs[0]?.size ?? 44);
        const li = (firstLi as Element).getBoundingClientRect();
        const contentLeft = D({ left: li.left + parseFloat(cs(firstLi).paddingLeft) * (kOf(firstLi) / sc), top: li.top, width: 0, height: 0 }).x;
        box.w = r2(box.x + box.w - (contentLeft - gutter));
        box.x = r2(contentLeft - gutter);
      }
      push({ t: "text", ...box, z: 0, paras }, list, ctx);
    };

    // ---- tables
    const parasOf = (container: Element): PagePara[] => {
      const out: PagePara[] = [];
      let group: Node[] = [];
      const flush = (block: Element, whole: boolean) => {
        if (hasText(group)) {
          const runs = runsOf(group, block, kOf(block), { before: whole, after: whole });
          if (runs.length) out.push(paraOf(block, runs));
        }
        group = [];
      };
      const kids = Array.from(container.childNodes);
      for (const c of kids) {
        if (isInlineFlow(c)) group.push(c);
        else if (c instanceof Element) {
          flush(container, false);
          if (cs(c).display !== "none") out.push(...parasOf(c));
        }
      }
      flush(container, out.length === 0);
      return out;
    };
    const tableItem = (table: HTMLTableElement, ctx: Ctx): boolean => {
      if (table.querySelector("img, svg, canvas, video, iframe, input, button, select, textarea, table")) return false;
      const rows = Array.from(table.rows).filter((r) => cs(r).display !== "none");
      if (!rows.length) return false;
      const grid: Array<Array<{ paras: PagePara[]; fill?: string }>> = [];
      let cols = 0;
      let widthRow: HTMLTableRowElement | null = null;
      for (const tr of rows) {
        const row: Array<{ paras: PagePara[]; fill?: string }> = [];
        const rowFill = hex(cs(tr).backgroundColor) ?? hex(cs(tr.parentElement!).backgroundColor) ?? undefined;
        for (const td of Array.from(tr.cells)) {
          const fill = hex(cs(td).backgroundColor) ?? rowFill;
          const paras = parasOf(td);
          fit(paras, td, opts.tableSize);
          row.push({ paras, ...(fill ? { fill } : {}) });
          for (let i = 1; i < td.colSpan; i++) row.push({ paras: [], ...(fill ? { fill } : {}) });
        }
        if (!widthRow && Array.from(tr.cells).every((c) => c.colSpan === 1) && tr.cells.length === row.length) widthRow = tr;
        cols = Math.max(cols, row.length);
        grid.push(row);
      }
      if (cols > 100 || grid.length > 100) return false;
      for (const row of grid) while (row.length < cols) row.push({ paras: [] });
      const R = D(table.getBoundingClientRect());
      const colWidths = widthRow && widthRow.cells.length === cols ? Array.from(widthRow.cells).map((c) => r2(c.getBoundingClientRect().width * sc)) : Array(cols).fill(r2(R.w / cols));
      const rowHeights = rows.map((r) => r2(r.getBoundingClientRect().height * sc));
      const first = rows[0]!.cells[0];
      const fs = first ? cs(first) : null;
      const bw = fs && fs.borderTopStyle !== "none" ? parseFloat(fs.borderBottomWidth) || parseFloat(fs.borderTopWidth) : 0;
      const stroke = fs ? hex(bw ? (parseFloat(fs.borderBottomWidth) ? fs.borderBottomColor : fs.borderTopColor) : "") : null;
      const head = rows[0]!.parentElement?.tagName === "THEAD" || Array.from(rows[0]!.cells).every((c) => c.tagName === "TH");
      const headerRow = head && grid[0]!.every((c) => c.fill);
      const fill = hex(cs(table).backgroundColor);
      push({ t: "table", ...R, z: 0, rows: grid.length, cols, colWidths, rowHeights, cells: grid, headerRow, ...(fill ? { fill } : {}), ...(stroke && bw ? { stroke } : {}), strokeWidth: stroke && bw ? r2(bw * kOf(table)) : 0 }, table, ctx);
      return true;
    };

    // ---- boxes: fill, border, radius, background picture
    const urlOf = (bg: string): string | null => {
      const m = /^url\("?(.*?)"?\)$/.exec(bg.trim());
      return m ? m[1]! : null;
    };
    const boxItems = (el: Element, s: CSSStyleDeclaration, ctx: Ctx, skipFill: boolean) => {
      const R = el.getBoundingClientRect();
      if (R.width < 0.5 || R.height < 0.5) return;
      const k = kOf(el);
      const box = D(R);
      const fill = skipFill ? null : hex(s.backgroundColor);
      const sides = (["Top", "Right", "Bottom", "Left"] as const).map((side) => {
        const w = parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`)) || 0;
        const st = s.getPropertyValue(`border-${side.toLowerCase()}-style`);
        const c = hex(s.getPropertyValue(`border-${side.toLowerCase()}-color`));
        return { w: w && st !== "none" && st !== "hidden" && c ? w : 0, st, c };
      });
      const radii = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius];
      const bgImg = skipFill ? "none" : s.backgroundImage;
      const shadow = s.boxShadow !== "none" && !/inset/.test(s.boxShadow);
      const anySide = sides.some((x) => x.w);
      const effects = s.filter !== "none" || s.getPropertyValue("backdrop-filter") !== "none" || s.clipPath !== "none" || /inset/.test(s.boxShadow) || (s.getPropertyValue("-webkit-mask-image") || "none") !== "none";
      if (!fill && bgImg === "none" && !anySide && !effects) return;
      const url = bgImg !== "none" ? urlOf(bgImg) : null;
      const complex = effects || (bgImg !== "none" && (!url || !/^(cover|contain|100% 100%)$/.test(s.backgroundSize))) || new Set(radii).size > 1 || / /.test(radii[0]!) || sides.some((x) => x.w && x.st !== "solid");
      if (complex) {
        const l = liveOf(el, bgImg !== "none" && !url ? "a gradient or patterned background" : "a CSS effect", true);
        push({ t: "html", ...l, z: 0 }, el, ctx);
        return;
      }
      const rad = radii[0]!.endsWith("%") ? (parseFloat(radii[0]!) / 100) * Math.min(box.w, box.h) : (parseFloat(radii[0]!) || 0) * k;
      const round = Math.abs(box.w - box.h) < 1.5 && rad >= box.w / 2 - 0.5;
      const uniform = anySide && sides.every((x) => x.w === sides[0]!.w && x.c === sides[0]!.c);
      if (fill || uniform) {
        const sw = uniform ? sides[0]!.w * k : 0;
        // CSS borders sit inside the box; a shape's stroke is centred on its outline
        push({ t: "shape", shape: round ? "ellipse" : "rect", x: r2(box.x + sw / 2), y: r2(box.y + sw / 2), w: r2(box.w - sw), h: r2(box.h - sw), z: 0, ...(fill ? { fill } : {}), ...(uniform ? { stroke: sides[0]!.c!, strokeWidth: r2(sw) } : {}), ...(rad && !round ? { radius: r2(Math.min(rad, box.w / 2, box.h / 2)) } : {}), ...(shadow ? { shadow: true } : {}) }, el, ctx);
      }
      if (url) {
        const fit = s.backgroundSize === "contain" ? "contain" : s.backgroundSize === "cover" ? "cover" : "fill";
        const bl = sides[3]!.w * k;
        const bt = sides[0]!.w * k;
        push({ t: "image", x: r2(box.x + bl), y: r2(box.y + bt), w: r2(box.w - bl - sides[1]!.w * k), h: r2(box.h - bt - sides[2]!.w * k), z: 0, src: url, fit, alt: "", ...(rad ? { radius: r2(rad) } : {}) }, el, ctx);
      }
      if (anySide && !uniform) {
        for (const [i, x] of sides.entries()) {
          if (!x.w) continue;
          const t = x.w * k;
          const r = i === 0 ? { x: box.x, y: box.y, w: box.w, h: t } : i === 1 ? { x: box.x + box.w - t, y: box.y, w: t, h: box.h } : i === 2 ? { x: box.x, y: box.y + box.h - t, w: box.w, h: t } : { x: box.x, y: box.y, w: t, h: box.h };
          push({ t: "shape", shape: "rect", x: r2(r.x), y: r2(r.y), w: r2(r.w), h: r2(r.h), z: 0, fill: x.c! }, el, ctx);
        }
      }
    };

    // ---- images and media
    // where object-fit and object-position draw a picture inside its box (screen px)
    const drawnRect = (img: HTMLImageElement, s: CSSStyleDeclaration, R: DOMRect): DOMRect => {
      const nw = img.naturalWidth || R.width;
      const nh = img.naturalHeight || R.height;
      const fit = s.objectFit;
      let k = 1;
      if (fit === "cover") k = Math.max(R.width / nw, R.height / nh);
      else if (fit === "contain" || (fit === "scale-down" && (nw > R.width || nh > R.height))) k = Math.min(R.width / nw, R.height / nh);
      else if (fit === "fill") return R;
      else k = kOf(img) / sc;
      const dw = nw * k;
      const dh = nh * k;
      const [px, py] = s.objectPosition.split(" ");
      const at = (v: string | undefined, free: number) => (!v ? free / 2 : v.endsWith("%") ? (parseFloat(v) / 100) * free : parseFloat(v) * (kOf(img) / sc));
      return new DOMRect(R.left + at(px, R.width - dw), R.top + at(py, R.height - dh), dw, dh);
    };
    const imageItem = (img: HTMLImageElement, s: CSSStyleDeclaration, ctx: Ctx) => {
      let src = img.currentSrc || img.src;
      if (!src) return;
      const R = img.getBoundingClientRect();
      let fit: "cover" | "contain" | "fill" = s.objectFit === "cover" ? "cover" : s.objectFit === "fill" ? "fill" : "contain";
      let radius = s.borderTopLeftRadius.endsWith("%") ? (parseFloat(s.borderTopLeftRadius) / 100) * Math.min(img.offsetWidth, img.offsetHeight) : parseFloat(s.borderTopLeftRadius) || 0;
      // what frames around it (overflow hidden) let through
      let V = new DOMRect(R.left, R.top, R.width, R.height);
      for (let a = img.parentElement; a && a !== slide.parentElement; a = a.parentElement) {
        const as = cs(a);
        if (as.overflow !== "visible") {
          const F = a.getBoundingClientRect();
          if (F.left > V.left + 0.5 || F.top > V.top + 0.5 || F.right < V.right - 0.5 || F.bottom < V.bottom - 0.5) {
            const l = Math.max(F.left, V.left);
            const t = Math.max(F.top, V.top);
            V = new DOMRect(l, t, Math.max(0, Math.min(F.right, V.right) - l), Math.max(0, Math.min(F.bottom, V.bottom) - t));
            radius = Math.max(radius, (parseFloat(as.borderTopLeftRadius) || 0) * (kOf(a) / kOf(img)));
          }
        }
        if (a === slide) break;
      }
      const P = drawnRect(img, s, R);
      const cropped = V.width < R.width - 0.5 || V.height < R.height - 0.5;
      const shifted = s.objectFit === "cover" && s.objectPosition !== "50% 50%";
      let box = V;
      if ((cropped || shifted) && img.complete && img.naturalWidth) {
        // cut out exactly the part that shows
        const l = Math.max(V.left, P.left);
        const t = Math.max(V.top, P.top);
        const vis = new DOMRect(l, t, Math.max(0, Math.min(V.right, P.right) - l), Math.max(0, Math.min(V.bottom, P.bottom) - t));
        const kx = img.naturalWidth / P.width;
        const ky = img.naturalHeight / P.height;
        const out = document.createElement("canvas");
        const lim = Math.min(1, 4096 / Math.max(vis.width * kx, vis.height * ky));
        out.width = Math.max(1, Math.round(vis.width * kx * lim));
        out.height = Math.max(1, Math.round(vis.height * ky * lim));
        try {
          out.getContext("2d")!.drawImage(img, (vis.left - P.left) * kx, (vis.top - P.top) * ky, vis.width * kx, vis.height * ky, 0, 0, out.width, out.height);
          src = out.toDataURL("image/png");
          box = vis;
          fit = "fill";
        } catch {
          fit = "cover"; // a picture from another site can't be read back; the frame's middle is close
        }
      } else if (cropped) fit = "cover";
      const item = { t: "image" as const, ...D(box), z: 0, src, fit, alt: img.alt || "", ...(radius ? { radius: r2(radius * kOf(img)) } : {}) };
      if (src.startsWith("blob:")) blobs.push({ item, url: src });
      const link = linkOf(img);
      push(link ? { ...item, link } : item, img, ctx);
    };
    const mediaItem = (m: HTMLMediaElement, ctx: Ctx) => {
      const src = m.currentSrc || m.src || m.querySelector("source")?.src || "";
      const fallback = liveOf(m, m.tagName === "VIDEO" ? "a video player" : "an audio player", false);
      if (!src || !m.controls || !/^(https?:|data:)/.test(src)) {
        push({ t: "html", ...fallback, z: 0 }, m, ctx);
        return;
      }
      const poster = m instanceof HTMLVideoElement && m.poster ? m.poster : undefined;
      push({ t: "media", kind: m.tagName === "VIDEO" ? "video" : "audio", ...D(m.getBoundingClientRect()), z: 0, src, ...(poster ? { poster } : {}), autoplay: m.autoplay, loop: m.loop, muted: m.muted, fallback }, m, ctx);
    };

    // ---- the walk
    const walk = (el: Element, ctx0: Ctx) => {
      if (SKIP.has(el.tagName) || el.matches(NOTES_SEL)) return;
      const s = cs(el);
      if (s.display === "none") return;
      const op = ctx0.opacity * (parseFloat(s.opacity) || 0);
      if (op < 0.01) return;
      const ctx: Ctx = { opacity: el === slide ? 1 : op, frag: ctx0.frag };
      if (found.how === "reveal" && el.classList.contains("fragment")) ctx.frag = Number(el.getAttribute("data-fragment-index") ?? NaN);
      const shown = s.visibility === "visible";
      if (el !== slide && shown) {
        const why = whyLive(el, s);
        if (why) {
          const l = liveOf(el, why, false);
          push({ t: "html", ...l, z: 0 }, el, ctx);
          return;
        }
        if (el instanceof HTMLImageElement) return imageItem(el, s, ctx);
        if (el instanceof HTMLMediaElement) return mediaItem(el, ctx);
        if (el instanceof HTMLTableElement) {
          boxItems(el, s, ctx, true);
          if (tableItem(el, ctx)) return;
          const l = liveOf(el, "a complex table", false);
          push({ t: "html", ...l, z: 0 }, el, ctx);
          return;
        }
        boxItems(el, s, ctx, false);
        if ((el.tagName === "UL" || el.tagName === "OL") && simpleList(el)) return listItem(el, ctx);
      }
      // inline content between blocks makes text elements; blocks are walked
      let group: Node[] = [];
      let first = true;
      const kids = Array.from(el.childNodes);
      const flush = (last: boolean) => {
        if (group.length && shown) textItem(el, group, ctx, first && last);
        if (group.length) first = false;
        group = [];
      };
      for (const c of kids) {
        if (isInlineFlow(c)) group.push(c);
        else if (c instanceof Element) {
          flush(false);
          first = false;
          walk(c, ctx);
        }
      }
      flush(true);
    };

    // ---- background: the slide's own, or the page's behind it
    const background: PageSlide["background"] = {};
    const ss = cs(slide);
    for (let a: Element | null = slide; a; a = a.parentElement) {
      const c = hex(cs(a).backgroundColor);
      if (c) {
        background.color = c.length === 9 ? c.slice(0, 7) : c;
        break;
      }
    }
    const bgUrl = ss.backgroundImage !== "none" ? urlOf(ss.backgroundImage) : null;
    if (bgUrl && /^(cover|contain)$/.test(ss.backgroundSize)) {
      background.image = bgUrl;
      background.fit = ss.backgroundSize as "cover" | "contain";
    } else if (ss.backgroundImage !== "none") {
      const l = liveOf(slide, "a gradient or patterned background", true);
      items.push({ t: "html", ...l, z: -1e9 });
    }
    // reveal.js draws these outside the section
    if (found.how === "reveal") {
      const c = hex(slide.getAttribute("data-background-color") ?? "");
      if (c) background.color = c.slice(0, 7);
      const img = slide.getAttribute("data-background-image");
      if (img) {
        background.image = new URL(img, document.baseURI).href;
        background.fit = slide.getAttribute("data-background-size") === "contain" ? "contain" : "cover";
      }
    }
    walk(slide, { opacity: 1 });
    // a solid box covering the whole slide at the back is the slide's background
    const firstItem = items.filter((i) => i.z <= 0)[0];
    if (firstItem && firstItem.t === "shape" && firstItem.shape === "rect" && firstItem.fill && firstItem.fill.length === 7 && !firstItem.stroke && !firstItem.radius && firstItem.opacity === undefined && firstItem.x <= 1 && firstItem.y <= 1 && firstItem.x + firstItem.w >= W - 1 && firstItem.y + firstItem.h >= (W * lh) / lw - 1 && !background.image) {
      background.color = firstItem.fill;
      items.splice(items.indexOf(firstItem), 1);
    }
    // stacking: z-index first, then page order
    const ordered = items.map((it, i) => ({ it, i })).sort((a, b) => a.it.z - b.it.z || a.i - b.i).map((x) => x.it);
    out.push({ width: lw, height: lh, background, items: ordered, notes: notesParts.join("\n\n").trim() });
  }
  // pictures made by the page's scripts (blob: URLs) can only be read here
  for (const b of blobs) {
    try {
      const data = await (await fetch(b.url)).blob();
      b.item.src = await new Promise<string>((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.readAsDataURL(data);
      });
    } catch {
      /* leave it; html.ts reports it */
    }
  }
  return { how: found.how, slides: out };
}
