import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
  applyJsonToDoc, applyOps, docFromUpdate, docToJson, encodeDoc, ensureTextField,
  findInDeck, findMatches, getElementMap, getSize, getSlideMap, getTextField, getTheme,
  jsonToDoc, normalizeDeck, normalizeElement, normalizeRichText, normalizeSize, normalizeTheme,
  replaceInDeck, replaceTextRange, setPlainText, setRichText, slideIds, slidesMap, orderArray,
  textDiff, yTextToRichText, DeckError, DEFAULT_THEME,
} from "../src/index";
import type { DeckInput, ElementInput, Op, RichText, TableElement, TextElement } from "../src/index";

function error(fn: () => unknown, code: string) { assert.throws(fn, e => e instanceof DeckError && e.code === code); }
const build = (elements: ElementInput[] = [], notes = "") => jsonToDoc({ slides: [{ id: "s", elements, notes }] });
const plain = (value: string) => ({ paragraphs: [{ runs: [{ text: value }] }] });
function textDoc(value: string): [Y.Doc, Y.Text] { const doc = new Y.Doc(); const t = doc.getText("t"); t.insert(0, value); return [doc, t]; }
function decodedText(doc: Y.Doc) { const copy = docFromUpdate(encodeDoc(doc)); return copy.getText("t").toString(); }

for (const [before, after] of [["😀", "😃"], ["👍🙏", "🙏"], ["🙏", "👍🙏"], ["👍🏻", "👍🏽"], ["A😀BCD", "A😃BXY"]]) {
  test(`Unicode text edits survive wire decoding: ${before} -> ${after}`, () => {
    const [doc, text] = textDoc(before); setPlainText(text, after);
    assert.equal(text.toString(), after); assert.equal(decodedText(doc), after);
    const [richDoc, rich] = textDoc(""); setRichText(rich, plain(before)); setRichText(rich, plain(after));
    assert.equal(decodedText(richDoc), `${after}\n`);
    const deck = build([{ id: "e", kind: "text", text: before }], before);
    applyJsonToDoc(deck, { slides: [{ id: "s", notes: after, elements: [{ id: "e", kind: "text", text: after }] }] });
    assert.deepEqual(docToJson(docFromUpdate(encodeDoc(deck))), docToJson(deck));
  });
}

test("the bounded diff preserves the prescribed longest common subsequence and tie break", () => {
  assert.deepEqual(textDiff("ab", "ba"), [{ kind: "delete", text: "a" }, { kind: "keep", text: "b" }, { kind: "insert", text: "a" }]);
  const [a, ta] = textDoc("one KEEP two"), b = docFromUpdate(encodeDoc(a)), tb = b.getText("t");
  setPlainText(ta, "1 KEEP 2"); tb.insert(8, "!");
  Y.applyUpdate(a, encodeDoc(b)); Y.applyUpdate(b, encodeDoc(a));
  assert.equal(ta.toString(), "1 KEEP! 2"); assert.equal(tb.toString(), ta.toString());
  const old = "x".repeat(2001), next = "y".repeat(2001);
  assert.deepEqual(textDiff(old, next), [{ kind: "delete", text: old }, { kind: "insert", text: next }]);
});

test("replace preserves equal runs and formats replacements from the deleted character", () => {
  const initial: RichText = { paragraphs: [{ runs: [{ text: "Total: " }, { text: "42", bold: true }, { text: " units" }] }] };
  const doc = build([{ id: "e", kind: "text", text: initial }]);
  applyOps(doc, [{ op: "replace_text", slide: "s", element: "e", find: "42 units", replace: "43 units" }]);
  const expected = structuredClone(initial); expected.paragraphs[0]!.runs[1]!.text = "43";
  assert.deepEqual((docToJson(doc).slides[0]!.elements[0] as TextElement).text, expected);
  replaceInDeck(doc, "Total: 43", "Balance: 44");
  assert.deepEqual((docToJson(doc).slides[0]!.elements[0] as TextElement).text, { paragraphs: [{ runs: [{ text: "Balance: " }, { text: "44", bold: true }, { text: " units" }] }] });
});

