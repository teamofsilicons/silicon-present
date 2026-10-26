"use client";

/**
 * One slide drawn by `@silicon-present/render` (the one definition of how a slide looks), scaled to fit its box. Used
 * by the history (read-only versions, thumbnails), present mode, the presenter view and follow-along.
 *
 *   <SlideStyles deck={deck} />                                  once per page: the slide CSS and the deck's fonts
 *   <SlideView deck={deck} slide={id} />                          fills the width of its box, keeps the deck's ratio
 *   <SlideView deck={deck} slide={id} step={2} animate />         present mode: step 2 of the click animations, playing
 *   <SlideView deck={deck} slide={id} html="preview" media="static" />   a noninteractive thumbnail
 *
 * HTML elements run live in sandboxed frames (lib/slides/sandbox.ts) unless `html="static"`.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import type { DeckJson } from "@silicon-present/deck";
import { fontCss, renderSlideHtml, slideCss, type RenderOptions } from "@silicon-present/render";
import { assetUrl } from "@/lib/present/files";
import { liveHtmlElements } from "@/lib/slides/sandbox";
import styles from "./slides.module.css";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The slide CSS and the deck's fonts, once per page. */
export function SlideStyles({ deck }: { deck: DeckJson }) {
  const css = useMemo(() => `${fontCss(deck, { assetUrl })}\n${slideCss()}`, [deck]);
  return <style>{css}</style>;
}

export interface SlideViewProps {
  deck: DeckJson;
  slide: string;
  step?: number | "all";
  animate?: boolean;
  /** "preview" renders HTML in the same sandbox while nearby, without pointer or keyboard interaction. */
  html?: RenderOptions["html"] | "preview";
  media?: RenderOptions["media"];
  links?: boolean;
  /** "width": as wide as the box, the deck's ratio (default). "contain": inside the box's width and height. */
  fit?: "width" | "contain";
  className?: string;
  style?: CSSProperties;
  /** An accessible name for the slide picture ("Slide 3 of 12"). */
  label?: string;
  /** A click on an element of the slide (its id), or on the slide (null). */
  onElementClick?: (elementId: string | null, event: ReactMouseEvent) => void;
  /** Elements to mark as selected. */
  selected?: string[];
}

function SlideViewInner({ deck, slide, step = "all", animate = false, html = "live", media = "interactive", links = true, fit = "width", className, style, label, onElementClick, selected }: SlideViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [nearby, setNearby] = useState(false);
  const { width: W, height: H } = deck.size;

  // A long slide strip must not keep every HTML game, animation or chart running offscreen.
  // Removing a preview's frame stops its scripts; returning to it renders its initial state again.
  useEffect(() => {
    if (html !== "preview" || !box.current) return;
    if (typeof IntersectionObserver === "undefined") {
      const frame = requestAnimationFrame(() => setNearby(true));
      return () => cancelAnimationFrame(frame);
    }
    const observer = new IntersectionObserver(entries => {
      setNearby(entries.some(entry => entry.isIntersecting));
    }, { rootMargin: "80px" });
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [html]);
  const renderedHtml = html === "preview" ? nearby ? "live" : "static" : html;

  useIsoLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // The markup does not depend on the step: moving through a slide's click animations only changes two attributes on
  // its root (below), so HTML elements keep running instead of reloading at every click.
  const markup = useMemo(() => {
    try {
      return renderSlideHtml(deck, slide, { assetUrl, step: 0, animate: false, html: renderedHtml, media, links, includeCss: false });
    } catch (error) {
      return `<div style="padding:40px;font:24px system-ui;color:#5c6370">${String((error as Error).message).replace(/</g, "&lt;")}</div>`;
    }
  }, [deck, slide, renderedHtml, media, links]);

  useIsoLayoutEffect(() => {
    const root = stage.current?.querySelector<HTMLElement>(".sp-slide");
    if (!root) return;
    const steps = Number(root.dataset.spSteps ?? 0);
    root.dataset.spAt = step === "all" ? "all" : String(Math.max(0, Math.min(steps, Math.round(step))));
    root.dataset.spAnimate = animate ? "1" : "0";
  }, [markup, step, animate]);

  // HTML elements run in sandbox frames; re-run after every new markup.
  useEffect(() => {
    if (!stage.current || renderedHtml === "static") return;
    return liveHtmlElements(stage.current);
  }, [markup, renderedHtml]);

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    node.querySelectorAll(".sp-el[data-selected]").forEach(element => element.removeAttribute("data-selected"));
    for (const id of selected ?? []) node.querySelector(`.sp-el[data-sp-id="${CSS.escape(id)}"]`)?.setAttribute("data-selected", "");
  }, [markup, selected]);

  const scale = fit === "contain" && size.height ? Math.min(size.width / W, size.height / H) : size.width / W;
  const shownWidth = W * scale;
  const shownHeight = H * scale;
  return (
    <div
      ref={box}
      className={[styles.box, className].filter(Boolean).join(" ")}
      data-fit={fit}
      data-html-preview={html === "preview" ? "" : undefined}
      style={{ ...(fit === "width" ? { aspectRatio: `${W} / ${H}` } : null), ...style }}
      role={label ? "img" : undefined}
      aria-label={label}
      onClick={onElementClick ? event => {
        const element = (event.target as HTMLElement).closest<HTMLElement>(".sp-el[data-sp-id]");
        onElementClick(element?.dataset.spId ?? null, event);
      } : undefined}
    >
      <div
        ref={stage}
        className={styles.stage}
        inert={html === "preview" || undefined}
        style={{ width: W, height: H, transform: `translate(${(size.width - shownWidth) / 2}px, ${fit === "contain" ? (size.height - shownHeight) / 2 : 0}px) scale(${scale || 0.0001})` }}
        dangerouslySetInnerHTML={{ __html: markup }}
      />
    </div>
  );
}

export const SlideView = memo(SlideViewInner);

/** The slides a viewer moves through in present mode: in order, skipped ones left out. */
export function visibleSlides(deck: DeckJson) {
  return deck.slides.filter(slide => !slide.skipped);
}
