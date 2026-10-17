"use client";

/**
 * Present mode: the deck full screen, one slide at a time. Next with →, ↓, Space, Page Down, Enter, a click or a tap
 * on the right of the slide, a swipe left; back with ←, ↑, Page Up, Backspace, a tap on the left, a swipe right; Home
 * and End; F for full screen; Escape to leave. Click animations play step by step and slide transitions play between
 * slides (both from `@silicon-present/render`), skipped slides are skipped, and HTML elements run live.
 *
 * A quiet bar at the bottom (it fades when the pointer rests) has the slide number, the presenter view, a follow
 * link anyone can follow live, full screen and leave. The presenter view and this window move together.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight, Link2, Maximize, Minimize, MonitorPlay, X } from "lucide-react";
import type { DeckJson } from "@silicon-present/deck";
import { transitionCss } from "@silicon-present/render";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { SlideStyles, SlideView } from "@/components/slides/slide-view";
import { followPath } from "@/lib/present/presentations";
import { usePresentation, type Move } from "./use-presentation";
import styles from "./present.module.css";

export interface PresentModeProps {
  deckId: string;
  title: string;
  deck: DeckJson;
  signedIn: boolean;
  initialSlide?: string | null;
}

/** Keys that move a presentation, for present mode and the presenter view. */
export function presentKeys(event: KeyboardEvent, controls: { next: () => void; previous: () => void; firstSlide: () => void; lastSlide: () => void }): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return false;
  switch (event.key) {
    case "ArrowRight": case "ArrowDown": case "PageDown": case " ": case "Enter": case "n": case "N":
      if (event.key === "Enter" && target?.closest("button, a")) return false;
      controls.next();
      return true;
    case "ArrowLeft": case "ArrowUp": case "PageUp": case "Backspace": case "p": case "P":
      controls.previous();
      return true;
    case "Home":
      controls.firstSlide();
      return true;
    case "End":
      controls.lastSlide();
      return true;
    default:
      return false;
  }
}

/** The slide on stage, with the outgoing one underneath while a transition plays. */
export function Stage({ deck, move, html = "live", label }: { deck: DeckJson; move: Move; html?: "live" | "static"; label: string }) {
  const incoming = deck.slides.find(slide => slide.id === move.to.slide);
  const css = move.transition && move.from && !move.to.ended && move.from.slide !== move.to.slide ? transitionCss(incoming?.transition) : null;
  // The move whose transition has finished playing: from then on only the incoming slide is drawn.
  const [finished, setFinished] = useState<Move | null>(null);
  useEffect(() => {
    if (!css) return;
    const timer = window.setTimeout(() => setFinished(move), css.duration + 50);
    return () => window.clearTimeout(timer);
  }, [move, css]);
  const playing = !!css && finished !== move;
  const outgoing = playing ? move.from : null;
  const key = `${move.to.slide}`;

  if (move.to.ended) {
    return <div className={styles.end}><p>End of the presentation.</p><p className={styles.endHint}>Press Escape to leave, or ← to go back.</p></div>;
  }
  return (
    <div className={styles.stage}>
      {outgoing && css ? (
        <div className={styles.layer} style={{ animation: css.out || undefined, zIndex: 0 }} aria-hidden="true">
          <SlideView deck={deck} slide={outgoing.slide} step={outgoing.step} fit="contain" html="static" media="static" />
        </div>
      ) : null}
      <div key={key} className={styles.layer} style={{ animation: playing && css ? css.in : undefined, zIndex: 1 }}>
        <SlideView deck={deck} slide={move.to.slide} step={move.to.step} animate={move.animate} fit="contain" html={html} label={label} />
      </div>
    </div>
  );
}

