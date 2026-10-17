import { type XNode, attr, child, kids, num } from "./xml";

// Custom geometry (a:custGeom: PowerPoint freeforms, LibreOffice custom shapes, template decorations) drawn as an SVG
// picture, so it looks exactly as it did. Guides are evaluated with the DrawingML formula language.

export interface PaintColor {
  hex: string;
  alpha: number;
}

export type Paint =
  | { kind: "none" }
  | { kind: "color"; color: PaintColor }
  | { kind: "linear"; angle: number; stops: Array<{ offset: number; color: PaintColor }> }
  | { kind: "radial"; stops: Array<{ offset: number; color: PaintColor }> };

const ANGLE = 60000; // DrawingML angles are 60000ths of a degree

/** Evaluate a:avLst / a:gdLst guides for a shape of size w x h (EMU). Unknown formulas yield NaN. */
export function guides(geom: XNode | undefined, w: number, h: number): Map<string, number> {
  const g = new Map<string, number>();
  const ss = Math.min(w, h);
  const ls = Math.max(w, h);
  const builtins: Record<string, number> = {
    w, h, l: 0, t: 0, r: w, b: h, hc: w / 2, vc: h / 2, ss, ls,
    wd2: w / 2, wd3: w / 3, wd4: w / 4, wd5: w / 5, wd6: w / 6, wd8: w / 8, wd10: w / 10, wd12: w / 12, wd32: w / 32,
    hd2: h / 2, hd3: h / 3, hd4: h / 4, hd5: h / 5, hd6: h / 6, hd8: h / 8, hd10: h / 10, hd12: h / 12, hd32: h / 32,
    ssd2: ss / 2, ssd4: ss / 4, ssd6: ss / 6, ssd8: ss / 8, ssd16: ss / 16, ssd32: ss / 32,
    cd2: 10800000, cd4: 5400000, cd8: 2700000, "3cd4": 16200000, "3cd8": 8100000, "5cd8": 13500000, "7cd8": 18900000,
  };
  for (const [k, v] of Object.entries(builtins)) g.set(k, v);
  const val = (tok: string): number => {
    if (g.has(tok)) return g.get(tok)!;
    const n = Number(tok);
    return Number.isFinite(n) ? n : NaN;
  };
  const evalFmla = (f: string): number => {
    const [op, ...a] = f.trim().split(/\s+/);
    const x = val(a[0] ?? "0");
    const y = val(a[1] ?? "0");
    const z = val(a[2] ?? "1");
    switch (op) {
      case "val":
        return x;
      case "*/":
        return (x * y) / z;
      case "+-":
        return x + y - z;
      case "+/":
        return (x + y) / z;
      case "?:":
        return x > 0 ? y : z;
      case "abs":
        return Math.abs(x);
      case "sqrt":
        return Math.sqrt(x);
      case "max":
        return Math.max(x, y);
      case "min":
        return Math.min(x, y);
      case "mod":
        return Math.sqrt(x * x + y * y + z * z);
      case "pin":
        return y < x ? x : y > z ? z : y;
      case "sin":
        return x * Math.sin(((y / ANGLE) * Math.PI) / 180);
      case "cos":
        return x * Math.cos(((y / ANGLE) * Math.PI) / 180);
      case "tan":
        return x * Math.tan(((y / ANGLE) * Math.PI) / 180);
      case "at2":
        return ((Math.atan2(y, x) * 180) / Math.PI) * ANGLE;
      case "cat2":
        return x * Math.cos(Math.atan2(z, y));
      case "sat2":
        return x * Math.sin(Math.atan2(z, y));
      default:
        return NaN;
    }
  };
  for (const list of [child(geom, "a:avLst"), child(geom, "a:gdLst")]) {
    for (const gd of kids(list, "a:gd")) {
      const name = attr(gd, "name");
      const f = attr(gd, "fmla");
      if (name && f) g.set(name, evalFmla(f));
    }
  }
  return g;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** SVG path data for one a:path, scaled into a W x H px box. Null if something can't be evaluated. */
function pathData(p: XNode, g: Map<string, number>, shapeW: number, shapeH: number, W: number, H: number): string | null {
  const pw = num(p, "w") || shapeW;
  const ph = num(p, "h") || shapeH;
  const sx = W / (pw || 1);
  const sy = H / (ph || 1);
  const v = (tok: string | undefined): number => {
    if (tok === undefined) return NaN;
    if (g.has(tok)) return g.get(tok)!;
    return Number(tok);
  };
  const pt = (n: XNode | undefined): [number, number] => [v(attr(n, "x")) * sx, v(attr(n, "y")) * sy];
  let d = "";
  let cur: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];
  for (const c of kids(p)) {
    switch (c.name) {
      case "a:moveTo": {
        cur = pt(child(c, "a:pt"));
        start = cur;
        d += `M${r2(cur[0])},${r2(cur[1])} `;
        break;
      }
      case "a:lnTo": {
        cur = pt(child(c, "a:pt"));
        d += `L${r2(cur[0])},${r2(cur[1])} `;
        break;
      }
      case "a:cubicBezTo": {
        const ps = kids(c, "a:pt").map(pt);
        if (ps.length !== 3) return null;
        d += `C${ps.map((q) => `${r2(q[0])},${r2(q[1])}`).join(" ")} `;
        cur = ps[2]!;
        break;
      }
      case "a:quadBezTo": {
        const ps = kids(c, "a:pt").map(pt);
        if (ps.length !== 2) return null;
        d += `Q${ps.map((q) => `${r2(q[0])},${r2(q[1])}`).join(" ")} `;
        cur = ps[1]!;
        break;
      }
      case "a:arcTo": {
        const wR = v(attr(c, "wR")) * sx;
        const hR = v(attr(c, "hR")) * sy;
        const st = (((v(attr(c, "stAng")) / ANGLE) * Math.PI) / 180);
        const sw = (((v(attr(c, "swAng")) / ANGLE) * Math.PI) / 180);
        if (![wR, hR, st, sw].every(Number.isFinite)) return null;
        // the arc starts at the current point, on the ellipse at angle stAng
        const cx = cur[0] - wR * Math.cos(st);
        const cy = cur[1] - hR * Math.sin(st);
        const end: [number, number] = [cx + wR * Math.cos(st + sw), cy + hR * Math.sin(st + sw)];
        const large = Math.abs(sw) > Math.PI ? 1 : 0;
        const sweep = sw > 0 ? 1 : 0;
        if (Math.abs(sw) >= 2 * Math.PI - 1e-6) {
          // a full ellipse: two half arcs
          const mid: [number, number] = [cx + wR * Math.cos(st + Math.PI), cy + hR * Math.sin(st + Math.PI)];
          d += `A${r2(wR)},${r2(hR)} 0 1 ${sweep} ${r2(mid[0])},${r2(mid[1])} A${r2(wR)},${r2(hR)} 0 1 ${sweep} ${r2(end[0])},${r2(end[1])} `;
        } else d += `A${r2(wR)},${r2(hR)} 0 ${large} ${sweep} ${r2(end[0])},${r2(end[1])} `;
        cur = end;
        break;
      }
      case "a:close":
        d += "Z ";
        cur = start;
        break;
    }
  }
  if (/NaN|Infinity/.test(d)) return null;
  return d.trim();
}

