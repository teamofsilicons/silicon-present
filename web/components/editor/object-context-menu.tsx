"use client";

import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, Code, Copy, CopyPlus, Group, Lock, LockOpen, MessageSquare, Scissors, Trash, Type, Ungroup } from "lucide-react";
import { keyLabel } from "@/lib/editor/keys";
import { canReorderSelection } from "@/lib/editor/layer-order";
import { useAbilities, useCurrentSlide, useEditor, useUi } from "./editor-context";
import { ContextMenu, type ContextItem } from "./context-menu";

export interface ObjectMenuTarget {
  at: { x: number; y: number };
  slideId: string;
  elementId: string;
  /** The table cell under the pointer, or the object's own text. */
  field?: string;
}

/** The same object actions are available on the canvas and in the layer list. */
export function ObjectContextMenu({ target, onClose, onFocusAction }: { target: ObjectMenuTarget | null; onClose: () => void; onFocusAction?: (action: () => void) => void }) {
  const editor = useEditor();
  const slide = useCurrentSlide();
  const selection = useUi(state => state.selection);
  const { canEdit, canComment, signInToComment } = useAbilities();
  if (!target || !slide || slide.id !== target.slideId) return null;
  const element = slide.elements.find(item => item.id === target.elementId);
  if (!element || !selection.includes(element.id)) return null;
  const selected = slide.elements.filter(item => selection.includes(item.id));
  const allLocked = selected.every(item => item.locked);
  const anyLocked = selected.some(item => item.locked);
  const grouped = selected.some(item => item.group);
  const sameGroup = Boolean(selected[0]?.group && selected.every(item => item.group === selected[0]?.group));
  const field = target.field ?? (element.kind === "text" || element.kind === "shape" ? "text" : element.kind === "table" ? "cell:0:0" : null);
  const action = (fn: () => void) => () => {
    editor.stopCapturing();
    fn();
    editor.stopCapturing();
  };
  const items: ContextItem[] = [];
  if (canEdit && selected.length === 1 && (field || element.kind === "html")) {
    items.push({
      label: field ? "Edit text" : "Edit code", icon: field ? <Type size={16} /> : <Code size={16} />,
      shortcut: "Enter", disabled: element.locked, restoreFocus: false,
      onSelect: () => {
        const edit = () => {
          if (field) editor.startEditing(element.id, field);
          else editor.ui.set({ codeElement: element.id });
        };
        if (onFocusAction) onFocusAction(edit);
        else edit();
      },
    });
  }
  items.push({ label: "Copy", icon: <Copy size={16} />, shortcut: keyLabel("Mod+C"), onSelect: () => { editor.copy(); } });
  if (canEdit) {
    items.push(
      { label: "Cut", icon: <Scissors size={16} />, shortcut: keyLabel("Mod+X"), disabled: anyLocked, onSelect: action(() => editor.cut()) },
      { label: "Duplicate", icon: <CopyPlus size={16} />, shortcut: keyLabel("Mod+D"), onSelect: action(() => editor.duplicateSelection()) },
      { label: "Bring to front", icon: <ArrowUpToLine size={16} />, shortcut: keyLabel("Mod+Shift+]"), separatorBefore: true,
        disabled: !canReorderSelection(slide.elements, selection, "front"), onSelect: () => editor.reorder("front") },
      { label: "Bring forward", icon: <ArrowUp size={16} />, shortcut: keyLabel("Mod+]"),
        disabled: !canReorderSelection(slide.elements, selection, "forward"), onSelect: () => editor.reorder("forward") },
      { label: "Send backward", icon: <ArrowDown size={16} />, shortcut: keyLabel("Mod+["),
        disabled: !canReorderSelection(slide.elements, selection, "backward"), onSelect: () => editor.reorder("backward") },
      { label: "Send to back", icon: <ArrowDownToLine size={16} />, shortcut: keyLabel("Mod+Shift+["),
        disabled: !canReorderSelection(slide.elements, selection, "back"), onSelect: () => editor.reorder("back") },
    );
    if (selected.length > 1 && !sameGroup) items.push({ label: "Group", icon: <Group size={16} />, shortcut: keyLabel("Mod+G"), disabled: anyLocked, separatorBefore: true, onSelect: action(() => editor.group()) });
    if (grouped) items.push({ label: "Ungroup", icon: <Ungroup size={16} />, shortcut: keyLabel("Mod+Shift+G"), disabled: anyLocked, separatorBefore: sameGroup, onSelect: action(() => editor.ungroup()) });
    items.push({ label: allLocked ? "Unlock" : "Lock", icon: allLocked ? <LockOpen size={16} /> : <Lock size={16} />,
      shortcut: keyLabel("Mod+Shift+L"), separatorBefore: !grouped && selected.length === 1, onSelect: action(() => editor.toggleLock()) });
  }
  if (canComment || signInToComment) items.push({
    label: "Comment", icon: <MessageSquare size={16} />, separatorBefore: true, restoreFocus: false,
    onSelect: () => {
      const comment = () => editor.ui.set({ composer: { anchor: { kind: "element", slide: slide.id, element: element.id }, at: { x: element.x + element.w, y: element.y } }, panel: "comments", panelOpen: true });
      if (onFocusAction) onFocusAction(comment);
      else comment();
    },
  });
  if (canEdit) items.push({ label: "Delete", icon: <Trash size={16} />, shortcut: "Delete", destructive: true, separatorBefore: true, disabled: anyLocked, onSelect: action(() => editor.deleteSelection()) });
  return <ContextMenu at={target.at} items={items} label="Object actions" onClose={onClose} />;
}
