import assert from "node:assert/strict";
import { test } from "node:test";
import { editorShortcutAllowed } from "../lib/editor/keys";
import { slideDropAfter } from "../lib/editor/slide-order";

function keyEvent(key: string, target: "canvas" | "button" | "input" | "dialog" | "menu" = "canvas", extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const selector = { canvas: "no-canvas-selector", button: "button", input: "input", dialog: "[role=dialog]", menu: "[data-radix-popper-content-wrapper]" }[target];
  return { key, target: { closest: (selectors: string) => selectors.split(", ").includes(selector) ? {} : null }, ...extra } as unknown as KeyboardEvent;
}

test("notes and tool buttons keep Enter and Space without starting a canvas edit or pan", () => {
  for (const key of ["Enter", " "]) {
    assert.equal(editorShortcutAllowed(keyEvent(key, "button")), false);
    assert.equal(editorShortcutAllowed(keyEvent(key)), true);
  }
  assert.equal(editorShortcutAllowed(keyEvent("h", "button")), true);
});

test("editor shortcuts leave typing, open menus, composition and handled events alone", () => {
  for (const target of ["input", "dialog", "menu"] as const) {
    for (const key of ["t", "c", "Enter", " ", "ArrowRight"]) assert.equal(editorShortcutAllowed(keyEvent(key, target)), false);
  }
  assert.equal(editorShortcutAllowed(keyEvent("t", "canvas", { isComposing: true })), false);
  assert.equal(editorShortcutAllowed(keyEvent("ArrowDown", "canvas", { defaultPrevented: true })), false);
});

test("grid drops can move a slide to either end and across adjacent cards", () => {
  const ids = ["a", "b", "c", "d"];
  assert.equal(slideDropAfter(ids, "a", "d", true), "d");
  assert.equal(slideDropAfter(ids, "d", "a", false), null);
  assert.equal(slideDropAfter(ids, "b", "c", true), "c");
  assert.equal(slideDropAfter(ids, "c", "b", false), "a");
  assert.equal(slideDropAfter(ids, "a", "c", false), "b");
});

test("grid drops ignore unchanged positions and slides absent from the current deck", () => {
  const ids = ["a", "b", "c"];
  for (const [moving, target, after] of [["a", "b", false], ["b", "a", true], ["b", "b", true], ["missing", "b", true], ["b", "missing", false]] as const) {
    assert.equal(slideDropAfter(ids, moving, target, after), undefined);
  }
});
