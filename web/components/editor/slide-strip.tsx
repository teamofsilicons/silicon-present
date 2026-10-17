"use client";

/**
 * The slide list on the left (and the slide sorter): thumbnails drawn by @silicon-present/render, sections as dividers,
 * skipped slides dimmed, who is on which slide, and comment counts. Drag a slide to move it; right-click for new,
 * duplicate, delete, skip, section and move. ↑/↓ move between slides, Delete deletes one.
 */
import { memo, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import { EyeOff, MessageSquare, Plus } from "lucide-react";
import { renderSlideHtml } from "@silicon-present/render";
import { LAYOUTS, type DeckJson, type Slide } from "@silicon-present/deck";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/arc/popover/popover";
import { useStore } from "@/lib/editor/store";
import { nameOf } from "@/lib/editor/normalize-api";
import { keyLabel } from "@/lib/editor/keys";
import { useAbilities, useDeck, useEditor, useUi } from "./editor-context";
import { ContextMenu, type ContextItem } from "./context-menu";
import styles from "./editor.module.css";

export const LAYOUT_NAMES: Record<string, string> = {
  title: "Title",
  "title-body": "Title and body",
  "two-columns": "Two columns",
  section: "Section",
  "title-only": "Title only",
  "image-caption": "Picture with caption",
  blank: "Blank",
};

const THUMB_W = 176;

const Thumb = memo(function Thumb({ deck, slide, width }: { deck: DeckJson; slide: Slide; width: number }) {
  const html = useMemo(
    () => renderSlideHtml({ ...deck, slides: [slide] }, slide.id, { html: "static", media: "static", links: false, includeCss: false, googleFonts: false, placeholders: false }),
    // Only what this slide shows: itself, the theme, the size, the master.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slide, deck.theme, deck.size, deck.master],
  );
  const scale = width / deck.size.width;
  return (
    <div className={styles.thumbBox} style={{ width, height: deck.size.height * scale }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0", width: deck.size.width, height: deck.size.height, pointerEvents: "none" }} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});

export function LayoutPicker({ onPick, children }: { onPick: (layout: string) => void; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className={styles.layoutMenu}>
        <p className={styles.menuTitle}>New slide</p>
        <div className={styles.layoutGrid}>
          {LAYOUTS.map(layout => (
            <button
              key={layout}
              type="button"
              className={styles.layoutOption}
              data-sq="surface"
              onClick={() => {
                setOpen(false);
                onPick(layout);
              }}
            >
              <LayoutGlyph layout={layout} />
              <span>{LAYOUT_NAMES[layout] ?? layout}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A tiny diagram of a layout's placeholders. */
export function LayoutGlyph({ layout }: { layout: string }) {
  const bar = (x: number, y: number, w: number, h: number, key: string, strong = false) => <rect key={key} x={x} y={y} width={w} height={h} rx={1.5} fill={strong ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1} opacity={strong ? 0.55 : 0.6} />;
  const parts: React.ReactNode[] = [];
  if (layout === "title") parts.push(bar(8, 13, 48, 7, "t", true), bar(16, 23, 32, 4, "s"));
  if (layout === "title-body") parts.push(bar(6, 5, 52, 6, "t", true), bar(6, 14, 52, 17, "b"));
  if (layout === "two-columns") parts.push(bar(6, 5, 52, 6, "t", true), bar(6, 14, 25, 17, "l"), bar(33, 14, 25, 17, "r"));
  if (layout === "section") parts.push(bar(6, 13, 8, 2, "a", true), bar(6, 17, 40, 6, "t", true));
  if (layout === "title-only") parts.push(bar(6, 5, 52, 6, "t", true));
  if (layout === "image-caption") parts.push(bar(6, 4, 52, 21, "i"), bar(14, 28, 36, 3, "c", true));
  return (
    <svg viewBox="0 0 64 36" width="64" height="36" className={styles.layoutGlyph} aria-hidden="true">
      <rect x="0.5" y="0.5" width="63" height="35" rx="3" fill="var(--surface)" stroke="var(--border)" />
      {parts}
    </svg>
  );
}

export function SlideStrip() {
  const editor = useEditor();
  const deck = useDeck();
  const { slideId, master } = useUi(s => ({ slideId: s.slideId, master: s.master }));
  const { canEdit } = useAbilities();
  const { others } = useStore(editor.presence, s => s);
  const { list: threads } = useStore(editor.threads, s => s);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; slide: string } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const current = master ? null : slideId ?? deck.slides[0]?.id ?? null;

  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const thread of threads) if (thread.state === "open" && thread.anchor.kind !== "deck") out.set(thread.anchor.slide, (out.get(thread.anchor.slide) ?? 0) + 1);
    return out;
  }, [threads]);

  const items = (id: string): ContextItem[] => {
    const slide = deck.slides.find(s => s.id === id);
    const index = deck.slides.findIndex(s => s.id === id);
    if (!slide) return [];
    return [
      { label: "New slide", shortcut: keyLabel("Mod+M"), onSelect: () => editor.addSlide("title-body", id) },
      { label: "Duplicate slide", onSelect: () => editor.duplicateSlide(id) },
      { label: slide.skipped ? "Don't skip slide" : "Skip slide", onSelect: () => editor.updateSlide(id, { skipped: !slide.skipped }) },
      { label: slide.section !== null ? "Rename section" : "Start a section here", separatorBefore: true, onSelect: () => {
          if (slide.section === null) editor.updateSlide(id, { section: "New section" });
          setRenaming(id);
        } },
      ...(slide.section !== null ? [{ label: "Remove section", onSelect: () => editor.updateSlide(id, { section: null }) }] : []),
      { label: "Move up", separatorBefore: true, disabled: index <= 0, onSelect: () => editor.moveSlide(id, index - 2 >= 0 ? deck.slides[index - 2]!.id : null) },
      { label: "Move down", disabled: index >= deck.slides.length - 1, onSelect: () => editor.moveSlide(id, deck.slides[index + 1]!.id) },
      { label: "Delete slide", destructive: true, separatorBefore: true, disabled: deck.slides.length <= 1, onSelect: () => editor.deleteSlides([id]) },
    ];
  };

  const onDragOver = (event: DragEvent<HTMLLIElement>, index: number) => {
    if (!dragging) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setDropAt(event.clientY < rect.top + rect.height / 2 ? index : index + 1);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    if (!dragging || dropAt === null) return finish();
    const ids = deck.slides.map(s => s.id).filter(id => id !== dragging);
    const from = deck.slides.findIndex(s => s.id === dragging);
    const to = dropAt > from ? dropAt - 1 : dropAt;
    if (to !== from) editor.moveSlide(dragging, to === 0 ? null : ids[to - 1]!);
    finish();
  };

  const finish = () => {
    setDragging(null);
    setDropAt(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("input")) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      editor.stepSlide(event.key === "ArrowDown" ? 1 : -1);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="slide-thumb"][data-current]`)?.focus());
    } else if ((event.key === "Delete" || event.key === "Backspace") && canEdit && current) {
      event.preventDefault();
      event.stopPropagation();
      editor.deleteSlides([current]);
    } else if (event.key === "d" && (event.metaKey || event.ctrlKey) && canEdit && current) {
      event.preventDefault();
      event.stopPropagation();
      editor.duplicateSlide(current);
    }
  };

  return (
    <nav className={styles.strip} aria-label="Slides" onKeyDown={onKeyDown}>
      <ol className={styles.stripList} onDragOver={event => dragging && event.preventDefault()} onDrop={onDrop}>
        {deck.slides.map((slide, index) => {
          const here = others.filter(o => o.slide === slide.id);
          const count = counts.get(slide.id) ?? 0;
          return (
            <li key={slide.id} onDragOver={event => onDragOver(event, index)} className={styles.stripItem}>
              {slide.section !== null ? (
                renaming === slide.id && canEdit ? (
                  <input
                    className={styles.sectionInput}
                    autoFocus
                    defaultValue={slide.section}
                    aria-label="Section name"
                    onKeyDown={event => {
                      event.stopPropagation();
                      if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                      if (event.key === "Escape") setRenaming(null);
                    }}
                    onBlur={event => {
                      const name = event.target.value.trim();
                      editor.updateSlide(slide.id, { section: name || "Section" });
                      setRenaming(null);
                    }}
                  />
                ) : (
                  <p className={styles.section} onDoubleClick={() => canEdit && setRenaming(slide.id)} data-testid="section-divider">
                    {slide.section || "Section"}
                  </p>
                )
              ) : null}
              {dropAt === index && dragging ? <div className={styles.dropLine} /> : null}
              <button
                type="button"
                className={styles.thumb}
                data-testid="slide-thumb"
                data-slide-id={slide.id}
                data-current={slide.id === current || undefined}
                data-skipped={slide.skipped || undefined}
                aria-current={slide.id === current ? "true" : undefined}
                aria-label={`Slide ${index + 1}${slide.skipped ? ", skipped" : ""}${count ? `, ${count} open comments` : ""}`}
                draggable={canEdit}
                onDragStart={event => {
                  setDragging(slide.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/x-present-slide", slide.id);
                }}
                onDragEnd={finish}
                onClick={() => editor.goToSlide(slide.id)}
                onContextMenu={event => {
                  if (!canEdit) return;
                  event.preventDefault();
                  editor.goToSlide(slide.id);
                  setMenu({ at: { x: event.clientX, y: event.clientY }, slide: slide.id });
                }}
              >
                <span className={styles.thumbNumber}>{index + 1}</span>
                <span className={styles.thumbFrame}>
                  <Thumb deck={deck} slide={slide} width={THUMB_W} />
                  {slide.skipped ? (
                    <span className={styles.skipBadge}>
                      <EyeOff size={12} aria-hidden="true" /> Skipped
                    </span>
                  ) : null}
                  {here.length ? (
                    <span className={styles.thumbPeople}>
                      {here.slice(0, 3).map(o => (
                        <Avatar key={o.session} name={nameOf(o.account)} src={o.account?.pfp_url ?? undefined} size="sm" />
                      ))}
                    </span>
                  ) : null}
                  {count ? (
                    <span className={styles.thumbComments}>
                      <MessageSquare size={11} aria-hidden="true" /> {count}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
        {dropAt === deck.slides.length && dragging ? <div className={styles.dropLine} /> : null}
      </ol>
      {canEdit ? (
        <LayoutPicker onPick={layout => editor.addSlide(layout, deck.slides.at(-1)?.id ?? null)}>
          <button type="button" className={styles.newSlide} data-sq="surface" data-testid="new-slide">
            <Plus size={16} aria-hidden="true" /> New slide
          </button>
        </LayoutPicker>
      ) : null}
      <ContextMenu at={menu?.at ?? null} items={menu ? items(menu.slide) : []} onClose={() => setMenu(null)} label="Slide actions" />
    </nav>
  );
}
