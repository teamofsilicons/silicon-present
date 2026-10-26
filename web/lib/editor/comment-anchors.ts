import type { Element } from "@silicon-present/deck";
import { fromElementFraction, toElementFraction, type Box } from "./geometry";
import type { Anchor } from "./types";

export interface PlacedAnchor {
  pin: { x: number; y: number };
  area: (Box & { rotation?: number }) | null;
}

/** Areas remain axis-aligned, including when their target element is rotated. */
export function areaAnchorFractions(element: Pick<Element, "x" | "y" | "w" | "h" | "rotation">, area: Box): { ex: number; ey: number; ew: number; eh: number } {
  const point = toElementFraction({ ...element, rotation: 0 }, area.x, area.y);
  // A dragged area can extend beyond its target. Clamping these fractions would move or shrink it on release.
  return { ...point, ew: area.w / Math.max(1, element.w), eh: area.h / Math.max(1, element.h) };
}

/** Current slide coordinates; deck and slide comments have no canvas marker. */
export function placeAnchor(anchor: Anchor, elements: readonly Element[]): PlacedAnchor | null {
  const element = "element" in anchor && anchor.element ? elements.find(e => e.id === anchor.element) : undefined;
  switch (anchor.kind) {
    case "point": {
      if (element && typeof anchor.ex === "number" && typeof anchor.ey === "number") return { pin: fromElementFraction(element, anchor.ex, anchor.ey), area: null };
      return { pin: { x: anchor.x, y: anchor.y }, area: null };
    }
    case "area": {
      if (element && typeof anchor.ex === "number" && typeof anchor.ey === "number") {
        const w = (anchor.ew ?? anchor.w / Math.max(1, element.w)) * element.w;
        const h = (anchor.eh ?? anchor.h / Math.max(1, element.h)) * element.h;
        const p = fromElementFraction({ ...element, rotation: 0 }, anchor.ex, anchor.ey);
        return { pin: { x: p.x + w, y: p.y }, area: { x: p.x, y: p.y, w, h } };
      }
      return { pin: { x: anchor.x + anchor.w, y: anchor.y }, area: { x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h } };
    }
    case "element":
    case "text": {
      if (!element) return null;
      return { pin: fromElementFraction(element, 1, 0), area: { x: element.x, y: element.y, w: element.w, h: element.h, rotation: element.rotation } };
    }
    default:
      return null;
  }
}
