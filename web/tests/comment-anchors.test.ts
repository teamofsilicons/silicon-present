import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDeck, type Element } from "@silicon-present/deck";
import { areaAnchorFractions, placeAnchor } from "../lib/editor/comment-anchors";
import type { Anchor } from "../lib/editor/types";

function element(overrides: Partial<Element> = {}): Element {
  return normalizeDeck({ slides: [{ elements: [{ kind: "shape", id: "e_anchor", x: 100, y: 200, w: 200, h: 100, rotation: 90, ...overrides }] }] }).slides[0]!.elements[0]!;
}

function nearPoint(actual: { x: number; y: number }, expected: { x: number; y: number }) {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-8, `x: ${actual.x} != ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-8, `y: ${actual.y} != ${expected.y}`);
}

test("a point inside an element follows its rotation and later moves and resizes", () => {
  const target = element();
  const anchor: Anchor = { kind: "point", slide: "s_one", x: 1, y: 2, element: target.id, ex: 0, ey: 0 };
  nearPoint(placeAnchor(anchor, [target])!.pin, { x: 250, y: 150 });
  nearPoint(placeAnchor(anchor, [{ ...target, x: 300, y: 400, w: 400, h: 200 }])!.pin, { x: 600, y: 300 });
  assert.equal(placeAnchor(anchor, [target])!.area, null);
});

test("an area dragged over a rotated element does not jump on release", () => {
  const target = element();
  const area = { x: 120, y: 220, w: 60, h: 40 };
  const fractions = areaAnchorFractions(target, area);
  assert.deepEqual(fractions, { ex: 0.1, ey: 0.2, ew: 0.3, eh: 0.4 });
  const anchor: Anchor = { kind: "area", slide: "s_one", element: target.id, ...area, ...fractions };
  assert.deepEqual(placeAnchor(anchor, [target]), { pin: { x: 180, y: 220 }, area });
  assert.deepEqual(placeAnchor(anchor, [{ ...target, x: 300, y: 400, w: 400, h: 200 }]), {
    pin: { x: 460, y: 440 }, area: { x: 340, y: 440, w: 120, h: 80 },
  });
});

test("an area crossing its target's bounds is preserved instead of clamped", () => {
  const target = element();
  const area = { x: 50, y: 150, w: 300, h: 200 };
  const fractions = areaAnchorFractions(target, area);
  assert.deepEqual(fractions, { ex: -0.25, ey: -0.5, ew: 1.5, eh: 2 });
  assert.deepEqual(placeAnchor({ kind: "area", slide: "s_one", element: target.id, ...area, ...fractions }, [target]), {
    pin: { x: 350, y: 150 }, area,
  });
});

test("element and text anchors outline the rotated object and pin its rotated top-right corner", () => {
  const target = element();
  const anchors: Anchor[] = [
    { kind: "element", slide: "s_one", element: target.id },
    { kind: "text", slide: "s_one", element: target.id, field: "text", quote: "Selected words" },
  ];
  for (const anchor of anchors) {
    const placed = placeAnchor(anchor, [target])!;
    nearPoint(placed.pin, { x: 250, y: 350 });
    assert.deepEqual(placed.area, { x: 100, y: 200, w: 200, h: 100, rotation: 90 });
    const moved = placeAnchor(anchor, [{ ...target, x: 300, y: 400, w: 400, h: 200, rotation: 0 }])!;
    assert.deepEqual(moved, { pin: { x: 700, y: 400 }, area: { x: 300, y: 400, w: 400, h: 200, rotation: 0 } });
  }
});

test("deleted elements leave point and area anchors at their saved slide coordinates", () => {
  const point: Anchor = { kind: "point", slide: "s_one", element: "e_gone", x: 25, y: 35, ex: 0.5, ey: 0.5 };
  const area: Anchor = { kind: "area", slide: "s_one", element: "e_gone", x: 25, y: 35, w: 45, h: 55, ex: 0.5, ey: 0.5, ew: 0.2, eh: 0.3 };
  assert.deepEqual(placeAnchor(point, []), { pin: { x: 25, y: 35 }, area: null });
  assert.deepEqual(placeAnchor(area, []), { pin: { x: 70, y: 35 }, area: { x: 25, y: 35, w: 45, h: 55 } });
  assert.equal(placeAnchor({ kind: "element", slide: "s_one", element: "e_gone" }, []), null);
  assert.equal(placeAnchor({ kind: "text", slide: "s_one", element: "e_gone", field: "text", quote: "Gone" }, []), null);
});

test("older point and area anchors without relative coordinates keep their absolute placement", () => {
  const target = element();
  assert.deepEqual(placeAnchor({ kind: "point", slide: "s_one", element: target.id, x: 25, y: 35 }, [target]), {
    pin: { x: 25, y: 35 }, area: null,
  });
  assert.deepEqual(placeAnchor({ kind: "area", slide: "s_one", element: target.id, x: 25, y: 35, w: 45, h: 55 }, [target]), {
    pin: { x: 70, y: 35 }, area: { x: 25, y: 35, w: 45, h: 55 },
  });
  assert.deepEqual(placeAnchor({ kind: "area", slide: "s_one", element: target.id, x: 25, y: 35, w: 60, h: 40, ex: 0.1, ey: 0.2 }, [target]), {
    pin: { x: 180, y: 220 }, area: { x: 120, y: 220, w: 60, h: 40 },
  });
});

test("deck and slide comments do not create a canvas marker", () => {
  assert.equal(placeAnchor({ kind: "deck" }, [element()]), null);
  assert.equal(placeAnchor({ kind: "slide", slide: "s_one" }, [element()]), null);
});
