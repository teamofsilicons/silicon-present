"use client";

/**
 * One element on the canvas, drawn by @silicon-present/render (the same HTML as present mode, thumbnails, exports), so
 * it looks the same everywhere. The element's position and rotation live on a wrapper React owns; the rendered HTML
 * inside is drawn at 0,0, so moving an element never re-renders it, and a running HTML element keeps running while it
 * is dragged. HTML elements run in /sandbox/html frames (lib/slides/sandbox.ts) instead of srcdoc frames, which this
 * site's CSP would stop.
 */
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { renderElementHtml } from "@silicon-present/render";
import type { Element, Theme } from "@silicon-present/deck";
import { liveHtmlElements } from "@/lib/slides/sandbox";

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
}

function inner(element: Element, theme: Theme, hideText: boolean, html: "live" | "static"): string {
  const atOrigin = { ...element, x: 0, y: 0, rotation: 0, style: { ...element.style, opacity: undefined } } as Element;
  if (hideText && (atOrigin.kind === "text" || atOrigin.kind === "shape")) (atOrigin as { text: unknown }).text = { paragraphs: [] };
  if (hideText && atOrigin.kind === "table") (atOrigin as { cells: unknown }).cells = atOrigin.cells.map(row => row.map(cell => ({ ...cell, text: { paragraphs: [] } })));
  return renderElementHtml(atOrigin, theme, { links: false, placeholders: true, html, media: "static", includeCss: false, googleFonts: false } as never);
}

export const SlideElement = memo(function SlideElement({ element, theme, box, hideText = false, html = "live", runKey = 0, muted = false }: Props) {
  const b = box ?? element;
  // Size changes re-render the inside (a table's rows, a shape's path); position and rotation never do.
  const sized = useMemo(() => ({ ...element, w: b.w, h: b.h }) as Element, [element, b.w, b.h]);
  const markup = useMemo(() => inner(sized, theme, hideText, html), [sized, theme, hideText, html]);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (element.kind !== "html" || html !== "live" || !ref.current) return;
    return liveHtmlElements(ref.current);
    // runKey reruns the element: the markup is the same, so swap again after a forced remount below.
  }, [markup, element.kind, html, runKey]);
  const opacity = element.style?.opacity;
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
      <div ref={ref} key={element.kind === "html" ? `${runKey}` : undefined} style={{ position: "absolute", inset: 0 }} dangerouslySetInnerHTML={{ __html: markup }} />
    </div>
  );
});
