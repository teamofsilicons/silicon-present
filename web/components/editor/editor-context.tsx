"use client";

/**
 * The editor in React: one Editor (lib/editor/editor.ts) per open deck, handed down through context, and hooks that read
 * exactly the part of its state a component needs.
 */
import { createContext, useContext, useSyncExternalStore } from "react";
import type { DeckJson } from "@silicon-present/deck";
import type { Editor, UiState } from "@/lib/editor/editor";
import { useStore } from "@/lib/editor/store";

export const EditorContext = createContext<Editor | null>(null);

export function useEditor(): Editor {
  const editor = useContext(EditorContext);
  if (!editor) throw new Error("useEditor is used outside the editor");
  return editor;
}

export function useDeck(): DeckJson {
  const editor = useEditor();
  return useSyncExternalStore(editor.mirror.subscribe, () => editor.mirror.get(), () => editor.mirror.get());
}

export function useUi<S>(select: (state: UiState) => S): S {
  return useStore(useEditor().ui, select);
}

export function useMeta() {
  const editor = useEditor();
  return useStore(editor.meta, state => state);
}

/** Whether this viewer may edit / comment right now (follows role changes). */
export function useAbilities() {
  const editor = useEditor();
  useStore(editor.meta, state => state);
  return { canEdit: editor.canEdit, canComment: editor.canComment, signInToComment: editor.signInToComment, signedIn: Boolean(editor.me) };
}

export function useCurrentSlide() {
  const editor = useEditor();
  useDeck();
  useUi(state => [state.slideId, state.master]);
  return editor.currentSlide();
}
