import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { NextRequest, NextResponse } from "next/server";
import { POST } from "../app/api/viewer-email/route";
import { GET } from "../app/api/[...path]/route";
import { normalizeViewerEmail } from "../lib/viewer-email";
import { viewerEmailCookieName, viewerEmailFromCookie, writeViewerEmail } from "../lib/server/viewer-email";
import { seal } from "../lib/server/seal";
import { forwardRequestHeaders } from "../lib/server/forward";
import { applyTestEnv, json, mockFetch } from "./env";

let restore = () => {};
beforeEach(() => applyTestEnv());
afterEach(() => restore());

test("viewer addresses reject header injection and malformed or oversized input", () => {
  assert.equal(normalizeViewerEmail(" Visitor@Example.com "), "visitor@example.com");
  for (const value of [null, {}, "", "a@b", "a@@b.com", "a b@example.com", "a\r\nb@example.com", `${"x".repeat(250)}@example.com`, "a..b@example.com", ".a@example.com", "a.@example.com", "a@-bad.com", "a@bad-.com", "a@b..com", `${"x".repeat(65)}@example.com`, `a@${"x".repeat(64)}.com`]) assert.equal(normalizeViewerEmail(value), null);
  assert.equal(normalizeViewerEmail("a+b@sub.example.com"), "a+b@sub.example.com");
});

test("anonymous submission writes a sealed HttpOnly cookie and never an authentication cookie", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1:4260/api/viewer-email", { method: "POST", headers: { origin: "http://127.0.0.1:4260" }, body: JSON.stringify({ email: "Guest@Example.com" }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const cookie = response.cookies.get(viewerEmailCookieName());
  assert.equal(viewerEmailFromCookie(cookie?.value), "guest@example.com");
  assert.equal(response.cookies.get("present_session"), undefined);
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(response.headers.get("set-cookie")!, /SameSite=lax/i);
  assert.ok(!response.headers.get("set-cookie")!.includes("guest"));
});

test("viewer cookie rejects tampering, expiration and the authentication cookie's purpose", () => {
  const response = NextResponse.json({});
  writeViewerEmail(response, "guest@example.com");
  const value = response.cookies.get(viewerEmailCookieName())!.value;
  assert.equal(viewerEmailFromCookie(`${value}bad`), null);
  assert.equal(viewerEmailFromCookie(value, Date.now() + 25 * 60 * 60 * 1000), null);
  assert.equal(viewerEmailFromCookie(seal({ email: "guest@example.com", expires: Date.now() + 100000 }, "session")), null);
});

test("submission rejects cross-site requests, invalid addresses and unbounded bodies", async () => {
  for (const [origin, body, status] of [["https://elsewhere.example", '{"email":"guest@example.com"}', 403], ["http://127.0.0.1:4260", '{"email":"bad"}', 400], ["http://127.0.0.1:4260", "x".repeat(2049), 413]] as const) {
    const response = await POST(new NextRequest("http://127.0.0.1:4260/api/viewer-email", { method: "POST", headers: { origin }, body }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("public API reads forward only the sealed visitor email and preserve email_required without sign-out", async () => {
  const mock = mockFetch(() => json(403, { error: { code: "email_required", message: "Enter an email." } }));
  restore = mock.restore;
  const cookieResponse = NextResponse.json({});
  writeViewerEmail(cookieResponse, "guest@example.com");
  const cookie = cookieResponse.cookies.get(viewerEmailCookieName())!;
  const response = await GET(new NextRequest("http://127.0.0.1:4260/api/v1/decks/d1/live", { headers: { cookie: `${cookie.name}=${cookie.value}`, "x-present-viewer-email": "forged@example.com" } }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "email_required");
  assert.equal(response.headers.get("set-cookie"), null);
  const outgoing = new Headers(mock.calls[0]!.init.headers);
  assert.equal(outgoing.get("x-present-viewer-email"), "guest@example.com");
  assert.equal(outgoing.get("authorization"), null);
  assert.equal(outgoing.get("cookie"), null);
  const untrusted = forwardRequestHeaders(new Headers({ "x-present-viewer-email": "forged@example.com" }), null, {}, ["x-present-viewer-email"]);
  assert.equal(untrusted.get("x-present-viewer-email"), null);
});
