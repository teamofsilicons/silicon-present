"use client";

import { useCallback, useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, ChartColumn, Code, GripVertical, Group, Image as ImageIcon, Layers, Lock, Music, Shapes, Table2, Type, Video } from "lucide-react";
import { richTextToPlain, type Element, type ShapeName } from "@silicon-present/deck";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/arc/popover/popover";
import { canMoveLayers, canReorderSelection, movableLayerIds, type LayerDirection, type LayerDropEdge } from "@/lib/editor/layer-order";
import { useAbilities, useCurrentSlide, useEditor, useUi } from "./editor-context";
import { ToolButton } from "./controls";
import { ObjectContextMenu, type ObjectMenuTarget } from "./object-context-menu";
import { SHAPE_NAMES } from "./shape-menu";
import styles from "./layers-control.module.css";

const kinds = { text: "Text", shape: "Shape", image: "Image", video: "Video", audio: "Audio", table: "Table", chart: "Chart", html: "HTML" };
const icons = { text: Type, shape: Shapes, image: ImageIcon, video: Video, audio: Music, table: Table2, chart: ChartColumn, html: Code };
const actions: { to: LayerDirection; label: string; Icon: typeof ArrowUp }[] = [
  { to: "front", label: "Bring to front", Icon: ArrowUpToLine },
  { to: "forward", label: "Bring forward", Icon: ArrowUp },
  { to: "backward", label: "Send backward", Icon: ArrowDown },
  { to: "back", label: "Send to back", Icon: ArrowDownToLine },
];

function objectLabel(element: Element): string {
  const text = element.kind === "text" || element.kind === "shape" ? richTextToPlain(element.text)
    : element.kind === "image" || element.kind === "video" ? element.alt : "";
  return text.replace(/\s+/g, " ").trim().slice(0, 100)
    || (element.kind === "shape" ? SHAPE_NAMES[element.shape as ShapeName] ?? element.shape.replace(/-/g, " ").replace(/^./, first => first.toUpperCase()) : kinds[element.kind]);
}

type Drop = { targetId: string; edge: LayerDropEdge };
type RowDrag = {
  pointerId: number; surface: HTMLButtonElement; sourceId: string; slideId: string;
  startX: number; startY: number; x: number; y: number; active: boolean; additive: boolean;
  selection: string[]; moving: string[]; label: string; drop: Drop | null;
};
type DragView = Pick<RowDrag, "x" | "y" | "moving" | "label" | "drop">;

function sameIds(a: string[], b: string[]) {
  return a.length === b.length && a.every(id => b.includes(id));
}

/** Pointer capture keeps events on the source; measure visible rows to find the actual drop boundary. */
function dropAt(list: HTMLUListElement | null, elements: Element[], selected: string[], x: number, y: number): Drop | null {
  if (!list) return null;
  const bounds = list.getBoundingClientRect();
  if (x < bounds.left - 20 || x > bounds.right + 20 || y < bounds.top - 28 || y > bounds.bottom + 28) return null;
  const at = Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, y));
  const rows = Array.from(list.querySelectorAll<HTMLButtonElement>("button[data-layer-id]"))
    .map(node => ({ node, box: node.getBoundingClientRect() }))
    .filter(({ box }) => box.bottom > bounds.top && box.top < bounds.bottom);
  const nearest = rows.reduce<typeof rows[number] | null>((best, row) => {
    const distance = Math.max(row.box.top - at, at - row.box.bottom, 0);
    const bestDistance = best ? Math.max(best.box.top - at, at - best.box.bottom, 0) : Infinity;
    return distance < bestDistance ? row : best;
  }, null);
  if (!nearest) return null;
  const target = elements.find(element => element.id === nearest.node.dataset.layerId);
  if (!target) return null;
  const edge: LayerDropEdge = at < nearest.box.top + nearest.box.height / 2 ? "before" : "after";
  // Match the helper's atomic target-group boundary, including groups that were previously interleaved.
  const group = target.group ? elements.filter(element => element.group === target.group) : [target];
  const targetId = (edge === "before" ? group.at(-1)! : group[0]!).id;
  return canMoveLayers(elements, selected, targetId, edge) ? { targetId, edge } : null;
}

