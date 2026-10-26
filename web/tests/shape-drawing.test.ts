import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_THEME, normalizeElement } from "@silicon-present/deck";
import { fromElementFraction } from "../lib/editor/geometry";
import { drawnShape } from "../lib/editor/shape-drawing";

const start = { x: 200, y: 300 };
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test("drawing requires a real drag in screen pixels at every zoom", () => {
  for (const scale of [0.1, 0.4, 1, 3]) {
    assert.equal(drawnShape("rect", start, start, false, DEFAULT_THEME, scale), null);
    assert.equal(drawnShape("rect", start, { x: start.x + 2 / scale, y: start.y }, false, DEFAULT_THEME, scale), null);
    assert.ok(drawnShape("rect", start, { x: start.x + 4 / scale, y: start.y }, false, DEFAULT_THEME, scale));
  }
  assert.equal(drawnShape("line", start, { x: Infinity, y: 0 }, false, DEFAULT_THEME, 1), null);
});

test("closed shapes follow any drag direction and Shift keeps the starting corner", () => {
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const end = { x: start.x + 120 * sx, y: start.y + 80 * sy };
    const rectangle = drawnShape("rect", start, end, false, DEFAULT_THEME, 1)!;
    assert.deepEqual([rectangle.x, rectangle.y, rectangle.w, rectangle.h], [Math.min(start.x, end.x), Math.min(start.y, end.y), 120, 80]);
    const circle = drawnShape("ellipse", start, end, true, DEFAULT_THEME, 1)!;
    assert.deepEqual([circle.x, circle.y, circle.w, circle.h], [start.x + Math.min(0, 120 * sx), start.y + Math.min(0, 120 * sy), 120, 120]);
  }
});

test("the renderer's diagonal line path lands on exact endpoints in every direction", () => {
  for (const [dx, dy] of [[100, 0], [-100, 0], [0, 100], [0, -100], [150, 90], [-150, 90], [150, -90], [-150, -90], [1.2, 0.1]]) {
    const end = { x: start.x + dx!, y: start.y + dy! };
    const line = normalizeElement(drawnShape("line", start, end, false, DEFAULT_THEME, 3)!);
    assert.ok(line.w > 0 && line.h > 0);
    const a = fromElementFraction(line, 0, 0);
    const b = fromElementFraction(line, 1, 1);
    close(a.x, start.x); close(a.y, start.y); close(b.x, end.x); close(b.y, end.y);
  }
});

test("Shift lines snap to 45 degree directions while keeping their length and start", () => {
  for (const degrees of [-179, -130, -91, -47, -2, 23, 70, 136, 179]) {
    const angle = degrees * Math.PI / 180;
    const end = { x: start.x + 160 * Math.cos(angle), y: start.y + 160 * Math.sin(angle) };
    const line = normalizeElement(drawnShape("line", start, end, true, DEFAULT_THEME, 1)!);
    const a = fromElementFraction(line, 0, 0);
    const b = fromElementFraction(line, 1, 1);
    const expected = Math.round(angle / (Math.PI / 4)) * Math.PI / 4;
    close(a.x, start.x); close(a.y, start.y);
    close(b.x, start.x + 160 * Math.cos(expected)); close(b.y, start.y + 160 * Math.sin(expected));
    close(Math.hypot(b.x - a.x, b.y - a.y), 160);
  }
});