test("replace inherits inserted paragraph attributes and skips paragraph breaks for inline attributes", () => {
  const [doc, t] = textDoc("");
  setRichText(t, { paragraphs: [{ align: "center", list: "bullet", runs: [{ text: "Buy milk", italic: true }] }] });
  replaceTextRange(t, 4, 4, "milk\nBuy eggs", true);
  assert.deepEqual(yTextToRichText(t), { paragraphs: [
    { align: "center", list: "bullet", runs: [{ text: "Buy milk", italic: true }] },
    { align: "center", list: "bullet", runs: [{ text: "Buy eggs", italic: true }] },
  ] });
  assert.equal(decodedText(doc), "Buy milk\nBuy eggs\n");
});

test("find offsets refer to original Unicode code points, including expanded lowercase mappings", () => {
  assert.deepEqual(findMatches("İstanbul plan", "PLAN", false), [{ index: 9, length: 4 }]);
  assert.deepEqual(findMatches("İi", "i", false), [{ index: 1, length: 1 }]);
  assert.deepEqual(findMatches("İ", "i\u0307", false), [{ index: 0, length: 1 }]);
  assert.deepEqual(findMatches("ΟΣ", "οσ", false), [{ index: 0, length: 2 }]);
  assert.deepEqual(findMatches("😀", "\ude00"), []);
  const doc = build([{ id: "e", kind: "text", text: { paragraphs: [{ list: "bullet", runs: [{ text: "İstanbul ve Ankara" }] }, { runs: [{ text: "next" }] }] } }]);
  assert.equal(findInDeck(docToJson(doc), "ankara")[0]!.index, 12);
  replaceInDeck(doc, "ankara", "İzmir", { matchCase: false });
  assert.deepEqual((docToJson(doc).slides[0]!.elements[0] as TextElement).text, { paragraphs: [{ list: "bullet", runs: [{ text: "İstanbul ve İzmir" }] }, { runs: [{ text: "next" }] }] });
});

test("replace scope includes notes and every element field, with ambiguity counted across fields", () => {
  const doc = build([{ id: "e", kind: "text", text: "needle" }, { id: "h", kind: "html", html: "needle", css: "needle" }, { id: "t", kind: "table", cells: [["needle"]] }], "needle");
  error(() => applyOps(doc, [{ op: "replace_text", slide: "s", find: "needle", replace: "changed" }]), "text_ambiguous");
  assert.equal(applyOps(doc, [{ op: "replace_text", slide: "s", element: "h", find: "needle", replace: "code", all: true }]).replaced, 2);
  assert.equal(applyOps(doc, [{ op: "replace_text", slide: "s", find: "NEEDLE", replace: "changed", all: true, matchCase: false }]).replaced, 3);
  error(() => applyOps(doc, [{ op: "replace_text", slide: "s", element: "e", field: "notes", find: "changed", replace: "bad" }]), "invalid_op");
  error(() => applyOps(doc, [{ op: "replace_text", slide: "master", field: "notes", find: "x", replace: "y" }]), "invalid_op");
});

test("writers validate JSON before any mutation; readers normalize malformed values without throwing", () => {
  const doc = build([{ id: "e", kind: "text", text: "keep" }]);
  const before = encodeDoc(doc); let updates = 0; doc.on("update", () => updates++);
  const cases: Array<[unknown, string]> = [
    [null, "invalid_value"],
    [{ slides: [{ id: "master" }] }, "reserved_id"],
    [{ slides: [{ id: "s" }, { id: "s" }] }, "duplicate_id"],
    [{ slides: [{ elements: [{ kind: "text", id: "e" }, { kind: "text", id: "e" }] }] }, "duplicate_id"],
    [{ slides: [{ elements: [{ kind: "constructor" }] }] }, "unknown_element_kind"],
    [{ slides: [{ extra: 1 }] }, "invalid_field"],
    [{ slides: [{ notes: "\ud83d" }] }, "invalid_value"],
    [{ size: { width: 1920, height: 1080, unit: "px" } }, "invalid_field"],
    [{ theme: { fonts: "Inter" } }, "invalid_value"],
    [{ slides: [{ elements: [{ kind: "table", rows: 2.5 }] }] }, "invalid_value"],
    [{ slides: [{ elements: [{ kind: "table", rows: 1, cols: 1, cells: [["a", "b"]] }] }] }, "invalid_value"],
    [{ slides: [{ elements: [{ kind: "table", rows: 101 }] }] }, "invalid_value"],
    [{ slides: [{ elements: [{ kind: "text", text: { paragraphs: [{ runs: [{ text: "hi", align: "left" }] }] } }] }] }, "invalid_field"],
  ];
  for (const [bad, code] of cases) {
    error(() => applyJsonToDoc(doc, bad as DeckInput), code);
    assert.deepEqual(encodeDoc(doc), before); assert.equal(updates, 0);
    const normalized = normalizeDeck(bad as DeckInput);
    assert.doesNotThrow(() => jsonToDoc(normalized));
  }
});

