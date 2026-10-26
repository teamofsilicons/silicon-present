import type { ElementInput, ShapeName, Theme } from "@silicon-present/deck";

export type DrawPoint = { x: number; y: number };

/** A preview is also the final input. Nothing is written until a real screen-space drag finishes. */
export function drawnShape(shape: ShapeName, start: DrawPoint, end: DrawPoint, constrain: boolean, theme: Theme, scale: number): ElementInput | null {
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || !Number.isFinite(scale) || scale <= 0 || length * scale < 3) return null;
  if (shape === "line") {
    let angle = Math.atan2(dy, dx);
    if (constrain) angle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
    dx = Math.cos(angle) * length;
    dy = Math.sin(angle) * length;
    // The shared line path is (0,0) → (w,h), rotated around its box centre. Compensate for
    // that diagonal so both endpoints match the drag, including horizontal and reverse lines.
    const h = Math.min(1, length / Math.SQRT2);
    const w = Math.sqrt(length * length - h * h);
    return { kind: "shape", shape, x: start.x + (dx - w) / 2, y: start.y + (dy - h) / 2, w, h,
      rotation: ((angle - Math.atan2(h, w)) * 180 / Math.PI + 360) % 360,
      style: { stroke: theme.colors.text, strokeWidth: 4 }, text: { paragraphs: [] } };
  }
  if (constrain) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side;
    dy = (dy < 0 ? -1 : 1) * side;
  }
  return { kind: "shape", shape, x: start.x + Math.min(0, dx), y: start.y + Math.min(0, dy),
    w: Math.max(1, Math.abs(dx)), h: Math.max(1, Math.abs(dy)), rotation: 0,
    style: { fill: theme.colors.accent }, text: { paragraphs: [] } };
}
