import type { DeckJson } from "@silicon-present/deck";
import { SLIDE_CSS } from "./css";
import { escapeHtml, n } from "./safe";
import { fontCss, renderSlideHtml, slideSteps, transitionCss } from "./slide";
import type { RenderOptions } from "./slide";

// A whole deck as one HTML document: a full-window player (arrow keys, click-steps, transitions), or print pages
// (one page per slide, for PDF). HTML export adds the deck JSON and assets so importing the file restores the deck.

export interface EmbeddedAsset {
  filename: string;
  contentType: string;
  /** base64 */
  data: string;
}

export interface DeckHtmlOptions extends RenderOptions {
  /** "player" (default) or "print" (stacked pages, final state, for PDF). */
  mode?: "player" | "print";
  /** Include skipped slides as pages / in navigation. Default false (they're skipped when presenting). */
  includeSkipped?: boolean;
  /** Embed the deck JSON as <script type="application/json" id="silicon-present-deck">. */
  embedDeck?: boolean;
  /**
   * Inline assets: every "asset:<id>" is served from this map (base64 in one JSON block, turned into blob URLs when
   * the page loads), so the file is self-contained and importing it gives back the same assets.
   */
  assets?: Record<string, EmbeddedAsset>;
  /** Page title (defaults to the deck title). */
  title?: string;
}

export const DECK_JSON_ID = "silicon-present-deck";
export const DECK_ASSETS_ID = "silicon-present-assets";

/** JSON that is safe inside a <script> element. */
export function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const PLAYER_JS = `
(function(){
  var frames = Array.prototype.slice.call(document.querySelectorAll('.sp-frame'));
  var stage = document.querySelector('.sp-stage');
  var W = +stage.getAttribute('data-w'), H = +stage.getAttribute('data-h');
  var cur = -1, step = 0, busy = null;
  function fit(){ var s = Math.min(innerWidth / W, innerHeight / H); stage.style.transform = 'translate(' + ((innerWidth - W * s) / 2) + 'px,' + ((innerHeight - H * s) / 2) + 'px) scale(' + s + ')'; }
  function slideEl(i){ return frames[i].querySelector('.sp-slide'); }
  function steps(i){ return +slideEl(i).getAttribute('data-sp-steps') || 0; }
  function setStep(i, k, animate){ var s = slideEl(i); s.setAttribute('data-sp-animate', animate ? '1' : '0'); s.setAttribute('data-sp-at', String(k)); }
  function show(i, k, animateIn){
    if (i < 0 || i >= frames.length) return;
    var prev = cur;
    if (busy) { clearTimeout(busy.t); busy.done(); }
    frames.forEach(function(f, j){ if (j !== i && j !== prev) f.style.display = 'none'; });
    var f = frames[i]; f.style.display = 'block'; f.style.zIndex = 2; f.style.animation = '';
    if (animateIn && prev >= 0 && prev !== i) {
      var tr = JSON.parse(f.getAttribute('data-transition') || 'null');
      var p = frames[prev]; p.style.zIndex = 1;
      if (tr) {
        f.style.animation = tr.in; p.style.animation = tr.out || 'none';
        var done = function(){ p.style.display = 'none'; p.style.animation = ''; f.style.animation = ''; busy = null; };
        busy = { t: setTimeout(done, tr.duration + 30), done: done };
      } else { p.style.display = 'none'; }
    } else if (prev >= 0 && prev !== i) frames[prev].style.display = 'none';
    // media on hidden slides stop
    frames.forEach(function(fr, j){ if (j !== i) fr.querySelectorAll('video,audio').forEach(function(m){ try { m.pause(); } catch(e){} }); });
    cur = i; step = k; setStep(i, k, animateIn);
    if (history.replaceState) history.replaceState(null, '', '#' + (i + 1) + (k ? '.' + k : ''));
    document.dispatchEvent(new CustomEvent('sp-slide', { detail: { index: i, step: k } }));
  }
  function next(){ if (step < steps(cur)) { step++; setStep(cur, step, true); } else if (cur < frames.length - 1) show(cur + 1, 0, true); }
  function prev(){ if (step > 0) { step--; setStep(cur, step, false); } else if (cur > 0) show(cur - 1, steps(cur - 1), false); }
  document.addEventListener('keydown', function(e){
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (['ArrowRight','ArrowDown',' ','PageDown','Enter','n'].indexOf(e.key) >= 0) { e.preventDefault(); next(); }
    else if (['ArrowLeft','ArrowUp','PageUp','Backspace','p'].indexOf(e.key) >= 0) { e.preventDefault(); prev(); }
    else if (e.key === 'Home') show(0, 0, false);
    else if (e.key === 'End') show(frames.length - 1, steps(frames.length - 1), false);
    else if (e.key === 'f' && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function(){});
  });
  document.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('[data-sp-goto]');
    if (a) { e.preventDefault(); var id = a.getAttribute('data-sp-goto'); var j = frames.findIndex(function(f){ return f.getAttribute('data-slide') === id; }); if (j >= 0) show(j, 0, true); return; }
    if (e.target.closest && e.target.closest('a,video,audio,iframe,button')) return;
    if (e.clientX < innerWidth / 4) prev(); else next();
  });
  addEventListener('resize', fit); fit();
  var m = /^#(\\d+)(?:\\.(\\d+))?$/.exec(location.hash || '');
  var start = m ? Math.min(frames.length - 1, Math.max(0, +m[1] - 1)) : 0;
  show(start, m && m[2] ? Math.min(+m[2], steps(start)) : 0, false);
  window.SiliconPresent = { go: function(i, k){ show(i, k || 0, false); }, next: next, prev: prev, get index(){ return cur; }, get step(){ return step; }, count: frames.length };
})();
`;

