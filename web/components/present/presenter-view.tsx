"use client";

/**
 * The presenter view: the current slide, the next one, the speaker notes and a timer, on the presenter's own screen.
 * It moves together with the audience window (present mode, opened from here) over a BroadcastChannel, and can share a
 * follow link so anyone follows along live. The same keys as present mode move it.
 */
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Link2, MonitorPlay, Pause, Play, RotateCcw, X } from "lucide-react";
import type { DeckJson } from "@silicon-present/deck";
import { Button } from "@/components/arc/button/button";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { SlideStyles, SlideView } from "@/components/slides/slide-view";
import { followPath } from "@/lib/present/presentations";
import { presentKeys } from "./present-mode";
import { usePresentation } from "./use-presentation";
import styles from "./present.module.css";

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
}

export function PresenterView({ deckId, title, deck }: { deckId: string; title: string; deck: DeckJson }) {
  const controls = usePresentation(deck, deckId);
  const { position, slide, index, visible, steps, next, previous, firstSlide, lastSlide, followId, followBusy, startFollow, stopFollow } = controls;
  const [started, setStarted] = useState(() => Date.now());
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (presentKeys(event, { next, previous, firstSlide, lastSlide })) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, previous, firstSlide, lastSlide]);

  const elapsed = (pausedAt ?? now) - started;
  const following = index >= 0 ? visible[index + 1] : undefined;
  const nextIsStep = !position.ended && position.step < steps;
  const link = followId && typeof window !== "undefined" ? `${window.location.origin}${followPath(followId)}` : "";

  return (
    <div className={styles.presenter}>
      <SlideStyles deck={deck} />
      <header className={styles.presenterTop}>
        <h1 className={styles.presenterTitle}>{title}: presenter view</h1>
        <span className={styles.timer} role="timer" aria-label={`Time ${clock(elapsed)}`}>{clock(elapsed)}</span>
        <Button size="sm" variant="ghost" onClick={() => (pausedAt ? (setStarted(started + (Date.now() - pausedAt)), setPausedAt(null)) : setPausedAt(Date.now()))}>
          {pausedAt ? <Play size={16} strokeWidth={1.75} aria-hidden="true" /> : <Pause size={16} strokeWidth={1.75} aria-hidden="true" />}
          {pausedAt ? "Resume timer" : "Pause timer"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setStarted(Date.now()); setPausedAt(pausedAt ? Date.now() : null); }}>
          <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
          Reset
        </Button>
        <Button size="sm" variant="secondary" onClick={() => window.open(`/decks/${encodeURIComponent(deckId)}/present`, `present-${deckId}`, "popup")}>
          <MonitorPlay size={16} strokeWidth={1.75} aria-hidden="true" />
          Open the audience window
        </Button>
        <Button size="sm" variant="ghost" onClick={() => window.close()} aria-label="Close the presenter view"><X size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
      </header>

      <div className={styles.presenterBody}>
        <section className={styles.current} aria-label="Current slide">
          <p className={styles.label} role="status" aria-live="polite">
            {position.ended ? "End of the presentation" : index >= 0 ? `Slide ${index + 1} of ${visible.length}` : "A skipped slide"}
            {steps && !position.ended ? ` · step ${position.step} of ${steps}` : ""}
          </p>
          <div className={styles.frame} data-sq="clip">
            {position.ended ? <div className={styles.nextEnd}>End of the presentation</div> : <SlideView deck={deck} slide={position.slide} step={position.step} html="live" label="Current slide" />}
          </div>
          <div className={styles.controls}>
            <Button variant="secondary" onClick={previous}><ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />Previous</Button>
            <Button onClick={next} disabled={position.ended}>Next<ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" /></Button>
          </div>
        </section>

        <aside className={styles.side} aria-label="Next and notes">
          <div className={styles.current}>
            <p className={styles.label}>{nextIsStep ? "Next: the next animation on this slide" : following ? "Next slide" : "Next"}</p>
            <div className={styles.frame} data-sq="clip">
              {nextIsStep && slide ? (
                <SlideView deck={deck} slide={slide.id} step={position.step + 1} html="static" media="static" label="Next step" />
              ) : following ? (
                <SlideView deck={deck} slide={following.id} step={0} html="static" media="static" label="Next slide" />
              ) : (
                <div className={styles.nextEnd}>End of the presentation</div>
              )}
            </div>
          </div>
          <div className={styles.current}>
            <p className={styles.label}>Speaker notes</p>
            {slide?.notes?.trim() ? <p className={styles.notes} data-testid="speaker-notes">{slide.notes}</p> : <p className={`${styles.notes} ${styles.notesEmpty}`} data-testid="speaker-notes">No notes for this slide.</p>}
          </div>
          <div className={styles.current}>
            <p className={styles.label}>Follow link</p>
            {followId ? (
              <>
                <div className={styles.followRow}>
                  <span className={styles.followLink} data-testid="follow-link">{link}</span>
                  <CopyButton value={link} label="Copy follow link" variant="outline" />
                </div>
                <div className={styles.controls}><Button size="sm" variant="ghost" onClick={() => void stopFollow()}>End the follow link</Button></div>
              </>
            ) : (
              <div className={styles.controls}>
                <Button size="sm" variant="secondary" loading={followBusy} disabled={followBusy} onClick={() => void startFollow()}>
                  <Link2 size={16} strokeWidth={1.75} aria-hidden="true" />
                  Share a follow link
                </Button>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
