"use client";

/**
 * Moving through a deck the way a presenter does, shared by present mode and the presenter view:
 *
 * - Next steps through the slide's click animations, then moves to the next slide that is not skipped (with its
 *   transition); Previous goes back a step, then to the previous slide in its final state.
 * - Every window presenting the same deck stays on the same slide and step: present mode and the presenter view talk
 *   over a BroadcastChannel (`present-sync:<deck>`), so a key pressed in either moves both.
 * - A follow link (`POST /v1/decks/{id}/presentations`) lets anyone follow along at /p/<id>; the window where a move
 *   happened tells the service (`PUT /v1/presentations/{id}`), so each move is sent once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeckJson, Slide } from "@silicon-present/deck";
import { slideSteps } from "@silicon-present/render";
import { ApiError } from "@/lib/errors";
import { notifyError } from "@/lib/notify";
import { movePresentation, startPresentation, stopPresentation } from "@/lib/present/presentations";

export interface Position {
  slide: string;
  step: number;
  /** Past the last slide: the end screen. */
  ended?: boolean;
}

export interface Move {
  from: Position | null;
  to: Position;
  /** Play the step's animations (moving forward), or show the final state (going back, jumping). */
  animate: boolean;
  /** Play the incoming slide's transition. */
  transition: boolean;
}

type Message =
  | { type: "position"; position: Position; sender: string }
  | { type: "follow"; id: string | null; sender: string }
  | { type: "hello"; sender: string };

const storageKey = (deck: string) => `present.follow.${deck}`;

function readFollow(deck: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(deck));
  } catch {
    return null;
  }
}

function writeFollow(deck: string, id: string | null) {
  try {
    if (id) window.sessionStorage.setItem(storageKey(deck), id);
    else window.sessionStorage.removeItem(storageKey(deck));
  } catch {
    // Not kept across reloads; the link still works.
  }
}

