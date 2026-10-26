import assert from "node:assert/strict";
import { test } from "node:test";
import { insertShortcut } from "../lib/editor/insert-shortcuts";

function event(key: string, extra: Partial<KeyboardEvent> = {}, blocked?: string): KeyboardEvent {
  return { key, target: { closest: (selector: string) => blocked && selector.includes(blocked) ? {} : null }, ...extra } as unknown as KeyboardEvent;
}

test("shape shortcuts match their visible labels and preserve the lock shortcut", () => {
  assert.deepEqual(insertShortcut(event("r")), { kind: "shape", shape: "rect" });
  assert.deepEqual(insertShortcut(event("o")), { kind: "shape", shape: "ellipse" });
  assert.deepEqual(insertShortcut(event("l")), { kind: "shape", shape: "line" });
  assert.deepEqual(insertShortcut(event("L", { shiftKey: true })), { kind: "shape", shape: "arrow-right" });
  for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
    assert.equal(insertShortcut(event("L", { ...modifier, shiftKey: true })), null, "Mod+Shift+L still locks, never inserts");
    assert.deepEqual(insertShortcut(event("K", { ...modifier, shiftKey: true })), { kind: "media" });
    assert.equal(insertShortcut(event("k", modifier)), null);
  }
});

test("insertion shortcuts never intercept text, menus, composition, repeats or Alt combinations", () => {
  for (const key of ["r", "o", "l", "K"]) {
    for (const blocked of ["input", "textarea", "contenteditable", "role=textbox", "role=dialog", "data-radix-popper-content-wrapper"]) {
      assert.equal(insertShortcut(event(key, key === "K" ? { metaKey: true, shiftKey: true } : {}, blocked)), null);
    }
    for (const extra of [{ repeat: true }, { isComposing: true }, { defaultPrevented: true }, { altKey: true }]) {
      assert.equal(insertShortcut(event(key, extra)), null);
    }
  }
  assert.equal(insertShortcut(event("R", { shiftKey: true })), null);
  assert.equal(insertShortcut(event("O", { shiftKey: true })), null);
  assert.equal(insertShortcut(event("h")), null);
  assert.equal(insertShortcut(event("v")), null);
});
