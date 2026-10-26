import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { applyOps, deckMap, docToJson, getTextField, jsonToDoc, normalizeDeck, normalizeElement, orderArray, slidesMap, type Element } from "@silicon-present/deck";
import { canMoveLayers, canReorderSelection, layerDropOrder, layerOrder, layerOrderOps, movableLayerIds, moveLayersOps, type LayerDirection, type LayerDropEdge } from "../lib/editor/layer-order";

const directions: LayerDirection[] = ["front", "back", "forward", "backward"];
const layers = (names: string) => [...names].map(id => normalizeElement({ id: `e_${id.repeat(6)}`, kind: "text", text: id }));
const ids = (elements: Element[]) => elements.map(element => element.id);
const names = (order: string[]) => order.map(id => id.at(-1)).join("");
const select = (names: string) => [...names].map(id => `e_${id.repeat(6)}`);

test("front/back and one-step ordering preserve multi-selection order", () => {
  const elements = layers("abcde");
  for (const [to, expected] of [["front", "acebd"], ["back", "bdace"], ["forward", "acbed"], ["backward", "badce"]] as const) {
    assert.equal(names(layerOrder(elements, select("db"), to)), expected, to);
  }
  assert.equal(names(layerOrder(elements, select("bc"), "forward")), "adbce");
  assert.equal(names(layerOrder(elements, select("bc"), "backward")), "bcade");
  assert.equal(names(layerOrder(elements, select("cde"), "forward")), "abcde", "a frontmost selected run does not reverse");
  assert.equal(names(layerOrder(elements, select("abc"), "backward")), "abcde", "a backmost selected run does not reverse");
});

test("empty, missing, all-selected and boundary selections cannot reorder", () => {
  const elements = layers("abc");
  for (const to of directions) {
    for (const selected of [[], select("x"), select("abc")]) {
      assert.equal(canReorderSelection(elements, selected, to), false);
      assert.deepEqual(layerOrderOps({ id: "s_layers", elements }, selected, to), []);
    }
  }
  for (const to of ["front", "forward"] as const) assert.equal(canReorderSelection(elements, select("c"), to), false);
  for (const to of ["back", "backward"] as const) assert.equal(canReorderSelection(elements, select("a"), to), false);
});

test("groups move together and one step crosses a neighboring group without splitting it", () => {
  const elements = layers("abcde");
  elements[1]!.group = elements[2]!.group = "g_pair";
  assert.equal(names(layerOrder(elements, select("b"), "forward")), "adbce");
  assert.equal(names(layerOrder(elements, select("c"), "backward")), "bcade");
  assert.equal(names(layerOrder(elements, select("a"), "forward")), "bcade");
  assert.equal(names(layerOrder(elements, select("d"), "backward")), "adbce");
  assert.equal(names(layerOrder(elements, select("b"), "front")), "adebc");
  assert.equal(names(layerOrder(elements, select("c"), "back")), "bcade");
});

test("locked selected objects and groups with a locked member are not mutated", () => {
  const elements = layers("abcde");
  elements[1]!.group = elements[2]!.group = "g_pair";
  elements[2]!.locked = true;
  elements[3]!.locked = true;
  for (const to of directions) {
    assert.equal(canReorderSelection(elements, select("bd"), to), false);
    const ops = layerOrderOps({ id: "s_layers", elements }, select("abd"), to);
    assert.ok(ops.every(op => op.op === "reorder_element" && op.element === elements[0]!.id));
  }
  assert.equal(names(layerOrder(elements, select("abd"), "front")), "bcdea");
});

test("all small selection combinations preserve stable order and their operations produce the planned stack", () => {
  const elements = layers("abcde");
  for (let mask = 0; mask < 32; mask++) {
    const selected = ids(elements.filter((_, index) => mask & (1 << index)));
    const selectedSet = new Set(selected);
    const beforeRest = ids(elements).filter(id => !selectedSet.has(id));
    for (const to of directions) {
      const planned = layerOrder(elements, selected, to);
      assert.deepEqual(planned.filter(id => selectedSet.has(id)), selected, `${mask} ${to} selected order`);
      assert.deepEqual(planned.filter(id => !selectedSet.has(id)), beforeRest, `${mask} ${to} unselected order`);
      if (to === "forward" || to === "backward") {
        for (const id of selected) {
          const before = ids(elements).slice(0, ids(elements).indexOf(id)).filter(item => !selectedSet.has(item)).length;
          const after = planned.slice(0, planned.indexOf(id)).filter(item => !selectedSet.has(item)).length;
          assert.ok(to === "forward" ? after >= before && after - before <= 1 : after <= before && before - after <= 1);
        }
      }
      const doc = jsonToDoc(normalizeDeck({ slides: [{ id: "s_layers", elements }] }));
      applyOps(doc, layerOrderOps({ id: "s_layers", elements }, selected, to));
      assert.deepEqual(ids(docToJson(doc).slides[0]!.elements), planned, `${mask} ${to} ops`);
      doc.destroy();
    }
  }
});