test("canonical numeric, string, object and rich attribute conversion matches the specified domains", () => {
  const e = (v: unknown) => normalizeElement({ kind: "image", x: v, alt: v, style: v });
  for (const value of [null, false, true, "", "0x10", "1.", ".5", "+1", "Infinity", "1e400", [], {}]) assert.equal(e(value).x, 0);
  assert.equal(e(" \t1e3\r\n").x, 1000); assert.equal(e("-0").x, 0);
  assert.equal((e(2.5) as { alt: string }).alt, "2.5"); assert.equal((e(1e21) as { alt: string }).alt, "");
  assert.deepEqual(e([]).style, {});
  assert.deepEqual(normalizeSize({ width: "1280", height: "720", extra: true }), { width: 1280, height: 720 });
  assert.deepEqual(normalizeTheme({ fonts: "bad", colors: ["bad"] }), DEFAULT_THEME);
  assert.deepEqual(normalizeRichText(1e21), { paragraphs: [] });
  assert.deepEqual(normalizeRichText({ paragraphs: [null, { runs: [null, { text: 42, size: "40", bold: true, font: "Inter", italic: "yes" }, { text: {}, size: "40px" }], heading: 0, list: "checked", indent: 9 }] }), { paragraphs: [{ runs: [] }, { runs: [{ text: "42", size: 40, bold: true, font: "Inter" }] }] });
  const doc = jsonToDoc({ slides: [{ elements: [{ kind: "image", x: "12", alt: 42, style: { opacity: 2 ** 60 } }] }] });
  assert.equal(docToJson(doc).slides[0]!.elements[0]!.x, 12);
});

test("reader repairs malformed maps in its result using map ids, without writing or creating roots", () => {
  const empty = new Y.Doc(); let changes = 0; empty.on("update", () => changes++);
  docToJson(empty); getSize(empty); getTheme(empty); slideIds(empty);
  assert.equal(empty.share.size, 0); assert.equal(changes, 0);
  const wrong = new Y.Doc(); wrong.getArray("deck"); wrong.getText("order"); wrong.getArray("slides");
  assert.deepEqual(docToJson(wrong).slides, []);
  const doc = build([{ id: "chart", kind: "chart" }, { id: "table", kind: "table", cells: [["a", "b"], ["c", "d"]] }]);
  const slide = getSlideMap(doc, "s"); slide.set("id", "wrong"); slide.delete("notes");
  const chart = getElementMap(doc, "s", "chart"); chart.delete("id"); chart.set("chart", { series: [null, false], labels: [null, true, 42], legend: "yes" }); chart.set("style", { enormous: 9007199254740993n });
  const table = getElementMap(doc, "s", "table"); table.set("rows", "2.5"); table.set("cols", null); table.set("colWidths", [1]);
  const els = slide.get("elements") as Y.Map<unknown>, order = slide.get("elementOrder") as Y.Array<string>;
  const unknown = new Y.Map(); unknown.set("kind", "constructor"); els.set("unknown", unknown); order.push(["unknown"]);
  order.push(["chart", "missing"]); orderArray(doc).push(["s", "master", "missing"]);
  const snapshot = encodeDoc(doc); let updates = 0; doc.on("update", () => updates++);
  const result = docToJson(doc);
  assert.equal(result.slides[0]!.id, "s"); assert.equal(result.slides[0]!.elements[0]!.id, "chart");
  assert.equal(result.slides[0]!.elements.length, 2);
  const t = result.slides[0]!.elements[1] as TableElement;
  assert.equal(t.rows, 2); assert.equal(t.cols, 2); assert.deepEqual(t.colWidths, [200, 200]); assert.equal(t.cells[1]![0]!.text.paragraphs[0]!.runs[0]!.text, "c");
  assert.equal((result.slides[0]!.elements[0]!.style as Record<string, unknown>).enormous, 9007199254740992);
  error(() => getTextField(doc, "s", null, "notes"), "field_not_found");
  assert.equal(updates, 0); assert.deepEqual(encodeDoc(doc), snapshot); assert.doesNotThrow(() => jsonToDoc(result));
  slide.set("notes", "existing 😀");
  const repaired = ensureTextField(doc, "s", null, "notes"); assert.equal(repaired.toString(), "existing 😀");
});

