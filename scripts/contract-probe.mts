/**
 * Broader differential coverage alongside the independently expected contract fixtures.
 * Fixed input corpus plus seed 42: canonical writers, raw Yjs readers, and rich-text edits.
 * Run separately: pnpm --filter @silicon-present/deck exec tsx ../../scripts/contract-probe.mts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  Y, DeckError, applyOps, deckMap, docToJson, encodeDoc, getElementMap, getSlideMap,
  getTextField, jsonToDoc,
} from "../packages/deck/src/index.ts";
import type { DeckInput, Op } from "../packages/deck/src/index.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const values: unknown[] = [
  null, false, true, "", "12", " 1e3 ", "0x10", "+1", ".5", "1.", "1e400", 0, -0,
  2.5, -1, 1e-7, 1e21, 9007199254740993n, [], [null], {}, { x: 1 }, "İ😀",
  { series: [null, false, [], {}, { name: 42, values: ["3", null, "bad"] }], labels: [{}, true, null, 42] },
  { paragraphs: [null, {}, false, { runs: [null, { text: 42, size: "40", bold: "yes" }] }] },
];
const kinds = ["text", "shape", "image", "video", "audio", "table", "chart", "html"];
type Outcome = { json: unknown } | { error: string };
type Probe = { name: string; request: Record<string, unknown>; expected: Outcome };
const probes: Probe[] = [];

function raw(name: string, doc: Y.Doc): void {
  probes.push({
    name: `read ${name}`,
    request: { decode: Buffer.from(encodeDoc(doc)).toString("base64") },
    expected: { json: docToJson(doc) },
  });
  doc.destroy();
}
function writer(name: string, input: unknown, ops?: Op[]): void {
  let expected: Outcome;
  let doc: Y.Doc | undefined;
  try {
    doc = jsonToDoc(input as DeckInput);
    if (ops) applyOps(doc, ops);
    expected = { json: docToJson(doc) };
  } catch (error) {
    if (!(error instanceof DeckError)) throw error;
    expected = { error: error.code };
  } finally {
    doc?.destroy();
  }
  probes.push({
    name: `write ${name}`,
    request: ops ? { name, start: input, ops } : { name, input },
    expected,
  });
}

for (const kind of kinds) {
  const ownFields = kind === "table" ? ["rows", "cols", "colWidths", "cells"]
    : kind === "chart" ? ["chart"] : kind === "shape" ? ["shape", "text"]
    : kind === "text" ? ["text"] : kind === "html" ? ["html", "css", "js"] : ["src", "alt"];
  const start = { slides: [{ id: "s", elements: [{ id: "e", kind }] }] };
  for (const field of ["x", "w", "style", "animation", "group", "locked", ...ownFields]) {
    for (const [index, value] of values.entries()) {
      const name = `${kind}.${field}[${index}]`;
      const doc = jsonToDoc(start as DeckInput);
      getElementMap(doc, "s", "e").set(field, value);
      raw(name, doc);
      // JSON input cannot carry BigInt; the corresponding writer input is its float64 value.
      const inputValue = typeof value === "bigint" ? Number(value) : value;
      writer(name, { slides: [{ id: "s", elements: [{ id: "e", kind, [field]: inputValue }] }] });
      writer(`update ${name}`, start, [{ op: "update_element", slide: "s", element: "e", set: { [field]: inputValue } }]);
    }
  }
}
for (const field of ["size", "theme"]) {
  for (const [index, value] of values.entries()) {
    const name = `deck.${field}[${index}]`, doc = jsonToDoc({});
    deckMap(doc).set(field, value);
    raw(name, doc);
    const inputValue = typeof value === "bigint" ? Number(value) : value;
    writer(name, { [field]: inputValue });
    writer(`update ${name}`, {}, [{ op: "update_deck", set: { [field]: inputValue } }]);
  }
}
for (const field of ["notes", "layout", "background", "transition", "skipped", "section"]) {
  for (const [index, value] of values.entries()) {
    const name = `slide.${field}[${index}]`, doc = jsonToDoc({ slides: [{ id: "s" }] });
    getSlideMap(doc, "s").set(field, value);
    raw(name, doc);
    const inputValue = typeof value === "bigint" ? Number(value) : value;
    writer(name, { slides: [{ id: "s", [field]: inputValue }] });
    writer(`update ${name}`, { slides: [{ id: "s" }] }, [{ op: "update_slide", slide: "s", set: { [field]: inputValue } }]);
  }
}

// Root shape validation uses the same corpus; null is valid for optional fields but not for a deck.
for (const [index, value] of values.entries()) {
  writer(`deck root[${index}]`, typeof value === "bigint" ? Number(value) : value);
}

let seed = 42;
function random(limit: number): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % limit;
}
const alphabet = ["a", "b", "c", "😀", "İ", "Σ", " ", "\n"];
for (let sample = 0; sample < 600; sample++) {
  let chars = "";
  for (let j = 0; j < 5 + random(18); j++) chars += alphabet[random(alphabet.length)];
  const paragraphs = chars.split("\n").map((paragraph, index) => ({
    ...(index % 2 ? { align: "center", list: "bullet" } : {}),
    runs: Array.from(paragraph, (character, run) => ({
      text: character,
      ...(run % 3 === 0 ? { bold: true } : run % 3 === 1 ? { italic: true } : { color: "#123456" }),
    })),
  }));
  const start = { slides: [{ id: "s", elements: [{ id: "e", kind: "text", text: { paragraphs } }] }] };
  const doc = jsonToDoc(start as DeckInput);
  const points = Array.from(getTextField(doc, "s", "e").toString());
  doc.destroy();
  const begin = random(points.length), end = begin + 1 + random(points.length - begin);
  const find = points.slice(begin, end).join("");
  let replacement = "";
  for (let j = 0; j < random(15); j++) replacement += alphabet[random(alphabet.length)];
  writer(`rich replacement[${sample}]`, start, [{ op: "replace_text", slide: "s", element: "e", find, replace: replacement, all: true }]);
}

const bridge = spawnSync("cargo", ["run", "--quiet", "-p", "present-deck", "--example", "contract_bridge"], {
  cwd: root,
  input: JSON.stringify(probes.map(probe => probe.request)),
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, CARGO_TARGET_DIR: resolve(root, "target"), CARGO_BUILD_JOBS: "4", CARGO_INCREMENTAL: "0" },
});
assert.equal(bridge.status, 0, bridge.stderr);
const outcomes = JSON.parse(bridge.stdout) as Array<{ json?: unknown; error?: string }>;
assert.equal(outcomes.length, probes.length, "The Rust bridge must answer every case.");
const failures = probes.flatMap((probe, index) => {
  const rust = outcomes[index]!;
  const outcome: Outcome = rust.error ? { error: rust.error } : { json: rust.json };
  return isDeepStrictEqual(outcome, probe.expected) ? [] : [{ name: probe.name, typescript: probe.expected, rust: outcome }];
});
assert.equal(failures.length, 0, `${failures.length} differential failures:\n${JSON.stringify(failures.slice(0, 10), null, 2)}`);
console.log(`Contract probe passed: ${probes.length} cases (raw readers, strict writers, edits; random seed 42).`);
