import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import {
  DEFAULT_THEME, applyOps, deckMap, docToJson, getTextField, jsonToDoc, layoutElements,
  normalizeDeck, normalizeElement, orderArray, richTextFromPlain, slidesMap,
  type DeckJson, type Element, type Size, type TextElement,
} from "@silicon-present/deck";
import { layoutChangeOps } from "../lib/editor/layout-change";

const SIZE = { width: 1920, height: 1080 };
function deck(layout: string, size: Size = SIZE): DeckJson {
  return normalizeDeck({ size, theme: DEFAULT_THEME, slides: [{ id: "s_layout", layout, elements: layoutElements(layout, DEFAULT_THEME, size) }] });
}
function change(input: DeckJson, layout: string): DeckJson {
  const doc = jsonToDoc(input);
  applyOps(doc, layoutChangeOps(input.slides[0]!, layout, input.theme, input.size));
  const result = docToJson(doc);
  doc.destroy();
  return result;
}
const boxes = (elements: Element[]) => elements.map(({ kind, x, y, w, h }) => ({ kind, x, y, w, h })).sort((a, b) => a.y - b.y || a.x - b.x);
const stripBox = (element: Element) => Object.fromEntries(Object.entries(element).filter(([key]) => !["x", "y", "w", "h"].includes(key)));

test("empty title-body placeholders really become picture and caption even after the old metadata-only bug", () => {
  const before = deck("title-body");
  before.slides[0]!.layout = "image-caption";
  const unchanged = structuredClone(before);
  const after = change(before, "image-caption");
  assert.equal(after.slides[0]!.layout, "image-caption");
  assert.equal(after.slides[0]!.elements.length, 2);
  assert.deepEqual(boxes(after.slides[0]!.elements), boxes(deck("image-caption").slides[0]!.elements));
  assert.deepEqual(before, unchanged, "planning does not mutate its input");
});

test("blank-to-columns uses the actual size and repeated layout changes do not accumulate placeholders", () => {
  const size = { width: 960, height: 1440 };
  let current = change(deck("blank", size), "two-columns");
  assert.equal(current.slides[0]!.elements.length, 3);
  assert.deepEqual(boxes(current.slides[0]!.elements), boxes(deck("two-columns", size).slides[0]!.elements));
  const ids = current.slides[0]!.elements.map(element => element.id);
  assert.deepEqual(layoutChangeOps(current.slides[0]!, "two-columns", current.theme, size), []);
  current = change(current, "two-columns");
  assert.deepEqual(current.slides[0]!.elements.map(element => element.id), ids);
  for (const [layout, count] of [["image-caption", 2], ["title-body", 2], ["section", 3], ["two-columns", 3], ["blank", 0]] as const) {
    current = change(current, layout);
    assert.equal(current.slides[0]!.elements.length, count, layout);
  }
});

test("authored title and body retain IDs, rich text, styles and anchors while moving to columns", () => {
  const before = deck("title");
  const [title, body] = before.slides[0]!.elements as TextElement[];
  title!.text = { paragraphs: [{ heading: 1, runs: [{ text: "Quarterly ", bold: true }, { text: "review", color: "#123456", link: "https://example.test" }] }] };
  title!.style.fill = "#EEEEEE";
  title!.link = "https://example.test/title";
  body!.text = { paragraphs: [{ list: "bullet", runs: [{ text: "Revenue grew", italic: true }] }] };
  body!.animation = { effect: "fade", trigger: "click", order: 1, duration: 500, delay: 0 };
  const extra = normalizeElement({ id: "e_custom", kind: "shape", shape: "star", x: 1720, y: 900, w: 80, h: 80 });
  before.slides[0]!.elements = [body!, extra, title!]; // Source roles must not depend on z-order.
  const after = change(before, "two-columns");
  const target = deck("two-columns").slides[0]!.elements;
  for (const [original, slot] of [[title!, target[0]!], [body!, target[1]!]]) {
    const moved = after.slides[0]!.elements.find(element => element.id === original!.id)!;
    assert.deepEqual(stripBox(moved), stripBox(original!));
    assert.deepEqual(boxes([moved]), boxes([slot!]));
  }
  assert.deepEqual(after.slides[0]!.elements.find(element => element.id === extra.id), extra);
  assert.equal(after.slides[0]!.elements.length, 4);
});

