/** Colours for people on the canvas (cursors, selections, change highlights) when the service gave none. */
const PALETTE = ["#1f5fb8", "#c2410c", "#0f766e", "#7c3aed", "#b42318", "#a16207", "#be185d", "#15803d"];

export function colorFor(key: string | null | undefined): string {
  if (!key) return PALETTE[0]!;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

/** A presence colour from the service, if it is a plain colour; otherwise one from the palette. */
export function safeColor(value: string | null | undefined, key: string): string {
  return value && /^#[0-9a-f]{3,8}$|^(rgb|hsl)a?\([0-9.,%\s/]+\)$/i.test(value.trim()) ? value.trim() : colorFor(key);
}