function colorAttr(c: PaintColor): string {
  return `${c.hex}"${c.alpha < 0.999 ? ` stop-opacity="${r2(c.alpha)}"` : ""}`;
}

function paintDef(paint: Paint, id: string, W: number, H: number): { def: string; ref: string; opacity?: number } {
  if (paint.kind === "none") return { def: "", ref: "none" };
  if (paint.kind === "color") return { def: "", ref: paint.color.hex, opacity: paint.color.alpha < 0.999 ? paint.color.alpha : undefined };
  const stops = paint.stops.map((s) => `<stop offset="${r2(s.offset)}" stop-color="${colorAttr(s.color)}/>`).join("");
  if (paint.kind === "radial") return { def: `<radialGradient id="${id}" cx="50%" cy="50%" r="70%">${stops}</radialGradient>`, ref: `url(#${id})` };
  // a:lin ang: 0 = left to right, increasing clockwise; drawn across the shape's box
  const a = (paint.angle * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const half = (Math.abs(W * dx) + Math.abs(H * dy)) / 2;
  const x1 = W / 2 - dx * half;
  const y1 = H / 2 - dy * half;
  const x2 = W / 2 + dx * half;
  const y2 = H / 2 + dy * half;
  return { def: `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${r2(x1)}" y1="${r2(y1)}" x2="${r2(x2)}" y2="${r2(y2)}">${stops}</linearGradient>`, ref: `url(#${id})` };
}

export interface SvgPath {
  d: string;
  /** false: this path is never filled (open outlines) */
  fill: boolean;
  /** false: this path is never stroked */
  stroke: boolean;
}

export interface LineStyle {
  color: PaintColor;
  width: number;
  /** arrowheads at the start (head) and end (tail) of open paths */
  head?: boolean;
  tail?: boolean;
}

/** Paths in a W x H px box as a standalone SVG, padded by half the line width so edge strokes aren't cut off. */
export function svgDoc(paths: SvgPath[], W: number, H: number, fill: Paint, line: LineStyle | null): string {
  const fp = paintDef(fill, "f", W, H);
  const pad = line ? line.width / 2 + (line.head || line.tail ? line.width * 2 : 0) : 0;
  const defs: string[] = [];
  if (fp.def) defs.push(fp.def);
  if (line && (line.head || line.tail)) {
    defs.push(`<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="${line.color.hex}"/></marker>`);
  }
  const parts = paths.map((p) => {
    const fillAttr = p.fill ? fp.ref : "none";
    const fo = p.fill && fp.opacity !== undefined ? ` fill-opacity="${r2(fp.opacity)}"` : "";
    const stroke =
      line && p.stroke
        ? ` stroke="${line.color.hex}" stroke-width="${r2(line.width)}" stroke-linejoin="round" stroke-linecap="round"${line.color.alpha < 0.999 ? ` stroke-opacity="${r2(line.color.alpha)}"` : ""}${line.head ? ' marker-start="url(#arrow)"' : ""}${line.tail ? ' marker-end="url(#arrow)"' : ""}`
        : "";
    return `<path d="${p.d}" fill="${fillAttr}"${fo}${stroke} fill-rule="evenodd"/>`;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(W + 2 * pad)}" height="${r2(H + 2 * pad)}" viewBox="${r2(-pad)} ${r2(-pad)} ${r2(W + 2 * pad)} ${r2(H + 2 * pad)}">` +
    (defs.length ? `<defs>${defs.join("")}</defs>` : "") +
    parts.join("") +
    `</svg>`
  );
}

/** How far an SVG from svgDoc reaches outside the W x H box on each side. */
export function svgPad(line: LineStyle | null): number {
  return line ? line.width / 2 + (line.head || line.tail ? line.width * 2 : 0) : 0;
}

/** Mirror path data for flipH / flipV (only absolute M, L, C, Q, A, Z commands, as produced here). */
export function flipPath(d: string, W: number, H: number, flipH: boolean, flipV: boolean): string {
  if (!flipH && !flipV) return d;
  const fx = (x: number) => (flipH ? W - x : x);
  const fy = (y: number) => (flipV ? H - y : y);
  return d.replace(/([MLCQA])([^MLCQAZ]*)/g, (_, cmd: string, args: string) => {
    const n = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === "A") {
      // rx ry rot large sweep x y: mirroring once flips the sweep direction
      const sweep = flipH !== flipV ? 1 - n[4]! : n[4]!;
      return `A${n[0]},${n[1]} ${n[2]} ${n[3]} ${sweep} ${r2(fx(n[5]!))},${r2(fy(n[6]!))} `;
    }
    const out: string[] = [];
    for (let i = 0; i + 1 < n.length; i += 2) out.push(`${r2(fx(n[i]!))},${r2(fy(n[i + 1]!))}`);
    return `${cmd}${out.join(" ")} `;
  });
}

