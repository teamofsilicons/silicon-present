import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../lib/errors";
import { toAccess, toDeck, toDeckViewers } from "../lib/present/normalize";
import { getDeckViewers, setPublic } from "../lib/present/sharing";

test("the email requirement is explicit, accepts wire spelling, and defaults off for older responses", () => {
  assert.equal(toDeck({ id: "deck", requireEmail: true }).requireEmail, true);
  assert.equal(toDeck({ deck: { id: "deck", require_email: true } }).requireEmail, true);
  assert.equal(toAccess({ access: { requireEmail: true } }).requireEmail, true);
  assert.equal(toAccess({ require_email: false }).requireEmail, false);
  assert.equal(toAccess({}).requireEmail, false);
  assert.equal(toDeck({ requireEmail: "false" }).requireEmail, false);
});

test("viewer provenance stays explicit and history is displayed newest first", () => {
  assert.deepEqual(toDeckViewers({ viewers: [
    { email: "visitor@example.test", source: "entered", first_viewed_at: "2026-10-24T10:00:00Z", last_viewed_at: "2026-10-24T10:30:00Z", views: "2" },
    { email: "account@example.test", source: "account", firstViewedAt: "2026-10-24T10:00:00Z", lastViewedAt: "2026-10-24T11:30:00Z", views: 3 },
  ] }), [
    { email: "account@example.test", source: "account", firstViewedAt: "2026-10-24T10:00:00Z", lastViewedAt: "2026-10-24T11:30:00Z", views: 3 },
    { email: "visitor@example.test", source: "entered", firstViewedAt: "2026-10-24T10:00:00Z", lastViewedAt: "2026-10-24T10:30:00Z", views: 2 },
  ]);
  assert.deepEqual(toDeckViewers({ viewers: [null, {}, { email: "" }, { email: 123 }, { email: "unknown@example.test", source: "verified", views: -2 }] }), [
    { email: "unknown@example.test", source: "entered", firstViewedAt: null, lastViewedAt: null, views: 0 },
  ], "unknown provenance must not claim an account email");
  assert.deepEqual(toDeckViewers({ viewers: [] }), []);
});

test("changing public mode preserves the email setting unless explicitly supplied", async context => {
  const requests: { url: string; method: string | undefined; body: unknown }[] = [];
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 204 });
  });
  await setPublic("deck/one", "off");
  await setPublic("deck/one", "comment", true);
  await setPublic("deck/one", "edit", false);
  assert.deepEqual(requests, [
    { url: "/api/v1/decks/deck%2Fone/public", method: "PUT", body: { mode: "off" } },
    { url: "/api/v1/decks/deck%2Fone/public", method: "PUT", body: { mode: "comment", requireEmail: true } },
    { url: "/api/v1/decks/deck%2Fone/public", method: "PUT", body: { mode: "edit", requireEmail: false } },
  ]);
});

test("viewer history uses the protected same-origin endpoint and propagates owner-only refusals", async context => {
  const controller = new AbortController();
  let allowed = true;
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "/api/v1/decks/deck%2Fone/viewers");
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.signal, controller.signal);
    return Response.json(allowed ? { viewers: [{ email: "visitor@example.test", source: "entered", views: 1 }] }
      : { error: { code: "forbidden", message: "Only the owner can see viewers." } }, { status: allowed ? 200 : 403 });
  });
  assert.equal((await getDeckViewers("deck/one", controller.signal))[0]?.source, "entered");
  allowed = false;
  await assert.rejects(getDeckViewers("deck/one", controller.signal), error => error instanceof ApiError && error.status === 403);
});