export function usePresentation(deck: DeckJson, deckId: string, options: { initialSlide?: string | null; canFollow?: boolean } = {}) {
  const visible = useMemo(() => deck.slides.filter(slide => !slide.skipped), [deck]);
  const stepsOf = useCallback((slide: Slide | undefined) => (slide ? slideSteps(slide).steps : 0), []);
  const first = (options.initialSlide && deck.slides.find(slide => slide.id === options.initialSlide)) || visible[0] || deck.slides[0];
  const [move, setMove] = useState<Move>({ from: null, to: { slide: first?.id ?? "", step: 0 }, animate: false, transition: false });
  const [followId, setFollowId] = useState<string | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  // Who is speaking on the channel: unique per window, made when the channel opens (below).
  const sender = useRef("");
  const channel = useRef<BroadcastChannel | null>(null);
  const followRef = useRef<string | null>(null);
  useEffect(() => {
    followRef.current = followId;
  }, [followId]);

  const position = move.to;
  const slide = deck.slides.find(item => item.id === position.slide) ?? first;
  const index = visible.findIndex(item => item.id === position.slide);

  const tellService = useCallback((to: Position) => {
    const id = followRef.current;
    if (!id || to.ended) return;
    movePresentation(id, to.slide, to.step).catch(error => {
      const failure = ApiError.from(error);
      // A presentation someone stopped elsewhere: stop sending.
      if (failure.status === 404 || failure.status === 410) {
        setFollowId(null);
        writeFollow(deckId, null);
      } else notifyError(failure, "Followers could not be moved along");
    });
  }, [deckId]);

  /** A move made here: show it, tell the other windows and the followers. */
  const go = useCallback((next: Move) => {
    setMove(next);
    channel.current?.postMessage({ type: "position", position: next.to, sender: sender.current } satisfies Message);
    tellService(next.to);
  }, [tellService]);

  const next = useCallback(() => {
    if (position.ended) return;
    const current = deck.slides.find(item => item.id === position.slide);
    const steps = stepsOf(current);
    if (position.step < steps) return go({ from: position, to: { slide: position.slide, step: position.step + 1 }, animate: true, transition: false });
    const at = visible.findIndex(item => item.id === position.slide);
    // A skipped slide (reached by a link) continues with the next slide that is not skipped after it in the deck.
    const following = at >= 0 ? visible[at + 1] : deck.slides.slice(deck.slides.findIndex(item => item.id === position.slide) + 1).find(item => !item.skipped);
    if (!following) return go({ from: position, to: { ...position, ended: true }, animate: false, transition: false });
    go({ from: position, to: { slide: following.id, step: 0 }, animate: true, transition: true });
  }, [deck, go, position, stepsOf, visible]);

  const previous = useCallback(() => {
    if (position.ended) return go({ from: null, to: { slide: position.slide, step: position.step }, animate: false, transition: false });
    if (position.step > 0) return go({ from: null, to: { slide: position.slide, step: position.step - 1 }, animate: false, transition: false });
    const at = visible.findIndex(item => item.id === position.slide);
    const before = at > 0 ? visible[at - 1] : at < 0 ? deck.slides.slice(0, Math.max(0, deck.slides.findIndex(item => item.id === position.slide))).reverse().find(item => !item.skipped) : undefined;
    if (!before) return;
    go({ from: null, to: { slide: before.id, step: stepsOf(before) }, animate: false, transition: false });
  }, [deck, go, position, stepsOf, visible]);

  const goTo = useCallback((slideId: string, step = 0) => {
    if (!deck.slides.some(item => item.id === slideId)) return;
    go({ from: position.ended ? null : position, to: { slide: slideId, step }, animate: false, transition: slideId !== position.slide });
  }, [deck, go, position]);

  const firstSlide = useCallback(() => visible[0] && goTo(visible[0].id), [goTo, visible]);
  const lastSlide = useCallback(() => {
    const last = visible[visible.length - 1];
    if (last) go({ from: null, to: { slide: last.id, step: stepsOf(last) }, animate: false, transition: false });
  }, [go, stepsOf, visible]);

  // Other windows presenting this deck.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    sender.current = crypto.randomUUID();
    const bc = new BroadcastChannel(`present-sync:${deckId}`);
    channel.current = bc;
    bc.onmessage = (event: MessageEvent<Message>) => {
      const message = event.data;
      if (!message || message.sender === sender.current) return;
      if (message.type === "position") setMove(current => ({ from: current.to.ended ? null : current.to, to: message.position, animate: true, transition: message.position.slide !== current.to.slide }));
      if (message.type === "follow") {
        setFollowId(message.id);
        writeFollow(deckId, message.id);
      }
    };
    bc.postMessage({ type: "hello", sender: sender.current } satisfies Message);
    return () => {
      bc.close();
      channel.current = null;
    };
  }, [deckId]);

  // A window that joins late hears the others' position: answer a hello with where we are.
  const positionRef = useRef(position);
  useEffect(() => {
    positionRef.current = position;
  }, [position]);
  useEffect(() => {
    const bc = channel.current;
    if (!bc) return;
    const answer = (event: MessageEvent<Message>) => {
      if (event.data?.type === "hello" && event.data.sender !== sender.current) {
        bc.postMessage({ type: "position", position: positionRef.current, sender: sender.current } satisfies Message);
        if (followRef.current) bc.postMessage({ type: "follow", id: followRef.current, sender: sender.current } satisfies Message);
      }
    };
    bc.addEventListener("message", answer);
    return () => bc.removeEventListener("message", answer);
  }, [deckId]);

  // A follow link started in this tab before a reload.
  useEffect(() => {
    const kept = readFollow(deckId);
    // After hydration (the server cannot read this tab's storage), as a callback rather than during the effect.
    if (kept) void Promise.resolve().then(() => setFollowId(kept));
  }, [deckId]);

  const startFollow = useCallback(async () => {
    if (followRef.current) return followRef.current;
    setFollowBusy(true);
    try {
      const presentation = await startPresentation(deckId, { slide: positionRef.current.slide, step: positionRef.current.step });
      setFollowId(presentation.id);
      followRef.current = presentation.id;
      writeFollow(deckId, presentation.id);
      channel.current?.postMessage({ type: "follow", id: presentation.id, sender: sender.current } satisfies Message);
      return presentation.id;
    } catch (error) {
      notifyError(error, "Could not start a follow link");
      return null;
    } finally {
      setFollowBusy(false);
    }
  }, [deckId]);

  const stopFollow = useCallback(async () => {
    const id = followRef.current;
    if (!id) return;
    setFollowId(null);
    writeFollow(deckId, null);
    channel.current?.postMessage({ type: "follow", id: null, sender: sender.current } satisfies Message);
    try {
      await stopPresentation(id);
    } catch (error) {
      const failure = ApiError.from(error);
      if (failure.status !== 404) notifyError(failure, "Could not end the follow link");
    }
  }, [deckId]);

  return {
    move, position, slide, index, visible, steps: stepsOf(slide),
    next, previous, goTo, firstSlide, lastSlide,
    followId, followBusy, startFollow, stopFollow,
    canFollow: options.canFollow ?? true,
  };
}

export type PresentationControls = ReturnType<typeof usePresentation>;