export function PresentMode({ deckId, title, deck, signedIn, initialSlide }: PresentModeProps) {
  const router = useRouter();
  const controls = usePresentation(deck, deckId, { initialSlide });
  const { move, position, index, visible, next, previous, firstSlide, lastSlide, goTo, followId, followBusy, startFollow, stopFollow } = controls;
  const root = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [showFollow, setShowFollow] = useState(false);
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const idleTimer = useRef<number | undefined>(undefined);

  const leave = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    if (window.opener && window.name === `present-${deckId}`) window.close();
    else router.push(`/decks/${encodeURIComponent(deckId)}`);
  }, [deckId, router]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void root.current?.requestFullscreen?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (presentKeys(event, { next, previous, firstSlide, lastSlide })) {
        event.preventDefault();
        return;
      }
      if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        toggleFullscreen();
      } else if (event.key === "Escape" && !document.fullscreenElement) {
        if (showFollow) setShowFollow(false);
        else leave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, previous, firstSlide, lastSlide, toggleFullscreen, leave, showFollow]);

  // The bar fades when the pointer rests for 2.5 s.
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2500);
  }, []);
  useEffect(() => {
    idleTimer.current = window.setTimeout(() => setIdle(true), 2500);
    return () => window.clearTimeout(idleTimer.current);
  }, []);

  function onStageClick(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    // A link to another slide jumps there; other links, media controls and the bar keep their own clicks.
    const slideLink = target.closest<HTMLElement>("[data-sp-goto]");
    if (slideLink) {
      event.preventDefault();
      goTo(slideLink.dataset.spGoto ?? "");
      return;
    }
    if (target.closest("a, video, audio, button, iframe, [data-bar]")) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX - box.left < box.width / 3) previous();
    else next();
  }

  function onPointerDown(event: ReactPointerEvent) {
    if (event.pointerType === "touch") touch.current = { x: event.clientX, y: event.clientY, t: Date.now() };
  }
  function onPointerUp(event: ReactPointerEvent) {
    const start = touch.current;
    touch.current = null;
    if (!start || event.pointerType !== "touch") return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - start.t < 800) {
      if (dx < 0) next();
      else previous();
    }
  }

  async function openFollow() {
    const id = followId ?? (await startFollow());
    if (id) setShowFollow(true);
  }

  const number = index >= 0 ? index + 1 : null;
  const link = followId ? `${window.location.origin}${followPath(followId)}` : "";
  const label = number ? `Slide ${number} of ${visible.length}` : "A skipped slide";

  return (
    <div ref={root} className={styles.present} data-idle={idle ? "" : undefined} onMouseMove={wake} onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
      <SlideStyles deck={deck} />
      <h1 className="sr-only">{title}: present mode</h1>
      <p className="sr-only" role="status" aria-live="polite">{position.ended ? "End of the presentation" : label}</p>
      <div className={styles.screen} onClick={onStageClick} data-testid="present-stage" data-slide={position.slide} data-step={position.step}>
        <Stage deck={deck} move={move} label={label} />
      </div>

      <div className={styles.bar} data-bar="" role="toolbar" aria-label="Presentation">
        <button type="button" className={styles.barButton} onClick={previous} aria-label="Previous"><ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" /></button>
        <span className={styles.counter}>{position.ended ? "End" : number ? `${number} / ${visible.length}` : "Skipped"}</span>
        <button type="button" className={styles.barButton} onClick={next} aria-label="Next"><ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" /></button>
        <span className={styles.barGap} />
        {signedIn ? (
          <>
            <button type="button" className={styles.barText} onClick={() => window.open(`/decks/${encodeURIComponent(deckId)}/presenter`, `presenter-${deckId}`, "popup,width=1280,height=800")}>
              <MonitorPlay size={16} strokeWidth={1.75} aria-hidden="true" />
              Presenter view
            </button>
            <button type="button" className={styles.barText} onClick={() => void openFollow()} disabled={followBusy} aria-expanded={showFollow}>
              <Link2 size={16} strokeWidth={1.75} aria-hidden="true" />
              {followId ? "Follow link" : "Share a follow link"}
            </button>
          </>
        ) : null}
        <button type="button" className={styles.barButton} onClick={toggleFullscreen} aria-label={fullscreen ? "Leave full screen" : "Full screen"}>
          {fullscreen ? <Minimize size={16} strokeWidth={1.75} aria-hidden="true" /> : <Maximize size={16} strokeWidth={1.75} aria-hidden="true" />}
        </button>
        <button type="button" className={styles.barButton} onClick={leave} aria-label="Leave present mode"><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
      </div>

      {showFollow && followId ? (
        <div className={styles.follow} data-bar="" role="dialog" aria-label="Follow link">
          <p className={styles.followTitle}>Anyone with this link follows along live</p>
          <div className={styles.followRow}>
            <span className={styles.followLink}>{link}</span>
            <CopyButton value={link} label="Copy follow link" variant="outline" />
          </div>
          <div className={styles.followActions}>
            <button type="button" className={styles.barText} onClick={() => { void stopFollow(); setShowFollow(false); }}>End the follow link</button>
            <button type="button" className={styles.barText} onClick={() => setShowFollow(false)}>Close</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