test("fewer slots preserve overflow body text and real pictures instead of deleting authored content", () => {
  const columns = deck("two-columns");
  for (const [index, element] of columns.slides[0]!.elements.entries()) {
    if (element.kind === "text") element.text.paragraphs[0]!.runs = [{ text: `Content ${index}`, bold: true }];
  }
  const titleOnly = change(columns, "title-only");
  assert.deepEqual(titleOnly.slides[0]!.elements, columns.slides[0]!.elements);

  const picture = deck("image-caption");
  const image = picture.slides[0]!.elements[0]!;
  assert.equal(image.kind, "image");
  if (image.kind !== "image") throw new Error("image expected");
  image.src = "asset:original"; image.alt = "Original alt text"; image.fit = "cover";
  const caption = picture.slides[0]!.elements[1] as TextElement;
  caption.text = richTextFromPlain("Do not lose this caption");
  const asTitle = change(picture, "title-only");
  assert.deepEqual(asTitle.slides[0]!.elements.find(element => element.id === image.id), image);
  assert.deepEqual(stripBox(asTitle.slides[0]!.elements.find(element => element.id === caption.id)!), stripBox(caption));
  const restored = change(asTitle, "image-caption");
  assert.deepEqual(restored.slides[0]!.elements, picture.slides[0]!.elements);
});

test("Blank removes only unchanged empty templates and preserves customized or protected empty objects", () => {
  const before = deck("title-body");
  const template = before.slides[0]!.elements[0]!;
  const custom = [
    { ...structuredClone(template), id: "e_locked", locked: true },
    { ...structuredClone(template), id: "e_group1", group: "g_custom" },
    { ...structuredClone(template), id: "e_rotate", rotation: 12 },
    { ...structuredClone(template), id: "e_linked", link: "https://example.test" },
    { ...structuredClone(template), id: "e_styled", style: { ...template.style, fill: "#123456" } },
    normalizeElement({ ...layoutElements("image-caption", DEFAULT_THEME)[0]!, id: "e_altimg", alt: "A planned picture", fit: "cover" }),
  ] as Element[];
  before.slides[0]!.elements.push(...custom);
  const after = change(before, "blank");
  assert.deepEqual(after.slides[0]!.elements, custom);
  const section = deck("section");
  section.slides[0]!.elements[0]!.style.fill = "#123456";
  const blank = change(section, "blank");
  assert.deepEqual(blank.slides[0]!.elements, [section.slides[0]!.elements[0]!]);
});

test("a large authored image fills the picture slot while a small logo stays where it was", () => {
  const before = deck("blank");
  const logo = normalizeElement({ id: "e_logo01", kind: "image", x: 140, y: 80, w: 80, h: 80, src: "asset:logo" });
  const photo = normalizeElement({ id: "e_photo1", kind: "image", x: 300, y: 200, w: 1100, h: 700, src: "asset:photo", alt: "Photograph" });
  before.slides[0]!.elements = [logo, photo];
  const after = change(before, "image-caption");
  assert.deepEqual(after.slides[0]!.elements.find(element => element.id === logo.id), logo);
  const moved = after.slides[0]!.elements.find(element => element.id === photo.id)!;
  assert.deepEqual(boxes([moved]), boxes([deck("image-caption").slides[0]!.elements[0]!]));
  assert.deepEqual(stripBox(moved), stripBox(photo));
});

