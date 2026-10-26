"use client";

/**
 * Present mode: the deck full screen, one slide at a time. Next with →, ↓, Space, Page Down, Enter, a click or a tap
 * on the right of the slide, a swipe left; back with ←, ↑, Page Up, Backspace, a tap on the left, a swipe right; Home
 * and End; F for full screen; Escape to leave. Click animations play step by step and slide transitions play between
 * slides (both from `@silicon-present/render`), skipped slides are skipped, and HTML elements run live.
 *
 * The title and Exit stay visible in the normal view. In full screen the top and bottom bars reveal independently
 * at their edges, when focused, or when tapped. The presenter view and this window move together.
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
import { presentationShortcutAllowed, presentationSwipe, presentKeys } from "./present-input";
import styles from "./present.module.css";

export { presentKeys } from "./present-input";

export interface PresentModeProps {
  deckId: string;
  title: string;
  deck: DeckJson;
  signedIn: boolean;
  initialSlide?: string | null;
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
  const [touchEdge, setTouchEdge] = useState<"top" | "bottom" | null>(null);
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const idleTimer = useRef<number | undefined>(undefined);
  const edgeTimer = useRef<number | undefined>(undefined);
  const suppressClick = useRef(false);
  const fullscreenExitedAt = useRef(0);

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
    const onChange = () => {
      const active = document.fullscreenElement === root.current;
      setFullscreen(active);
      setTouchEdge(null);
      if (!active) fullscreenExitedAt.current = Date.now();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!presentationShortcutAllowed(event)) return;
      if (event.key === "Escape") {
        // Escape may be consumed by the browser before keydown reaches us.
        // Leaving full screen must not also navigate out of the presentation.
        if (document.fullscreenElement) {
          event.preventDefault();
          void document.exitFullscreen().catch(() => undefined);
        } else if (Date.now() - fullscreenExitedAt.current > 300) {
          if (showFollow) setShowFollow(false);
          else leave();
        }
        return;
      }
      if (showFollow) return;
      if (presentKeys(event, { next, previous, firstSlide, lastSlide })) {
        event.preventDefault();
        return;
      }
      if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, previous, firstSlide, lastSlide, toggleFullscreen, leave, showFollow]);

  // Only the cursor disappears when resting; bar visibility follows its edge.
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2500);
  }, []);
  useEffect(() => {
    idleTimer.current = window.setTimeout(() => setIdle(true), 2500);
    return () => { window.clearTimeout(idleTimer.current); window.clearTimeout(edgeTimer.current); };
  }, []);

  function onStageClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (suppressClick.current) { suppressClick.current = false; return; }
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
    suppressClick.current = false;
    if ((event.target as HTMLElement).closest("a, video, audio, button, iframe, [data-bar]")) return;
    if (event.pointerType === "touch") {
      if (touchEdge) { setTouchEdge(null); suppressClick.current = true; return; }
      touch.current = { x: event.clientX, y: event.clientY, t: Date.now() };
    }
  }
  function onPointerUp(event: ReactPointerEvent) {
    const start = touch.current;
    touch.current = null;
    if (!start || event.pointerType !== "touch") return;
    const swipe = presentationSwipe(start, { x: event.clientX, y: event.clientY, t: Date.now() });
    if (swipe) {
      suppressClick.current = true;
      if (swipe === "next") next();
      else previous();
    }
  }

  function revealForTouch(event: ReactPointerEvent, edge: "top" | "bottom") {
    if (!fullscreen || event.pointerType !== "touch") return;
    setTouchEdge(edge);
    window.clearTimeout(edgeTimer.current);
    edgeTimer.current = window.setTimeout(() => setTouchEdge(null), 4000);
  }

  function releasePointerFocus(event: ReactMouseEvent) {
    // Mouse/touch activation must not leave an edge pinned open after the
    // pointer leaves. Keyboard activation (detail=0) keeps its visible focus.
    if (event.detail > 0) (event.target as HTMLElement).closest<HTMLElement>("button, a")?.blur();
  }

  async function openFollow() {
    const id = followId ?? (await startFollow());
    if (id) setShowFollow(true);
  }

  const number = index >= 0 ? index + 1 : null;
  const link = followId ? `${window.location.origin}${followPath(followId)}` : "";
  const label = number ? `Slide ${number} of ${visible.length}` : "A skipped slide";

  return (
    <div ref={root} className={styles.present} data-fullscreen={fullscreen ? "" : undefined} data-idle={idle ? "" : undefined} onMouseMove={wake}>
      <SlideStyles deck={deck} />
      <div className={styles.topEdge} data-bar="" data-touch-open={touchEdge === "top" ? "" : undefined} data-testid="present-top-edge" onPointerDown={event => revealForTouch(event, "top")} onClick={releasePointerFocus}>
        <header className={styles.topBar} data-testid="present-top-bar">
          <h1 className={styles.presentTitle} title={title}>{title}</h1>
          <button type="button" className={styles.exitButton} data-sq="surface" onClick={leave} aria-label="Exit presentation" aria-keyshortcuts="Escape">
            <X size={16} strokeWidth={1.75} aria-hidden="true" />Exit
          </button>
        </header>
      </div>
      <p className="sr-only">Use the arrow keys to move through slides, F for full screen, and Escape to leave full screen or exit. In full screen, move to or tap an edge for controls, or use Tab.</p>
      <p className="sr-only" role="status" aria-live="polite">{position.ended ? "End of the presentation" : label}</p>
      <div className={styles.screen} onClick={onStageClick} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { touch.current = null; }} data-testid="present-stage" data-slide={position.slide} data-step={position.step}>
        <Stage deck={deck} move={move} label={label} />
      </div>

      <div className={styles.bottomEdge} data-bar="" data-touch-open={touchEdge === "bottom" ? "" : undefined} data-testid="present-bottom-edge" onPointerDown={event => revealForTouch(event, "bottom")} onClick={releasePointerFocus}>
        <div className={styles.bar} data-sq="surface" role="toolbar" aria-label="Presentation">
          <button type="button" className={styles.barButton} data-sq="surface" onClick={previous} aria-label="Previous"><ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" /></button>
          <span className={styles.counter}>{position.ended ? "End" : number ? `${number} / ${visible.length}` : "Skipped"}</span>
          <button type="button" className={styles.barButton} data-sq="surface" onClick={next} aria-label="Next"><ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" /></button>
          <span className={styles.barGap} />
          {signedIn ? (
            <>
              <button type="button" className={styles.barText} data-sq="surface" onClick={() => window.open(`/decks/${encodeURIComponent(deckId)}/presenter`, `presenter-${deckId}`, "popup,width=1280,height=800")}>
                <MonitorPlay size={16} strokeWidth={1.75} aria-hidden="true" />
                Presenter view
              </button>
              <button type="button" className={styles.barText} data-sq="surface" onClick={() => void openFollow()} disabled={followBusy} aria-expanded={showFollow}>
                <Link2 size={16} strokeWidth={1.75} aria-hidden="true" />
                {followId ? "Follow link" : "Share a follow link"}
              </button>
            </>
          ) : null}
          <button type="button" className={styles.barButton} data-sq="surface" onClick={event => { if (event.detail) event.currentTarget.blur(); toggleFullscreen(); }} aria-label={fullscreen ? "Leave full screen" : "Full screen"} aria-keyshortcuts="F">
            {fullscreen ? <Minimize size={16} strokeWidth={1.75} aria-hidden="true" /> : <Maximize size={16} strokeWidth={1.75} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {showFollow && followId ? (
        <div className={styles.follow} data-bar="" data-sq="surface" role="dialog" aria-label="Follow link">
          <p className={styles.followTitle}>Anyone with this link follows along live</p>
          <div className={styles.followRow}>
            <span className={styles.followLink}>{link}</span>
            <CopyButton value={link} label="Copy follow link" variant="outline" />
          </div>
          <div className={styles.followActions}>
            <button type="button" className={styles.barText} data-sq="surface" onClick={() => { void stopFollow(); setShowFollow(false); }}>End the follow link</button>
            <button type="button" className={styles.barText} data-sq="surface" onClick={() => setShowFollow(false)}>Close</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
