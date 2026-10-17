import type { Theme } from "./types";

// Default themes: calm, minimal, each one heading/body font pair plus six colours.
// Fonts are Google Fonts families (the renderer loads them by name) with sensible fallbacks in the renderer.

function theme(name: string, heading: string, body: string, colors: Theme["colors"]): Theme {
  return { name, fonts: { heading, body }, colors, customFonts: [] };
}

export const THEMES: Theme[] = [
  theme("Paper", "Inter", "Inter", {
    background: "#ffffff",
    text: "#1b1b1f",
    accent: "#2f5bea",
    accent2: "#e5484d",
    accent3: "#12a594",
    muted: "#6f6f78",
  }),
  theme("Ivory", "Fraunces", "Inter", {
    background: "#f8f5ee",
    text: "#211d17",
    accent: "#b4532a",
    accent2: "#3b6e8f",
    accent3: "#7a8b3a",
    muted: "#7d7468",
  }),
  theme("Ink", "Space Grotesk", "Inter", {
    background: "#111214",
    text: "#f2f2f0",
    accent: "#8ab4ff",
    accent2: "#ffb86b",
    accent3: "#7ee0b8",
    muted: "#9a9ca3",
  }),
  theme("Slate", "IBM Plex Sans", "IBM Plex Sans", {
    background: "#eef1f5",
    text: "#18202b",
    accent: "#3a5a80",
    accent2: "#d08a2e",
    accent3: "#5f8f6e",
    muted: "#66717f",
  }),
  theme("Forest", "DM Serif Display", "DM Sans", {
    background: "#f3f5f0",
    text: "#1c2a22",
    accent: "#2f6b4f",
    accent2: "#c2733d",
    accent3: "#8a9a3b",
    muted: "#6b776f",
  }),
  theme("Coral", "Manrope", "Manrope", {
    background: "#fff8f5",
    text: "#2a1d1a",
    accent: "#e2614b",
    accent2: "#2d7f8f",
    accent3: "#f2a93b",
    muted: "#8a7570",
  }),
  theme("Mono", "JetBrains Mono", "Inter", {
    background: "#fafafa",
    text: "#111111",
    accent: "#111111",
    accent2: "#7a7a7a",
    accent3: "#c0c0c0",
    muted: "#7a7a7a",
  }),
];

export const DEFAULT_THEME: Theme = THEMES[0]!;

export function themeByName(name: string): Theme | undefined {
  const t = THEMES.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return t ? structuredClone(t) : undefined;
}

/** Colours used for chart series, in order, when a series has no colour of its own. */
export function seriesPalette(t: Theme): string[] {
  const c = t.colors;
  return [c.accent, c.accent2, c.accent3, c.muted, mix(c.accent, c.background, 0.45), mix(c.accent2, c.background, 0.45), mix(c.accent3, c.background, 0.45), mix(c.text, c.background, 0.25)];
}

/** Mix two hex colours: t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return a;
  const out = pa.map((v, i) => Math.round(v + (pb[i]! - v) * t));
  return "#" + out.map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Relative luminance 0..1, used to pick readable text over a fill. */
export function luminance(hex: string): number {
  const p = parseHex(hex);
  if (!p) return 1;
  const [r, g, b] = p.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
