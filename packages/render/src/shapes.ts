// SVG geometry for every shape in docs/architecture.md, computed for the element's own width and height (so shapes
// stretch the way they do in PowerPoint and Google Slides, without distorting stroke widths).

const r = (v: number) => Math.round(v * 100) / 100;

function poly(points: Array<[number, number]>): string {
  return "M" + points.map(([x, y]) => `${r(x)},${r(y)}`).join(" L") + " Z";
}

function regular(sides: number, w: number, h: number, rotate = -Math.PI / 2): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < sides; i++) {
    const a = rotate + (i * 2 * Math.PI) / sides;
    pts.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)]);
  }
  return pts;
}

export interface ShapeGeometry {
  /** SVG path data in the element's coordinate system (0..w, 0..h). */
  d: string;
  /** Lines are stroked only. */
  open?: boolean;
  /** Where text sits inside the shape, as insets in px. */
  text: { top: number; right: number; bottom: number; left: number };
}

export function shapeGeometry(shape: string, w: number, h: number, radius?: number): ShapeGeometry {
  const none = { top: 0, right: 0, bottom: 0, left: 0 };
  const m = Math.min(w, h);
  switch (shape) {
    case "round-rect": {
      const rr = Math.min(radius ?? m * 0.16, w / 2, h / 2);
      return {
        d: `M${r(rr)},0 H${r(w - rr)} A${r(rr)},${r(rr)} 0 0 1 ${r(w)},${r(rr)} V${r(h - rr)} A${r(rr)},${r(rr)} 0 0 1 ${r(w - rr)},${r(h)} H${r(rr)} A${r(rr)},${r(rr)} 0 0 1 0,${r(h - rr)} V${r(rr)} A${r(rr)},${r(rr)} 0 0 1 ${r(rr)},0 Z`,
        text: { top: rr * 0.3, right: rr * 0.3, bottom: rr * 0.3, left: rr * 0.3 },
      };
    }
    case "ellipse":
      return {
        d: `M0,${r(h / 2)} A${r(w / 2)},${r(h / 2)} 0 1 0 ${r(w)},${r(h / 2)} A${r(w / 2)},${r(h / 2)} 0 1 0 0,${r(h / 2)} Z`,
        text: { top: h * 0.146, right: w * 0.146, bottom: h * 0.146, left: w * 0.146 },
      };
    case "triangle":
      return { d: poly([[w / 2, 0], [w, h], [0, h]]), text: { top: h * 0.45, right: w * 0.22, bottom: 0, left: w * 0.22 } };
    case "right-triangle":
      return { d: poly([[0, 0], [w, h], [0, h]]), text: { top: h * 0.45, right: w * 0.45, bottom: 0, left: 0 } };
    case "diamond":
      return { d: poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]), text: { top: h / 4, right: w / 4, bottom: h / 4, left: w / 4 } };
    case "pentagon":
      return { d: poly(regular(5, w, h)), text: { top: h * 0.2, right: w * 0.18, bottom: h * 0.1, left: w * 0.18 } };
    case "hexagon":
      return { d: poly([[w * 0.25, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.25, h], [0, h / 2]]), text: { top: 0, right: w * 0.15, bottom: 0, left: w * 0.15 } };
    case "octagon": {
      const c = 0.29289;
      return {
        d: poly([[w * c, 0], [w * (1 - c), 0], [w, h * c], [w, h * (1 - c)], [w * (1 - c), h], [w * c, h], [0, h * (1 - c)], [0, h * c]]),
        text: { top: h * 0.1, right: w * 0.1, bottom: h * 0.1, left: w * 0.1 },
      };
    }
    case "star": {
      const pts: Array<[number, number]> = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const k = i % 2 === 0 ? 1 : 0.4;
        pts.push([w / 2 + (w / 2) * k * Math.cos(a), h * 0.525 + (h / 2) * k * Math.sin(a)]);
      }
      return { d: poly(pts), text: { top: h * 0.35, right: w * 0.3, bottom: h * 0.2, left: w * 0.3 } };
    }
    case "arrow-right": {
      const head = Math.min(w * 0.45, h * 0.9);
      return { d: poly([[0, h * 0.25], [w - head, h * 0.25], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h * 0.75], [0, h * 0.75]]), text: { top: h * 0.25, right: head * 0.5, bottom: h * 0.25, left: 0 } };
    }
    case "arrow-left": {
      const head = Math.min(w * 0.45, h * 0.9);
      return { d: poly([[w, h * 0.25], [head, h * 0.25], [head, 0], [0, h / 2], [head, h], [head, h * 0.75], [w, h * 0.75]]), text: { top: h * 0.25, right: 0, bottom: h * 0.25, left: head * 0.5 } };
    }
    case "arrow-up": {
      const head = Math.min(h * 0.45, w * 0.9);
      return { d: poly([[w * 0.25, h], [w * 0.25, head], [0, head], [w / 2, 0], [w, head], [w * 0.75, head], [w * 0.75, h]]), text: { top: head * 0.5, right: w * 0.25, bottom: 0, left: w * 0.25 } };
    }
    case "arrow-down": {
      const head = Math.min(h * 0.45, w * 0.9);
      return { d: poly([[w * 0.25, 0], [w * 0.75, 0], [w * 0.75, h - head], [w, h - head], [w / 2, h], [0, h - head], [w * 0.25, h - head]]), text: { top: 0, right: w * 0.25, bottom: head * 0.5, left: w * 0.25 } };
    }
    case "chevron": {
      const k = Math.min(w * 0.4, h * 0.5);
      return { d: poly([[0, 0], [w - k, 0], [w, h / 2], [w - k, h], [0, h], [k, h / 2]]), text: { top: 0, right: k, bottom: 0, left: k } };
    }
    case "line":
      return { d: `M0,0 L${r(w)},${r(h)}`, open: true, text: none };
    case "callout": {
      const bh = h * 0.78;
      const rr = Math.min(m * 0.1, 24);
      return {
        d: `M${r(rr)},0 H${r(w - rr)} Q${r(w)},0 ${r(w)},${r(rr)} V${r(bh - rr)} Q${r(w)},${r(bh)} ${r(w - rr)},${r(bh)} H${r(w * 0.42)} L${r(w * 0.22)},${r(h)} L${r(w * 0.26)},${r(bh)} H${r(rr)} Q0,${r(bh)} 0,${r(bh - rr)} V${r(rr)} Q0,0 ${r(rr)},0 Z`,
        text: { top: 0, right: 0, bottom: h - bh, left: 0 },
      };
    }
    case "heart":
      return {
        d: `M${r(w / 2)},${r(h * 0.28)} C${r(w * 0.5)},${r(h * 0.1)} ${r(w * 0.18)},${r(-h * 0.04)} ${r(w * 0.04)},${r(h * 0.18)} C${r(-w * 0.08)},${r(h * 0.38)} ${r(w * 0.12)},${r(h * 0.62)} ${r(w / 2)},${r(h)} C${r(w * 0.88)},${r(h * 0.62)} ${r(w * 1.08)},${r(h * 0.38)} ${r(w * 0.96)},${r(h * 0.18)} C${r(w * 0.82)},${r(-h * 0.04)} ${r(w * 0.5)},${r(h * 0.1)} ${r(w / 2)},${r(h * 0.28)} Z`,
        text: { top: h * 0.25, right: w * 0.22, bottom: h * 0.25, left: w * 0.22 },
      };
    case "cloud":
      return {
        d: `M${r(w * 0.25)},${r(h * 0.85)} C${r(w * 0.05)},${r(h * 0.85)} ${r(w * 0.0)},${r(h * 0.58)} ${r(w * 0.14)},${r(h * 0.5)} C${r(w * 0.06)},${r(h * 0.3)} ${r(w * 0.26)},${r(h * 0.14)} ${r(w * 0.38)},${r(h * 0.24)} C${r(w * 0.44)},${r(h * 0.04)} ${r(w * 0.7)},${r(h * 0.04)} ${r(w * 0.74)},${r(h * 0.24)} C${r(w * 0.9)},${r(h * 0.18)} ${r(w * 1.0)},${r(h * 0.38)} ${r(w * 0.92)},${r(h * 0.52)} C${r(w * 1.02)},${r(h * 0.66)} ${r(w * 0.94)},${r(h * 0.88)} ${r(w * 0.76)},${r(h * 0.85)} Z`,
        text: { top: h * 0.25, right: w * 0.15, bottom: h * 0.15, left: w * 0.15 },
      };
    case "plus": {
      const a = w * 0.33;
      const b = h * 0.33;
      return { d: poly([[a, 0], [w - a, 0], [w - a, b], [w, b], [w, h - b], [w - a, h - b], [w - a, h], [a, h], [a, h - b], [0, h - b], [0, b], [a, b]]), text: { top: b, right: 0, bottom: b, left: 0 } };
    }
    case "rect":
    default: {
      const rr = Math.min(radius ?? 0, w / 2, h / 2);
      if (rr > 0) return shapeGeometry("round-rect", w, h, rr);
      return { d: `M0,0 H${r(w)} V${r(h)} H0 Z`, text: none };
    }
  }
}
