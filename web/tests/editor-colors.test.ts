import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDeck, normalizeRichText } from "@silicon-present/deck";
import { renderElementHtml } from "@silicon-present/render";
import { commonTextColor, documentSwatches, elementFillColor, elementTextColor, normalizeHexColor, recentColors, uniqueSwatches } from "../lib/editor/colors";

test("hex entry expands short colours and alpha without accepting incomplete or arbitrary CSS", () => {
  assert.equal(normalizeHexColor(" abc "), "#AABBCC");
  assert.equal(normalizeHexColor("#1234"), "#11223344");
  assert.equal(normalizeHexColor("#1f5fb8"), "#1F5FB8");
  assert.equal(normalizeHexColor("123456ab"), "#123456AB");
  for (const input of ["", "#", "#12", "#12345", "#1234567", "#123456789", "red", "rgb(0,0,0)", "url(https://example.com)"]) {
    assert.equal(normalizeHexColor(input), null, input);
  }
});

test("recent colours move the selected colour to the front, deduplicate and bound persisted data", () => {
  assert.deepEqual(recentColors(["#aabbcc", "#abc", "red", null, "#123456"], "#123"), ["#112233", "#AABBCC", "#123456"]);
  assert.deepEqual(recentColors({ color: "#123" }, "#fff"), ["#FFFFFF"]);
  assert.equal(recentColors(Array.from({ length: 20 }, (_, i) => `#${i.toString(16).padStart(6, "0")}`)).length, 8);
  assert.deepEqual(uniqueSwatches([{ color: "#fff", name: "First" }, { color: "#FFFFFF", name: "Duplicate" }, { color: null, name: "None" }]), [{ color: "#fff", name: "First" }]);
});

test("document palette includes backgrounds, master, text, cells and chart colours without embedded content", () => {
  const deck = normalizeDeck({
    master: { elements: [{ kind: "shape", style: { stroke: "#123" } }] },
    slides: [{
      background: { color: "#345678" },
      elements: [
        { kind: "text", style: { fill: "#123456" }, text: { paragraphs: [{ runs: [{ text: "Hello", color: "#ABC", highlight: "#fedcba" }] }] } },
        { kind: "table", rows: 1, cols: 1, cells: [[{ fill: "#AABBCC", text: { paragraphs: [{ runs: [{ text: "Cell", color: "#654321" }] }] } }]] },
        { kind: "chart", chart: { series: [{ name: "Series", values: [1], color: "#987654" }] } },
        { kind: "html", html: "<p style='color:#111111'>HTML</p>", css: "p{color:#222222}" },
      ],
    }],
  });
  const palette = documentSwatches(deck, [{ color: "#112233", name: "Theme" }]);
  assert.deepEqual(palette.map(swatch => swatch.color), ["#345678", "#123456", "#ABC", "#fedcba", "#654321", "#987654"]);
});

test("text colour distinguishes theme defaults and mixed runs while ignoring empty text", () => {
  const rich = (runs: { text: string; color?: string }[]) => normalizeRichText({ paragraphs: [{ runs }] });
  assert.equal(commonTextColor([rich([{ text: "one" }, { text: "two" }])]), null);
  assert.equal(commonTextColor([rich([{ text: "one", color: "#abc" }, { text: "two", color: "#AABBCC" }])]), "#AABBCC");
  assert.equal(commonTextColor([rich([{ text: "one", color: "#abc" }, { text: "two" }])]), undefined);
  assert.equal(commonTextColor([rich([{ text: "", color: "#123" }, { text: "two", color: "#fff" }])]), "#FFFFFF");
  assert.equal(commonTextColor([rich([{ text: "one", color: "#abc" }]), rich([{ text: "two", color: "#def" }])]), undefined);
});

test("shape defaults show their rendered fill and text contrast, and None stays unfilled", () => {
  const deck = normalizeDeck({ slides: [{ elements: [
    { kind: "shape", text: "A dark shape" },
    { kind: "shape", style: { fill: "transparent" }, text: "No fill" },
    { kind: "shape", style: { stroke: "#123456" }, text: "Border only" },
    { kind: "shape", shape: "line" },
  ] }] });
  const [filled, transparent, outline, line] = deck.slides[0]!.elements;
  assert.equal(elementFillColor(filled!, deck.theme), deck.theme.colors.accent);
  assert.equal(elementFillColor(transparent!, deck.theme), null);
  assert.equal(elementFillColor(outline!, deck.theme), null);
  assert.equal(elementFillColor(line!, deck.theme), null);
  assert.match(renderElementHtml(transparent!, deck.theme), /fill="transparent"/);
  assert.equal(elementTextColor(transparent!, deck.theme), deck.theme.colors.text);
  for (const element of deck.slides[0]!.elements.slice(0, 3)) {
    assert.ok(renderElementHtml(element, deck.theme).includes(`color:${elementTextColor(element, deck.theme)}`));
  }
});
