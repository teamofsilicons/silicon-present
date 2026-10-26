"use client";

/**
 * Comments on the canvas: a pin for every thread on this slide (where its point, area, element or text is now: a point
 * or area inside an element follows the element), the area of the open thread, the new-comment box right where someone
 * clicked, and the open thread next to its pin. Drawn above the scaled slide, so pins and boxes keep their size at any
 * zoom.
 */
import type { Element, Slide } from "@silicon-present/deck";
import { Plus } from "lucide-react";
import { placeAnchor, type PlacedAnchor } from "@/lib/editor/comment-anchors";
import { useStore } from "@/lib/editor/store";
import type { Thread } from "@/lib/editor/types";
import { useAbilities, useEditor, useUi } from "@/components/editor/editor-context";
import { CommentComposer } from "./comment-composer";
import { ThreadView } from "./thread-view";
import styles from "./comments.module.css";

interface Placed extends PlacedAnchor {
  thread: Thread;
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
  const areaStyle = (area: NonNullable<PlacedAnchor["area"]>) => ({ ...at(area.x, area.y), width: area.w * scale, height: area.h * scale, transform: area.rotation ? `rotate(${area.rotation}deg)` : undefined });
  // The draft belongs to its slide, and follows its target just like a posted thread.
  const currentComposer = composer && composer.anchor.kind !== "deck" && composer.anchor.slide === slide.id ? composer : null;
  const draft = currentComposer ? placeAnchor(currentComposer.anchor, elements) : null;
  const floating = currentComposer?.at ? currentComposer : null;
  const floatingAt = draft?.pin ?? floating?.at;

  return (
    <div className="comment-layer" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {active?.area ? <div className={styles.area} style={areaStyle(active.area)} /> : null}
      {draft ? (
        <div className={styles.draftMarker} data-testid="comment-draft-anchor" data-anchor-kind={currentComposer!.anchor.kind} role="img" aria-label="New comment placement">
          {draft.area ? <div className={`${styles.area} ${styles.draftArea}`} data-testid="comment-draft-area" style={areaStyle(draft.area)} /> : null}
          <span className={`${styles.pin} ${styles.draftPin}`} data-testid="comment-draft-pin" style={at(draft.pin.x, draft.pin.y)} aria-hidden="true"><Plus size={16} strokeWidth={2} /></span>
        </div>
      ) : null}
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
      {floating && floatingAt ? (
        <div className={styles.floating} data-no-canvas="" style={clampedAt(floatingAt.x * scale + 12, floatingAt.y * scale)} onPointerDown={event => event.stopPropagation()}>
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
