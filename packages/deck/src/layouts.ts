import { newElementId } from "./ids";
import { richTextFromPlain } from "./normalize";
import { LAYOUTS } from "./types";
import type { ElementInput, LayoutName, Paragraph, RichText, Size, Theme } from "./types";

// The seven layouts. Each one is a function that returns the placeholder elements of a new slide for a theme and
// slide size. Placeholders are ordinary elements (there is no separate placeholder kind in the format): empty text
// boxes carry their paragraph style (heading level, list) so typing into them looks right, and an empty image src
// means "image to come" (the renderer draws a quiet placeholder box, exports skip it).

export interface LayoutContent {
  title?: string;
  subtitle?: string;
  /** Body text; an array gives one bullet per entry. */
  body?: string | string[];
  left?: string | string[];
  right?: string | string[];
  caption?: string;
  /** Image src for image-caption ("asset:<id>" or a URL). */
  image?: string;
}

type Box = { x: number; y: number; w: number; h: number };

function scaleBox(b: Box, size: Size): Box {
  const sx = size.width / 1920;
  const sy = size.height / 1080;
  return { x: Math.round(b.x * sx), y: Math.round(b.y * sy), w: Math.round(b.w * sx), h: Math.round(b.h * sy) };
}

function rich(text: string | string[] | undefined, para: Omit<Paragraph, "runs">): RichText {
  if (text === undefined) return { paragraphs: [{ ...para, runs: [] }] };
  const lines = Array.isArray(text) ? text : text.split("\n");
  return { paragraphs: lines.map((l) => ({ ...para, runs: l ? [{ text: l }] : [] })) };
}

function textBox(box: Box, size: Size, text: RichText, verticalAlign: "top" | "middle" | "bottom" = "top"): ElementInput {
  return { id: newElementId(), kind: "text", ...scaleBox(box, size), text, style: { verticalAlign } };
}

const TITLE_TOP: Box = { x: 140, y: 80, w: 1640, h: 170 };

export const LAYOUT_FUNCTIONS: Record<LayoutName, (theme: Theme, size: Size, content?: LayoutContent) => ElementInput[]> = {
  title: (_t, size, c = {}) => [
    textBox({ x: 140, y: 300, w: 1640, h: 280 }, size, rich(c.title, { heading: 1 }), "bottom"),
    textBox({ x: 140, y: 610, w: 1640, h: 160 }, size, rich(c.subtitle, {}), "top"),
  ],
  "title-body": (_t, size, c = {}) => [
    textBox(TITLE_TOP, size, rich(c.title, { heading: 2 }), "bottom"),
    textBox({ x: 140, y: 290, w: 1640, h: 700 }, size, rich(c.body, { list: "bullet" })),
  ],
  "two-columns": (_t, size, c = {}) => [
    textBox(TITLE_TOP, size, rich(c.title, { heading: 2 }), "bottom"),
    textBox({ x: 140, y: 290, w: 790, h: 700 }, size, rich(c.left, { list: "bullet" })),
    textBox({ x: 990, y: 290, w: 790, h: 700 }, size, rich(c.right, { list: "bullet" })),
  ],
  section: (t, size, c = {}) => [
    { id: newElementId(), kind: "shape", shape: "rect", ...scaleBox({ x: 140, y: 400, w: 120, h: 10 }, size), style: { fill: t.colors.accent }, text: { paragraphs: [] } },
    textBox({ x: 140, y: 440, w: 1640, h: 220 }, size, rich(c.title, { heading: 1 })),
    textBox({ x: 140, y: 670, w: 1640, h: 120 }, size, rich(c.subtitle, {})),
  ],
  "title-only": (_t, size, c = {}) => [textBox(TITLE_TOP, size, rich(c.title, { heading: 2 }), "bottom")],
  "image-caption": (_t, size, c = {}) => [
    { id: newElementId(), kind: "image", ...scaleBox({ x: 140, y: 80, w: 1640, h: 780 }, size), src: c.image ?? "", alt: "", fit: "contain" },
    textBox({ x: 140, y: 890, w: 1640, h: 110 }, size, rich(c.caption, { align: "center" })),
  ],
  blank: () => [],
};

export function isLayout(name: string): name is LayoutName {
  return (LAYOUTS as readonly string[]).includes(name);
}

/** Placeholder elements for a new slide with this layout ("blank" for unknown names). */
export function layoutElements(layout: string, theme: Theme, size: Size = { width: 1920, height: 1080 }, content?: LayoutContent): ElementInput[] {
  const f = isLayout(layout) ? LAYOUT_FUNCTIONS[layout] : LAYOUT_FUNCTIONS.blank;
  return f(theme, size, content);
}

export { richTextFromPlain };