test("a multi-object layer change is one undo step separate from typing and preserves element content", () => {
  const before = normalizeDeck({ slides: [{ id: "s_layers", elements: layers("abcd") }] });
  const doc = jsonToDoc(before);
  const origin = Symbol("local");
  const undo = new Y.UndoManager([slidesMap(doc), orderArray(doc), deckMap(doc)], { trackedOrigins: new Set([origin]), captureTimeout: 450 });
  const text = getTextField(doc, "s_layers", select("b")[0]!);
  doc.transact(() => text.insert(0, "Typed "), origin);
  const beforeReorder = docToJson(doc);
  undo.stopCapturing();
  doc.transact(() => applyOps(doc, layerOrderOps(beforeReorder.slides[0]!, select("bc"), "front"), origin, { atomic: false }), origin);
  undo.stopCapturing();
  const after = docToJson(doc);
  assert.equal(names(ids(after.slides[0]!.elements)), "adbc");
  assert.equal(getTextField(doc, "s_layers", select("b")[0]!), text);
  for (const element of beforeReorder.slides[0]!.elements) assert.deepEqual(after.slides[0]!.elements.find(item => item.id === element.id), element);
  assert.equal(undo.undoStack.length, 2);
  undo.undo();
  assert.deepEqual(docToJson(doc), beforeReorder);
  undo.redo();
  assert.deepEqual(docToJson(doc), after);
  undo.destroy(); doc.destroy();
});

test("row drop edges follow the front-to-back list in either drag direction", () => {
  const elements = layers("abcde");
  for (const [source, target, edge, expected] of [
    ["b", "d", "before", "acdbe"], ["b", "d", "after", "acbde"],
    ["d", "b", "before", "abdce"], ["d", "b", "after", "adbce"],
    ["db", "c", "before", "acbde"], ["db", "c", "after", "abdce"],
    ["ac", "e", "before", "bdeac"], ["ce", "a", "after", "ceabd"],
  ] as const) {
    assert.equal(names(layerDropOrder(elements, select(source), select(target)[0]!, edge)), expected, `${source} ${edge} ${target}`);
  }
});

test("dragging expands source groups and drops outside the whole target group", () => {
  const elements = layers("abcdef");
  elements[1]!.group = elements[2]!.group = "g_source";
  elements[3]!.group = elements[4]!.group = "g_target";
  assert.deepEqual(movableLayerIds(elements, select("c")), select("bc"));
  for (const member of ["d", "e"]) {
    assert.equal(names(layerDropOrder(elements, select("c"), select(member)[0]!, "before")), "adebcf");
    assert.equal(names(layerDropOrder(elements, select("fb"), select(member)[0]!, "after")), "abcfde");
  }
  for (const edge of ["before", "after"] as const) {
    assert.equal(canMoveLayers(elements, select("b"), select("c")[0]!, edge), false, "a drop on an implicitly selected group member is a no-op");
  }
  // Legacy/interleaved target members remain in their existing relative order.
  elements[3]!.group = null;
  elements[0]!.group = elements[4]!.group = "g_target";
  assert.equal(names(layerDropOrder(elements, select("f"), select("a")[0]!, "before")), "abcdef");
  assert.equal(names(layerDropOrder(elements, select("f"), select("e")[0]!, "after")), "fabcde");
});