const ASSETS_JS = `
(function(){
  var el = document.getElementById('${DECK_ASSETS_ID}'); if (!el) return;
  var assets = JSON.parse(el.textContent || '{}'), urls = {};
  Object.keys(assets).forEach(function(id){
    var a = assets[id], bin = atob(a.data), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    urls[id] = URL.createObjectURL(new Blob([bytes], { type: a.contentType }));
  });
  function swap(s){ return s.replace(/sp-asset:([A-Za-z0-9_-]+)/g, function(_, id){ return urls[id] || ''; }); }
  document.querySelectorAll('[src^="sp-asset:"],[poster^="sp-asset:"]').forEach(function(n){
    ['src','poster'].forEach(function(k){ var v = n.getAttribute(k); if (v && v.indexOf('sp-asset:') === 0) n.setAttribute(k, swap(v)); });
  });
  document.querySelectorAll('[style*="sp-asset:"]').forEach(function(n){ n.setAttribute('style', swap(n.getAttribute('style'))); });
  document.querySelectorAll('style').forEach(function(s){ if (s.textContent.indexOf('sp-asset:') >= 0) s.textContent = swap(s.textContent); });
})();
`;

/** The whole deck as one HTML document (player or print pages). */
export function renderDeckHtml(deck: DeckJson, opts: DeckHtmlOptions = {}): string {
  const mode = opts.mode ?? "player";
  const slides = deck.slides.filter((s) => opts.includeSkipped || !s.skipped);
  const W = n(deck.size.width);
  const H = n(deck.size.height);
  const ropts: RenderOptions = { ...opts, includeCss: false };
  if (opts.assets) ropts.assetUrl = (id) => (opts.assets![id] ? `sp-asset:${id}` : (opts.assetUrl ?? ((x: string) => `/api/v1/assets/${x}`))(id));
  const title = escapeHtml(opts.title ?? deck.title ?? "Slides");
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="Silicon Present"><title>${title}</title>`;
  const fonts = fontCss(deck, ropts, slides);
  let body = "";
  let css = "";
  if (mode === "print") {
    css = `@page{size:${W}px ${H}px;margin:0}html,body{margin:0;padding:0;background:#fff}.sp-page{width:${W}px;height:${H}px;overflow:hidden;break-after:page;page-break-after:always;position:relative}.sp-page:last-child{break-after:auto;page-break-after:auto}`;
    body = slides.map((s) => `<div class="sp-page">${renderSlideHtml(deck, s.id, { ...ropts, step: "all", animate: false })}</div>`).join("");
  } else {
    css = `html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#000}.sp-stage{position:absolute;left:0;top:0;width:${W}px;height:${H}px;transform-origin:0 0;overflow:hidden}.sp-frame{position:absolute;inset:0;display:none}`;
    body =
      `<div class="sp-stage" data-w="${W}" data-h="${H}">` +
      slides
        .map((s) => {
          const tr = transitionCss(s.transition);
          return `<section class="sp-frame" data-slide="${escapeHtml(s.id)}" data-steps="${slideSteps(s).steps}" data-transition="${escapeHtml(JSON.stringify(tr))}">${renderSlideHtml(deck, s.id, { ...ropts, step: 0, animate: false })}</section>`;
        })
        .join("") +
      `</div>`;
  }
  const embeds: string[] = [];
  if (opts.embedDeck) embeds.push(`<script type="application/json" id="${DECK_JSON_ID}">${scriptJson(deck)}</script>`);
  if (opts.assets) embeds.push(`<script type="application/json" id="${DECK_ASSETS_ID}">${scriptJson(opts.assets)}</script>`, `<script>${ASSETS_JS}</script>`);
  const scripts = mode === "player" ? `<script>${PLAYER_JS}</script>` : "";
  return `${head}<style>${fonts}\n${SLIDE_CSS}\n${css}</style></head><body>${body}${embeds.join("")}${scripts}</body></html>`;
}
