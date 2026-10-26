import assert from "node:assert/strict";
import { test } from "node:test";
import { presentationShortcutAllowed, presentationSwipe, presentKeys } from "../components/present/present-input";

function event(key: string, target: "stage" | "control" | "editable" = "stage", extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key, target: { closest: (selector: string) => target === "editable" && selector.includes("input") || target === "control" && selector.includes("button") ? {} : null },
    ...extra,
  } as unknown as KeyboardEvent;
}

test("presentation navigation preserves control activation with Space and Enter", () => {
  const moves: string[] = [];
  const controls = { next: () => moves.push("next"), previous: () => moves.push("previous"), firstSlide: () => moves.push("first"), lastSlide: () => moves.push("last") };
  for (const key of [" ", "Enter"]) {
    assert.equal(presentKeys(event(key, "control"), controls), false);
    assert.equal(moves.length, 0);
  }
  for (const [key, move] of [["ArrowRight", "next"], [" ", "next"], ["ArrowLeft", "previous"], ["Home", "first"], ["End", "last"]]) {
    assert.equal(presentKeys(event(key!), controls), true);
    assert.equal(moves.at(-1), move);
  }
});

test("presentation shortcuts leave typing, composition and browser shortcuts alone", () => {
  for (const key of ["f", "Escape", "ArrowRight", " "]) {
    assert.equal(presentationShortcutAllowed(event(key, "editable")), false);
    for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { defaultPrevented: true }]) {
      assert.equal(presentationShortcutAllowed(event(key, "stage", extra)), false);
    }
    assert.equal(presentationShortcutAllowed(event(key)), true);
  }
});

test("touch navigation accepts one horizontal swipe while leaving taps and vertical gestures alone", () => {
  const start = { x: 200, y: 100, t: 0 };
  assert.equal(presentationSwipe(start, { x: 100, y: 110, t: 300 }), "next");
  assert.equal(presentationSwipe(start, { x: 300, y: 110, t: 300 }), "previous");
  for (const end of [{ x: 199, y: 101, t: 100 }, { x: 100, y: 200, t: 300 }, { x: 100, y: 100, t: 900 }]) {
    assert.equal(presentationSwipe(start, end), null);
  }
});
