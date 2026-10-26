"use client";

/**
 * Following a presentation live (/p/<id>): the slide being shown, moving whenever the presenter moves, from the
 * service's server-sent events (`GET /v1/presentations/{id}/live`: `state` with the slide and step, `ended`). Works for
 * anonymous viewers of a public deck. EventSource reconnects by itself (the proxy ends a stream after 5 minutes).
 */
import { useEffect, useRef, useState } from "react";
import type { DeckJson } from "@silicon-present/deck";
import { SlideStyles } from "@/components/slides/slide-view";
import { getContent } from "@/lib/present/versions";
import { presentationLiveUrl } from "@/lib/present/presentations";
import type { Presentation } from "@/lib/present/types";
import { Stage } from "./present-mode";
import type { Move } from "./use-presentation";
import styles from "./present.module.css";

type Live = "connecting" | "live" | "waiting" | "ended";

function readState(raw: string): { slide: string | null; step: number; ended: boolean } | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const body = (data.presentation && typeof data.presentation === "object" ? data.presentation : data) as Record<string, unknown>;
    const slide = typeof body.slide === "string" ? body.slide : body.slide && typeof body.slide === "object" ? String((body.slide as { id?: unknown }).id ?? "") : typeof body.slideId === "string" ? body.slideId : null;
    return { slide, step: typeof body.step === "number" ? body.step : 0, ended: !!(body.endedAt ?? body.ended_at) };
  } catch {
    return null;
  }
}

export function FollowView({ presentation, deck: initialDeck, title }: { presentation: Presentation; deck: DeckJson; title: string }) {
  const [deck, setDeck] = useState(initialDeck);
  const first = presentation.slide && initialDeck.slides.some(slide => slide.id === presentation.slide) ? presentation.slide : initialDeck.slides.find(slide => !slide.skipped)?.id ?? initialDeck.slides[0]?.id ?? "";
  const [move, setMove] = useState<Move>({ from: null, to: { slide: first, step: presentation.step }, animate: false, transition: false });
  const [live, setLive] = useState<Live>(presentation.endedAt ? "ended" : "connecting");
  const deckRef = useRef(deck);
  useEffect(() => {
    deckRef.current = deck;
  }, [deck]);

  useEffect(() => {
    if (presentation.endedAt) return;
    const source = new EventSource(presentationLiveUrl(presentation.id));
    let disposed = false;
    const checkEmailRequirement = () => {
      void fetch(`/api/v1/presentations/${encodeURIComponent(presentation.id)}`, { cache: "no-store" })
        .then(async response => {
          if (response.status !== 403) return;
          const body = await response.json().catch(() => null);
          if (!disposed && body?.error?.code === "email_required") { source.close(); window.location.reload(); }
        }).catch(() => { /* EventSource retries ordinary network failures. */ });
    };
    const apply = async (raw: string) => {
      const state = readState(raw);
      if (!state) return;
      if (state.ended) {
        setLive("ended");
        source.close();
        return;
      }
      setLive("live");
      if (!state.slide) return;
      // A slide the presenter added after this page loaded: read the deck again.
      if (!deckRef.current.slides.some(slide => slide.id === state.slide)) {
        try {
          const fresh = await getContent(presentation.deck);
          setDeck(fresh);
        } catch {
          return;
        }
      }
      setMove(current => (current.to.slide === state.slide && current.to.step === state.step ? current : { from: current.to, to: { slide: state.slide!, step: state.step }, animate: state.slide === current.to.slide ? state.step > current.to.step : true, transition: state.slide !== current.to.slide }));
    };
    source.addEventListener("state", event => void apply((event as MessageEvent<string>).data));
    source.addEventListener("message", event => void apply((event as MessageEvent<string>).data));
    source.addEventListener("ended", event => {
      setLive("ended");
      source.close();
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data);
        if (payload.role === null) checkEmailRequirement();
      } catch { /* A normal end needs no further request. */ }
    });
    source.onopen = () => setLive(current => (current === "ended" ? current : "live"));
    source.onerror = () => {
      setLive(current => (current === "ended" ? current : "waiting"));
      checkEmailRequirement();
    };
    return () => { disposed = true; source.close(); };
  }, [presentation.id, presentation.deck, presentation.endedAt]);

  const index = deck.slides.filter(slide => !slide.skipped).findIndex(slide => slide.id === move.to.slide);
  const who = presentation.presenter?.id ?? "the presenter";
  return (
    <div className={styles.followView}>
      <SlideStyles deck={deck} />
      <h1 className="sr-only">{title}: following {who}</h1>
      <div className={styles.screen} data-testid="follow-stage" data-slide={move.to.slide} data-step={move.to.step}>
        <Stage deck={deck} move={move} label={index >= 0 ? `Slide ${index + 1}` : "Slide"} />
      </div>
      <footer className={styles.followFoot}>
        <span className={styles.live} role="status" aria-live="polite">
          <span className={styles.dot} data-state={live === "live" ? "live" : live === "ended" ? "ended" : "waiting"} aria-hidden="true" />
          {live === "ended" ? `The presentation ended.` : live === "live" ? `Following ${who} live` : live === "waiting" ? "Reconnecting…" : "Connecting…"}
        </span>
        <span>{title}{index >= 0 ? ` · slide ${index + 1}` : ""}</span>
        {live === "ended" ? <a href={`/decks/${encodeURIComponent(presentation.deck)}`}>Open the deck</a> : null}
      </footer>
    </div>
  );
}