/** A small layer list exposes obscured objects without taking another side of the canvas. */
export function LayersControl() {
  const editor = useEditor();
  const slide = useCurrentSlide();
  const selection = useUi(state => state.selection);
  const { canEdit } = useAbilities();
  const [open, setOpen] = useState(false);
  const [menuTarget, setMenuTarget] = useState<ObjectMenuTarget | null>(null);
  const [dragView, setDragView] = useState<DragView | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const drag = useRef<RowDrag | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const suppressClick = useRef<{ id: string; until: number } | null>(null);
  const dragEscape = useRef<KeyboardEvent | null>(null);
  const actionOnClose = useRef<(() => void) | null>(null);
  const heading = useId();
  const hint = useId();
  const elements = slide?.elements ?? [];
  const frontFirst = [...elements].reverse();
  const draggable = new Set(canEdit ? movableLayerIds(elements, elements.map(element => element.id)) : []);
  const validTarget = menuTarget && menuTarget.slideId === slide?.id && elements.some(element => element.id === menuTarget.elementId)
    && selection.includes(menuTarget.elementId) ? menuTarget : null;
  const stopDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    setDragView(null);
    if (current?.active) suppressClick.current = { id: current.sourceId, until: performance.now() + 400 };
    if (current?.surface.hasPointerCapture(current.pointerId)) current.surface.releasePointerCapture(current.pointerId);
    return current;
  }, []);
  useEffect(() => {
    const check = () => {
      const current = drag.current;
      if (!current) return;
      const latest = editor.currentSlide();
      const selected = editor.ui.get().selection;
      if (!editor.canEdit || latest?.id !== current.slideId
        || !movableLayerIds(latest.elements, [current.sourceId]).includes(current.sourceId)
        || current.active && (!sameIds(selected, current.selection) || !sameIds(movableLayerIds(latest.elements, selected), current.moving))) stopDrag();
    };
    const stopUi = editor.ui.subscribe(check), stopMeta = editor.meta.subscribe(check), stopMirror = editor.mirror.subscribe(check);
    const blur = () => { stopDrag(); };
    window.addEventListener("blur", blur);
    return () => {
      stopUi(); stopMeta(); stopMirror(); window.removeEventListener("blur", blur);
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
      drag.current = null;
    };
  }, [editor, stopDrag]);
  const showDrag = (current: RowDrag) => {
    const latest = editor.currentSlide();
    current.drop = latest?.id === current.slideId ? dropAt(list.current, latest.elements, current.selection, current.x, current.y) : null;
    setDragView(previous => previous && previous.x === current.x && previous.y === current.y
      && previous.drop?.targetId === current.drop?.targetId && previous.drop?.edge === current.drop?.edge ? previous
      : { x: current.x, y: current.y, moving: current.moving, label: current.label, drop: current.drop });
  };
  const scrollWhileDragging = () => {
    const current = drag.current, node = list.current;
    if (!current?.active || !node) return;
    const box = node.getBoundingClientRect();
    if (current.x >= box.left - 20 && current.x <= box.right + 20 && current.y >= box.top - 28 && current.y <= box.bottom + 28) {
      const edge = Math.min(36, box.height / 3);
      const speed = current.y < box.top + edge ? -14 * Math.min(1, (box.top + edge - current.y) / edge)
        : current.y > box.bottom - edge ? 14 * Math.min(1, (current.y - box.bottom + edge) / edge) : 0;
      const before = node.scrollTop;
      if (speed) node.scrollTop += speed;
      if (node.scrollTop !== before) showDrag(current);
    }
    scrollFrame.current = requestAnimationFrame(scrollWhileDragging);
  };
  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>, element: Element) => {
    if (event.button !== 0 || !event.isPrimary || !slide || !draggable.has(element.id)
      || event.pointerType === "touch" && !(event.target as HTMLElement).closest("[data-layer-grip]")) return;
    stopDrag();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, surface: event.currentTarget, sourceId: element.id, slideId: slide.id,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false,
      additive: event.shiftKey || event.metaKey || event.ctrlKey, selection: [], moving: [], label: objectLabel(element), drop: null };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.x = event.clientX; current.y = event.clientY;
    if (!current.active) {
      if (Math.hypot(current.x - current.startX, current.y - current.startY) < 5) return;
      const latest = editor.currentSlide();
      if (!editor.canEdit || latest?.id !== current.slideId) { stopDrag(); return; }
      editor.setTool("select");
      if (!editor.ui.get().selection.includes(current.sourceId)) editor.select([current.sourceId], current.additive ? "add" : "replace");
      current.selection = [...editor.ui.get().selection];
      current.moving = movableLayerIds(latest.elements, current.selection);
      if (!current.moving.includes(current.sourceId)) { stopDrag(); return; }
      current.active = true;
      setMenuTarget(null);
      scrollFrame.current = requestAnimationFrame(scrollWhileDragging);
    }
    event.preventDefault();
    showDrag(current);
  };
  const pointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.active) {
      event.preventDefault();
      current.x = event.clientX; current.y = event.clientY;
      showDrag(current);
    }
    stopDrag();
    if (current.active && current.drop && editor.canEdit && editor.currentSlideId() === current.slideId
      && sameIds(editor.ui.get().selection, current.selection)) editor.moveLayers(current.drop.targetId, current.drop.edge);
  };
  const clickSuppressed = (id: string, at: number) => suppressClick.current?.id === id && suppressClick.current.until > at;
  const closeForAction = (action: () => void) => {
    stopDrag();
    actionOnClose.current = action;
    setOpen(false);
    setMenuTarget(null);
  };
  const edit = (element: Element) => {
    if (!canEdit || element.locked || !["text", "shape", "table", "html"].includes(element.kind)) return;
    closeForAction(() => {
      editor.selectOnly(element.id);
      if (element.kind === "html") editor.ui.set({ codeElement: element.id });
      else editor.startEditing(element.id, element.kind === "table" ? "cell:0:0" : "text");
    });
  };
  return <><Popover open={open} onOpenChange={next => { stopDrag(); setOpen(next); setMenuTarget(null); }}>
    <PopoverTrigger asChild>
      <ToolButton label="Layers" tip={false} className={styles.trigger} data-testid="layers-control"><Layers size={16} /><span>Layers</span></ToolButton>
    </PopoverTrigger>
    <PopoverContent className={styles.panel} side="top" align="end" aria-labelledby={heading}
      onEscapeKeyDown={event => {
        if (!drag.current?.active) return;
        event.preventDefault();
        dragEscape.current = event;
        stopDrag();
      }}
      onCloseAutoFocus={event => {
        const action = actionOnClose.current;
        if (!action) return;
        event.preventDefault();
        actionOnClose.current = null;
        // Wait for the popover's own focus teardown, then let the editor or composer take focus.
        requestAnimationFrame(action);
      }}
      onInteractOutside={event => { if (validTarget || drag.current?.active) event.preventDefault(); }}
      onKeyDown={event => {
        if (event.nativeEvent === dragEscape.current) {
          dragEscape.current = null;
          event.preventDefault(); event.stopPropagation();
          return;
        }
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          if (drag.current?.active) stopDrag();
          else if (validTarget) setMenuTarget(null);
          else setOpen(false);
        }
        event.stopPropagation();
      }}>
      <div className={styles.heading}><h2 id={heading}>Layers</h2><span>Front at top</span></div>
      <div className={styles.actions} role="group" aria-label="Layer order">
        {actions.map(({ to, label, Icon }) => <ToolButton key={to} label={label} tip={false} disabled={!canEdit || !canReorderSelection(elements, selection, to)} onClick={() => editor.reorder(to)} data-testid={`layer-${to}`}><Icon size={17} /></ToolButton>)}
      </div>
      {frontFirst.length ? <ul ref={list} className={styles.list} data-dragging={Boolean(dragView) || undefined} aria-label="Slide objects, front to back" onKeyDown={event => {
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-layer-id]"));
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
        buttons[next]?.focus();
      }}>
        {frontFirst.map(element => {
          const Icon = icons[element.kind];
          const label = objectLabel(element);
          const moving = dragView?.moving.includes(element.id);
          const drop = dragView?.drop?.targetId === element.id ? dragView.drop.edge : undefined;
          return <li key={element.id} className={styles.item} data-drop={drop} data-testid={drop ? "layer-drop-marker" : undefined}>
            <button type="button" className={styles.row} data-sq="surface" data-layer-id={element.id} data-selected={selection.includes(element.id) || undefined}
              data-draggable={draggable.has(element.id) || undefined} data-drag-source={moving || undefined} aria-describedby={hint}
              aria-pressed={selection.includes(element.id)} aria-label={`${label}, ${kinds[element.kind]}${element.group ? ", grouped" : ""}${element.locked ? ", locked" : ""}`}
              onPointerDown={event => pointerDown(event, element)} onPointerMove={pointerMove} onPointerUp={pointerUp}
              onPointerCancel={() => { stopDrag(); }}
              onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) stopDrag(); }}
              onClick={event => { if (event.detail && clickSuppressed(element.id, event.timeStamp)) { event.preventDefault(); return; } editor.setTool("select"); editor.select([element.id], event.shiftKey || event.metaKey || event.ctrlKey ? "toggle" : "replace"); }}
              onDoubleClick={event => { if (!clickSuppressed(element.id, event.timeStamp)) edit(element); }}
              onContextMenu={event => {
                event.preventDefault(); event.stopPropagation();
                stopDrag();
                editor.setTool("select");
                if (!editor.ui.get().selection.includes(element.id)) editor.select([element.id]);
                const box = event.currentTarget.getBoundingClientRect();
                if (slide) setMenuTarget({ at: { x: event.clientX || box.left + 20, y: event.clientY || box.top + 20 }, slideId: slide.id, elementId: element.id });
              }}>
              <span className={styles.grip} data-layer-grip="" aria-hidden="true">{draggable.has(element.id) ? <GripVertical size={14} /> : null}</span>
              <Icon size={15} className={styles.icon} aria-hidden="true" />
              <span className={styles.name}>{label}</span>
              {element.group ? <Group size={13} className={styles.icon} aria-hidden="true" /> : null}
              {element.locked ? <Lock size={13} className={styles.icon} aria-hidden="true" /> : null}
            </button>
          </li>;
        })}
      </ul> : <p className={styles.empty}>No objects on this slide.</p>}
      <p className={styles.hint} id={hint}>{canEdit ? "Drag a row to reorder. Shift-click to select more; use the arrows to move selected layers." : "Select an object to find it on the slide."}</p>
      <span className={styles.srOnly} role="status">{dragView ? `Moving ${dragView.moving.length} ${dragView.moving.length === 1 ? "layer" : "layers"}${dragView.drop ? "; release to reorder" : "; move to a new position"}. Escape cancels.` : ""}</span>
      <ObjectContextMenu target={validTarget} onClose={() => setMenuTarget(null)} onFocusAction={closeForAction} />
    </PopoverContent>
  </Popover>{dragView ? createPortal(<div className={styles.dragGhost} data-sq="surface" data-testid="layer-drag-preview" aria-hidden="true"
    style={{ left: Math.max(8, Math.min(dragView.x + 14, window.innerWidth - 244)), top: Math.max(8, Math.min(dragView.y + 12, window.innerHeight - 48)) }}>
    <GripVertical size={15} /><span className={styles.name}>{dragView.moving.length === 1 ? dragView.label : `${dragView.moving.length} layers`}</span>
  </div>, document.body) : null}</>;
}
