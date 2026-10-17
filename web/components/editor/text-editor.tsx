"use client";

/**
 * Rich text edited in place, on the slide: a Quill editor bound to the element's Y.Text (lib/editor/quill-binding.ts),
 * laid over the element and styled the way @silicon-present/render draws text (same padding, faces, sizes, line
 * heights, vertical alignment), so text doesn't jump when editing starts or ends. Concurrent typing merges through Yjs.
 *
 * Read-only, the same editor lets commenters and viewers pick a passage to comment on (a text anchor with Yjs relative
 * positions, so the comment keeps pointing at that passage while others edit around it).
 */
import { useEffect, useRef } from "react";
import { BODY_SIZE, HEADING_SIZES, TABLE_SIZE, shapeGeometry } from "@silicon-present/render";
import { luminance, type Element, type Theme } from "@silicon-present/deck";
import type * as Y from "yjs";
import type Quill from "quill/core";
import { QuillBinding } from "@/lib/editor/quill-binding";
import { encodeRelative } from "@/lib/editor/comments";
import type { Anchor } from "@/lib/editor/types";
import { useEditor } from "./editor-context";
import styles from "./text-editor.module.css";

interface Props {
  element: Element;
  field: string;
  theme: Theme;
  readOnly: boolean;
  onPickText?: (anchor: Anchor, at: { x: number; y: number }) => void;
  onClose?: () => void;
}

interface Frame {
  left: number;
  top: number;
  width: number;
  height: number;
  rotation: number;
  padding: string;
  fontSize: number;
  lineHeight: number;
  color: string;
  align?: "center";
  va: "top" | "middle" | "bottom";
  bold?: boolean;
}

/** Where the text sits and how render styles it, for a text/shape element or a table cell. */
function frameFor(element: Element, field: string, theme: Theme): Frame {
  const s = element.style ?? {};
  const base = { left: element.x, top: element.y, width: element.w, height: element.h, rotation: element.rotation };
  if (element.kind === "shape") {
    const geo = shapeGeometry(element.shape, element.w, element.h, s.radius);
    const pad = typeof s.padding === "number" ? s.padding : 16;
    const t = geo.text;
    const fill = geo.open ? "none" : (s.fill ?? (s.stroke && !s.fill ? "none" : theme.colors.accent));
    const color = fill !== "none" && luminance(fill) < 0.4 ? "#ffffff" : theme.colors.text;
    return { ...base, padding: `${t.top + pad}px ${t.right + pad}px ${t.bottom + pad}px ${t.left + pad}px`, fontSize: BODY_SIZE, lineHeight: 1.25, color, align: "center", va: s.verticalAlign ?? "middle" };
  }
  const cell = /^cell:(\d+):(\d+)$/.exec(field);
  if (element.kind === "table" && cell) {
    const r = Number(cell[1]);
    const c = Number(cell[2]);
    const totalW = element.colWidths.reduce((a, b) => a + b, 0) || 1;
    const totalH = element.rowHeights.reduce((a, b) => a + b, 0) || 1;
    const x0 = (element.colWidths.slice(0, c).reduce((a, b) => a + b, 0) / totalW) * element.w;
    const y0 = (element.rowHeights.slice(0, r).reduce((a, b) => a + b, 0) / totalH) * element.h;
    const w = ((element.colWidths[c] ?? 0) / totalW) * element.w;
    const h = ((element.rowHeights[r] ?? 0) / totalH) * element.h;
    // A cell inside a rotated table: place it in the table's frame, then rotate about the table's centre.
    return {
      left: element.x + x0,
      top: element.y + y0,
      width: w,
      height: h,
      rotation: element.rotation,
      padding: "10px 16px",
      fontSize: TABLE_SIZE,
      lineHeight: 1.2,
      color: theme.colors.text,
      va: "middle",
      bold: element.headerRow && r === 0,
      ...(element.rotation ? { origin: `${element.w / 2 - x0}px ${element.h / 2 - y0}px` } : {}),
    } as Frame;
  }
  return { ...base, padding: `${typeof s.padding === "number" ? s.padding : 0}px`, fontSize: BODY_SIZE, lineHeight: 1.25, color: theme.colors.text, va: s.verticalAlign ?? "top" };
}

