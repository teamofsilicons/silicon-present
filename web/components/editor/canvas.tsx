"use client";

/**
 * The slide canvas: the current slide at its own size (1920 x 1080 by default), scaled to fit the window or to a zoom
 * level. Editors select (click, shift-click, marquee), move, resize (8 handles, shift keeps the ratio), rotate (shift
 * snaps to 15°), with snapping to the slide's edges and centre, other elements' edges and centres and an optional grid,
 * showing the guide lines. Double-click edits text in place, or the inside of an HTML element (./html-inside.tsx).
 *
 * In comment mode (or the phone's review view), a click opens a comment box right there and a drag draws an area for
 * it; double-clicking text lets them pick a passage to comment on. Select never changes a read-only deck.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { backgroundCss, fontCss, slideCss } from "@silicon-present/render";
import { normalizeElement, type Element, type ShapeName } from "@silicon-present/deck";
import { HANDLES, hitElement, intersects, normalizeRect, resizeBox, rotatedBounds, snapMove, snapResize, toElementFraction, unionBox, type Box, type Handle } from "@/lib/editor/geometry";
import { insertFiles } from "@/lib/editor/insert";
import { areaAnchorFractions } from "@/lib/editor/comment-anchors";
import { drawnShape } from "@/lib/editor/shape-drawing";
import { editorShortcutAllowed } from "@/lib/editor/keys";
import type { Anchor } from "@/lib/editor/types";
import { useAbilities, useCurrentSlide, useDeck, useEditor, useUi } from "./editor-context";
import { SlideElement, type ElementBox } from "./slide-element";
import { CanvasPresence } from "./canvas-presence";
import { TextEditor } from "./text-editor";
import { HtmlInside } from "./html-inside";
import { CommentLayer } from "@/components/comments/comment-layer";
import { ObjectContextMenu, type ObjectMenuTarget } from "./object-context-menu";
import styles from "./editor.module.css";

type Drag =
  | { kind: "draw"; shape: ShapeName; slideId: string; start: { x: number; y: number }; current: { x: number; y: number }; pointerId: number; surface: HTMLElement; scale: number }
  | { kind: "move"; start: { x: number; y: number }; boxes: Map<string, ElementBox>; moved: boolean; clicked: string; wasSelected: boolean }
  | { kind: "resize"; handle: Handle; id: string; start: { x: number; y: number }; box: ElementBox }
  | { kind: "rotate"; id: string; center: { x: number; y: number }; startAngle: number; startRotation: number }
  | { kind: "marquee"; start: { x: number; y: number }; current: { x: number; y: number }; additive: boolean }
  | { kind: "comment"; start: { x: number; y: number }; current: { x: number; y: number } };

const GRID = 40;

export function Canvas({ phone = false }: { phone?: boolean }) {
  const editor = useEditor();
  const deck = useDeck();
  const slide = useCurrentSlide();
  const ui = useUi(s => ({
    selection: s.selection,
    editing: s.editing,
    zoom: s.zoom,
    commentMode: s.commentMode,
    handMode: s.handMode,
    shape: s.shape,
    shapeArmed: s.shapeArmed,
    preview: s.preview,
    guides: s.guides,
    snap: s.snap,
    grid: s.grid,
    master: s.master,
    codeElement: s.codeElement,
    htmlInside: s.htmlInside,
  }));
  const { canEdit, canComment, signInToComment } = useAbilities();
  const viewport = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(0.4);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const panDrag = useRef<{ id: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const panning = ui.handMode || spaceHeld;
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.metaKey || event.ctrlKey || event.altKey || !editorShortcutAllowed(event)) return;
      event.preventDefault(); setSpaceHeld(true);
    };
    const up = (event: KeyboardEvent) => { if (event.code === "Space") setSpaceHeld(false); };
    const blur = () => { setSpaceHeld(false); panDrag.current = null; };
    const reset = () => setPan({ x: 0, y: 0 });
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", blur); window.addEventListener("present:fit", reset);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); window.removeEventListener("present:fit", reset); };
  }, []);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const [drawing, setDrawing] = useState<{ slideId: string; element: Element } | null>(null);
  const [objectMenu, setObjectMenu] = useState<ObjectMenuTarget | null>(null);
  const [commentText, setCommentText] = useState<{ elementId: string; field: string } | null>(null);
  const [runKeys, setRunKeys] = useState<Record<string, number>>({});
  const [paused, setPaused] = useState<Record<string, boolean>>({});
  const drag = useRef<Drag | null>(null);
  const cancelDrawing = useCallback(() => {
    const current = drag.current;
    if (current?.kind !== "draw") return;
    drag.current = null;
    setDrawing(null);
    if (current.surface.hasPointerCapture(current.pointerId)) current.surface.releasePointerCapture(current.pointerId);
  }, []);
  useEffect(() => {
    const check = () => {
      const state = editor.ui.get();
      const current = drag.current;
      if (current?.kind === "draw" && (!editor.canEdit || !state.shapeArmed || state.shape !== current.shape
        || state.overview || editor.currentSlideId() !== current.slideId)) cancelDrawing();
      setObjectMenu(menu => menu && (editor.currentSlideId() !== menu.slideId || state.shapeArmed || state.handMode || state.commentMode || state.overview) ? null : menu);
    };
    const stopUi = editor.ui.subscribe(check);
    const stopMeta = editor.meta.subscribe(check);
    const blur = () => cancelDrawing();
    const shift = (event: KeyboardEvent) => {
      const current = drag.current;
      if (event.key !== "Shift" || current?.kind !== "draw") return;
      const input = drawnShape(current.shape, current.start, current.current, event.shiftKey, editor.deck().theme, current.scale);
      setDrawing(input ? { slideId: current.slideId, element: normalizeElement({ ...input, id: "e_drawpreview" }) } : null);
    };
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", shift); window.addEventListener("keyup", shift);
    return () => { stopUi(); stopMeta(); window.removeEventListener("blur", blur); window.removeEventListener("keydown", shift); window.removeEventListener("keyup", shift); };
  }, [editor, cancelDrawing]);
  const { width: W, height: H } = deck.size;
  const commenting = phone || ui.commentMode;
  const mayComment = canComment || signInToComment;
  // A passage picker belongs to Comment; returning to Select or Hand closes it.
  if (!commenting && commentText) setCommentText(null);

  // Fit to the window.
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () => {
      const pad = phone ? 16 : 56;
      const next = Math.max(0.05, Math.min((node.clientWidth - pad) / W, (node.clientHeight - pad - (phone ? 0 : 72)) / H));
      setFit(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [W, H, phone]);
  const scale = ui.zoom === "fit" ? fit : ui.zoom;
  useEffect(() => {
    editor.ui.set({ fitScale: fit });
  }, [editor, fit]);

  // The code panel's Run and Pause (lib/editor's events).
  useEffect(() => {
    const onRun = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      setPaused(p => ({ ...p, [id]: false }));
      setRunKeys(k => ({ ...k, [id]: (k[id] ?? 0) + 1 }));
    };
    const onPause = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      setPaused(p => ({ ...p, [id]: !p[id] }));
    };
    window.addEventListener("present:run-html", onRun);
    window.addEventListener("present:pause-html", onPause);
    return () => {
      window.removeEventListener("present:run-html", onRun);
      window.removeEventListener("present:pause-html", onPause);
    };
  }, []);
  useEffect(() => {
    (window as unknown as { __presentPaused?: Record<string, boolean> }).__presentPaused = paused;
  }, [paused]);

  const elements = useMemo(() => slide?.elements ?? [], [slide]);
  const masterElements = slide && !slide.isMaster && !slide.hideMaster ? deck.master.elements : [];
  const selected = useMemo(() => new Set(ui.selection), [ui.selection]);

  const toSlide = useCallback(
    (clientX: number, clientY: number) => {
      const rect = slideRef.current!.getBoundingClientRect();
      return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
    },
    [scale],
  );

  const hit = useCallback((p: { x: number; y: number }): Element | null => {
    for (let i = elements.length - 1; i >= 0; i--) if (hitElement(elements[i]!, p.x, p.y)) return elements[i]!;
    return null;
  }, [elements]);

  const boxOf = (element: Element): ElementBox => ui.preview?.[element.id] ?? { x: element.x, y: element.y, w: element.w, h: element.h, rotation: element.rotation };

  // Editing an HTML element's inside ends when it is locked, deleted, or this Carbon can no longer edit.
  const insideEl = ui.htmlInside && canEdit && !commenting ? elements.find(e => e.id === ui.htmlInside!.elementId && e.kind === "html" && !e.locked) ?? null : null;
  const insideLost = Boolean(ui.htmlInside) && !insideEl;
  useEffect(() => {
    if (insideLost) editor.exitHtmlInside();
  }, [editor, insideLost]);

  // ---- comments ----

  const openComposer = (anchor: Anchor, at: { x: number; y: number }) => {
    editor.ui.set({ composer: { anchor, at }, activeThread: null, panel: "comments", panelOpen: !phone || editor.ui.get().panelOpen });
  };

  const commentAt = (start: { x: number; y: number }, end: { x: number; y: number }) => {
    if (!slide) return;
    const area = normalizeRect(start.x, start.y, end.x, end.y);
    const isArea = area.w > 12 && area.h > 12;
    const target = hit(isArea ? { x: area.x + area.w / 2, y: area.y + area.h / 2 } : start);
    const slideId = slide.id;
    let anchor: Anchor;
    if (isArea) {
      anchor = { kind: "area", slide: slideId, x: round(area.x), y: round(area.y), w: round(area.w), h: round(area.h) };
      if (target) {
        const a = areaAnchorFractions(target, area);
        anchor = { ...anchor, element: target.id, ...a };
      }
      openComposer(anchor, { x: area.x + area.w, y: area.y });
    } else {
      anchor = { kind: "point", slide: slideId, x: round(start.x), y: round(start.y) };
      if (target) {
        const a = toElementFraction(target, start.x, start.y);
        anchor = { ...anchor, element: target.id, ex: frac(a.ex), ey: frac(a.ey) };
      }
      openComposer(anchor, start);
    }
  };

  // ---- pointer ----

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !slide || !event.isPrimary) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-no-canvas]")) return;
    const p = toSlide(event.clientX, event.clientY);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    // The HTML element being edited inside covers its own box: a press anywhere else on the canvas finishes.
    if (ui.htmlInside) editor.exitHtmlInside();
    editor.ui.set({ composer: null });
    setObjectMenu(null);
    if (commentText) setCommentText(null);

    if (commenting) {
      if (!mayComment) return;
      drag.current = { kind: "comment", start: p, current: p };
      return;
    }
    if (!canEdit) {
      const element = hit(p);
      if (element) editor.select([element.id], event.shiftKey ? "toggle" : "replace");
      else editor.clearSelection();
      return;
    }
    if (ui.editing) editor.stopEditing();
    if (ui.shapeArmed) {
      event.preventDefault();
      drag.current = { kind: "draw", shape: ui.shape, slideId: slide.id, start: p, current: p,
        pointerId: event.pointerId, surface: event.currentTarget, scale };
      setDrawing(null);
      return;
    }

    const handle = target.dataset.handle as Handle | "rotate" | undefined;
    const one = ui.selection.length === 1 ? elements.find(e => e.id === ui.selection[0]) : null;
    if (handle && one && !one.locked) {
      const box = boxOf(one);
      if (handle === "rotate") {
        const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
        drag.current = { kind: "rotate", id: one.id, center, startAngle: Math.atan2(p.y - center.y, p.x - center.x), startRotation: box.rotation };
      } else drag.current = { kind: "resize", handle, id: one.id, start: p, box };
      editor.stopCapturing();
      return;
    }
    const element = hit(p);
    if (!element) {
      if (!event.shiftKey) editor.clearSelection();
      drag.current = { kind: "marquee", start: p, current: p, additive: event.shiftKey };
      return;
    }
    const wasSelected = selected.has(element.id);
    if (event.shiftKey) editor.select([element.id], "toggle");
    else if (!wasSelected) editor.select([element.id]);
    const ids = editor.ui.get().selection;
    const boxes = new Map<string, ElementBox>();
    for (const id of ids) {
      const el = elements.find(e => e.id === id);
      if (el && !el.locked) boxes.set(id, boxOf(el));
    }
    drag.current = { kind: "move", start: p, boxes, moved: false, clicked: element.id, wasSelected };
    editor.stopCapturing();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!slide) return;
    const p = toSlide(event.clientX, event.clientY);
    editor.provider.setPresence({ cursor: { x: round(p.x), y: round(p.y) } });
    const d = drag.current;
    if (!d) return;
    if (d.kind === "draw") {
      if (d.pointerId !== event.pointerId) return;
      d.current = p;
      const input = drawnShape(d.shape, d.start, p, event.shiftKey, deck.theme, d.scale);
      setDrawing(input ? { slideId: d.slideId, element: normalizeElement({ ...input, id: "e_drawpreview" }) } : null);
      return;
    }
    const threshold = 6 / scale;
    if (d.kind === "comment") {
      d.current = p;
      const box = normalizeRect(d.start.x, d.start.y, p.x, p.y);
      setDraft(box.w > 12 && box.h > 12 ? box : null);
      return;
    }
    if (d.kind === "marquee") {
      d.current = p;
      setMarquee(normalizeRect(d.start.x, d.start.y, p.x, p.y));
      return;
    }
    if (d.kind === "move") {
      let dx = p.x - d.start.x;
      let dy = p.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) < 3 / scale) return;
      d.moved = true;
      if (event.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const moving = [...d.boxes.values()].map(b => rotatedBounds({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, b.rotation));
      const union = unionBox(moving);
      let guides: ReturnType<typeof snapMove>["guides"] = [];
      if (union && ui.snap && !event.altKey) {
        const others = elements.filter(e => !d.boxes.has(e.id)).map(e => rotatedBounds(e, e.rotation));
        const snapped = snapMove(union, others, deck.size, threshold, ui.grid ? GRID : 0);
        dx += snapped.dx;
        dy += snapped.dy;
        guides = snapped.guides;
      }
      const preview: Record<string, ElementBox> = {};
      for (const [id, b] of d.boxes) preview[id] = { ...b, x: b.x + dx, y: b.y + dy };
      editor.ui.set({ preview, guides });
      return;
    }
    if (d.kind === "resize") {
      const el = elements.find(e => e.id === d.id);
      const keep = event.shiftKey || (el?.kind === "image" && d.handle.length === 2);
      let next = resizeBox(d.box, d.box.rotation, d.handle, p.x - d.start.x, p.y - d.start.y, keep);
      let guides: ReturnType<typeof snapResize>["guides"] = [];
      if (ui.snap && !d.box.rotation && !keep && !event.altKey) {
        const others = elements.filter(e => e.id !== d.id).map(e => rotatedBounds(e, e.rotation));
        const snapped = snapResize(next, d.handle, others, deck.size, threshold);
        next = snapped.box;
        guides = snapped.guides;
      }
      editor.ui.set({ preview: { [d.id]: { ...next, rotation: d.box.rotation } }, guides });
      return;
    }
    if (d.kind === "rotate") {
      const angle = Math.atan2(p.y - d.center.y, p.x - d.center.x);
      let rotation = d.startRotation + ((angle - d.startAngle) * 180) / Math.PI;
      rotation = ((rotation % 360) + 360) % 360;
      if (event.shiftKey) rotation = Math.round(rotation / 15) * 15;
      else for (const snapTo of [0, 90, 180, 270, 360]) if (Math.abs(rotation - snapTo) < 3) rotation = snapTo % 360;
      const el = elements.find(e => e.id === d.id);
      if (el) editor.ui.set({ preview: { [d.id]: { ...boxOf(el), rotation: Math.round(rotation * 10) / 10 } } });
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.kind === "draw" && d.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!d || !slide) return;
    if (d.kind === "draw") {
      setDrawing(null);
      if (d.surface.hasPointerCapture(d.pointerId)) d.surface.releasePointerCapture(d.pointerId);
      const state = editor.ui.get();
      if (!editor.canEdit || !state.shapeArmed || state.shape !== d.shape || state.overview || editor.currentSlideId() !== d.slideId) return;
      const input = drawnShape(d.shape, d.start, toSlide(event.clientX, event.clientY), event.shiftKey, deck.theme, d.scale);
      if (input) editor.addElement(input);
      return;
    }
    if (d.kind === "comment") {
      setDraft(null);
      const target = event.target as HTMLElement;
      if (target.closest("[data-pin]")) return;
      commentAt(d.start, d.current);
      return;
    }
    if (d.kind === "marquee") {
      setMarquee(null);
      const box = normalizeRect(d.start.x, d.start.y, d.current.x, d.current.y);
      if (box.w < 3 && box.h < 3) return;
      const ids = elements.filter(e => intersects(rotatedBounds(e, e.rotation), box)).map(e => e.id);
      editor.select(ids, d.additive ? "add" : "replace");
      return;
    }
    const preview = editor.ui.get().preview;
    editor.ui.set({ preview: null, guides: [] });
    if (d.kind === "move") {
      if (!d.moved) {
        // A click on an element that was already selected: inside a group it picks that one element; on a lone text
        // box it starts editing (as in other slide editors).
        if (d.wasSelected && !event.shiftKey) {
          const el = elements.find(e => e.id === d.clicked);
          const groupSelected = el?.group && editor.ui.get().selection.length > 1;
          if (groupSelected) editor.selectOnly(d.clicked);
          else if (el && (el.kind === "text" || el.kind === "shape") && editor.ui.get().selection.length === 1 && !el.locked) editor.startEditing(el.id);
        }
        return;
      }
      if (preview) editor.updateElements(Object.entries(preview).map(([id, b]) => ({ id, set: { x: round(b.x), y: round(b.y) } })));
      editor.stopCapturing();
      return;
    }
    if (d.kind === "resize" && preview?.[d.id]) {
      const b = preview[d.id]!;
      editor.updateElement(d.id, { x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) });
      editor.stopCapturing();
      return;
    }
    if (d.kind === "rotate" && preview?.[d.id]) {
      editor.updateElement(d.id, { rotation: preview[d.id]!.rotation });
      editor.stopCapturing();
    }
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!slide || panning) return;
    const p = toSlide(event.clientX, event.clientY);
    const element = hit(p);
    if (!element) return;
    const field = textFieldAt(element, p);
    if (commenting) {
      if (field && mayComment) {
        editor.ui.set({ composer: null });
        setCommentText({ elementId: element.id, field });
      }
      return;
    }
    if (!canEdit || element.locked) return;
    if (ui.shapeArmed) editor.setTool("select");
    if (element.kind === "html") {
      editor.enterHtmlInside(element.id);
      return;
    }
    if (field) editor.startEditing(element.id, field);
  };

  // ---- drop files ----

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!canEdit || !event.dataTransfer.files.length) return;
    event.preventDefault();
    const p = toSlide(event.clientX, event.clientY);
    void insertFiles(editor, Array.from(event.dataTransfer.files), p);
  };

  const openObjectMenu = useCallback((element: Element, at: { x: number; y: number }, field?: string) => {
    const slideId = editor.currentSlideId();
    if (!slideId) return;
    editor.setTool("select");
    if (!editor.ui.get().selection.includes(element.id)) editor.select([element.id]);
    setObjectMenu({ at, slideId, elementId: element.id, field });
  }, [editor]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) || !editorShortcutAllowed(event)) return;
      const element = editor.selectedElements()[0];
      const rect = slideRef.current?.getBoundingClientRect();
      if (!element || !rect) return;
      event.preventDefault();
      openObjectMenu(element, { x: rect.left + (element.x + element.w / 2) * scale, y: rect.top + (element.y + element.h / 2) * scale });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor, openObjectMenu, scale]);

  if (!slide) {
    return (
      <div className={styles.viewport} ref={viewport}>
        <p className={styles.loadingNote}>{editor.status.get().synced ? "This deck has no slides yet." : "Opening the deck…"}</p>
      </div>
    );
  }

  const one = ui.selection.length === 1 ? elements.find(e => e.id === ui.selection[0]) : null;
  const selectionBoxes = elements.filter(e => selected.has(e.id)).map(e => ({ element: e, box: boxOf(e) }));
  const union = selectionBoxes.length > 1 ? unionBox(selectionBoxes.map(s => rotatedBounds(s.box, s.box.rotation))) : null;
  const hs = 10 / scale;
  const line = 1.5 / scale;
  const editingEl = ui.editing ? elements.find(e => e.id === ui.editing!.elementId) : null;
  const commentTextEl = commentText ? elements.find(e => e.id === commentText.elementId) : null;

  return (
    <div
      className={styles.viewport}
      ref={viewport}
      data-hand={panning || undefined}
      onPointerDownCapture={event => {
        if ((event.button !== 0 && event.button !== 1) || (!panning && event.button !== 1) || (event.target as HTMLElement).closest("[data-no-canvas]")) return;
        event.preventDefault(); event.stopPropagation();
        if (panDrag.current || !event.isPrimary) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        panDrag.current = { id: event.pointerId, x: pan.x, y: pan.y, startX: event.clientX, startY: event.clientY };
      }}
      onPointerMoveCapture={event => { const start = panDrag.current; if (!start) return; event.stopPropagation(); if (start.id === event.pointerId) setPan({ x: start.x + event.clientX - start.startX, y: start.y + event.clientY - start.startY }); }}
      onPointerUpCapture={event => { if (!panDrag.current) return; event.stopPropagation(); if (panDrag.current.id !== event.pointerId) return; panDrag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancelCapture={event => { if (panDrag.current?.id === event.pointerId) panDrag.current = null; }}
      onLostPointerCapture={event => { if (panDrag.current?.id === event.pointerId) panDrag.current = null; }}
      data-zoomed={ui.zoom !== "fit" || undefined}
      onDragOver={event => {
        if (canEdit && event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={onDrop}
    >
      <style>{slideCss()}</style>
      <FontStyles />
      <div className={styles.stage} style={{ width: W * scale, height: H * scale, transform: `translate(${pan.x}px, ${pan.y}px)` }}>
        <div
          ref={slideRef}
          className={`sp-slide ${styles.slide}`}
          data-testid="slide-canvas"
          data-slide-id={slide.id}
          data-mode={panning ? "hand" : commenting ? "comment" : ui.shapeArmed ? "draw" : "edit"}
          style={{ width: W, height: H, transform: `scale(${scale})`, fontFamily: `"${deck.theme.fonts.body}", system-ui, sans-serif`, color: deck.theme.colors.text }}
        >
          <div className={styles.transitionTarget} data-transition-target="">
          <div className="sp-bg" style={cssText(backgroundCss(deck, slide.isMaster ? null : slide, {}))} />
          <div className="sp-layer" style={{ pointerEvents: "none" }}>
            {masterElements.map(element => (
              <SlideElement key={`m-${element.id}`} element={element} theme={deck.theme} muted={!slide.isMaster} />
            ))}
            {elements.map(element => (
              <SlideElement
                key={element.id}
                element={element}
                theme={deck.theme}
                box={ui.preview?.[element.id] ?? null}
                hideText={editingEl?.id === element.id}
                hidden={insideEl?.id === element.id}
                html={paused[element.id] || insideEl?.id === element.id ? "static" : "live"}
                runKey={runKeys[element.id] ?? 0}
                placeholder={canEdit && !commenting}
              />
            ))}
            {drawing && drawing.slideId === slide.id && ui.shapeArmed ? <div data-testid="shape-draw-preview" aria-hidden="true" style={{ position: "absolute", inset: 0, opacity: 0.75, pointerEvents: "none" }}>
              <SlideElement element={drawing.element} theme={deck.theme} />
            </div> : null}
          </div>
          </div>
          {ui.grid && !commenting ? <div className={styles.grid} style={{ backgroundSize: `${GRID}px ${GRID}px` }} aria-hidden="true" /> : null}
          <div
            className={styles.overlay}
            data-testid="canvas-overlay"
            data-commenting={commenting || undefined}
            data-can-comment={mayComment || undefined}
            style={ui.shapeArmed ? { cursor: "crosshair" } : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              cancelDrawing();
              drag.current = null;
              setMarquee(null);
              setDraft(null);
              editor.ui.set({ preview: null, guides: [] });
            }}
            onLostPointerCapture={event => { if (drag.current?.kind === "draw" && drag.current.pointerId === event.pointerId) cancelDrawing(); }}
            onPointerLeave={() => editor.provider.setPresence({ cursor: null })}
            onDoubleClick={onDoubleClick}
            onContextMenu={event => {
              event.preventDefault(); event.stopPropagation();
              const point = toSlide(event.clientX, event.clientY);
              const element = hit(point);
              if (element) openObjectMenu(element, { x: event.clientX, y: event.clientY }, textFieldAt(element, point) ?? undefined);
              else { cancelDrawing(); setObjectMenu(null); }
            }}
          >
            {!commenting
              ? selectionBoxes.map(({ element, box }) => (
                  <div
                    key={element.id}
                    className={styles.selectionBox}
                    data-locked={element.locked || undefined}
                    data-testid="selection-box"
                    style={{ left: box.x, top: box.y, width: box.w, height: box.h, transform: box.rotation ? `rotate(${box.rotation}deg)` : undefined, outlineWidth: line, outlineOffset: line }}
                  >
                    {canEdit && one && one.id === element.id && !element.locked && !ui.editing && !insideEl
                      ? HANDLES.map(h => (
                          <span key={h} className={styles.handle} data-handle={h} data-pos={h} style={{ width: hs, height: hs, margin: -hs / 2, borderWidth: line }} />
                        ))
                      : null}
                    {canEdit && one && one.id === element.id && !element.locked && !ui.editing && !insideEl ? (
                      <span className={styles.rotateHandle} data-handle="rotate" title="Rotate (shift snaps to 15°)" style={{ width: hs * 1.2, height: hs * 1.2, top: -hs * 3, marginLeft: (-hs * 1.2) / 2, borderWidth: line }} />
                    ) : null}
                    {element.locked ? <span className={styles.lockBadge} style={{ fontSize: 12 / scale, padding: `${2 / scale}px ${6 / scale}px` }}>Locked</span> : null}
                  </div>
                ))
              : null}
            {union && !commenting ? <div className={styles.unionBox} style={{ left: union.x, top: union.y, width: union.w, height: union.h, borderWidth: line }} /> : null}
            {ui.guides.map((g, i) =>
              g.axis === "x" ? (
                <div key={i} className={styles.guide} data-testid="snap-guide" style={{ left: g.at - line / 2, top: g.from, width: line, height: g.to - g.from }} />
              ) : (
                <div key={i} className={styles.guide} data-testid="snap-guide" style={{ top: g.at - line / 2, left: g.from, height: line, width: g.to - g.from }} />
              ),
            )}
            {marquee ? <div className={styles.marquee} style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, borderWidth: line }} /> : null}
            {draft ? <div className={styles.commentDraft} data-testid="comment-drag-area" style={{ left: draft.x, top: draft.y, width: draft.w, height: draft.h, borderWidth: 2 / scale }} /> : null}
            <CanvasPresence slideId={slide.id} elements={elements} scale={scale} />
          </div>
          {insideEl?.kind === "html" ? <HtmlInside key={insideEl.id} element={insideEl} theme={deck.theme} /> : null}
          {editingEl && ui.editing ? <TextEditor key={`${editingEl.id}/${ui.editing.field}`} element={editingEl} field={ui.editing.field} theme={deck.theme} readOnly={false} /> : null}
          {commentTextEl && commentText ? (
            <TextEditor
              key={`c/${commentTextEl.id}/${commentText.field}`}
              element={commentTextEl}
              field={commentText.field}
              theme={deck.theme}
              readOnly
              onPickText={(anchor, at) => {
                setCommentText(null);
                openComposer(anchor, at);
              }}
              onClose={() => setCommentText(null)}
            />
          ) : null}
        </div>
        <CommentLayer slide={slide} elements={elements} scale={scale} phone={phone} />
      </div>
      <ObjectContextMenu target={objectMenu} onClose={() => setObjectMenu(null)} />
    </div>
  );
}

/** Which text field of an element a slide point is on: "text", or the table cell "cell:r:c". */
function textFieldAt(element: Element, p: { x: number; y: number }): string | null {
  if (element.kind === "text" || element.kind === "shape") return "text";
  if (element.kind !== "table") return null;
  const { ex, ey } = toElementFraction(element, p.x, p.y);
  const totalW = element.colWidths.reduce((a, b) => a + b, 0) || 1;
  const totalH = element.rowHeights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  let c = 0;
  for (; c < element.cols - 1; c++) {
    acc += element.colWidths[c]! / totalW;
    if (ex < acc) break;
  }
  acc = 0;
  let r = 0;
  for (; r < element.rows - 1; r++) {
    acc += element.rowHeights[r]! / totalH;
    if (ey < acc) break;
  }
  return `cell:${r}:${c}`;
}

function FontStyles() {
  const deck = useDeck();
  const css = useMemo(() => fontCss(deck, { googleFonts: true }), [deck]);
  return <style>{css}</style>;
}

/** "a:b;c:d" → React style object. */
export function cssText(text: string): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const part of text.split(";")) {
    const index = part.indexOf(":");
    if (index < 0) continue;
    const key = part.slice(0, index).trim().replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
    out[key] = part.slice(index + 1).trim();
  }
  return out as React.CSSProperties;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function frac(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 10000) / 10000;
}
