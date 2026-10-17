"use client";

/**
 * One element on the canvas, drawn by @silicon-present/render (the same HTML as present mode, thumbnails, exports), so
 * it looks the same everywhere. The element's position and rotation live on a wrapper React owns; the rendered HTML
 * inside is drawn at 0,0, so moving an element never re-renders it, and a running HTML element keeps running while it
 * is dragged.
 *
 * HTML elements run in /sandbox/html frames (the same sandbox and protocol as lib/slides/sandbox.ts: a srcdoc frame
 * would inherit this site's CSP, which only runs scripts with its nonce). Here each frame keeps its document on the
 * node and is (re)loaded by an effect that can run twice (React's strict mode) without losing it.
 *
 * Empty text boxes show a quiet "Click to add text" to editors, as slide editors do; it is never part of the slide.
 */
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { renderElementHtml } from "@silicon-present/render";
import type { Element, Theme } from "@silicon-present/deck";
import styles from "./editor.module.css";

export interface ElementBox {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

interface Props {
  element: Element;
  theme: Theme;
  /** The live box while it is dragged, resized or rotated (not yet in the doc). */
  box?: ElementBox | null;
  /** Leave the element's text out (its text is being edited in place on top). */
  hideText?: boolean;
  /** HTML elements: "live" runs them, "static" draws a quiet placeholder (paused). */
  html?: "live" | "static";
  /** Changing it reruns a live HTML element. */
  runKey?: number;
  /** Dimmed (master elements while editing a slide are drawn but not selectable). */
  muted?: boolean;
  /** Show "Click to add text" in an empty text box (editors). */
  placeholder?: boolean;
}

const READY = "present:sandbox-ready";
let loads = 0;

function inner(element: Element, theme: Theme, hideText: boolean, html: "live" | "static"): string {
  const atOrigin = { ...element, x: 0, y: 0, rotation: 0, style: { ...element.style, opacity: undefined } } as Element;
  if (hideText && (atOrigin.kind === "text" || atOrigin.kind === "shape")) (atOrigin as { text: unknown }).text = { paragraphs: [] };
  if (hideText && atOrigin.kind === "table") (atOrigin as { cells: unknown }).cells = atOrigin.cells.map(row => row.map(cell => ({ ...cell, text: { paragraphs: [] } })));
  return renderElementHtml(atOrigin, theme, { links: false, placeholders: true, html, media: "static", includeCss: false, googleFonts: false });
}

type DocFrame = HTMLIFrameElement & { __presentDoc?: string };

/** Loads every HTML element frame under `root` from /sandbox/html and hands it its document. */
function runFrames(root: HTMLElement): () => void {
  const frames = Array.from(root.querySelectorAll<DocFrame>("iframe.sp-html"));
  const waiting = new Map<DocFrame, string>();
  for (const frame of frames) {
    const doc = frame.getAttribute("srcdoc") ?? frame.__presentDoc;
    if (doc === undefined) continue;
    frame.__presentDoc = doc;
    frame.removeAttribute("srcdoc");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.dataset.live = "";
    waiting.set(frame, doc);
    frame.src = `/sandbox/html?load=${++loads}`;
  }
  if (!waiting.size) return () => undefined;
  const onMessage = (event: MessageEvent) => {
    if (!event.data || event.data.type !== READY) return;
    for (const [frame, doc] of waiting) {
      if (frame.contentWindow !== event.source) continue;
      waiting.delete(frame);
      frame.contentWindow?.postMessage({ type: "present:html", doc }, "*");
    }
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

function isEmptyText(element: Element): boolean {
  if (element.kind !== "text") return false;
  return element.text.paragraphs.every(p => p.runs.every(r => !r.text.trim()));
}

export const SlideElement = memo(function SlideElement({ element, theme, box, hideText = false, html = "live", runKey = 0, muted = false, placeholder = false }: Props) {
  const b = box ?? element;
  // Size changes re-render the inside (a table's rows, a shape's path); position and rotation never do.
  const sized = useMemo(() => ({ ...element, w: b.w, h: b.h }) as Element, [element, b.w, b.h]);
  const markup = useMemo(() => inner(sized, theme, hideText, html), [sized, theme, hideText, html]);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (element.kind !== "html" || html !== "live" || !ref.current) return;
    return runFrames(ref.current);
  }, [markup, element.kind, html, runKey]);
  const opacity = element.style?.opacity;
  const empty = placeholder && !hideText && isEmptyText(element);
  const heading = element.kind === "text" && element.text.paragraphs[0]?.heading;
  return (
    <div
      className="sp-ed-el"
      data-element-id={element.id}
      data-kind={element.kind}
      style={{
        position: "absolute",
        left: b.x,
        top: b.y,
        width: b.w,
        height: b.h,
        transform: b.rotation ? `rotate(${b.rotation}deg)` : undefined,
        opacity: muted ? 0.55 : typeof opacity === "number" && opacity < 1 ? Math.max(0, opacity) : undefined,
      }}
    >
      <div ref={ref} style={{ position: "absolute", inset: 0 }} dangerouslySetInnerHTML={{ __html: markup }} />
      {empty ? (
        <div className={styles.emptyText} data-heading={heading || undefined} aria-hidden="true">
          {heading ? "Click to add title" : "Click to add text"}
        </div>
      ) : null}
    </div>
  );
});