test("writers canonicalize rewritten maps, including unknown keys and malformed text fields", () => {
  const doc = build([{ id: "e", kind: "text", text: "hello" }]);
  const slide = getSlideMap(doc, "s"), element = getElementMap(doc, "s", "e");
  element.set("text", { paragraphs: [{ runs: [{ text: "not a Y.Text" }] }] });
  assert.deepEqual((docToJson(doc).slides[0]!.elements[0] as TextElement).text, { paragraphs: [] });
  element.set("w", "400"); element.set("text", "hello"); element.set("extra", 1); slide.set("extra", 1); slide.set("notes", 42);
  applyOps(doc, [{ op: "update_element", slide: "s", element: "e", set: { x: 10 } }, { op: "update_slide", slide: "s", set: { skipped: true } }]);
  assert.equal(element.get("w"), 400); assert.equal(element.has("extra"), false); assert.equal(slide.has("extra"), false);
  assert.equal(getTextField(doc, "s", "e").toString(), "hello\n"); assert.equal(getTextField(doc, "s", null, "notes").toString(), "42");
});

test("order ops count visible ids and remove every duplicate of the moved id", () => {
  const doc = jsonToDoc({ slides: [{ id: "s1", elements: [{ kind: "text", id: "a" }, { kind: "text", id: "b" }, { kind: "text", id: "c" }] }, { id: "s2" }, { id: "s3" }] });
  orderArray(doc).insert(1, ["missing", "s1"]);
  const slide = getSlideMap(doc, "s1"), order = slide.get("elementOrder") as Y.Array<string>; order.insert(1, ["missing", "a"]);
  applyOps(doc, [{ op: "move_slide", slide: "s1", after: "s2" }, { op: "reorder_element", slide: "s1", element: "a", to: "forward" }]);
  assert.deepEqual(docToJson(doc).slides.map(s => s.id), ["s2", "s1", "s3"]);
  assert.deepEqual(docToJson(doc).slides[1]!.elements.map(e => e.id), ["b", "a", "c"]);
  assert.equal(orderArray(doc).toArray().filter(id => id === "s1").length, 1); assert.equal(order.toArray().filter(id => id === "a").length, 1);
  applyOps(doc, [{ op: "move_slide", slide: "s1" }, { op: "add_element", slide: "s1", element: { id: "d", kind: "text" }, z: 1 }]);
  assert.deepEqual(docToJson(doc).slides.map(s => s.id), ["s2", "s3", "s1"]);
  assert.deepEqual(docToJson(doc).slides[2]!.elements.map(e => e.id), ["b", "d", "a", "c"]);
});

