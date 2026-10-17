import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
  THEMES, LAYOUTS, layoutElements, newSlideId, newElementId, SLIDE_ID_RE, ELEMENT_ID_RE, jsonToDoc, docToJson, addSlide, duplicateSlide,
  moveSlideTo, deleteSlide, slideIds, addElement, updateElement, groupElements, ungroup, groupMembers, getSlide, moveElements,
  alignElements, distributeElements, findInDeck, replaceInDeck, setElementText, setCellText, setNotes, setCode, duplicateElements,
  newDeckJson, richTextToPlain, getTextField, normalizeDeck, themeByName,
} from "../src/index";
import type { TextElement } from "../src/index";
import { fixtures } from "./make-fixtures";

test("ids", () => {
  const s = new Set<string>();
  for (let i = 0; i < 2000; i++) s.add(newSlideId());
  assert.ok(s.size > 1990);
  for (const id of s) assert.match(id, SLIDE_ID_RE);
  assert.match(newElementId(), ELEMENT_ID_RE);
});

test("at least six themes, each complete", () => {
  assert.ok(THEMES.length >= 6);
  for (const t of THEMES) {
    assert.ok(t.name && t.fonts.heading && t.fonts.body);
    for (const k of ["background", "text", "accent", "accent2", "accent3", "muted"] as const) assert.match(t.colors[k], /^#[0-9a-f]{6}$/);
  }
  assert.equal(themeByName("ink")!.name, "Ink");
});

test("seven layouts produce valid placeholders inside the slide", () => {
  assert.equal(LAYOUTS.length, 7);
  for (const l of LAYOUTS) {
    const els = layoutElements(l, THEMES[0]!, { width: 1920, height: 1080 }, { title: "T", body: ["a", "b"] });
    const deck = normalizeDeck({ slides: [{ layout: l, elements: els }] });
    for (const e of deck.slides[0]!.elements) {
      assert.ok(e.x >= 0 && e.y >= 0 && e.x + e.w <= 1920 && e.y + e.h <= 1080, `${l} ${e.kind} out of bounds`);
    }
    if (l === "blank") assert.equal(els.length, 0);
    else assert.ok(els.length >= 1);
  }
  const tb = normalizeDeck({ slides: [{ elements: layoutElements("title-body", THEMES[0]!, undefined, { title: "Hello", body: ["a", "b"] }) }] }).slides[0]!;
  assert.equal(richTextToPlain((tb.elements[0] as TextElement).text), "Hello");
  assert.deepEqual((tb.elements[1] as TextElement).text.paragraphs.map((p) => p.list), ["bullet", "bullet"]);
  // scaled for a square deck
  const sq = layoutElements("title", THEMES[0]!, { width: 1080, height: 1080 });
  assert.ok((sq[0]!.w as number) < 1080);
});

test("slide helpers: add with layout, duplicate, move, delete", () => {
  const doc = jsonToDoc(newDeckJson({ title: "Deck" }));
  const first = slideIds(doc)[0]!;
  const a = addSlide(doc, { layout: "two-columns" }, { content: { title: "Two", left: "L", right: "R" } });
  assert.equal(getSlide(doc, a).elements.length, 3);
  const copy = duplicateSlide(doc, a);
  assert.deepEqual(slideIds(doc), [first, a, copy]);
  const ca = getSlide(doc, copy);
  assert.notDeepEqual(ca.elements.map((e) => e.id), getSlide(doc, a).elements.map((e) => e.id));
  moveSlideTo(doc, copy, 0);
  assert.deepEqual(slideIds(doc), [copy, first, a]);
  deleteSlide(doc, first);
  assert.deepEqual(slideIds(doc), [copy, a]);
});

test("element helpers: text, cells, notes, code, group, move (locked stays), duplicate", () => {
  const doc = jsonToDoc(fixtures()["every-element"]!);
  const s2 = getSlide(doc, "s_000002");
  const grouped = s2.elements.filter((e) => e.group === "g_000001").map((e) => e.id);
  assert.deepEqual(groupMembers(s2, grouped[0]!), grouped);
  ungroup(doc, "s_000002", "g_000001");
  assert.ok(getSlide(doc, "s_000002").elements.every((e) => e.group === null));
  const g = groupElements(doc, "s_000002", grouped);
  assert.ok(getSlide(doc, "s_000002").elements.filter((e) => e.group === g).length === 2);
  // first grouped element is locked
  const before = getSlide(doc, "s_000002").elements.filter((e) => grouped.includes(e.id));
  moveElements(doc, "s_000002", grouped, 10, 20);
  const after = getSlide(doc, "s_000002").elements.filter((e) => grouped.includes(e.id));
  assert.equal(after[0]!.x, before[0]!.x);
  assert.equal(after[1]!.x, before[1]!.x + 10);
  const t = addElement(doc, "s_000004", { kind: "text", x: 1, y: 2, w: 3, h: 4 });
  setElementText(doc, "s_000004", t, "line one\nline two");
  assert.equal(getTextField(doc, "s_000004", t).toString(), "line one\nline two\n");
  updateElement(doc, "s_000004", t, { rotation: 45 });
  assert.equal(getSlide(doc, "s_000004").elements[0]!.rotation, 45);
  const tableId = getSlide(doc, "s_000003").elements[0]!.id;
  setCellText(doc, "s_000003", tableId, 0, 0, "Area");
  setNotes(doc, "s_000004", "notes!");
  const htmlId = getSlide(doc, "s_000003").elements[2]!.id;
  setCode(doc, "s_000003", htmlId, "js", "console.log(1)");
  const j = docToJson(doc);
  assert.equal(j.slides[3]!.notes, "notes!");
  assert.equal((j.slides[2]!.elements[2] as { js: string }).js, "console.log(1)");
  const dups = duplicateElements(doc, "s_000002", grouped);
  const dupEls = getSlide(doc, "s_000002").elements.filter((e) => dups.includes(e.id));
  assert.equal(dupEls.length, 2);
  assert.ok(dupEls[0]!.group && dupEls[0]!.group !== g && dupEls[0]!.group === dupEls[1]!.group);
});

test("align and distribute (pure)", () => {
  const els = [
    { id: "a", x: 0, y: 0, w: 100, h: 50 },
    { id: "b", x: 300, y: 100, w: 50, h: 50 },
    { id: "c", x: 900, y: 40, w: 100, h: 100 },
  ];
  assert.deepEqual(alignElements(els, "right").map((c) => c.set.x), [900, 950, 900]);
  assert.deepEqual(alignElements(els, "middle", { x: 0, y: 0, w: 1920, h: 1080 }).map((c) => c.set.y), [515, 515, 490]);
  const d = distributeElements(els, "horizontal");
  assert.deepEqual(d.map((c) => c.set.x), [0, 475, 900]);
});

test("find and replace across the deck (slides, master, cells, notes)", () => {
  const doc = jsonToDoc(fixtures()["every-element"]!);
  const deck = docToJson(doc);
  const hits = findInDeck(deck, "north");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.field, "cell:1:0");
  assert.equal(findInDeck(deck, "north", { matchCase: true }).length, 0);
  const n = replaceInDeck(doc, "Speaker", "Talk");
  assert.equal(n, 1);
  assert.equal(docToJson(doc).slides[0]!.notes.startsWith("Talk notes"), true);
  const m = replaceInDeck(doc, "a", "A", { matchCase: true });
  assert.ok(m > 3);
  assert.equal(findInDeck(docToJson(doc), "a", { matchCase: true }).length, 0);
});

test("one helper call is one update (one undo step)", () => {
  const doc = jsonToDoc(fixtures()["every-element"]!);
  let n = 0;
  doc.on("update", () => n++);
  const um = new Y.UndoManager([doc.getMap("slides"), doc.getArray("order")], { trackedOrigins: new Set(["me"]) });
  duplicateSlide(doc, "s_000002", "me");
  assert.equal(n, 1);
  um.undo();
  assert.equal(slideIds(doc).length, 5);
});
