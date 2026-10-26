import assert from "node:assert/strict";
import { test } from "node:test";
import { cssColorToHex, markParts, movedTranslate, partNames, partRange, safeColor, safeStyleSet, scanTags, setStyleValues, styleValue } from "../lib/editor/html-inside";

test("parts are numbered by start tag in source order, skipping comments, doctypes and raw text", () => {
  const src = `<!doctype html><!-- <b>no</b> --><div class="a>b" title='x'><h1>Hi</h1><img src="x.png"><style>p > a { }</style><script>if (a < b) "<p>"</script><p>Body</p></div>`;
  assert.equal(partNames(src), "div h1 img style script p");
  const marked = markParts(src);
  assert.match(marked, /<div data-sp-part="0" class="a>b" title='x'>/);
  assert.match(marked, /<h1 data-sp-part="1">Hi<\/h1>/);
  assert.match(marked, /<img data-sp-part="2" src="x.png">/);
  assert.match(marked, /<script data-sp-part="4">if \(a < b\) "<p>"<\/script>/);
  assert.match(marked, /<p data-sp-part="5">Body<\/p>/);
});

test("a part's range finds its own end tag through nesting, and none when it is left implied", () => {
  const src = `<div><div>in</div><br/>tail</div><p>open`;
  const tags = scanTags(src);
  const outer = partRange(tags, 0)!;
  assert.equal(src.slice(outer.innerStart, outer.innerEnd), "<div>in</div><br/>tail");
  assert.equal(src.slice(outer.tag.start, outer.end), "<div><div>in</div><br/>tail</div>");
  const br = partRange(tags, 2)!;
  assert.equal(br.innerStart, br.innerEnd);
  assert.equal(partRange(tags, 3), null);
  assert.equal(partRange(tags, 9), null);
});

test("style attributes change one property and keep the others as written", () => {
  const style = "color: red; background: url('a;b.png'); font-size:12px !important";
  assert.equal(styleValue(style, "font-size"), "12px");
  assert.equal(styleValue(style, "background"), "url('a;b.png')");
  assert.equal(setStyleValues(style, { color: "#00FF00" }), "background: url('a;b.png'); font-size:12px !important; color: #00FF00");
  assert.equal(setStyleValues("color: red", { color: null }), "");
  assert.equal(setStyleValues("", { translate: "4px 5px" }), "translate: 4px 5px");
});

test("only the toolbar's properties and plain values may be written", () => {
  assert.deepEqual(safeStyleSet({ color: "#ABCDEF", "font-size": "48px", "font-weight": "bold", "font-style": "italic", "background-color": "transparent" }), { color: "#ABCDEF", "font-size": "48px", "font-weight": "bold", "font-style": "italic", "background-color": "transparent" });
  assert.deepEqual(safeStyleSet({ color: "red;position:fixed", "background-color": "url(javascript:x)", position: "fixed", "font-size": "1e9px", translate: "1px 2px" }), { translate: "1px 2px" });
  assert.deepEqual(safeStyleSet({ color: null }), { color: null });
  assert.deepEqual(safeStyleSet("color:red"), {});
  for (const bad of ["expression(alert(1))", "#12", "rgb(0,0,0);x", "</style>", 7]) assert.equal(safeColor(bad), null, String(bad));
  assert.equal(safeColor("rgba(1, 2, 3, 0.5)"), "rgba(1, 2, 3, 0.5)");
});

test("moving adds to the part's own translate", () => {
  assert.equal(movedTranslate("", 10, -5.26), "10px -5.3px");
  assert.equal(movedTranslate("color:red; translate: 4px 6px", 1, 1), "5px 7px");
  assert.equal(movedTranslate("translate: 3px", 1, 1), "4px 1px");
  assert.equal(movedTranslate("translate: 50%", 2, 2), null);
  assert.equal(movedTranslate("translate: none", 2, 2), "2px 2px");
});

test("computed colours turn into hex, transparent into none", () => {
  assert.equal(cssColorToHex("rgb(31, 95, 184)"), "#1F5FB8");
  assert.equal(cssColorToHex("rgba(255, 0, 0, 0.5)"), "#FF000080");
  assert.equal(cssColorToHex("rgba(0, 0, 0, 0)"), null);
  assert.equal(cssColorToHex("red"), null);
  assert.equal(cssColorToHex(null), null);
});