test("invalid op shapes, canonical values and cross-slide duplicate ids are atomic even for local helpers", () => {
  const doc = build([{ id: "e", kind: "text", text: "keep" }]); const before = encodeDoc(doc); let updates = 0; doc.on("update", () => updates++);
  const cases: Array<[unknown, string]> = [
    [{ op: "unknown" }, "invalid_op"], [{ op: "update_slide", slide: "master", set: {} }, "invalid_op"],
    [{ op: "move_slide", slide: "s", after: "s" }, "invalid_op"], [{ op: "delete_slide", slide: "s", extra: true }, "invalid_op"],
    [{ op: "add_element", slide: "s", element: { kind: "text" }, z: 1.5 }, "invalid_op"],
    [{ op: "reorder_element", slide: "s", element: "e", to: -1 }, "invalid_op"],
    [{ op: "replace_text", slide: "s", find: "", replace: "" }, "invalid_op"],
    [{ op: "replace_text", slide: "s", find: "keep", replace: "\ud83d" }, "invalid_op"],
    [{ op: "update_element", slide: "s", element: "e", set: { w: "wide" } }, "invalid_value"],
    [{ op: "update_element", slide: "s", element: "e", set: { cells: [] } }, "invalid_field"],
    [{ op: "add_slide", slide: { id: "new", elements: [{ kind: "text", id: "e" }] } }, "element_exists"],
  ];
  for (const [bad, code] of cases) for (const atomic of [true, false]) {
    error(() => applyOps(doc, [{ op: "update_slide", slide: "s", set: { notes: "would change" } }, bad as Op], undefined, { atomic }), code);
    assert.deepEqual(encodeDoc(doc), before); assert.equal(updates, 0);
  }
  const undo = new Y.UndoManager(slidesMap(doc), { trackedOrigins: new Set(["local"]) });
  applyOps(doc, [{ op: "add_slide" }], "local", { atomic: false }); assert.equal(docToJson(doc).slides.length, 2);
  undo.undo(); assert.equal(docToJson(doc).slides.length, 1);
});

test("table resizing scales unchanged counts, infers a new grid, and discards removed cells", () => {
  const doc = build([{ id: "t", kind: "table", w: 400, h: 200, cells: [["a", "b"], ["c", "d"]], colWidths: [100, 300], rowHeights: [50, 150] }]);
  const table = () => docToJson(doc).slides[0]!.elements[0] as TableElement;
  const update = (set: Record<string, unknown>) => applyOps(doc, [{ op: "update_element", slide: "s", element: "t", set }]);
  update({ w: "800", cols: "2" }); assert.deepEqual(table().colWidths, [200, 600]);
  update({ rows: 1, h: 300 }); assert.deepEqual(table().rowHeights, [300]); assert.equal(table().cells.length, 1);
  update({ rows: 2 }); assert.deepEqual(table().cells[1]![0]!.text, { paragraphs: [] });
  update({ cells: [["new"]] }); assert.equal(table().rows, 1); assert.equal(table().cols, 1); assert.deepEqual(table().colWidths, [800]);
  update({ cells: null, colWidths: null }); assert.deepEqual(table().cells[0]![0]!.text, { paragraphs: [] }); assert.deepEqual(table().colWidths, [800]);
});

test("writers remove embeds before using reader text offsets and clear plain formatting", () => {
  const [doc, text] = textDoc("ab"); text.insertEmbed(1, { unexpected: true });
  setPlainText(text, "ac"); assert.equal(text.length, 2); assert.equal(text.toString(), "ac");
  text.insertEmbed(1, { unexpected: true }); text.format(0, text.length, { bold: true });
  replaceTextRange(text, 1, 1, "d", false);
  assert.deepEqual(text.toDelta(), [{ insert: "ad" }]); assert.equal(decodedText(doc), "ad");
  text.insertEmbed(1, { unexpected: true }); setRichText(text, plain("a😀d"));
  assert.equal(text.length, 5); assert.equal(decodedText(doc), "a😀d\n");
});


test("full reconcile canonicalizes raw storage and a repeated reconcile is silent", () => {
  const doc = build([{ id: "e", kind: "text", text: "keep" }]);
  const root = doc.getMap("deck"); root.set("extra", true); root.set("version", "wrong");
  slidesMap(doc).set("hidden", new Y.Map());
  orderArray(doc).push(["s", "hidden", "missing", 42 as never]);
  const slide = getSlideMap(doc, "s"), order = slide.get("elementOrder") as Y.Array<string>;
  order.push(["e", "missing", 42 as never]);
  const target = docToJson(doc); target.slides = target.slides.filter(s => s.id === "s");
  applyJsonToDoc(doc, target);
  assert.deepEqual([...root.keys()].sort(), ["size", "theme", "version"]); assert.equal(root.get("version"), 1);
  assert.equal(slidesMap(doc).has("hidden"), false); assert.deepEqual(orderArray(doc).toArray(), ["s"]); assert.deepEqual(order.toArray(), ["e"]);
  let updates = 0; doc.on("update", () => updates++); applyJsonToDoc(doc, target); assert.equal(updates, 0);
});