test("row drops ignore stale targets, self drops, adjacent boundaries and immovable sources", () => {
  const elements = layers("abcde");
  const slide = { id: "s_layers", elements };
  for (const [source, target, edge] of [
    ["", "b", "before"], ["x", "b", "after"], ["b", "x", "before"],
    ["b", "b", "after"], ["bc", "b", "before"], ["bc", "a", "before"],
    ["bc", "d", "after"], ["abcde", "c", "before"],
  ] as const) {
    assert.equal(canMoveLayers(elements, select(source), select(target)[0]!, edge), false);
    assert.deepEqual(moveLayersOps(slide, select(source), select(target)[0]!, edge), []);
  }
  assert.equal(names(layerDropOrder(elements, select("bx"), select("d")[0]!, "before")), "acdbe", "a deleted source ID does not block the remaining source");
  elements[1]!.group = elements[2]!.group = "g_locked";
  elements[2]!.locked = true;
  elements[3]!.locked = true;
  assert.deepEqual(movableLayerIds(elements, select("bd")), []);
  for (const edge of ["before", "after"] as const) {
    assert.equal(canMoveLayers(elements, select("bd"), select("e")[0]!, edge), false);
    assert.deepEqual(moveLayersOps(slide, select("bd"), select("e")[0]!, edge), []);
  }
  const ops = moveLayersOps(slide, select("abd"), select("e")[0]!, "before");
  assert.ok(ops.length > 0 && ops.every(op => op.op === "reorder_element" && op.element === elements[0]!.id));
  assert.equal(names(layerDropOrder(elements, select("abd"), select("e")[0]!, "before")), "bcdea");
});

test("all small row drops produce their planned stack without touching unselected objects", () => {
  const elements = layers("abcde");
  const edges: LayerDropEdge[] = ["before", "after"];
  for (let mask = 0; mask < 32; mask++) {
    const selected = ids(elements.filter((_, index) => mask & (1 << index)));
    const selectedSet = new Set(selected);
    for (const target of elements) for (const edge of edges) {
      const planned = layerDropOrder(elements, selected, target.id, edge);
      assert.deepEqual(planned.filter(id => selectedSet.has(id)), selected);
      assert.deepEqual(planned.filter(id => !selectedSet.has(id)), ids(elements).filter(id => !selectedSet.has(id)));
      if (!selectedSet.has(target.id) && selected.length) {
        const targetIndex = planned.indexOf(target.id);
        assert.ok(selected.every(id => edge === "before" ? planned.indexOf(id) > targetIndex : planned.indexOf(id) < targetIndex));
        const start = planned.indexOf(selected[0]!);
        assert.deepEqual(planned.slice(start, start + selected.length), selected, "a drop forms one stable block");
      }
      const ops = moveLayersOps({ id: "s_layers", elements }, selected, target.id, edge);
      assert.ok(ops.every(op => op.op === "reorder_element" && selectedSet.has(op.element)));
      const doc = jsonToDoc(normalizeDeck({ slides: [{ id: "s_layers", elements }] }));
      applyOps(doc, ops);
      assert.deepEqual(ids(docToJson(doc).slides[0]!.elements), planned, `${mask} ${edge} ${target.id}`);
      doc.destroy();
    }
  }
});

test("dropping a grouped selection is a separate single undo step with content and Y.Text intact", () => {
  const elements = layers("abcde");
  elements[1]!.group = elements[2]!.group = "g_dragged";
  const before = normalizeDeck({ slides: [{ id: "s_layers", elements }] });
  const doc = jsonToDoc(before);
  const origin = Symbol("drag");
  const undo = new Y.UndoManager([slidesMap(doc), orderArray(doc), deckMap(doc)], { trackedOrigins: new Set([origin]), captureTimeout: 450 });
  const text = getTextField(doc, "s_layers", select("b")[0]!);
  doc.transact(() => text.insert(0, "Typed "), origin);
  const beforeDrag = docToJson(doc);
  undo.stopCapturing();
  doc.transact(() => applyOps(doc, moveLayersOps(beforeDrag.slides[0]!, select("b"), select("e")[0]!, "before"), origin, { atomic: false }), origin);
  undo.stopCapturing();
  const after = docToJson(doc);
  assert.equal(names(ids(after.slides[0]!.elements)), "adebc");
  assert.equal(getTextField(doc, "s_layers", select("b")[0]!), text);
  for (const element of beforeDrag.slides[0]!.elements) assert.deepEqual(after.slides[0]!.elements.find(item => item.id === element.id), element);
  assert.equal(undo.undoStack.length, 2);
  undo.undo();
  assert.deepEqual(docToJson(doc), beforeDrag);
  undo.redo();
  assert.deepEqual(docToJson(doc), after);
  undo.destroy(); doc.destroy();
});
