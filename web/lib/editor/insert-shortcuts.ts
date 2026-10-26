import type { ShapeName } from "@silicon-present/deck";
import { editorShortcutAllowed } from "./keys";

export type InsertShortcut = { kind: "shape"; shape: ShapeName } | { kind: "media" };

/** Only canvas shortcuts: never typing, native controls, menus, IME, or held keys. */
export function insertShortcut(event: KeyboardEvent): InsertShortcut | null {
  if (!editorShortcutAllowed(event) || event.repeat || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.metaKey || event.ctrlKey) {
    return event.shiftKey && key === "k" ? { kind: "media" } : null;
  }
  if (key === "l") return { kind: "shape", shape: event.shiftKey ? "arrow-right" : "line" };
  if (event.shiftKey) return null;
  if (key === "r") return { kind: "shape", shape: "rect" };
  if (key === "o") return { kind: "shape", shape: "ellipse" };
  return null;
}

export const PICK_MEDIA_EVENT = "present:pick-media";
