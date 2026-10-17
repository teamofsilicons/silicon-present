"use client";

/**
 * Every thread of the deck in one list, grouped by slide (the whole deck first, then slides in order, then slides that
 * were deleted, by what the comment remembers). ↑/↓ (or j/k) move through the threads and open each on its slide;
 * "Show resolved" brings resolved threads back. New comments on the whole deck or the current slide start here.
 */
import { useMemo, useRef, type KeyboardEvent } from "react";
import { MessageSquarePlus } from "lucide-react";
import { Switch } from "@/components/arc/switch/switch";
import { formatRelative } from "@/lib/format";
import { anchorSlide, anchorText } from "@/lib/editor/comments";
import { nameOf } from "@/lib/editor/normalize-api";
import type { Thread } from "@/lib/editor/types";
import { useAbilities, useDeck, useEditor, useUi } from "@/components/editor/editor-context";
import { useStore } from "@/lib/editor/store";
import { CommentComposer } from "./comment-composer";
import { ThreadView } from "./thread-view";
import styles from "./comments.module.css";

interface Group {
  key: string;
  title: string;
  threads: Thread[];
}

export function ThreadsPanel() {
  const editor = useEditor();
  const deck = useDeck();
  const { canComment, signInToComment } = useAbilities();
  const { list, loaded } = useStore(editor.threads, state => state);
  const { activeThread, showResolved, composer, slideId } = useUi(state => ({ activeThread: state.activeThread, showResolved: state.showResolved, composer: state.composer, slideId: state.slideId }));
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const visible = list.filter(thread => showResolved || thread.state === "open");
    const bySlide = new Map<string, Thread[]>();
    for (const thread of visible) {
      const key = anchorSlide(thread.anchor) ?? "deck";
      if (!bySlide.has(key)) bySlide.set(key, []);
      bySlide.get(key)!.push(thread);
    }
    const out: Group[] = [];
    if (bySlide.has("deck")) out.push({ key: "deck", title: "The whole deck", threads: bySlide.get("deck")! });
    deck.slides.forEach((slide, index) => {
      const threads = bySlide.get(slide.id);
      if (threads) out.push({ key: slide.id, title: `Slide ${index + 1}`, threads });
    });
    if (bySlide.has("master")) out.push({ key: "master", title: "Master", threads: bySlide.get("master")! });
    const known = new Set(["deck", "master", ...deck.slides.map(s => s.id)]);
    const gone = [...bySlide.entries()].filter(([key]) => !known.has(key)).flatMap(([, threads]) => threads);
    if (gone.length) out.push({ key: "gone", title: "Deleted slides", threads: gone });
    for (const group of out) group.threads.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return out;
  }, [list, showResolved, deck.slides]);

  const flat = useMemo(() => groups.flatMap(group => group.threads), [groups]);
  const openCount = list.filter(thread => thread.state === "open").length;

  const open = (thread: Thread) => {
    const slide = anchorSlide(thread.anchor);
    if (slide && slide !== "master" && deck.slides.some(s => s.id === slide) && slide !== editor.ui.get().slideId) editor.goToSlide(slide);
    editor.ui.set({ activeThread: thread.id, composer: null });
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-thread="${thread.id}"]`)?.scrollIntoView({ block: "nearest" }));
  };

  const move = (delta: number) => {
    if (!flat.length) return;
    const index = flat.findIndex(thread => thread.id === activeThread);
    const next = flat[index < 0 ? (delta > 0 ? 0 : flat.length - 1) : (index + delta + flat.length) % flat.length]!;
    open(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("textarea, input")) return;
    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Escape" && activeThread) {
      editor.ui.set({ activeThread: null });
    }
  };

  const startOn = (kind: "deck" | "slide") => {
    const slide = editor.currentSlideId();
    editor.ui.set({ composer: { anchor: kind === "deck" || !slide ? { kind: "deck" } : { kind: "slide", slide }, at: null }, activeThread: null });
  };

  const panelComposer = composer && composer.at === null ? composer : null;

  return (
    <div className={styles.panel} ref={listRef} onKeyDown={onKeyDown} tabIndex={-1} aria-label="Comments">
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>
          Comments <span className={styles.count}>{openCount}</span>
        </h2>
        <Switch label="Show resolved" checked={showResolved} onCheckedChange={value => editor.ui.set({ showResolved: value })} />
      </div>
      {canComment || signInToComment ? (
        <div className={styles.startRow}>
          <button type="button" className={styles.startButton} data-sq="surface" onClick={() => startOn("slide")} disabled={!slideId}>
            <MessageSquarePlus size={15} aria-hidden="true" /> On this slide
          </button>
          <button type="button" className={styles.startButton} data-sq="surface" onClick={() => startOn("deck")}>
            <MessageSquarePlus size={15} aria-hidden="true" /> On the whole deck
          </button>
        </div>
      ) : null}
      {panelComposer ? <CommentComposer editor={editor} anchor={panelComposer.anchor} onDone={() => editor.ui.set({ composer: null })} /> : null}
      {!loaded ? <p className={styles.empty}>Loading comments…</p> : null}
      {loaded && !flat.length ? (
        <p className={styles.empty}>
          {list.length ? "Every thread is resolved. Turn on Show resolved to see them." : canComment ? "No comments yet. Click anywhere on a slide in comment mode, or drag over an area, to comment on it." : "No comments yet."}
        </p>
      ) : null}
      {groups.map(group => (
        <section key={group.key} className={styles.group} aria-label={group.title}>
          <h3 className={styles.groupTitle}>{group.title}</h3>
          <ul className={styles.threadList}>
            {group.threads.map(thread =>
              thread.id === activeThread ? (
                <li key={thread.id} data-thread={thread.id} className={styles.threadItemOpen}>
                  <ThreadView thread={thread} editor={editor} canComment={canComment} onClose={() => editor.ui.set({ activeThread: null })} />
                </li>
              ) : (
                <li key={thread.id} data-thread={thread.id}>
                  <button type="button" className={styles.threadItem} data-state={thread.state} onClick={() => open(thread)}>
                    <span className={styles.anchorLabel}>
                      {anchorText(thread.anchor)}
                      {thread.exists ? "" : " · no longer in the deck"}
                    </span>
                    <span className={styles.preview}>
                      <strong>{nameOf(thread.comments[0]?.author)}</strong> {thread.comments.find(c => !c.deleted)?.body ?? ""}
                    </span>
                    <span className={styles.muted}>
                      {thread.comments.length > 1 ? `${thread.comments.length - 1} ${thread.comments.length === 2 ? "reply" : "replies"} · ` : ""}
                      {formatRelative(thread.comments.at(-1)?.createdAt ?? thread.createdAt)}
                      {thread.state === "resolved" ? " · Resolved" : ""}
                    </span>
                  </button>
                </li>
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
