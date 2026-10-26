"use client";

/**
 * Editing the inside of an HTML element on the canvas (double-click it): its own html and css drawn in the
 * /sandbox/html-edit frame (app/sandbox/html-edit/route.ts) without its JS, on top of the canvas at the element's box.
 * A click selects a part, a drag moves it, a double-click on text types into it; the toolbar's HTML tools restyle or
 * delete the selected part. Each change goes into the element's `html` through the editor (lib/editor/html-inside.ts:
 * one minimal splice, one undo step, live for everyone), and the frame redraws from the new source.
 *
 * The frame is sandboxed like every HTML element (allow-scripts only, an opaque origin). Only messages from this
 * frame's window with an opaque origin are read, and each is checked: the revision it was drawn from, part numbers,
 * numbers and strings. Nothing from the frame is ever put into this page as HTML.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { htmlElementBaseCss, renderElementHtml } from "@silicon-present/render";
import type { Element, Theme } from "@silicon-present/deck";
import { cssColorToHex, markParts, partNames, type PartChange } from "@/lib/editor/html-inside";
import type { HtmlPartInfo } from "@/lib/editor/editor";
import { notify } from "@/lib/notify";
import { useEditor } from "./editor-context";

type HtmlElement = Extract<Element, { kind: "html" }>;

const MAX_PART = 1_000_000;

function partNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < MAX_PART ? value : null;
}

function readInfo(value: unknown): HtmlPartInfo | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const size = typeof v.fontSize === "number" && Number.isFinite(v.fontSize) ? Math.max(1, Math.min(2000, Math.round(v.fontSize * 10) / 10)) : null;
  const weight = typeof v.fontWeight === "string" ? v.fontWeight : "";
  return {
    tag: typeof v.tag === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(v.tag) ? v.tag : "part",
    text: v.text === true,
    color: cssColorToHex(v.color),
    background: cssColorToHex(v.background),
    fontSize: size,
    bold: weight === "bold" || Number(weight) >= 600,
    italic: v.fontStyle === "italic" || v.fontStyle === "oblique",
  };
}

function readChange(value: unknown): PartChange | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const part = partNumber(v.part);
  if (part === null) return null;
  if (v.kind === "move" && typeof v.dx === "number" && typeof v.dy === "number" && Number.isFinite(v.dx) && Number.isFinite(v.dy)) {
    const clamp = (n: number) => Math.max(-10_000, Math.min(10_000, n));
    return { kind: "move", part, dx: clamp(v.dx), dy: clamp(v.dy) };
  }
  if (v.kind === "text" && Array.isArray(v.texts) && v.texts.length <= 10_000 && v.texts.every(t => typeof t === "string")) {
    return { kind: "text", part, texts: v.texts as string[] };
  }
  return null;
}

export const HtmlInside = memo(function HtmlInside({ element, theme }: { element: HtmlElement; theme: Theme }) {
  const editor = useEditor();
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  /** What the frame shows: its revision, the html it was drawn from; whether it is ready, and typing (no redraws). */
  const shown = useRef({ ready: false, typing: false, rev: 0, html: "" });
  const base = useMemo(() => htmlElementBaseCss(theme), [theme]);
  const source = useRef({ html: element.html, css: element.css, base });
  // The box (its fill, border, corners) as the element draws it, with no document: the frame below gets the source.
  const markup = useMemo(() => {
    const empty = { ...element, html: "", css: "", js: "", x: 0, y: 0, rotation: 0, style: { ...element.style, opacity: undefined } } as Element;
    return renderElementHtml(empty, theme, { links: false, html: "live", includeCss: false, googleFonts: false });
    // Only what changes the box redraws it (and reloads the frame); the source travels by message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element.w, element.h, element.style, theme]);

  const post = useCallback(() => {
    const s = shown.current;
    const win = frame.current?.contentWindow;
    if (!s.ready || s.typing || !win) return;
    const { html, css, base } = source.current;
    s.rev += 1;
    s.html = html;
    const selected = editor.ui.get().htmlInside?.part ?? null;
    win.postMessage({ type: "present:edit-doc", rev: s.rev, base, css, html: markParts(html), selected }, "*");
  }, [editor]);

  useLayoutEffect(() => {
    const node = ref.current?.querySelector<HTMLIFrameElement>("iframe.sp-html");
    if (!node) return;
    node.removeAttribute("srcdoc");
    node.setAttribute("sandbox", "allow-scripts");
    node.setAttribute("title", "Editing the HTML element");
    node.dataset.testid = "html-inside-frame";
    node.src = "/sandbox/html-edit";
    frame.current = node;
    shown.current = { ...shown.current, ready: false, typing: false };
  }, [markup]);

  useEffect(() => {
    source.current = { html: element.html, css: element.css, base };
    post();
  }, [element.html, element.css, base, post]);

  useEffect(() => {
    const id = element.id;
    const onMessage = (event: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || event.source !== win || event.origin !== "null") return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== "object" || typeof data.type !== "string") return;
      const s = shown.current;
      if (data.type === "present:edit-ready") {
        s.ready = true;
        s.typing = false;
        post();
        return;
      }
      if (data.rev !== s.rev) return;
      const inside = editor.ui.get().htmlInside;
      if (!inside || inside.elementId !== id) return;
      if (data.type === "present:edit-select") {
        const part = partNumber(data.part);
        editor.ui.set({ htmlInside: { ...inside, part, info: part === null ? null : readInfo(data.info) } });
      } else if (data.type === "present:edit-typing") {
        s.typing = data.typing === true;
        // Someone else's change waited while this Carbon typed: show it now.
        if (!s.typing && source.current.html !== s.html) post();
      } else if (data.type === "present:edit-change") {
        const change = readChange(data.change);
        if (!change) return;
        // Parts are numbered in the source the frame shows; a change made meanwhile must not shift them.
        const now = editor.textField(editor.currentSlideId() ?? "", id, "html")?.toString() ?? "";
        if (now !== s.html && partNames(now) !== partNames(s.html)) {
          notify.info("That change was not made", "Someone changed this HTML element at the same time. Try it again.");
          post();
          return;
        }
        // A change that couldn't be made leaves the frame as the source still is (a dragged part goes back).
        if (!editor.changeHtmlInside(change)) post();
      } else if (data.type === "present:edit-key") {
        const key = data.key;
        if (key === "Escape") editor.exitHtmlInside();
        else if (key === "undo") editor.undo();
        else if (key === "redo") editor.redo();
        else if (inside.part !== null && key === "Delete") editor.changeHtmlInside({ kind: "delete", part: inside.part });
        else if (inside.part !== null && typeof key === "string" && /^Arrow(Left|Right|Up|Down)$/.test(key)) {
          const step = data.shift === true ? 10 : 1;
          editor.changeHtmlInside({ kind: "move", part: inside.part, dx: key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0, dy: key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0 });
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [editor, element.id, post]);

  return (
    <div
      data-no-canvas=""
      data-testid="html-inside"
      data-inside-id={element.id}
      style={{
        position: "absolute",
        left: element.x,
        top: element.y,
        width: element.w,
        height: element.h,
        transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined,
        // Above the canvas overlay (as the text editor is), so the frame gets the pointer.
        zIndex: 40,
      }}
    >
      <div ref={ref} style={{ position: "absolute", inset: 0 }} dangerouslySetInnerHTML={{ __html: markup }} />
    </div>
  );
});
