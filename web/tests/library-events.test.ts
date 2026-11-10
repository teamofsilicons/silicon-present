import assert from "node:assert/strict";
import { test } from "node:test";
import { watchLibrary } from "../lib/present/library-events";

test("library observers reconcile, reconnect, suspend and release their session", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const document = new EventTarget() as EventTarget & { hidden: boolean };
  document.hidden = false;
  class Source extends EventTarget {
    static opened: Source[] = [];
    closed = false;
    onerror?: () => void;
    constructor(readonly url: string, readonly options: unknown) { super(); Source.opened.push(this); }
    close() { this.closed = true; }
  }
  const previous = { document: globalThis.document, EventSource: globalThis.EventSource };
  Object.assign(globalThis, { document, EventSource: Source });
  t.after(() => Object.assign(globalThis, previous));
  let refreshes = 0;
  const stop = watchLibrary(() => refreshes++);
  const first = Source.opened[0]!;
  assert.equal(first.url, "/api/v1/library/events");
  first.dispatchEvent(new Event("ready"));
  first.dispatchEvent(new Event("library"));
  t.mock.timers.tick(151);
  assert.equal(refreshes, 1, "bursts coalesce into one authorized refetch");
  first.onerror?.();
  assert.equal(first.closed, true);
  t.mock.timers.tick(1201);
  assert.equal(Source.opened.length, 2);
  const replacement = Source.opened[1]!;
  replacement.dispatchEvent(new Event("ready"));
  t.mock.timers.tick(151);
  assert.equal(refreshes, 2, "reconnect reconciles instead of replaying a stale session");
  t.mock.timers.tick(30_000);
  t.mock.timers.tick(151);
  assert.equal(refreshes, 3, "periodic reconciliation covers missed hints");
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(replacement.closed, true);
  t.mock.timers.tick(60_000);
  assert.equal(Source.opened.length, 2);
  document.hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(Source.opened.length, 3);
  stop();
  t.mock.timers.tick(60_000);
  assert.equal(Source.opened[2]!.closed, true);
  assert.equal(refreshes, 3, "unmount cancels timers and refetches");
});
