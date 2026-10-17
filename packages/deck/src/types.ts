// Deck JSON types. These mirror docs/architecture.md ("The deck document" and "Deck JSON") exactly.
// Every position and size is in slide pixels of the deck's coordinate system (1920 x 1080 by default).

export type Align = "left" | "center" | "right" | "justify";
export type Direction = "left" | "right" | "up" | "down";

/** One run of characters that share inline formatting. */
export interface Run {
  /** The characters. Never contains "\n" (that ends a paragraph); a soft line break is U+2028. */
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Hex colour, e.g. "#1a1a1a". */
  color?: string;
  /** Hex colour behind the text. */
  highlight?: string;
  /** Font size in slide px. */
  size?: number;
  /** Font family. */
  font?: string;
  link?: string;
  code?: boolean;
}

export interface Paragraph {
  align?: Align;
  list?: "bullet" | "ordered";
  /** 0-8 */
  indent?: number;
  /** 1-3 */
  heading?: 1 | 2 | 3;
  lineHeight?: number;
  runs: Run[];
}

export interface RichText {
  paragraphs: Paragraph[];
}

export const INLINE_ATTRS = ["bold", "italic", "underline", "strike", "color", "highlight", "size", "font", "link", "code"] as const;
export const PARAGRAPH_ATTRS = ["align", "list", "indent", "heading", "lineHeight"] as const;
export type InlineAttr = (typeof INLINE_ATTRS)[number];
export type ParagraphAttr = (typeof PARAGRAPH_ATTRS)[number];

export interface Size {
  width: number;
  height: number;
}

export interface ThemeColors {
  background: string;
  text: string;
  accent: string;
  accent2: string;
  accent3: string;
  muted: string;
}

export interface CustomFont {
  family: string;
  /** "asset:<id>" (or a URL). */
  src: string;
}

export interface Theme {
  name: string;
  fonts: { heading: string; body: string };
  colors: ThemeColors;
  customFonts: CustomFont[];
}

export type Background = null | { color: string } | { image: string; fit: "cover" | "contain" };

export type TransitionType = "fade" | "push" | "wipe" | "zoom" | "cover";
export interface Transition {
  type: TransitionType;
  /** milliseconds */
  duration: number;
  direction?: Direction;
}

export type AnimationEffect = "appear" | "fade" | "fly-in" | "zoom" | "wipe" | "rise";
export type AnimationTrigger = "click" | "with-previous" | "after-previous";
export interface Animation {
  effect: AnimationEffect;
  trigger: AnimationTrigger;
  order: number;
  /** milliseconds */
  duration: number;
  /** milliseconds */
  delay: number;
  direction?: Direction;
}

export interface ElementStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  opacity?: number;
  shadow?: boolean;
  padding?: number;
  verticalAlign?: "top" | "middle" | "bottom";
}

export type ElementKind = "text" | "shape" | "image" | "video" | "audio" | "table" | "chart" | "html";

export const SHAPES = [
  "rect",
  "round-rect",
  "ellipse",
  "triangle",
  "right-triangle",
  "diamond",
  "pentagon",
  "hexagon",
  "octagon",
  "star",
  "arrow-right",
  "arrow-left",
  "arrow-up",
  "arrow-down",
  "chevron",
  "line",
  "callout",
  "heart",
  "cloud",
  "plus",
] as const;
export type ShapeName = (typeof SHAPES)[number];

export interface BaseElement {
  id: string;
  kind: ElementKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  locked: boolean;
  group: string | null;
  link: string | null;
  animation: Animation | null;
  style: ElementStyle;
}

export interface TextElement extends BaseElement {
  kind: "text";
  text: RichText;
}

export interface ShapeElement extends BaseElement {
  kind: "shape";
  shape: ShapeName | string;
  text: RichText;
}

export interface ImageElement extends BaseElement {
  kind: "image";
  src: string;
  alt: string;
  fit: "cover" | "contain" | "fill";
}

export interface VideoElement extends BaseElement {
  kind: "video";
  src: string;
  alt: string;
  autoplay: boolean;
  loop: boolean;
  muted: boolean;
  poster: string | null;
}

export interface AudioElement extends BaseElement {
  kind: "audio";
  src: string;
  alt: string;
  autoplay: boolean;
  loop: boolean;
  muted: boolean;
}

export interface TableCell {
  text: RichText;
  fill: string | null;
}

export interface TableElement extends BaseElement {
  kind: "table";
  rows: number;
  cols: number;
  colWidths: number[];
  rowHeights: number[];
  headerRow: boolean;
  /** rows of cols */
  cells: TableCell[][];
}

export type ChartType = "bar" | "column" | "line" | "area" | "pie" | "donut" | "scatter";
export interface ChartSeries {
  name: string;
  values: number[];
  color?: string;
}
export interface Chart {
  type: ChartType;
  title?: string;
  labels: string[];
  series: ChartSeries[];
  legend: boolean;
}

export interface ChartElement extends BaseElement {
  kind: "chart";
  chart: Chart;
}

export interface HtmlElement extends BaseElement {
  kind: "html";
  html: string;
  css: string;
  js: string;
}

export type Element =
  | TextElement
  | ShapeElement
  | ImageElement
  | VideoElement
  | AudioElement
  | TableElement
  | ChartElement
  | HtmlElement;

export const LAYOUTS = ["title", "title-body", "two-columns", "section", "title-only", "image-caption", "blank"] as const;
export type LayoutName = (typeof LAYOUTS)[number];

export interface Slide {
  id: string;
  layout: LayoutName | string;
  background: Background;
  skipped: boolean;
  section: string | null;
  hideMaster: boolean;
  transition: Transition | null;
  notes: string;
  /** back to front */
  elements: Element[];
}

export interface DeckJson {
  id?: string;
  title?: string;
  version?: number;
  size: Size;
  theme: Theme;
  master: { elements: Element[] };
  slides: Slide[];
}

/** Partial inputs accepted by helpers and ops; missing fields get canonical defaults. */
export type ElementInput = Element | { kind: ElementKind; id?: string; [key: string]: unknown };
export type SlideInput = Partial<Omit<Slide, "elements">> & { elements?: ElementInput[] };
export interface DeckInput {
  id?: string;
  title?: string;
  version?: number;
  size?: Size;
  theme?: Partial<Theme>;
  master?: { elements?: ElementInput[] };
  slides?: SlideInput[];
}
