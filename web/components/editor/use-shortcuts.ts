"use client";

/**
 * The editor's keyboard: every common shortcut (listed in lib/editor/keys.ts and the "?" dialog), plus copy, cut and
 * paste through the clipboard events (so pasting an image from anywhere puts it on the slide, and elements copied in
 * one deck paste into another).
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { insertFiles, textInput } from "@/lib/editor/insert";
import type { Editor } from "@/lib/editor/editor";

function typingIn(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  return Boolean(node.closest("input, textarea, select, [contenteditable='true'], .ql-editor, [role='dialog'] input"));
}

export function useShortcuts(editor: Editor) {
  const router = useRouter();
  useEffect(() => {
    // Copy, cut and paste normally arrive as clipboard events. Where the browser doesn't turn the keys into those
    // events (some headless and embedded browsers), the keys do it themselves a moment later, unless the event came.
    let pendingCut: ReturnType<typeof setTimeout> | null = null;
    let pendingPaste: ReturnType<typeof setTimeout> | null = null;

    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key;
      const ui = editor.ui.get();
      const canEdit = editor.canEdit;

      // Shortcuts that work even while typing in a field of the editor.
      if (mod && event.altKey && (key === "m" || key === "M" || event.code === "KeyM")) {
        event.preventDefault();
        const selected = editor.selectedElements();
        const slide = editor.currentSlideId();
        if (canEdit && selected.length === 1 && slide && !ui.editing) {
          const el = selected[0]!;
          editor.ui.set({ composer: { anchor: { kind: "element", slide, element: el.id }, at: { x: el.x + el.w, y: el.y } }, panel: "comments", panelOpen: true });
        } else if (canEdit) {
          editor.ui.set({ commentMode: !ui.commentMode, panel: "comments", panelOpen: true, editing: null });
        } else editor.ui.set({ panel: "comments", panelOpen: true });
        return;
      }
      if (mod && key.toLowerCase() === "f") {
        event.preventDefault();
        editor.ui.set({ findOpen: true });
        return;
      }
      if (typingIn(event.target)) return;

      if (key === "Escape") {
        if (ui.composer) editor.ui.set({ composer: null });
        else if (ui.findOpen) editor.ui.set({ findOpen: false });
        else if (ui.codeElement) editor.ui.set({ codeElement: null });
        else if (ui.activeThread) editor.ui.set({ activeThread: null });
        else if (ui.commentMode) editor.ui.set({ commentMode: false });
        else if (ui.selection.length) editor.clearSelection();
        return;
      }
      if (key === "?" || (key === "/" && event.shiftKey)) {
        event.preventDefault();
        editor.ui.set({ shortcutsOpen: true });
        return;
      }
      if (mod && key === "Enter") {
        event.preventDefault();
        const slide = editor.currentSlideId();
        router.push(`/decks/${encodeURIComponent(editor.deckId)}/present${slide ? `?slide=${encodeURIComponent(slide)}` : ""}`);
        return;
      }
      if (key === "PageDown" || key === "PageUp") {
        event.preventDefault();
        editor.stepSlide(key === "PageDown" ? 1 : -1);
        return;
      }
      if (mod && (key === "=" || key === "+" || key === "-" || key === "0")) {
        event.preventDefault();
        const fit = ui.fitScale;
        const current = ui.zoom === "fit" ? fit : ui.zoom;
        if (key === "0") editor.ui.set({ zoom: "fit" });
        else editor.ui.set({ zoom: Math.max(0.1, Math.min(3, Math.round(current * (key === "-" ? 0.8 : 1.25) * 100) / 100)) });
        return;
      }
      if (!ui.selection.length && (key === "ArrowDown" || key === "ArrowUp" || key === "ArrowLeft" || key === "ArrowRight") && !mod) {
        event.preventDefault();
        editor.stepSlide(key === "ArrowDown" || key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (mod && !event.altKey && key.toLowerCase() === "c" && ui.selection.length) {
        editor.copy();
        return;
      }
      if (!canEdit) return;

      if (mod && !event.altKey && key.toLowerCase() === "x" && ui.selection.length) {
        editor.copy();
        if (pendingCut) clearTimeout(pendingCut);
        pendingCut = setTimeout(() => {
          pendingCut = null;
          editor.deleteSelection();
        }, 60);
        return;
      }
      if (mod && !event.altKey && key.toLowerCase() === "v") {
        if (pendingPaste) clearTimeout(pendingPaste);
        pendingPaste = setTimeout(() => {
          pendingPaste = null;
          void editor.paste(null);
        }, 60);
        return;
      }
      if (mod && key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) editor.redo();
        else editor.undo();
        return;
      }
      if (mod && key.toLowerCase() === "y") {
        event.preventDefault();
        editor.redo();
        return;
      }
      if (mod && key.toLowerCase() === "m" && !event.altKey) {
        event.preventDefault();
        editor.addSlide("title-body");
        return;
      }
      if (mod && key.toLowerCase() === "a") {
        event.preventDefault();
        editor.selectAll();
        return;
      }
      if (!ui.selection.length) return;
      if (key === "Delete" || key === "Backspace") {
        event.preventDefault();
        editor.deleteSelection();
        return;
      }
      if (key.startsWith("Arrow")) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        editor.nudge(key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0, key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0);
        return;
      }
      if (key === "Enter") {
        const one = editor.selectedElements();
        if (one.length === 1) {
          event.preventDefault();
          const el = one[0]!;
          if (el.kind === "text" || el.kind === "shape") editor.startEditing(el.id);
          else if (el.kind === "table") editor.startEditing(el.id, "cell:0:0");
          else if (el.kind === "html") editor.ui.set({ codeElement: el.id });
        }
        return;
      }
      if (mod && key.toLowerCase() === "d") {
        event.preventDefault();
        editor.duplicateSelection();
        return;
      }
      if (mod && key.toLowerCase() === "g") {
        event.preventDefault();
        if (event.shiftKey) editor.ungroup();
        else editor.group();
        return;
      }
      if (mod && event.shiftKey && key.toLowerCase() === "l") {
        event.preventDefault();
        editor.toggleLock();
        return;
      }
      if (mod && (key === "]" || key === "}" || event.code === "BracketRight")) {
        event.preventDefault();
        editor.reorder(event.shiftKey ? "front" : "forward");
        return;
      }
      if (mod && (key === "[" || key === "{" || event.code === "BracketLeft")) {
        event.preventDefault();
        editor.reorder(event.shiftKey ? "back" : "backward");
        return;
      }
      if (mod && ["b", "i", "u"].includes(key.toLowerCase())) {
        // Bold, italic, underline on whole text boxes when they are selected but not being edited.
        event.preventDefault();
        const name = key.toLowerCase() === "b" ? "bold" : key.toLowerCase() === "i" ? "italic" : "underline";
        const slide = editor.currentSlideId();
        const boxes = editor.selectedElements().filter(e => e.kind === "text" || e.kind === "shape");
        if (!slide || !boxes.length) return;
        const on = !boxes.every(e => (e.kind === "text" || e.kind === "shape") && e.text.paragraphs.every(p => p.runs.every(r => r[name as "bold"])));
        editor.change(() => {
          for (const el of boxes) {
            const text = editor.textField(slide, el.id, "text");
            if (text) text.format(0, text.length, { [name]: on ? true : null });
          }
        }, "Formatting");
      }
    };

    const onCopy = (event: ClipboardEvent) => {
      if (typingIn(event.target) || !editor.ui.get().selection.length) return;
      if (editor.copy()) {
        event.preventDefault();
        const payload = localStorage.getItem("silicon-present:clipboard");
        if (payload) event.clipboardData?.setData("text/plain", payload);
      }
    };
    const onCut = (event: ClipboardEvent) => {
      if (typingIn(event.target) || !editor.canEdit || !editor.ui.get().selection.length) return;
      if (pendingCut) clearTimeout(pendingCut);
      pendingCut = null;
      onCopy(event);
      editor.deleteSelection();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (typingIn(event.target) || !editor.canEdit) return;
      if (pendingPaste) clearTimeout(pendingPaste);
      pendingPaste = null;
      const data = event.clipboardData;
      if (!data) return;
      const files = Array.from(data.files ?? []).filter(file => /^(image|video|audio)\//.test(file.type));
      if (files.length) {
        event.preventDefault();
        void insertFiles(editor, files);
        return;
      }
      const text = data.getData("text/plain");
      event.preventDefault();
      void editor.paste(text).then(done => {
        if (!done && text.trim()) editor.addElement(textInput(editor, text.trim()));
      });
    };

    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      if (pendingCut) clearTimeout(pendingCut);
      if (pendingPaste) clearTimeout(pendingPaste);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  }, [editor, router]);
}
