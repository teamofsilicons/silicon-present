import type { RichText, Run, Theme } from "@silicon-present/deck";
import { BODY_SIZE, HEADING_SIZES } from "./css";
import { color, escapeHtml, fontStack, linkHref, n } from "./safe";

// Rich text -> HTML. Every inline attribute (bold, italic, underline, strike, color, highlight, size, font, link,
// code) and paragraph attribute (align, list, indent, heading, lineHeight) from docs/architecture.md.

export interface TextDefaults {
  /** Body size in px when a run has no size. */
  size?: number;
  color?: string;
  align?: "left" | "center" | "right" | "justify";
  font?: string;
  /** Links are clickable (false in the editor while editing). */
  links?: boolean;
}

const BULLETS = ["•", "◦", "▪", "–", "•", "◦", "▪", "–", "•"];
const INDENT_EM = 1.1;

function toRoman(num: number): string {
  const m: Array<[number, string]> = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [v, s] of m) while (num >= v) {
    out += s;
    num -= v;
  }
  return out;
}

function orderedMarker(level: number, k: number): string {
  const kind = level % 3;
  if (kind === 1) return String.fromCharCode(97 + ((k - 1) % 26)) + ".";
  if (kind === 2) return toRoman(k) + ".";
  return k + ".";
}

function runHtml(r: Run, theme: Theme, d: TextDefaults): string {
  const css: string[] = [];
  const deco: string[] = [];
  if (r.bold) css.push("font-weight:700");
  if (r.italic) css.push("font-style:italic");
  if (r.underline || (r.link && d.links !== false)) deco.push("underline");
  if (r.strike) deco.push("line-through");
  if (deco.length) css.push(`text-decoration:${deco.join(" ")}`);
  if (r.color) css.push(`color:${color(r.color, "inherit")}`);
  if (r.highlight) css.push(`background-color:${color(r.highlight, "transparent")}`);
  if (r.size) css.push(`font-size:${n(r.size, BODY_SIZE)}px`);
  if (r.font) css.push(`font-family:${fontStack(r.font)}`);
  // U+2028 is a soft line break inside a paragraph
  let inner = escapeHtml(r.text).replace(/\u2028/g, "<br>");
  if (r.code) inner = `<code>${inner}</code>`;
  const style = css.length ? ` style="${escapeHtml(css.join(";"))}"` : "";
  const href = r.link ? linkHref(r.link) : null;
  if (href && d.links !== false) {
    const ext = !href.startsWith("#");
    return `<a href="${escapeHtml(href)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ` data-sp-goto="${escapeHtml(href.slice(7))}"`}${style}>${inner}</a>`;
  }
  return `<span${style}>${inner}</span>`;
}

export function richTextHtml(rt: RichText | null | undefined, theme: Theme, d: TextDefaults = {}): string {
  const paragraphs = rt?.paragraphs ?? [];
  const counters: number[] = [];
  let prevOrdered = false;
  const out: string[] = [];
  for (const p of paragraphs) {
    const level = Math.max(0, Math.min(8, Math.round(n(p.indent, 0))));
    const css: string[] = [];
    const align = p.align ?? d.align;
    if (align && align !== "left") css.push(`text-align:${align}`);
    if (p.heading) {
      css.push(`font-size:${HEADING_SIZES[p.heading] ?? BODY_SIZE}px`);
      css.push(`font-family:${fontStack(theme.fonts.heading)}`);
      css.push(`font-weight:${p.heading === 1 ? 700 : 600}`);
      css.push(`line-height:${p.lineHeight ? n(p.lineHeight, 1.1) : 1.1}`);
      css.push("letter-spacing:-0.01em");
    } else if (p.lineHeight) css.push(`line-height:${n(p.lineHeight, 1.25)}`);
    let marker = "";
    const base = p.heading ? HEADING_SIZES[p.heading] ?? BODY_SIZE : d.size ?? BODY_SIZE;
    const firstRun = p.runs[0];
    const markerSize = n(firstRun?.size, 0) || base;
    const unit = INDENT_EM * markerSize;
    if (p.list) {
      if (p.list === "ordered") {
        if (!prevOrdered) counters.length = 0;
        counters.length = level + 1;
        counters[level] = (counters[level] ?? 0) + 1;
        marker = orderedMarker(level, counters[level]!);
      } else marker = BULLETS[level]!;
      const markerCss = [`width:${n(unit * 0.9)}px`, `left:${n(level * unit)}px`, `font-size:${n(markerSize)}px`];
      if (firstRun?.color) markerCss.push(`color:${color(firstRun.color, "inherit")}`);
      if (firstRun?.bold) markerCss.push("font-weight:700");
      css.push(`padding-left:${n((level + 1) * unit)}px`);
      marker = `<span class="sp-marker" style="${escapeHtml(markerCss.join(";"))}">${escapeHtml(marker)}</span>`;
      prevOrdered = p.list === "ordered";
    } else {
      if (level) css.push(`padding-left:${n(level * unit)}px`);
      prevOrdered = false;
      counters.length = 0;
    }
    const body = p.runs.length ? p.runs.map((r) => runHtml(r, theme, d)).join("") : "<br>";
    out.push(`<p${p.list ? ' class="sp-li"' : ""}${css.length ? ` style="${escapeHtml(css.join(";"))}"` : ""}>${marker}${body}</p>`);
  }
  return out.join("");
}