test("layout changes leave labels inside custom graphics and add missing body slots", () => {
  const before = deck("blank");
  const title = normalizeElement({ id: "e_heading", kind: "text", x: 130, y: 130, w: 1640, h: 150, text: "A clearer way to present" });
  const body = normalizeElement({ id: "e_body01", kind: "text", x: 136, y: 330, w: 1500, h: 140, text: "A focused workspace for ideas and feedback." });
  const background = normalizeElement({ id: "e_backgr", kind: "shape", shape: "rect", x: 0, y: 0, w: SIZE.width, h: SIZE.height, style: { fill: "#F5F7FB" } });
  const graphics = [140, 690, 1240].map((x, index) => normalizeElement({ id: `e_graph${index}`, kind: "shape", shape: "round-rect", x, y: 610, w: 430, h: 210, style: { fill: ["#4277C5", "#E58D68", "#5C9F89"][index] } }));
  const labels = ["Compose", "Collaborate", "Present"].map((copy, index) => normalizeElement({
    id: `e_label${index}`, kind: "text", x: [190, 730, 1300][index], y: 672, w: [330, 360, 310][index], h: 80,
    text: { paragraphs: [{ runs: [{ text: copy, bold: true, color: "#FFFFFF", size: 40 }] }] },
  }));
  before.slides[0]!.elements = [background, title, body, ...graphics, ...labels];
  const after = change(before, "two-columns");
  const target = deck("two-columns").slides[0]!.elements;
  for (const [original, slot] of [[title, target[0]!], [body, target[1]!]]) {
    const moved = after.slides[0]!.elements.find(element => element.id === original!.id)!;
    assert.deepEqual(boxes([moved]), boxes([slot!]));
    assert.deepEqual(stripBox(moved), stripBox(original!));
  }
  for (const extra of [background, ...graphics, ...labels]) {
    assert.deepEqual(after.slides[0]!.elements.find(element => element.id === extra.id), extra);
  }
  const added = after.slides[0]!.elements.filter(element => !before.slides[0]!.elements.some(original => original.id === element.id));
  assert.equal(added.length, 1);
  assert.deepEqual(boxes(added), boxes([target[2]!]));
  assert.deepEqual(layoutChangeOps(after.slides[0]!, "two-columns", after.theme, after.size), []);
});

test("a picture with a text overlay stays together instead of supplying a new layout's picture slot", () => {
  const before = deck("blank");
  const picture = normalizeElement({ id: "e_picture", kind: "image", x: 200, y: 300, w: 700, h: 500, src: "asset:photo" });
  const label = normalizeElement({ id: "e_caption", kind: "text", x: 260, y: 650, w: 580, h: 80, text: "An overlaid label" });
  before.slides[0]!.elements = [picture, label];
  const after = change(before, "image-caption");
  assert.equal(after.slides[0]!.elements.length, 4);
  assert.deepEqual(after.slides[0]!.elements.filter(element => [picture.id, label.id].includes(element.id)), [picture, label]);
});

test("an empty canonical-looking label inside custom artwork is preserved too", () => {
  const before = deck("title-only");
  const label = before.slides[0]!.elements[0]!;
  const graphic = normalizeElement({ id: "e_planned", kind: "shape", shape: "round-rect", x: label.x - 20, y: label.y - 20, w: label.w + 40, h: label.h + 40, style: { fill: "#4277C5" } });
  before.slides[0]!.elements = [graphic, label];
  assert.deepEqual(change(before, "blank").slides[0]!.elements, before.slides[0]!.elements);
  const columns = change(before, "two-columns");
  assert.deepEqual(columns.slides[0]!.elements.filter(element => [graphic.id, label.id].includes(element.id)), [graphic, label]);
});

test("the entire layout change is one reversible Yjs step and retains authored Y.Text identity", () => {
  const before = deck("title");
  const title = before.slides[0]!.elements[0] as TextElement;
  title.text = richTextFromPlain("Original title");
  const doc = jsonToDoc(before);
  const origin = Symbol("local");
  const undo = new Y.UndoManager([slidesMap(doc), orderArray(doc), deckMap(doc)], { trackedOrigins: new Set([origin]), captureTimeout: 450 });
  const text = getTextField(doc, before.slides[0]!.id, title.id);
  doc.transact(() => text.insert(0, "Typed "), origin);
  const beforeLayout = docToJson(doc);
  undo.stopCapturing();
  doc.transact(() => applyOps(doc, layoutChangeOps(beforeLayout.slides[0]!, "two-columns", before.theme, before.size), undefined, { atomic: false }), origin);
  undo.stopCapturing();
  const afterLayout = docToJson(doc);
  assert.equal(getTextField(doc, before.slides[0]!.id, title.id), text);
  assert.equal(undo.undoStack.length, 2);
  undo.undo();
  assert.deepEqual(docToJson(doc), beforeLayout, "undo restores the layout but keeps the previous typing");
  undo.redo();
  assert.deepEqual(docToJson(doc), afterLayout);
  undo.destroy(); doc.destroy();
});
