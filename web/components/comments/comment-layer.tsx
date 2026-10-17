"use client";

/**
 * Comments on the canvas: a pin for every thread on this slide (where its point, area, element or text is now: a point
 * or area inside an element follows the element), the area of the open thread, the new-comment box right where someone
 * clicked, and the open thread next to its pin. Drawn above the scaled slide, so pins and boxes keep their size at any
 * zoom.
 */
import type { Element, Slide } from "@silicon-present/deck";
import { fromElementFraction } from "@/lib/editor/geometry";
import { useStore } from "@/lib/editor/store";
import type { Anchor, Thread } from "@/lib/editor/types";
import { useAbilities, useEditor, useUi } from "@/components/editor/editor-context";
import { CommentComposer } from "./comment-composer";
import { ThreadView } from "./thread-view";
import styles from "./comments.module.css";

interface Placed {
  thread: Thread;
  pin: { x: number; y: number };
  area: { x: number; y: number; w: number; h: number } | null;
}

/** Where an anchor is on the slide right now (null for slide and deck comments, which live in the list). */
export function placeAnchor(anchor: Anchor, elements: Element[]): Omit<Placed, "thread"> | null {
  const element = "element" in anchor && anchor.element ? elements.find(e => e.id === anchor.element) : undefined;
  switch (anchor.kind) {
    case "point": {
      if (element && typeof anchor.ex === "number" && typeof anchor.ey === "number") return { pin: fromElementFraction(element, anchor.ex, anchor.ey), area: null };
      return { pin: { x: anchor.x, y: anchor.y }, area: null };
    }
    case "area": {
      if (element && typeof anchor.ex === "number" && typeof anchor.ey === "number") {
        const w = (anchor.ew ?? anchor.w / Math.max(1, element.w)) * element.w;
        const h = (anchor.eh ?? anchor.h / Math.max(1, element.h)) * element.h;
        const p = fromElementFraction({ ...element, rotation: 0 }, anchor.ex, anchor.ey);
        return { pin: { x: p.x + w, y: p.y }, area: { x: p.x, y: p.y, w, h } };
      }
      return { pin: { x: anchor.x + anchor.w, y: anchor.y }, area: { x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h } };
    }
    case "element":
    case "text": {
      if (!element) return null;
      return { pin: { x: element.x + element.w, y: element.y }, area: { x: element.x, y: element.y, w: element.w, h: element.h } };
    }
    default:
      return null;
  }
}

export function CommentLayer({ slide, elements, scale, phone = false }: { slide: Slide; elements: Element[]; scale: number; phone?: boolean }) {
  const editor = useEditor();
  const { list } = useStore(editor.threads, state => state);
  const { composer, activeThread, showResolved, commentMode, panel, panelOpen } = useUi(s => ({ composer: s.composer, activeThread: s.activeThread, showResolved: s.showResolved, commentMode: s.commentMode, panel: s.panel, panelOpen: s.panelOpen }));
  const { canComment, canEdit } = useAbilities();
  // Pins stay small and quiet while an editor edits; they come forward in comment mode and for reviewers.
  const quiet = canEdit && !commentMode;
  // The open thread shows in the comments list when that is on screen; otherwise next to its pin (phones: the list).
  const listShows = panelOpen && (panel === "comments" || !canEdit);
  const placed: Placed[] = [];
  for (const thread of list) {
    if (thread.anchor.kind === "deck" || thread.anchor.slide !== slide.id) continue;
    if (thread.state === "resolved" && !showResolved && thread.id !== activeThread) continue;
    const where = placeAnchor(thread.anchor, elements);
    if (where) placed.push({ thread, ...where });
  }
  const active = placed.find(p => p.thread.id === activeThread);
  const at = (x: number, y: number) => ({ left: x * scale, top: y * scale });
  const floating = composer && composer.at ? composer : null;

  return (
    <div className="comment-layer" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {active?.area ? <div className={styles.area} style={{ ...at(active.area.x, active.area.y), width: active.area.w * scale, height: active.area.h * scale }} /> : null}
      {placed.map(({ thread, pin }, index) => (
        <button
          key={thread.id}
          type="button"
          className={styles.pin}
          data-pin=""
          data-no-canvas=""
          data-testid="comment-pin"
          data-state={thread.state}
          data-active={thread.id === activeThread || undefined}
          data-quiet={quiet || undefined}
          data-phone={phone || undefined}
          style={at(pin.x, pin.y)}
          aria-label={`Comment ${index + 1}: ${thread.comments[0]?.body ?? ""}`}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation();
            const next = thread.id === activeThread ? null : thread.id;
            editor.ui.set(phone ? { activeThread: next, composer: null, panelOpen: true, panel: "comments" } : { activeThread: next, composer: null });
          }}
        >
          {thread.comments.length}
        </button>
      ))}
      {floating ? (
        <div className={styles.floating} data-no-canvas="" style={clampedAt(floating.at!.x * scale + 12, floating.at!.y * scale)} onPointerDown={event => event.stopPropagation()}>
          <CommentComposer editor={editor} anchor={floating.anchor} onDone={() => editor.ui.set({ composer: null })} />
        </div>
      ) : null}
      {active && !floating && !listShows && !phone ? (
        <div className={`${styles.floating} ${styles.popThread}`} data-no-canvas="" data-sq="surface" style={clampedAt(active.pin.x * scale + 20, active.pin.y * scale - 30)} onPointerDown={event => event.stopPropagation()}>
          <ThreadView thread={active.thread} editor={editor} canComment={canComment} compact onClose={() => editor.ui.set({ activeThread: null })} />
        </div>
      ) : null}
    </div>
  );
}

/** Keeps a floating box near its point but inside the stage (it flips to the left near the right edge). */
function clampedAt(left: number, top: number): React.CSSProperties {
  return { left: `max(0px, min(${left}px, calc(100% - 320px)))`, top: `max(0px, min(${top}px, calc(100% - 220px)))` };
}
