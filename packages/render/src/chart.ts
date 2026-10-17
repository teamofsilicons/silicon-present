import { luminance, mix, seriesPalette } from "@silicon-present/deck";
import type { Chart, Theme } from "@silicon-present/deck";
import { color, escapeHtml, fontStack, n } from "./safe";

// Charts as inline SVG (bar, column, line, area, pie, donut, scatter), with an optional title and legend.
// No chart library: the same SVG is used in the editor, present mode, screenshots, PDF and HTML export.

interface Ctx {
  theme: Theme;
  fs: number;
  text: string;
  muted: string;
  grid: string;
  font: string;
}

const textW = (s: string, fs: number) => s.length * fs * 0.56;

function niceStep(range: number, ticks: number): number {
  const raw = range / Math.max(1, ticks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

export function niceScale(min: number, max: number, ticks = 5): { min: number; max: number; step: number; values: number[] } {
  if (min === max) {
    if (max === 0) max = 1;
    else if (max > 0) min = 0;
    else max = 0;
  }
  const step = niceStep(max - min, ticks);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const values: number[] = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) values.push(Math.round(v * 1e6) / 1e6);
  return { min: lo, max: hi, step, values };
}

export function formatNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return trim(v / 1e9) + "B";
  if (a >= 1e6) return trim(v / 1e6) + "M";
  if (a >= 1e4) return trim(v / 1e3) + "k";
  return trim(v);
}
function trim(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function t(x: number, y: number, s: string, c: Ctx, opts: { anchor?: "start" | "middle" | "end"; size?: number; fill?: string; weight?: number; baseline?: string } = {}): string {
  return `<text x="${n(x)}" y="${n(y)}" font-size="${n(opts.size ?? c.fs)}" fill="${opts.fill ?? c.muted}" text-anchor="${opts.anchor ?? "start"}"${opts.weight ? ` font-weight="${opts.weight}"` : ""} dominant-baseline="${opts.baseline ?? "middle"}">${escapeHtml(s)}</text>`;
}

export function chartSvg(chart: Chart, w: number, h: number, theme: Theme): string {
  const fs = Math.max(16, Math.min(28, Math.min(w, h) * 0.06));
  const c: Ctx = {
    theme,
    fs,
    text: theme.colors.text,
    muted: mix(theme.colors.text, theme.colors.background, 0.35),
    grid: mix(theme.colors.text, theme.colors.background, 0.88),
    font: fontStack(theme.fonts.body),
  };
  const palette = seriesPalette(theme);
  // series without a colour take the next palette colour no other series uses explicitly
  const used = new Set((chart.series ?? []).map((s) => (typeof s.color === "string" ? s.color.toLowerCase() : "")));
  const free = palette.filter((p) => !used.has(p.toLowerCase()));
  let nextFree = 0;
  const series = (chart.series ?? []).map((s) => ({ ...s, values: (s.values ?? []).map((v) => n(v)), color: color(s.color, "") || free[nextFree++ % Math.max(1, free.length)] || palette[0]! }));
  const labels = (chart.labels ?? []).map(String);
  const pie = chart.type === "pie" || chart.type === "donut";
  const pad = fs * 0.8;
  let top = pad;
  let bottom = h - pad;
  const parts: string[] = [];

  if (chart.title) {
    const ts = fs * 1.3;
    parts.push(t(w / 2, top + ts / 2, chart.title, c, { anchor: "middle", size: ts, fill: c.text, weight: 600 }));
    top += ts * 1.6;
  }

  // legend: one row of swatches at the bottom, wrapping to more rows if needed
  const legendItems = chart.legend ? (pie ? labels.map((l, i) => ({ name: l, color: palette[i % palette.length]! })) : series.map((s) => ({ name: s.name, color: s.color }))) : [];
  if (legendItems.length) {
    const sw = fs * 0.8;
    const gap = fs * 1.2;
    const rows: Array<Array<{ name: string; color: string; w: number }>> = [[]];
    let rowW = 0;
    for (const it of legendItems) {
      const iw = sw + fs * 0.4 + textW(it.name, fs);
      if (rowW + iw > w - pad * 2 && rows[rows.length - 1]!.length) {
        rows.push([]);
        rowW = 0;
      }
      rows[rows.length - 1]!.push({ ...it, w: iw });
      rowW += iw + gap;
    }
    const lh = fs * 1.5;
    bottom -= rows.length * lh;
    rows.forEach((row, ri) => {
      const total = row.reduce((s, it) => s + it.w, 0) + gap * (row.length - 1);
      let x = (w - total) / 2;
      const y = bottom + lh * (ri + 0.5) + fs * 0.4;
      for (const it of row) {
        parts.push(`<rect x="${n(x)}" y="${n(y - sw / 2)}" width="${n(sw)}" height="${n(sw)}" rx="${n(sw * 0.2)}" fill="${it.color}"/>`);
        parts.push(t(x + sw + fs * 0.4, y, it.name, c, { fill: c.text }));
        x += it.w + gap;
      }
    });
    bottom -= fs * 0.4;
  }

  const plot = { x: pad, y: top, w: w - pad * 2, h: Math.max(10, bottom - top) };
  if (pie) parts.push(pieChart(chart.type === "donut", labels, series[0]?.values ?? [], palette, plot, c));
  else if (chart.type === "bar") parts.push(barChart(labels, series, plot, c));
  else if (chart.type === "scatter") parts.push(scatterChart(labels, series, plot, c));
  else parts.push(axisChart(chart.type, labels, series, plot, c));

  return `<svg class="sp-chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="100%" height="100%" font-family="${escapeHtml(c.font)}">${parts.join("")}</svg>`;
}

type S = { name: string; values: number[]; color: string };

function axisChart(type: string, labels: string[], series: S[], p: { x: number; y: number; w: number; h: number }, c: Ctx): string {
  const all = series.flatMap((s) => s.values);
  const sc = niceScale(Math.min(0, ...all), Math.max(0, ...all, 0));
  const axisW = Math.max(...sc.values.map((v) => textW(formatNumber(v), c.fs))) + c.fs * 0.6;
  const x0 = p.x + axisW;
  const pw = p.w - axisW;
  const ph = p.h - c.fs * 1.6;
  const y = (v: number) => p.y + ph - ((v - sc.min) / (sc.max - sc.min)) * ph;
  const out: string[] = [];
  for (const v of sc.values) {
    out.push(`<line x1="${n(x0)}" x2="${n(x0 + pw)}" y1="${n(y(v))}" y2="${n(y(v))}" stroke="${v === 0 ? c.muted : c.grid}" stroke-width="${v === 0 ? 1.5 : 1}"/>`);
    out.push(t(x0 - c.fs * 0.4, y(v), formatNumber(v), c, { anchor: "end" }));
  }
  const count = Math.max(labels.length, ...series.map((s) => s.values.length), 1);
  const band = pw / count;
  for (let i = 0; i < count; i++) {
    const lab = labels[i] ?? "";
    const maxChars = Math.max(1, Math.floor(band / (c.fs * 0.56)));
    out.push(t(x0 + band * (i + 0.5), p.y + ph + c.fs * 0.9, lab.length > maxChars ? lab.slice(0, Math.max(1, maxChars - 1)) + "…" : lab, c, { anchor: "middle" }));
  }
  if (type === "column") {
    const inner = band * 0.72;
    const bw = inner / Math.max(1, series.length);
    series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const bx = x0 + band * i + (band - inner) / 2 + bw * si;
        const y1 = y(Math.max(0, v));
        const y2 = y(Math.min(0, v));
        out.push(`<rect x="${n(bx + bw * 0.06)}" y="${n(y1)}" width="${n(bw * 0.88)}" height="${n(Math.max(0, y2 - y1))}" rx="${n(Math.min(4, bw * 0.1))}" fill="${s.color}"/>`);
      });
    });
  } else {
    series.forEach((s) => {
      const pts = s.values.map((v, i) => [x0 + band * (i + 0.5), y(v)] as const);
      if (!pts.length) return;
      const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${n(px)},${n(py)}`).join(" ");
      if (type === "area") {
        const base = y(Math.max(sc.min, 0));
        out.push(`<path d="${line} L${n(pts[pts.length - 1]![0])},${n(base)} L${n(pts[0]![0])},${n(base)} Z" fill="${s.color}" fill-opacity="0.22"/>`);
      }
      out.push(`<path d="${line}" fill="none" stroke="${s.color}" stroke-width="${n(Math.max(2, c.fs * 0.16))}" stroke-linejoin="round" stroke-linecap="round"/>`);
      if (type === "line") for (const [px, py] of pts) out.push(`<circle cx="${n(px)}" cy="${n(py)}" r="${n(c.fs * 0.22)}" fill="${s.color}"/>`);
    });
  }
  return out.join("");
}

function barChart(labels: string[], series: S[], p: { x: number; y: number; w: number; h: number }, c: Ctx): string {
  const all = series.flatMap((s) => s.values);
  const sc = niceScale(Math.min(0, ...all), Math.max(0, ...all, 0));
  const labW = Math.min(p.w * 0.35, Math.max(0, ...labels.map((l) => textW(l, c.fs))) + c.fs * 0.6);
  const x0 = p.x + labW;
  const pw = p.w - labW - c.fs;
  const ph = p.h - c.fs * 1.6;
  const x = (v: number) => x0 + ((v - sc.min) / (sc.max - sc.min)) * pw;
  const out: string[] = [];
  for (const v of sc.values) {
    out.push(`<line x1="${n(x(v))}" x2="${n(x(v))}" y1="${n(p.y)}" y2="${n(p.y + ph)}" stroke="${v === 0 ? c.muted : c.grid}" stroke-width="${v === 0 ? 1.5 : 1}"/>`);
    out.push(t(x(v), p.y + ph + c.fs * 0.9, formatNumber(v), c, { anchor: "middle" }));
  }
  const count = Math.max(labels.length, ...series.map((s) => s.values.length), 1);
  const band = ph / count;
  const inner = band * 0.72;
  const bh = inner / Math.max(1, series.length);
  for (let i = 0; i < count; i++) out.push(t(x0 - c.fs * 0.4, p.y + band * (i + 0.5), labels[i] ?? "", c, { anchor: "end" }));
  series.forEach((s, si) =>
    s.values.forEach((v, i) => {
      const by = p.y + band * i + (band - inner) / 2 + bh * si;
      const a = x(Math.min(0, v));
      const b = x(Math.max(0, v));
      out.push(`<rect x="${n(a)}" y="${n(by + bh * 0.06)}" width="${n(Math.max(0, b - a))}" height="${n(bh * 0.88)}" rx="${n(Math.min(4, bh * 0.1))}" fill="${s.color}"/>`);
    }),
  );
  return out.join("");
}

function scatterChart(labels: string[], series: S[], p: { x: number; y: number; w: number; h: number }, c: Ctx): string {
  const xs = labels.map((l, i) => {
    const v = Number(l);
    return Number.isFinite(v) ? v : i + 1;
  });
  const count = Math.max(...series.map((s) => s.values.length), 0);
  while (xs.length < count) xs.push(xs.length + 1);
  const ys = series.flatMap((s) => s.values);
  const sy = niceScale(Math.min(0, ...ys), Math.max(0, ...ys, 0));
  const sx = niceScale(Math.min(...xs, 0), Math.max(...xs, 1));
  const axisW = Math.max(...sy.values.map((v) => textW(formatNumber(v), c.fs))) + c.fs * 0.6;
  const x0 = p.x + axisW;
  const pw = p.w - axisW - c.fs;
  const ph = p.h - c.fs * 1.6;
  const X = (v: number) => x0 + ((v - sx.min) / (sx.max - sx.min)) * pw;
  const Y = (v: number) => p.y + ph - ((v - sy.min) / (sy.max - sy.min)) * ph;
  const out: string[] = [];
  for (const v of sy.values) {
    out.push(`<line x1="${n(x0)}" x2="${n(x0 + pw)}" y1="${n(Y(v))}" y2="${n(Y(v))}" stroke="${c.grid}"/>`);
    out.push(t(x0 - c.fs * 0.4, Y(v), formatNumber(v), c, { anchor: "end" }));
  }
  for (const v of sx.values) {
    out.push(`<line x1="${n(X(v))}" x2="${n(X(v))}" y1="${n(p.y)}" y2="${n(p.y + ph)}" stroke="${c.grid}"/>`);
    out.push(t(X(v), p.y + ph + c.fs * 0.9, formatNumber(v), c, { anchor: "middle" }));
  }
  series.forEach((s) => s.values.forEach((v, i) => out.push(`<circle cx="${n(X(xs[i]!))}" cy="${n(Y(v))}" r="${n(c.fs * 0.32)}" fill="${s.color}" fill-opacity="0.85"/>`)));
  return out.join("");
}

function pieChart(donut: boolean, labels: string[], values: number[], palette: string[], p: { x: number; y: number; w: number; h: number }, c: Ctx): string {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  const rad = Math.max(1, Math.min(p.w, p.h) / 2);
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  const inner = donut ? rad * 0.58 : 0;
  const out: string[] = [];
  if (total <= 0) {
    out.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(rad)}" fill="${c.grid}"/>`);
    return out.join("");
  }
  let a = -Math.PI / 2;
  values.forEach((v, i) => {
    const frac = Math.max(0, v) / total;
    if (frac <= 0) return;
    const b = a + frac * Math.PI * 2;
    const col = palette[i % palette.length]!;
    if (frac >= 0.9999) {
      out.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(rad)}" fill="${col}"/>`);
    } else {
      const large = b - a > Math.PI ? 1 : 0;
      const p1 = [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
      const p2 = [cx + rad * Math.cos(b), cy + rad * Math.sin(b)];
      if (inner) {
        const q1 = [cx + inner * Math.cos(b), cy + inner * Math.sin(b)];
        const q2 = [cx + inner * Math.cos(a), cy + inner * Math.sin(a)];
        out.push(`<path d="M${n(p1[0])},${n(p1[1])} A${n(rad)},${n(rad)} 0 ${large} 1 ${n(p2[0])},${n(p2[1])} L${n(q1[0])},${n(q1[1])} A${n(inner)},${n(inner)} 0 ${large} 0 ${n(q2[0])},${n(q2[1])} Z" fill="${col}" stroke="${c.theme.colors.background}" stroke-width="2"/>`);
      } else {
        out.push(`<path d="M${n(cx)},${n(cy)} L${n(p1[0])},${n(p1[1])} A${n(rad)},${n(rad)} 0 ${large} 1 ${n(p2[0])},${n(p2[1])} Z" fill="${col}" stroke="${c.theme.colors.background}" stroke-width="2"/>`);
      }
    }
    if (frac > 0.06) {
      const mid = (a + b) / 2;
      const lr = inner ? (rad + inner) / 2 : rad * 0.62;
      out.push(t(cx + lr * Math.cos(mid), cy + lr * Math.sin(mid), `${Math.round(frac * 100)}%`, c, { anchor: "middle", fill: luminance(col) > 0.45 ? "#1b1b1f" : "#ffffff", weight: 600 }));
    }
    a = b;
  });
  void labels;
  return out.join("");
}
