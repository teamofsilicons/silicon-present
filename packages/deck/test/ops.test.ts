import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { applyOps, applyJsonToDoc, docToJson, jsonToDoc, DeckError, SLIDE_ID_RE, ELEMENT_ID_RE, THEMES, richTextToPlain } from "../src/index";
import type { TextElement, TableElement } from "../src/index";
import { fixtures } from "./make-fixtures";

const deck = () => jsonToDoc(fixtures()["every-element"]!);

function err(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof DeckError && e.code === code && !!e.hint && !!e.message);
}

test("add_slide: after null = first, missing = last, generated ids, nested elements", () => {
  const doc = deck();
  const r = applyOps(doc, [
    { op: "add_slide", after: null, slide: { layout: "title", elements: [{ kind: "text", text: "Hello" } as never] } },
    { op: "add_slide", slide: { notes: "end" } },
  ]);
  const j = docToJson(doc);
  assert.equal(j.slides[0]!.id, r.slides[0]);
  assert.equal(j.slides.at(-1)!.id, r.slides[1]);
  assert.match(r.slides[0]!, SLIDE_ID_RE);
  assert.match(r.elements[0]!, ELEMENT_ID_RE);
  assert.equal(richTextToPlain((j.slides[0]!.elements[0] as TextElement).text), "Hello");
  assert.equal(j.slides.at(-1)!.notes, "end");
  assert.deepEqual(r.touched, r.slides);
});

test("update_slide / move_slide / delete_slide", () => {
  const doc = deck();
  applyOps(doc, [
    { op: "update_slide", slide: "s_000001", set: { skipped: true, notes: "New notes", background: { color: "#000000" }, section: null } },
    { op: "move_slide", slide: "s_000001", after: "s_000003" },
    { op: "move_slide", slide: "s_000005", after: null },
    { op: "delete_slide", slide: "s_000004" },
  ]);
  const j = docToJson(doc);
  assert.deepEqual(j.slides.map((s) => s.id), ["s_000005", "s_000002", "s_000003", "s_000001"]);
  const s1 = j.slides.find((s) => s.id === "s_000001")!;
  assert.equal(s1.skipped, true);
  assert.equal(s1.notes, "New notes");
  assert.deepEqual(s1.background, { color: "#000000" });
  assert.equal(s1.section, null);
  err(() => applyOps(doc, [{ op: "update_slide", slide: "s_000001", set: { nope: 1 } as never }]), "invalid_field");
  err(() => applyOps(doc, [{ op: "delete_slide", slide: "s_zzzzzz" }]), "slide_not_found");
});

test("add_element with z, update_element merges, reorder, delete", () => {
  const doc = deck();
  const r = applyOps(doc, [
    { op: "add_element", slide: "s_000002", element: { kind: "shape", shape: "star", x: 10, y: 10, w: 100, h: 100 }, z: 0 },
    { op: "add_element", slide: "master", element: { kind: "text", text: "logo" } },
  ]);
  let j = docToJson(doc);
  assert.equal(j.slides[1]!.elements[0]!.id, r.elements[0]);
  assert.equal(j.master.elements.at(-1)!.id, r.elements[1]);
  applyOps(doc, [
    { op: "update_element", slide: "s_000002", element: r.elements[0]!, set: { x: 500, style: { fill: "#ff0000" }, text: "★" } },
    { op: "reorder_element", slide: "s_000002", element: r.elements[0]!, to: "front" },
  ]);
  j = docToJson(doc);
  const star = j.slides[1]!.elements.at(-1)!;
  assert.equal(star.id, r.elements[0]);
  assert.equal(star.x, 500);
  assert.equal(star.y, 10);
  assert.deepEqual(star.style, { fill: "#ff0000" });
  applyOps(doc, [{ op: "reorder_element", slide: "s_000002", element: r.elements[0]!, to: 2 }, { op: "reorder_element", slide: "s_000002", element: r.elements[0]!, to: "backward" }]);
  assert.equal(docToJson(doc).slides[1]!.elements.findIndex((e) => e.id === r.elements[0]), 1);
  applyOps(doc, [{ op: "delete_element", slide: "s_000002", element: r.elements[0]! }]);
  assert.ok(!docToJson(doc).slides[1]!.elements.some((e) => e.id === r.elements[0]));
  err(() => applyOps(doc, [{ op: "update_element", slide: "s_000002", element: "e_nope00", set: {} }]), "element_not_found");
  err(() => applyOps(doc, [{ op: "update_element", slide: "s_000002", element: "e_000003", set: { kind: "text" } }]), "kind_change");
});

test("update_element on a table: resizing keeps cells, cells replace via diff", () => {
  const doc = deck();
  const tableId = docToJson(doc).slides[2]!.elements[0]!.id;
  applyOps(doc, [{ op: "update_element", slide: "s_000003", element: tableId, set: { rows: 4, cols: 2 } }]);
  let t = docToJson(doc).slides[2]!.elements[0] as TableElement;
  assert.equal(t.rows, 4);
  assert.equal(t.cols, 2);
  assert.equal(t.cells.length, 4);
  assert.equal(t.colWidths.length, 2);
  assert.equal(richTextToPlain(t.cells[1]![0]!.text), "North");
  applyOps(doc, [{ op: "update_element", slide: "s_000003", element: tableId, set: { w: 1800 } }]);
  t = docToJson(doc).slides[2]!.elements[0] as TableElement;
  assert.equal(t.colWidths.reduce((a, b) => a + b, 0), 1800);
});

