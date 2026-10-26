import { luminance, mix, type DeckJson, type Element, type RichText, type Theme } from "@silicon-present/deck";
import { shapeGeometry } from "@silicon-present/render";

export interface ColorSwatch {
  color: string | null;
  name: string;
}

/** Hex entry accepts the CSS short forms and alpha, and stores one canonical spelling. */
export function normalizeHexColor(input: string): string | null {
  const hex = input.trim().replace(/^#/, "");
  if (!/^(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) return null;
  return `#${(hex.length < 5 ? [...hex].map(character => character.repeat(2)).join("") : hex).toUpperCase()}`;
}

export function colorKey(color: string): string {
  return normalizeHexColor(color) ?? color.trim().toLowerCase();
}

export function isTransparentColor(color: string | null | undefined): boolean {
  if (!color) return true;
  if (["none", "transparent"].includes(color.trim().toLowerCase())) return true;
  const hex = normalizeHexColor(color);
  return Boolean(hex?.length === 9 && hex.endsWith("00"));
}

/** Missing fill can be a theme fill; an explicit transparent fill must stay transparent. */
export function elementFillColor(element: Element, theme: Theme): string | null {
  if (element.kind === "shape" && shapeGeometry(element.shape, element.w, element.h, element.style.radius).open) return null;
  const fallback = element.kind === "shape" && !element.style.stroke ? theme.colors.accent
    : element.kind === "audio" ? mix(theme.colors.accent, theme.colors.background, 0.86) : null;
  const fill = element.style.fill ?? fallback;
  return isTransparentColor(fill) ? null : fill;
}

/** Match the renderer's automatic text contrast for shapes instead of claiming every default is theme.text. */
export function elementTextColor(element: Element, theme: Theme): string {
  if (element.kind !== "shape") return theme.colors.text;
  const open = shapeGeometry(element.shape, element.w, element.h, element.style.radius).open;
  const fill = open ? "none" : element.style.fill ?? (element.style.stroke ? "none" : theme.colors.accent);
  return fill !== "none" && luminance(fill) < 0.4 ? "#ffffff" : theme.colors.text;
}

export function uniqueSwatches(swatches: ColorSwatch[], limit = Infinity): ColorSwatch[] {
  const seen = new Set<string>();
  return swatches.filter(swatch => {
    if (!swatch.color || seen.size >= limit) return false;
    const key = colorKey(swatch.color);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function recentColors(colors: unknown, next?: string): string[] {
  const previous = Array.isArray(colors) ? colors.filter((color): color is string => typeof color === "string") : [];
  return uniqueSwatches([...(next ? [next] : []), ...previous]
    .map(color => normalizeHexColor(color))
    .filter((color): color is string => color !== null)
    .map(color => ({ color, name: color })), 8).map(swatch => swatch.color!);
}

/** Only authored deck colours belong here; image URLs and embedded HTML are not colour sources. */
export function documentSwatches(deck: DeckJson, excluded: ColorSwatch[] = []): ColorSwatch[] {
  const colors: ColorSwatch[] = [];
  const add = (color: string | null | undefined) => {
    if (color) colors.push({ color, name: color });
  };
  const text = (value: RichText) => value.paragraphs.forEach(paragraph => paragraph.runs.forEach(run => {
    add(run.color);
    add(run.highlight);
  }));
  const element = (value: Element) => {
    add(value.style.fill);
    add(value.style.stroke);
    if (value.kind === "text" || value.kind === "shape") text(value.text);
    if (value.kind === "table") value.cells.forEach(row => row.forEach(cell => { add(cell.fill); text(cell.text); }));
    if (value.kind === "chart") value.chart.series.forEach(series => add(series.color));
  };
  deck.master.elements.forEach(element);
  deck.slides.forEach(slide => {
    if (slide.background && "color" in slide.background) add(slide.background.color);
    slide.elements.forEach(element);
  });
  const hidden = new Set(excluded.flatMap(swatch => swatch.color ? [colorKey(swatch.color)] : []));
  return uniqueSwatches(colors.filter(swatch => !hidden.has(colorKey(swatch.color!))), 16);
}

/** Undefined means mixed; null means every run uses the theme's text colour. */
export function commonTextColor(texts: RichText[]): string | null | undefined {
  const colors = texts.flatMap(text => text.paragraphs.flatMap(paragraph => paragraph.runs
    .filter(run => run.text.length > 0)
    .map(run => run.color ? colorKey(run.color) : null)));
  return colors.every(color => color === colors[0]) ? colors[0] ?? null : undefined;
}
