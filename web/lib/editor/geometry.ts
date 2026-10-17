/**
 * Slide geometry: element boxes, rotation, resize handles and snapping. Everything is in slide pixels (the deck's own
 * coordinate system, 1920 x 1080 by default); the canvas scales it for the screen.
 */
import type { Element } from "@silicon-present/deck";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function boxOf(element: Pick<Element, "x" | "y" | "w" | "h">): Box {
  return { x: element.x, y: element.y, w: element.w, h: element.h };
}

/** The axis-aligned box around a rotated box. */
export function rotatedBounds(box: Box, rotation: number): Box {
  if (!rotation) return box;
  const r = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(r));
  const sin = Math.abs(Math.sin(r));
  const w = box.w * cos + box.h * sin;
  const h = box.w * sin + box.h * cos;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Box {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/** A point in the element's own frame (0..1 on each axis), undoing its rotation. */
export function toElementFraction(element: Pick<Element, "x" | "y" | "w" | "h" | "rotation">, px: number, py: number): { ex: number; ey: number } {
  const cx = element.x + element.w / 2;
  const cy = element.y + element.h / 2;
  const r = (-(element.rotation || 0) * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  const lx = dx * Math.cos(r) - dy * Math.sin(r);
  const ly = dx * Math.sin(r) + dy * Math.cos(r);
  return { ex: (lx + element.w / 2) / Math.max(1, element.w), ey: (ly + element.h / 2) / Math.max(1, element.h) };
}

/** The slide point of a fraction inside an element (the inverse of toElementFraction). */
export function fromElementFraction(element: Pick<Element, "x" | "y" | "w" | "h" | "rotation">, ex: number, ey: number): { x: number; y: number } {
  const cx = element.x + element.w / 2;
  const cy = element.y + element.h / 2;
  const r = ((element.rotation || 0) * Math.PI) / 180;
  const lx = ex * element.w - element.w / 2;
  const ly = ey * element.h - element.h / 2;
  return { x: cx + lx * Math.cos(r) - ly * Math.sin(r), y: cy + lx * Math.sin(r) + ly * Math.cos(r) };
}

/** Whether a slide point is inside an element (respecting its rotation). */
export function hitElement(element: Pick<Element, "x" | "y" | "w" | "h" | "rotation">, px: number, py: number): boolean {
  const { ex, ey } = toElementFraction(element, px, py);
  return ex >= 0 && ex <= 1 && ey >= 0 && ey <= 1;
}

/**
 * Resizes `start` by dragging `handle` by (dx, dy) slide pixels in the element's own (unrotated) frame. With `keepRatio`
 * (shift, or a corner on an image) the aspect ratio stays. The opposite edge or corner stays where it was on the slide,
 * even when the element is rotated.
 */
export function resizeBox(start: Box, rotation: number, handle: Handle, dx: number, dy: number, keepRatio: boolean, min = 8): Box {
  const r = (rotation * Math.PI) / 180;
  // The drag in the element's frame.
  const lx = dx * Math.cos(-r) - dy * Math.sin(-r);
  const ly = dx * Math.sin(-r) + dy * Math.cos(-r);
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.startsWith("n");
  const south = handle.startsWith("s");
  let w = start.w + (east ? lx : west ? -lx : 0);
  let h = start.h + (south ? ly : north ? -ly : 0);
  if (keepRatio && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    if ((east || west) && (north || south)) {
      if (Math.abs(w / start.w) > Math.abs(h / start.h)) h = w / ratio;
      else w = h * ratio;
    } else if (east || west) h = w / ratio;
    else w = h * ratio;
  }
  w = Math.max(min, w);
  h = Math.max(min, h);
  // Keep the anchor (opposite side) fixed on the slide.
  const ax = west ? 1 : east ? 0 : 0.5;
  const ay = north ? 1 : south ? 0 : 0.5;
  const anchorBefore = fromElementFraction({ ...start, rotation }, ax, ay);
  const next = { x: start.x, y: start.y, w, h };
  const anchorAfter = fromElementFraction({ ...next, rotation }, ax, ay);
  return { x: next.x + anchorBefore.x - anchorAfter.x, y: next.y + anchorBefore.y - anchorAfter.y, w, h };
}

// ---- snapping ----

export interface Guide {
  axis: "x" | "y";
  /** Where the line is (slide px). */
  at: number;
  /** The extent of the line on the other axis. */
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

interface Line {
  at: number;
  from: number;
  to: number;
}

/**
 * Snaps a moving box to the slide's edges and centre, other elements' edges and centres, and (when `grid` > 0) a grid.
 * `threshold` is in slide px (the canvas passes ~6 screen px divided by the zoom). Returns the correction and the guide
 * lines to draw.
 */
export function snapMove(box: Box, others: Box[], slide: { width: number; height: number }, threshold: number, grid = 0): SnapResult {
  const xs: Line[] = [
    { at: 0, from: 0, to: slide.height },
    { at: slide.width / 2, from: 0, to: slide.height },
    { at: slide.width, from: 0, to: slide.height },
  ];
  const ys: Line[] = [
    { at: 0, from: 0, to: slide.width },
    { at: slide.height / 2, from: 0, to: slide.width },
    { at: slide.height, from: 0, to: slide.width },
  ];
  for (const o of others) {
    for (const at of [o.x, o.x + o.w / 2, o.x + o.w]) xs.push({ at, from: o.y, to: o.y + o.h });
    for (const at of [o.y, o.y + o.h / 2, o.y + o.h]) ys.push({ at, from: o.x, to: o.x + o.w });
  }
  const mine = {
    x: [box.x, box.x + box.w / 2, box.x + box.w],
    y: [box.y, box.y + box.h / 2, box.y + box.h],
  };
  const best = (values: number[], lines: Line[]) => {
    let delta = Infinity;
    for (const v of values) for (const line of lines) if (Math.abs(line.at - v) < Math.abs(delta)) delta = line.at - v;
    return Math.abs(delta) <= threshold ? delta : null;
  };
  let dx = best(mine.x, xs);
  let dy = best(mine.y, ys);
  if (dx === null && grid > 0) {
    const g = Math.round(box.x / grid) * grid - box.x;
    if (Math.abs(g) <= threshold) dx = g;
  }
  if (dy === null && grid > 0) {
    const g = Math.round(box.y / grid) * grid - box.y;
    if (Math.abs(g) <= threshold) dy = g;
  }
  const moved = { x: box.x + (dx ?? 0), y: box.y + (dy ?? 0), w: box.w, h: box.h };
  const guides: Guide[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  if (dx !== null) {
    for (const v of [moved.x, moved.x + moved.w / 2, moved.x + moved.w]) {
      for (const line of xs) {
        if (!near(line.at, v)) continue;
        guides.push({ axis: "x", at: line.at, from: Math.min(line.from, moved.y), to: Math.max(line.to, moved.y + moved.h) });
      }
    }
  }
  if (dy !== null) {
    for (const v of [moved.y, moved.y + moved.h / 2, moved.y + moved.h]) {
      for (const line of ys) {
        if (!near(line.at, v)) continue;
        guides.push({ axis: "y", at: line.at, from: Math.min(line.from, moved.x), to: Math.max(line.to, moved.x + moved.w) });
      }
    }
  }
  return { dx: dx ?? 0, dy: dy ?? 0, guides: dedupeGuides(guides) };
}

/** Snaps the moving edges of a resize (only the edges the handle moves). */
export function snapResize(box: Box, handle: Handle, others: Box[], slide: { width: number; height: number }, threshold: number): { box: Box; guides: Guide[] } {
  const xs = [0, slide.width / 2, slide.width, ...others.flatMap(o => [o.x, o.x + o.w / 2, o.x + o.w])];
  const ys = [0, slide.height / 2, slide.height, ...others.flatMap(o => [o.y, o.y + o.h / 2, o.y + o.h])];
  const out = { ...box };
  const guides: Guide[] = [];
  const snapTo = (value: number, lines: number[]) => {
    let best: number | null = null;
    for (const line of lines) if (Math.abs(line - value) <= threshold && (best === null || Math.abs(line - value) < Math.abs(best - value))) best = line;
    return best;
  };
  if (handle.includes("e")) {
    const s = snapTo(out.x + out.w, xs);
    if (s !== null) {
      out.w = s - out.x;
      guides.push({ axis: "x", at: s, from: 0, to: slide.height });
    }
  } else if (handle.includes("w")) {
    const s = snapTo(out.x, xs);
    if (s !== null) {
      out.w += out.x - s;
      out.x = s;
      guides.push({ axis: "x", at: s, from: 0, to: slide.height });
    }
  }
  if (handle.startsWith("s")) {
    const s = snapTo(out.y + out.h, ys);
    if (s !== null) {
      out.h = s - out.y;
      guides.push({ axis: "y", at: s, from: 0, to: slide.width });
    }
  } else if (handle.startsWith("n")) {
    const s = snapTo(out.y, ys);
    if (s !== null) {
      out.h += out.y - s;
      out.y = s;
      guides.push({ axis: "y", at: s, from: 0, to: slide.width });
    }
  }
  return { box: out, guides };
}

function dedupeGuides(guides: Guide[]): Guide[] {
  const out: Guide[] = [];
  for (const g of guides) {
    const same = out.find(o => o.axis === g.axis && Math.abs(o.at - g.at) < 0.5);
    if (same) {
      same.from = Math.min(same.from, g.from);
      same.to = Math.max(same.to, g.to);
    } else out.push({ ...g });
  }
  return out;
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}
