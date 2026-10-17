/**
 * The deck as plain JSON for React, kept in step with the Y.Doc. Only the slides a transaction touched are read again,
 * so every other slide keeps its object identity and its thumbnail and canvas don't re-render.
 *
 * It also reports which elements a remote change touched, and who made it, so the canvas can briefly highlight each
 * one with the author's name (a Silicon's whole change arrives in one update, so it appears at once).
 */
import * as Y from "yjs";
import { MASTER, deckMap, docToJson, orderArray, readElement, readSlide, slidesMap, type DeckJson, type Element, type Slide } from "@silicon-present/deck";
import { RemoteOrigin } from "@/lib/live/provider";
import type { LiveAccount } from "@/lib/live/types";

export interface RemoteTouch {
  slideId: string;
  elementId: string | null;
  author: LiveAccount | null;
  at: number;
}

type Listener = () => void;

export class DeckMirror {
  private json: DeckJson;
  private readonly doc: Y.Doc;
  private dirtySlides = new Set<string>();
  private dirtyTop = false;
  private scheduled = false;
  private listeners = new Set<Listener>();
  private remoteListeners = new Set<(touches: RemoteTouch[]) => void>();

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.json = docToJson(doc);
    slidesMap(doc).observeDeep(this.onSlides);
    orderArray(doc).observe(this.onTop);
    deckMap(doc).observe(this.onTop);
  }

  get(): DeckJson {
    return this.json;
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onRemote(listener: (touches: RemoteTouch[]) => void) {
    this.remoteListeners.add(listener);
    return () => this.remoteListeners.delete(listener);
  }

  destroy() {
    slidesMap(this.doc).unobserveDeep(this.onSlides);
    orderArray(this.doc).unobserve(this.onTop);
    deckMap(this.doc).unobserve(this.onTop);
  }

  private onTop = () => {
    this.dirtyTop = true;
    this.schedule();
  };

  private onSlides = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    const touches: RemoteTouch[] = [];
    const remote = transaction.origin instanceof RemoteOrigin && transaction.origin.kind === "update" ? transaction.origin : null;
    const now = Date.now();
    for (const event of events) {
      const path = event.path as (string | number)[];
      if (path.length === 0) {
        // Slides added or removed.
        for (const key of (event as Y.YMapEvent<unknown>).keysChanged) this.dirtySlides.add(key);
        this.dirtyTop = true;
        continue;
      }
      const slideId = String(path[0]);
      this.dirtySlides.add(slideId);
      if (!remote) continue;
      if (path[1] === "elements" && path.length >= 3) touches.push({ slideId, elementId: String(path[2]), author: remote.author, at: now });
      else if (path[1] === "elements" && path.length === 2) {
        for (const key of (event as Y.YMapEvent<unknown>).keysChanged) touches.push({ slideId, elementId: key, author: remote.author, at: now });
      } else if (path[1] !== "elementOrder") touches.push({ slideId, elementId: null, author: remote.author, at: now });
    }
    this.schedule();
    if (touches.length) {
      const seen = new Set<string>();
      const unique = touches.filter(touch => {
        const key = `${touch.slideId}/${touch.elementId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      queueMicrotask(() => this.remoteListeners.forEach(listener => listener(unique)));
    }
  };

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.rebuild();
    });
  }

  private rebuild() {
    const prev = this.json;
    const slides = slidesMap(this.doc);
    const deck = deckMap(this.doc);
    const byId = new Map(prev.slides.map(slide => [slide.id, slide]));
    let master = prev.master;
    for (const id of this.dirtySlides) {
      if (id === MASTER) {
        const m = slides.get(MASTER);
        master = { elements: m instanceof Y.Map ? readSlideElements(m) : [] };
        continue;
      }
      const m = slides.get(id);
      if (m instanceof Y.Map) byId.set(id, readSlide(m));
      else byId.delete(id);
    }
    const dirtyCount = this.dirtySlides.size;
    this.dirtySlides.clear();
    if (!this.dirtyTop && dirtyCount === 0) return;
    let size = prev.size;
    let theme = prev.theme;
    let order: Slide[] = prev.slides;
    if (this.dirtyTop || dirtyCount) {
      if (this.dirtyTop) {
        const fresh = docToJson(this.doc);
        size = sameJson(prev.size, fresh.size) ? prev.size : fresh.size;
        theme = sameJson(prev.theme, fresh.theme) ? prev.theme : fresh.theme;
        void deck;
      }
      const seen = new Set<string>();
      order = [];
      for (const id of orderArray(this.doc).toArray()) {
        if (seen.has(id) || id === MASTER) continue;
        seen.add(id);
        let slide = byId.get(id);
        if (!slide) {
          const m = slides.get(id);
          if (m instanceof Y.Map) slide = readSlide(m);
        }
        if (slide) order.push(slide);
      }
    }
    this.dirtyTop = false;
    this.json = { ...prev, size, theme, master, slides: order };
    this.listeners.forEach(listener => listener());
  }
}

function readSlideElements(m: Y.Map<unknown>): Element[] {
  const els = m.get("elements");
  const order = m.get("elementOrder");
  if (!(els instanceof Y.Map)) return [];
  const out: Element[] = [];
  const seen = new Set<string>();
  for (const id of order instanceof Y.Array ? (order.toArray() as string[]) : []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const em = els.get(id);
    if (em instanceof Y.Map) {
      const element = readElement(em as Y.Map<unknown>);
      if (element) out.push(element);
    }
  }
  return out;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
