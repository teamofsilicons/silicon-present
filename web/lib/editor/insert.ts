/**
 * New elements: sensible defaults for every kind (placed in the middle of the slide unless a point is given), and
 * inserting uploaded files (images keep their own aspect ratio).
 */
import { richTextFromPlain, type ElementInput, type ShapeName, type Theme } from "@silicon-present/deck";
import type { Editor } from "./editor";

export const DEFAULT_HTML = {
  html: `<div class="card">\n  <h1>Hello from HTML</h1>\n  <p id="clock"></p>\n</div>`,
  css: `.card {\n  height: 100%;\n  display: grid;\n  place-content: center;\n  text-align: center;\n  font-family: system-ui, sans-serif;\n}\nh1 { margin: 0; font-size: 64px; animation: rise 1.2s ease-out both; }\np { font-size: 32px; opacity: .7; }\n@keyframes rise { from { opacity: 0; transform: translateY(24px); } }`,
  js: `const clock = document.getElementById("clock");\nconst tick = () => (clock.textContent = new Date().toLocaleTimeString());\ntick();\nsetInterval(tick, 1000);`,
};

function centered(editor: Editor, w: number, h: number, at?: { x: number; y: number }) {
  const size = editor.deck().size;
  const cx = at?.x ?? size.width / 2;
  const cy = at?.y ?? size.height / 2;
  return { x: Math.round(Math.max(0, Math.min(size.width - w, cx - w / 2))), y: Math.round(Math.max(0, Math.min(size.height - h, cy - h / 2))), w, h };
}

export function textInput(editor: Editor, text = "", at?: { x: number; y: number }): ElementInput {
  return { kind: "text", ...centered(editor, 900, 160, at), text: richTextFromPlain(text), style: { verticalAlign: "top" } };
}

export function shapeInput(editor: Editor, shape: ShapeName, theme: Theme): ElementInput {
  if (shape === "line") return { kind: "shape", shape, ...centered(editor, 600, 4), style: { stroke: theme.colors.text, strokeWidth: 4 }, text: { paragraphs: [] } };
  const square = ["ellipse", "star", "hexagon", "octagon", "pentagon", "heart", "plus", "diamond", "cloud"].includes(shape);
  return { kind: "shape", shape, ...centered(editor, square ? 360 : 480, square ? 360 : 300), style: { fill: theme.colors.accent }, text: { paragraphs: [] } };
}

export function tableInput(editor: Editor, rows = 3, cols = 3): ElementInput {
  const cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ text: { paragraphs: [] }, fill: null })));
  return { kind: "table", ...centered(editor, 1200, rows * 110), rows, cols, headerRow: true, cells };
}

export function chartInput(editor: Editor): ElementInput {
  return {
    kind: "chart",
    ...centered(editor, 1100, 640),
    chart: { type: "column", title: "Revenue", labels: ["Q1", "Q2", "Q3", "Q4"], series: [{ name: "2026", values: [12, 19, 15, 24] }], legend: true },
  };
}

export function htmlInput(editor: Editor): ElementInput {
  return { kind: "html", ...centered(editor, 960, 540), ...DEFAULT_HTML };
}

function imageSize(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

/** Uploads files to the deck and puts each one on the current slide (images, video, audio). Returns the new ids. */
export async function insertFiles(editor: Editor, files: File[], at?: { x: number; y: number }): Promise<string[]> {
  const created: string[] = [];
  const size = editor.deck().size;
  for (const file of files) {
    const type = file.type || "";
    const kind = type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type.startsWith("audio/") ? "audio" : null;
    if (!kind) continue;
    let dims = { w: 960, h: 540 };
    if (kind === "image") {
      const natural = await imageSize(file);
      if (natural) {
        const k = Math.min(1, (size.width * 0.6) / natural.w, (size.height * 0.6) / natural.h);
        dims = { w: Math.round(natural.w * k), h: Math.round(natural.h * k) };
      }
    }
    if (kind === "audio") dims = { w: 640, h: 96 };
    const asset = await editor.upload(file);
    if (!asset) continue;
    const box = centered(editor, dims.w, dims.h, at);
    const name = file.name.replace(/\.[^.]+$/, "");
    const input: ElementInput =
      kind === "image"
        ? { kind, ...box, src: `asset:${asset.id}`, alt: name, fit: "contain" }
        : { kind, ...box, src: `asset:${asset.id}`, alt: name, autoplay: false, loop: false, muted: false, ...(kind === "video" ? { poster: null } : {}) };
    const id = editor.addElement(input, { select: true });
    if (id) created.push(id);
    if (at) at = { x: at.x + 32, y: at.y + 32 };
  }
  if (created.length) editor.select(created);
  return created;
}
