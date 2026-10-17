// Everything a deck contains is untrusted (any editor, Carbon or Silicon, can write anything), and the web viewer puts
// rendered slides straight into its own page. So every string that reaches the HTML goes through one of these.
// Only HTML elements run code, and they run inside a sandboxed iframe (see elements.ts).

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const escapeAttr = escapeHtml;

/** A finite number, rounded to 3 decimals (keeps the HTML small). */
export function n(v: unknown, d = 0): number {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : d;
}

const NAMED = /^[a-z]{3,20}$/i;
const HEX = /^#[0-9a-f]{3,8}$/i;
const FUNC = /^(rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/+-]+\)$/i;

/** A CSS colour, or the fallback if it isn't a plain colour. */
export function color(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const s = v.trim();
  if (HEX.test(s) || FUNC.test(s) || (NAMED.test(s) && s.toLowerCase() !== "expression")) return s;
  return fallback;
}

export function optColor(v: unknown): string | null {
  const c = color(v, "");
  return c || null;
}

/** A font family name, quoted, with anything that could break out of a CSS value removed. */
export function fontName(v: unknown): string {
  const s = String(v ?? "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 80);
  return s ? `"${s}"` : "";
}

const SERIF = /serif|fraunces|playfair|georgia|garamond|merriweather|lora|times|caslon|baskerville|dm serif|source serif|cormorant|libre/i;
const MONO = /mono|code|courier|consolas/i;

/** A CSS font-family list for a family, with fallbacks of the same flavour. */
export function fontStack(family: unknown): string {
  const f = fontName(family);
  const raw = String(family ?? "");
  const fallback = MONO.test(raw)
    ? 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
    : SERIF.test(raw) && !/sans/i.test(raw)
      ? 'Georgia, "Times New Roman", serif'
      : 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
  return f ? `${f}, ${fallback}` : fallback;
}

/** A link target a Carbon can safely click: http(s), mailto, tel, or a slide link. */
export function linkHref(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^slide:[A-Za-z0-9_-]+$/.test(s)) return "#" + s;
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  return null;
}

/** A media/image source: http(s), data:, blob:, or a same-origin path. Anything else (javascript:, etc.) is dropped. */
export function mediaSrc(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  if (/^(https?:|data:(image|video|audio|font)\/|blob:)/i.test(s)) return s;
  if (s.startsWith("/") && !s.startsWith("//")) return s;
  return null;
}

/** For url(...) inside CSS: escape the characters that could end the string. */
export function cssUrl(u: string): string {
  return `url("${u.replace(/["\\\n\r]/g, (c) => encodeURIComponent(c))}")`;
}