export function TextEditor({ element, field, theme, readOnly, onPickText, onClose }: Props) {
  const editor = useEditor();
  const host = useRef<HTMLDivElement>(null);
  const frame = frameFor(element, field, theme);
  const slideId = editor.currentSlideId();

  useEffect(() => {
    const node = host.current;
    if (!node || !slideId) return;
    const text = editor.textField(slideId, element.id, field);
    if (!text) return;
    let quill: Quill | null = null;
    let binding: QuillBinding | null = null;
    let disposed = false;
    const target = document.createElement("div");
    node.appendChild(target);

    const selectionAnchor = (): Anchor | null => {
      const range = quill?.getSelection();
      if (!quill || !range || range.length === 0) return null;
      const quote = quill.getText(range.index, range.length);
      return {
        kind: "text",
        slide: slideId,
        element: element.id,
        field,
        quote: quote.slice(0, 500),
        start: encodeRelative(text as Y.Text, range.index),
        end: encodeRelative(text as Y.Text, range.index + range.length),
      };
    };

    void import("@/lib/editor/quill-setup").then(({ setupQuill, QUILL_FORMATS }) => {
      if (disposed) return;
      const Q = setupQuill();
      quill = new Q(target, {
        readOnly,
        formats: QUILL_FORMATS,
        modules: {
          history: { delay: 400, maxStack: 1, userOnly: true },
          keyboard: {
            bindings: {
              exit: { key: "Escape", handler: () => (onClose ? onClose() : editor.stopEditing()) },
              undo: { key: "z", shortKey: true, shiftKey: false, handler: () => editor.undo() },
              redo: { key: "z", shortKey: true, shiftKey: true, handler: () => editor.redo() },
              redoY: { key: "y", shortKey: true, handler: () => editor.redo() },
              comment: {
                key: "m",
                shortKey: true,
                altKey: true,
                handler: () => {
                  const anchor = selectionAnchor();
                  if (anchor) editor.ui.set({ composer: { anchor, at: { x: element.x + element.w, y: element.y } } });
                  return false;
                },
              },
            },
          },
        },
      });
      binding = new QuillBinding(text, quill, !readOnly);
      const publish = () => {
        if (!quill) return;
        const range = quill.getSelection();
        editor.textUi.set({ formats: range ? quill.getFormat(range) : {} });
      };
      if (!readOnly) {
        editor.textUi.set({
          quill: {
            format: (name, value) => {
              if (!quill) return;
              const range = quill.getSelection(true);
              if (range.length === 0 && ["align", "list", "indent", "heading", "lineHeight"].indexOf(name) < 0) {
                // Nothing selected: format the whole text, as slide editors do for a text box.
                quill.formatText(0, quill.getLength(), name, value, "user");
              } else quill.format(name, value, "user");
              publish();
            },
            getFormat: () => (quill ? quill.getFormat() : {}),
            focus: () => quill?.focus(),
            selectionAnchor,
          },
        });
        quill.on("selection-change", publish);
        quill.on("text-change", publish);
        quill.focus();
        quill.setSelection(quill.getLength() - 1, 0, "silent");
        publish();
      } else {
        // Picking a passage to comment on: the box opens as soon as the mouse lets go of a selection.
        const onUp = () => {
          setTimeout(() => {
            const anchor = selectionAnchor();
            if (anchor) onPickText?.(anchor, { x: element.x + element.w, y: element.y });
          }, 0);
        };
        target.addEventListener("mouseup", onUp);
        target.addEventListener("keyup", onUp);
      }
    });

    return () => {
      disposed = true;
      binding?.destroy();
      if (!readOnly) editor.textUi.set({ quill: null, formats: {} });
      target.remove();
    };
    // The editor is rebuilt when the element or field changes (the parent keys it); its box can move meanwhile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, element.id, field, readOnly, slideId]);

  const origin = (frame as Frame & { origin?: string }).origin;
  return (
    <div
      className={styles.frame}
      data-readonly={readOnly || undefined}
      data-testid={readOnly ? "text-picker" : "text-editor"}
      onPointerDown={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      style={{
        left: frame.left,
        top: frame.top,
        width: frame.width,
        height: frame.height,
        transform: frame.rotation ? `rotate(${frame.rotation}deg)` : undefined,
        transformOrigin: origin,
        padding: frame.padding,
        justifyContent: frame.va === "middle" ? "center" : frame.va === "bottom" ? "flex-end" : "flex-start",
        fontFamily: `"${theme.fonts.body}", system-ui, sans-serif`,
        fontSize: frame.fontSize,
        lineHeight: frame.lineHeight,
        color: frame.color,
        textAlign: frame.align,
        fontWeight: frame.bold ? 600 : undefined,
        ["--heading-font" as string]: `"${theme.fonts.heading}", system-ui, sans-serif`,
        ["--h1" as string]: `${HEADING_SIZES[1]}px`,
        ["--h2" as string]: `${HEADING_SIZES[2]}px`,
        ["--h3" as string]: `${HEADING_SIZES[3]}px`,
      }}
    >
      <div ref={host} className={styles.host} />
      {readOnly ? <span className={styles.pickHint}>Select the words to comment on</span> : null}
    </div>
  );
}
