// Cross-language contract: the TS and Rust deck models agree on the Yjs layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import { docToJson, jsonToDoc } from "../src/index";
import { CONTRACT_DIR, fixtures, tsUpdate } from "./make-fixtures";

const names = readdirSync(CONTRACT_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

test("contract fixtures exist and match the generator", () => {
  const gen = fixtures();
  assert.ok(names.length >= 4);
  for (const [name, json] of Object.entries(gen)) {
    const onDisk = JSON.parse(readFileSync(join(CONTRACT_DIR, `${name}.json`), "utf8"));
    assert.deepEqual(onDisk, json, `${name}.json is stale; run test/make-fixtures.ts`);
  }
});

for (const name of names) {
  const json = JSON.parse(readFileSync(join(CONTRACT_DIR, `${name}.json`), "utf8"));

  test(`${name}: json -> doc -> update -> doc -> json is exact`, () => {
    const update = Y.encodeStateAsUpdate(jsonToDoc(json));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    assert.deepEqual(docToJson(doc), json);
  });

  test(`${name}: the committed .ts.yupdate decodes to the json`, () => {
    const file = join(CONTRACT_DIR, `${name}.ts.yupdate`);
    assert.ok(existsSync(file), `${file} missing; run test/make-fixtures.ts`);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(readFileSync(file)));
    assert.deepEqual(docToJson(doc), json);
    // and TS still produces the same bytes (clientID 1), so Rust tests a stable file
    assert.deepEqual(Buffer.from(tsUpdate(json)), readFileSync(file));
  });

  const rust = join(CONTRACT_DIR, `${name}.rust.yupdate`);
  test(`${name}: the Rust-made .rust.yupdate decodes to the json`, { skip: existsSync(rust) ? false : `${name}.rust.yupdate not there yet (made by crates/present-deck)` }, () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(readFileSync(rust)));
    assert.deepEqual(docToJson(doc), json);
  });
}