/**
 * The custom geometry as a standalone SVG of W x H px (the element's size), with its fill and line. Null when the
 * geometry uses something we can't evaluate (the caller then pictures it from LibreOffice's render instead).
 */
export function custGeomSvg(geom: XNode, shapeW: number, shapeH: number, W: number, H: number, fill: Paint, line: LineStyle | null, flip: { h: boolean; v: boolean } = { h: false, v: false }): string | null {
  const g = guides(geom, shapeW, shapeH);
  const paths = kids(child(geom, "a:pathLst"), "a:path");
  if (!paths.length) return null;
  const out: SvgPath[] = [];
  for (const p of paths) {
    const d = pathData(p, g, shapeW, shapeH, W, H);
    if (d === null) return null;
    out.push({ d: flipPath(d, W, H, flip.h, flip.v), fill: attr(p, "fill") !== "none", stroke: attr(p, "stroke") !== "false" });
  }
  return svgDoc(out, W, H, fill, line);
}

/** Connector geometry (bent and curved connectors) as path data in a W x H box; null for unknown presets. */
export function connectorPath(prst: string, W: number, H: number, adj: number | undefined): string | null {
  const a = (adj ?? 50000) / 100000;
  switch (prst) {
    case "bentConnector2":
      return `M0,0 L${r2(W)},0 L${r2(W)},${r2(H)}`;
    case "bentConnector3":
    case "bentConnector4":
    case "bentConnector5":
      return `M0,0 L${r2(W * a)},0 L${r2(W * a)},${r2(H)} L${r2(W)},${r2(H)}`;
    case "curvedConnector2":
      return `M0,0 Q${r2(W)},0 ${r2(W)},${r2(H)}`;
    case "curvedConnector3":
    case "curvedConnector4":
    case "curvedConnector5":
      return `M0,0 C${r2(W * a)},0 ${r2(W * a)},${r2(H)} ${r2(W)},${r2(H)}`;
    case "straightConnector1":
    case "line":
      return `M0,0 L${r2(W)},${r2(H)}`;
    default:
      return null;
  }
}
