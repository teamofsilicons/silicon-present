import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { applySavedTextFormat, SavedTextSelection } from "../lib/editor/text-selection";

function setup(content = "Before chosen after\n") {
  const doc = new Y.Doc();
  const text = doc.getText("text");
  text.insert(0, content);
  const selection = new SavedTextSelection(text);
  let range = { index: 0, length: 0 };
  const calls: { kind: string; index: number; length: number }[] = [];
  const quill = {
    setSelection(index: number, length: number) { range = { index, length }; },
    getLength: () => text.length,
    formatText(index: number, length: number, name: string, value: unknown) {
      calls.push({ kind: "whole", index, length });
      text.format(index, length, { [name]: value });
    },
    format(name: string, value: unknown) {
      calls.push({ kind: "range", ...range });
      text.format(range.index, range.length, { [name]: value });
    },
  };
  const remote = (edit: (other: Y.Text) => void) => {
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    edit(other.getText("text"));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    other.destroy();
  };
  return { doc, text, selection, quill, calls, remote };
}

test("a blurred passage follows remote typing and formatting stays on the selected characters", () => {
  const { text, selection, quill, calls, remote } = setup();
  selection.remember({ index: 7, length: 6 });
  selection.remember(null); // The custom colour input now owns keyboard focus.
  remote(other => other.insert(0, "New "));
  assert.deepEqual(selection.resolve(), { index: 11, length: 6, hadSelection: true });
  assert.equal(applySavedTextFormat(quill, selection, "color", "#123456"), true);
  assert.deepEqual(calls, [{ kind: "range", index: 11, length: 6 }]);
  assert.deepEqual(text.toDelta(), [
    { insert: "New Before " },
    { insert: "chosen", attributes: { color: "#123456" } },
    { insert: " after\n" },
  ]);
});

test("new text just outside either selected boundary is excluded", () => {
  const { selection, remote } = setup();
  selection.remember({ index: 7, length: 6 });
  remote(other => {
    other.insert(13, " OUTSIDE");
    other.insert(7, "OUTSIDE ");
  });
  assert.deepEqual(selection.resolve(), { index: 15, length: 6, hadSelection: true });
});

test("deleting the passage remotely never turns its formatting into a whole-box change", () => {
  const { text, selection, quill, calls, remote } = setup();
  selection.remember({ index: 7, length: 6 });
  remote(other => other.delete(7, 6));
  assert.equal(selection.resolve()?.length, 0);
  assert.equal(selection.resolve()?.hadSelection, true);
  assert.equal(applySavedTextFormat(quill, selection, "color", "#FF0000"), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(text.toDelta(), [{ insert: "Before  after\n" }]);
});

test("partial deletion and Unicode insertion retain the surviving selected passage", () => {
  const { text, selection, quill, remote } = setup();
  selection.remember({ index: 7, length: 6 });
  remote(other => {
    other.delete(7, 2);
    other.insert(0, "👋 ");
  });
  assert.deepEqual(selection.resolve(), { index: 10, length: 4, hadSelection: true });
  applySavedTextFormat(quill, selection, "highlight", "#FFFF00");
  assert.deepEqual(text.toDelta(), [{ insert: "👋 Before " }, { insert: "osen", attributes: { highlight: "#FFFF00" } }, { insert: " after\n" }]);
});

test("an intentional caret keeps the existing text-box inline formatting behavior", () => {
  const { selection, quill, calls, remote } = setup();
  selection.remember({ index: 7, length: 0 });
  remote(other => other.insert(7, "more "));
  assert.deepEqual(selection.resolve(), { index: 12, length: 0, hadSelection: false });
  applySavedTextFormat(quill, selection, "color", "#123456");
  assert.equal(calls[0]?.kind, "whole");
  calls.length = 0;
  applySavedTextFormat(quill, selection, "align", "center");
  assert.deepEqual(calls, [{ kind: "range", index: 12, length: 0 }]);
});

test("an unknown or deleted text field has no formatting target", () => {
  const { selection, quill, calls } = setup();
  assert.equal(applySavedTextFormat(quill, selection, "color", "#123456"), false);
  assert.deepEqual(calls, []);
  const doc = new Y.Doc();
  const fields = doc.getMap<Y.Text>("fields");
  const text = new Y.Text("chosen\n");
  fields.set("body", text);
  const saved = new SavedTextSelection(text);
  saved.remember({ index: 0, length: 6 });
  fields.delete("body");
  assert.equal(saved.resolve(), null);
});