test("replace_text: exact, all, not found with closest match, ambiguous; keeps formatting", () => {
  const doc = deck();
  const id = docToJson(doc).slides[0]!.elements[0]!.id;
  const r = applyOps(doc, [{ op: "replace_text", slide: "s_000001", element: id, find: "inline", replace: "INLINE" }]);
  assert.equal(r.replaced, 1);
  const el = docToJson(doc).slides[0]!.elements[0] as TextElement;
  assert.deepEqual(el.text.paragraphs[0]!.runs[1], { text: "INLINE", bold: true });
  try {
    applyOps(doc, [{ op: "replace_text", slide: "s_000001", element: id, find: "Justifeid heading", replace: "x" }]);
    assert.fail();
  } catch (e) {
    assert.ok(e instanceof DeckError);
    assert.equal(e.code, "text_not_found");
    assert.match(e.hint, /Justified heading/);
  }
  err(() => applyOps(doc, [{ op: "replace_text", slide: "s_000001", element: id, find: "bullet", replace: "x" }]), "text_ambiguous");
  assert.equal(applyOps(doc, [{ op: "replace_text", slide: "s_000001", element: id, find: "bullet", replace: "point", all: true }]).replaced, 2);
  applyOps(doc, [{ op: "replace_text", slide: "s_000001", find: "two lines", replace: "2 lines" }]);
  assert.equal(docToJson(doc).slides[0]!.notes, "Speaker notes\nwith 2 lines");
  const tableId = docToJson(doc).slides[2]!.elements[0]!.id;
  applyOps(doc, [{ op: "replace_text", slide: "s_000003", element: tableId, field: "cell:1:0", find: "North", replace: "Nord" }]);
  assert.equal(richTextToPlain((docToJson(doc).slides[2]!.elements[0] as TableElement).cells[1]![0]!.text), "Nord");
  const htmlId = docToJson(doc).slides[2]!.elements[2]!.id;
  applyOps(doc, [{ op: "replace_text", slide: "s_000003", element: htmlId, field: "css", find: "#b4532a", replace: "#000" }]);
  assert.match((docToJson(doc).slides[2]!.elements[2] as { css: string }).css, /#000;/);
});

test("ops are atomic: a failing op leaves the document unchanged and emits no update", () => {
  const doc = deck();
  const before = JSON.stringify(docToJson(doc));
  let updates = 0;
  doc.on("update", () => updates++);
  err(() => applyOps(doc, [{ op: "delete_slide", slide: "s_000001" }, { op: "delete_slide", slide: "s_missing" }]), "slide_not_found");
  assert.equal(JSON.stringify(docToJson(doc)), before);
  assert.equal(updates, 0);
  applyOps(doc, [{ op: "delete_slide", slide: "s_000001" }, { op: "add_slide", slide: {} }]);
  assert.equal(updates, 1, "all ops in one request are one update");
});

test("update_deck replaces theme and size", () => {
  const doc = deck();
  applyOps(doc, [{ op: "update_deck", set: { theme: THEMES[2]!, size: { width: 1080, height: 1080 } } }]);
  const j = docToJson(doc);
  assert.equal(j.theme.name, "Ink");
  assert.deepEqual(j.size, { width: 1080, height: 1080 });
});

test("ops on an older copy merge with concurrent edits (pull/push)", () => {
  const live = deck();
  const old = new Y.Doc();
  Y.applyUpdate(old, Y.encodeStateAsUpdate(live));
  // someone edits slide 2 live; the Silicon edits slide 1 on its older copy
  applyOps(live, [{ op: "update_slide", slide: "s_000002", set: { notes: "live note" } }]);
  const sv = Y.encodeStateVector(old);
  applyOps(old, [{ op: "replace_text", slide: "s_000001", find: "Speaker", replace: "Silicon" }]);
  Y.applyUpdate(live, Y.encodeStateAsUpdate(old, sv));
  const j = docToJson(live);
  assert.equal(j.slides[0]!.notes, "Silicon notes\nwith two lines");
  assert.equal(j.slides[1]!.notes, "live note");
});

test("applyJsonToDoc reconciles minimally (untouched slides produce no change)", () => {
  const doc = deck();
  const j = docToJson(doc);
  let updates = 0;
  doc.on("update", () => updates++);
  applyJsonToDoc(doc, j);
  assert.equal(updates, 0, "same JSON means no update");
  j.slides[1]!.elements[0]!.x = 999;
  j.slides.reverse();
  applyJsonToDoc(doc, j);
  assert.equal(updates, 1);
  assert.deepEqual(docToJson(doc), j);
});

test("concurrent moves of the same slide never duplicate it", () => {
  const a = deck();
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  applyOps(a, [{ op: "move_slide", slide: "s_000001", after: "s_000005" }]);
  applyOps(b, [{ op: "move_slide", slide: "s_000001", after: "s_000002" }]);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  const ids = docToJson(a).slides.map((s) => s.id);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
});
