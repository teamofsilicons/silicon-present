"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Presentation } from "lucide-react";
import type { Element } from "@silicon-present/deck";
import { SlideStyles, SlideView } from "@/components/slides/slide-view";
import { useSessionView } from "@/lib/client/session";
import { getContent } from "@/lib/present/versions";
import type { Deck } from "@/lib/present/types";
import styles from "./deck-thumbnail.module.css";

export interface DeckThumbnailProps {
  deck: Deck;
  /** The immutable UUID of the account whose listing contains this deck. */
  accountId: string;
}

// The renderer's static video mode loads the first frame. Cards use posters only,
// so a grid of decks never downloads each deck's video files in the background.
const postersOnly = (elements: Element[]): Element[] => elements.map(element => element.kind === "video" ? { ...element, src: "" } : element);

function Placeholder({ text }: { text: string }) {
  return <div className={styles.placeholder} aria-hidden="true">
    <Presentation size={24} strokeWidth={1.4} />
    <span>{text}</span>
  </div>;
}

/** A noninteractive picture that can be placed inside the card's link. */
export function DeckThumbnail({ deck, accountId }: DeckThumbnailProps) {
  const session = useSessionView();
  // Account changes unmount the old preview immediately, including its pending request.
  // A listing from the previous account must never hydrate a preview under a new sign-in.
  if (!session.signedIn || session.account?.uuid !== accountId) {
    return <div className={styles.preview} role="img" aria-label="Preview unavailable" data-state="unavailable">
      <Placeholder text="Preview unavailable" />
    </div>;
  }
  const identity = JSON.stringify([accountId, deck.id, deck.version, deck.updatedAt, deck.role, deck.public, deck.requireEmail, deck.trashedAt]);
  return <Thumbnail key={identity} deck={deck} identity={identity} />;
}

function Thumbnail({ deck, identity }: { deck: Deck; identity: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(false);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      const frame = requestAnimationFrame(() => setNearby(true));
      return () => cancelAnimationFrame(frame);
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setNearby(true);
        observer.disconnect();
      }
    }, { rootMargin: "160px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const preview = useQuery({
    queryKey: ["deck-thumbnail", identity],
    queryFn: async ({ signal }) => {
      // The ordinary BFF content route enforces the same ACL and email gate as opening a deck.
      const content = await getContent(deck.id, undefined, signal);
      if (!Number.isFinite(content?.size?.width) || !Number.isFinite(content?.size?.height)
        || content.size.width <= 0 || content.size.height <= 0 || !Array.isArray(content.slides)) {
        throw new Error("The deck preview could not be read.");
      }
      return {
        ...content,
        master: { ...content.master, elements: postersOnly(content.master.elements) },
        slides: content.slides.slice(0, 1).map(slide => ({ ...slide, elements: postersOnly(slide.elements) })),
      };
    },
    enabled: nearby,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
  // Never retain the last successful picture while access is being rechecked or after a refusal.
  const content = preview.isSuccess && !preview.isFetching ? preview.data : null;
  const first = content?.slides[0];
  const text = preview.error?.code === "email_required" ? "Open to enter your email"
    : preview.isError ? "Preview unavailable"
    : content && !first ? "No slides yet"
    : "Loading preview…";
  const label = first ? `First slide of ${deck.title || "Untitled deck"}` : text;

  return <div ref={box} className={styles.preview} role="img" aria-label={label} data-state={first ? "ready" : preview.isError ? "unavailable" : content ? "empty" : "loading"}>
    {content && first ? <div className={styles.slide} aria-hidden="true" inert>
      <SlideStyles deck={content} />
      <SlideView deck={content} slide={first.id} html="preview" media="static" links={false} fit="contain" />
    </div> : <Placeholder text={text} />}
  </div>;
}
