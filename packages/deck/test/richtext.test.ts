import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { deltaToRichText, richTextToDelta, setPlainText, setRichText, writeRichText, yTextToRichText, normalizeRichText, richTextFromPlain, richTextToPlain } from "../src/index";
import type { RichText } from "../src/index";

function text(): Y.Text {
  const d = new Y.Doc();
  return d.getText("t");
}

test("delta layout: runs carry inline attributes, the paragraph's \\n carries paragraph attributes", () => {
  const rt: RichText = { paragraphs: [{ align: "center", heading: 1, runs: [{ text: "Hi " }, { text: "there", bold: true }] }, { list: "bullet", indent: 1, runs: [{ text: "x", color: "#ff0000" }] }] };
  assert.deepEqual(richTextToDelta(rt), [
    { insert: "Hi " },
    { insert: "there", attributes: { bold: true } },
    { insert: "\n", attributes: { align: "center", heading: 1 } },
    { insert: "x", attributes: { color: "#ff0000" } },
    { insert: "\n", attributes: { list: "bullet", indent: 1 } },
  ]);
  const t = text();
  writeRichText(t, rt);
  assert.deepEqual(yTextToRichText(t), rt);
});

test("reading merged ops and a trailing paragraph without \\n", () => {
  assert.deepEqual(deltaToRichText([{ insert: "a\nb\nc" }]), { paragraphs: [{ runs: [{ text: "a" }] }, { runs: [{ text: "b" }] }, { runs: [{ text: "c" }] }] });
  assert.deepEqual(deltaToRichText([]), { paragraphs: [] });
  assert.deepEqual(deltaToRichText([{ insert: "\n" }]), { paragraphs: [{ runs: [] }] });
});

test("normalize drops false/null attributes, indent 0, empty runs, merges equal neighbours, splits \\n", () => {
  const rt = normalizeRichText({ paragraphs: [{ indent: 0, align: undefined, runs: [{ text: "a", bold: false }, { text: "" }, { text: "b" }, { text: "c\nd", italic: true }] }] } as never);
  assert.deepEqual(rt, { paragraphs: [{ runs: [{ text: "ab" }, { text: "c", italic: true }] }, { runs: [{ text: "d", italic: true }] }] });
  assert.equal(richTextToPlain(richTextFromPlain("one\ntwo")), "one\ntwo");
});

test("setRichText is a minimal diff: concurrent typing outside the changed middle survives", () => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const ta = a.getText("t");
  writeRichText(ta, { paragraphs: [{ runs: [{ text: "Hello brave world" }] }] });
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const tb = b.getText("t");
  // a replaces "brave" with "new"; b concurrently types at the end
  setRichText(ta, { paragraphs: [{ runs: [{ text: "Hello new world" }] }] });
  tb.insert(tb.length - 1, "!");
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  assert.equal(ta.toString(), "Hello new world!\n");
  assert.equal(tb.toString(), ta.toString());
});

test("setRichText changes only formatting when characters are equal", () => {
  const t = text();
  writeRichText(t, { paragraphs: [{ runs: [{ text: "abc" }] }] });
  const target: RichText = { paragraphs: [{ align: "right", runs: [{ text: "a" }, { text: "b", bold: true, size: 40 }, { text: "c" }] }] };
  setRichText(t, target);
  assert.deepEqual(yTextToRichText(t), target);
  const back: RichText = { paragraphs: [{ runs: [{ text: "abc", italic: true }] }] };
  setRichText(t, back);
  assert.deepEqual(yTextToRichText(t), back);
});

test("setRichText handles paragraphs added and removed", () => {
  const t = text();
  const cases: RichText[] = [
    { paragraphs: [] },
    { paragraphs: [{ runs: [] }] },
    { paragraphs: [{ runs: [{ text: "x" }] }, { list: "ordered", runs: [{ text: "y" }] }, { runs: [] }] },
    { paragraphs: [{ list: "ordered", runs: [{ text: "y" }] }] },
    { paragraphs: [{ heading: 2, runs: [{ text: "y", underline: true }, { text: "z" }] }, { runs: [{ text: "🎉 ünï" }] }] },
    { paragraphs: [] },
  ];
  for (const c of cases) {
    setRichText(t, c);
    assert.deepEqual(yTextToRichText(t), c);
  }
});

test("setPlainText minimal diff", () => {
  const t = text();
  setPlainText(t, "<div>hi</div>");
  setPlainText(t, "<div>hello</div>");
  assert.equal(t.toString(), "<div>hello</div>");
  setPlainText(t, "");
  assert.equal(t.toString(), "");
});
