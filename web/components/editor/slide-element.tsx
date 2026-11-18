"use client";

/**
 * One element on the canvas, drawn by @silicon-present/render (the same HTML as present mode, thumbnails, exports), so
 * it looks the same everywhere. The element's position and rotation live on a wrapper React owns; the rendered HTML
 * inside is drawn at 0,0, so moving an element never re-renders it, and a running HTML element keeps running while it
 * is dragged.
 *
 * HTML elements run in /sandbox/html frames (the same sandbox and protocol as lib/slides/sandbox.ts: a srcdoc frame
 * would inherit this site's CSP, which only runs scripts with its nonce). The shared sandbox handshake retains each
 * frame's document across effect restarts and frame reloads.
 *
 * Empty text boxes show a quiet "Click to add text" to editors, as slide editors do; it is never part of the slide.
 */
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { renderElementHtml } from "@silicon-present/render";
import type { Element, Theme } from "@silicon-present/deck";
import { liveHtmlElements } from "@/lib/slides/sandbox";
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
  /** Not drawn (an HTML element being edited inside: its edit frame is drawn on top instead). */
  hidden?: boolean;
  /** Keep an off-slide HTML element mounted without showing or interacting with it. */
  inactive?: boolean;
  order?: number;
}

function inner(element: Element, theme: Theme, hideText: boolean, html: "live" | "static"): string {
  const atOrigin = { ...element, x: 0, y: 0, rotation: 0, style: { ...element.style, opacity: undefined } } as Element;
  if (hideText && (atOrigin.kind === "text" || atOrigin.kind === "shape")) (atOrigin as { text: unknown }).text = { paragraphs: [] };
  if (hideText && atOrigin.kind === "table") (atOrigin as { cells: unknown }).cells = atOrigin.cells.map(row => row.map(cell => ({ ...cell, text: { paragraphs: [] } })));
  return renderElementHtml(atOrigin, theme, { links: false, placeholders: true, html, deferHtmlDocument: true, media: "static", includeCss: false, googleFonts: false });
}

function isEmptyText(element: Element): boolean {
  if (element.kind !== "text") return false;
  return element.text.paragraphs.every(p => p.runs.every(r => !r.text.trim()));
}

export const SlideElement = memo(function SlideElement({ element, theme, box, hideText = false, html = "live", runKey = 0, muted = false, placeholder = false, hidden = false, inactive = false, order }: Props) {
  const b = box ?? element;
  // Size changes re-render the inside (a table's rows, a shape's path); position and rotation never do.
  const sized = useMemo(() => ({ ...element, w: b.w, h: b.h }) as Element, [element, b.w, b.h]);
  const markup = useMemo(() => inner(sized, theme, hideText, html), [sized, theme, hideText, html]);
  const ref = useRef<HTMLDivElement>(null);
  const previousRun = useRef(runKey);
  useLayoutEffect(() => {
    if (element.kind !== "html" || html !== "live" || !ref.current) return;
    const restart = previousRun.current !== runKey;
    previousRun.current = runKey;
    return liveHtmlElements(ref.current, restart);
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
        visibility: hidden || inactive ? "hidden" : undefined,
        zIndex: order,
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
