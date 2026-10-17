#!/usr/bin/env node
// Silicon Ting stand-in for tests and end-to-end runs. It speaks Ting's current contract (0.3) closely enough for
// Silicon Present to deliver to it, and records everything it receives so tests can read it back.
//
//   POST /v1/subscriptions   Authorization: Bearer sap_… (User verification proof, scope subscriptions.register)
//                            { "app_id": "present", "for": "<uuid>" } → 201 { id }  (200 with the same id if it exists)
//   POST /v1/tings           Authorization: Bearer sap_… (App verification proof, scope tings.send)
//                            { type, for, key, data, metadata } → 201 { id }; the same key with the same content → 200
//                            with the first id; the same key with different content → 409 idempotency_conflict.
//                            Unknown fields → 400; over 256 KiB → 413.
//
// Proofs are checked with POST {ACCOUNTS_API_URL}/v1/proofs/verify using the `ting` app's credentials
// (TING_APP_ID / TING_APP_SECRET). With TING_VERIFY=off proofs are accepted without checking (unit tests).
//
// For tests:
//   GET    /_tings[?for=<uuid>&type=<type>]   every ting received, oldest first
//   GET    /_subscriptions                    every subscription
//   DELETE /_tings                            forget everything
//   POST   /_fail { "count": N, "status": 503 } the next N calls to /v1/tings fail with that status
//   GET    /health
//
// Env: TING_PORT (default 4323), TING_HOST (127.0.0.1), ACCOUNTS_API_URL, TING_APP_ID (ting), TING_APP_SECRET,
// TING_VERIFY (on). No dependencies: node tools/ting-standin/server.mjs

import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.TING_PORT ?? 4323);
const HOST = process.env.TING_HOST ?? "127.0.0.1";
const ACCOUNTS = (process.env.ACCOUNTS_API_URL ?? "http://127.0.0.1:9741").replace(/\/$/, "");
const APP_ID = process.env.TING_APP_ID ?? "ting";
const APP_SECRET = process.env.TING_APP_SECRET ?? "";
const VERIFY = (process.env.TING_VERIFY ?? "on") !== "off";
const MAX_BODY = 256 * 1024;

const tings = [];
const subscriptions = [];
let failNext = { count: 0, status: 503 };

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function error(res, status, code, message, hint) {
  send(res, status, { error: { code, message, hint } });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) return { tooLarge: true };
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return { json: {} };
  try {
    return { json: JSON.parse(raw) };
  } catch {
    return { invalid: true };
  }
}

async function verifyProof(req, scope) {
  const auth = req.headers.authorization ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) return { ok: false, code: "unauthorized", message: "The request has no `Authorization: Bearer sap_…` proof." };
  if (!VERIFY) return { ok: true, proof: { issuing_app: "present", scopes: [scope] } };
  try {
    const r = await fetch(`${ACCOUNTS}/v1/proofs/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Basic " + Buffer.from(`${APP_ID}:${APP_SECRET}`).toString("base64"),
      },
      body: JSON.stringify({ proof_token: m[1] }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.valid !== true) {
      return { ok: false, code: "invalid_proof", message: `Silicon Accounts says the proof isn't valid (${r.status}).`, detail: body };
    }
    const scopes = body.scopes ?? body.proof?.scopes ?? [];
    if (Array.isArray(scopes) && scopes.length && !scopes.includes(scope)) {
      return { ok: false, code: "insufficient_scope", message: `The proof doesn't carry the ${scope} scope.` };
    }
    return { ok: true, proof: body };
  } catch (e) {
    return { ok: false, code: "accounts_unreachable", message: `The stand-in couldn't reach Silicon Accounts: ${e.message}`, status: 503 };
  }
}

const stable = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true, service: "ting-standin", verify: VERIFY });
    if (req.method === "GET" && path === "/_tings") {
      const f = url.searchParams.get("for");
      const t = url.searchParams.get("type");
      return send(res, 200, { tings: tings.filter((x) => (!f || x.for === f) && (!t || x.type === t)) });
    }
    if (req.method === "GET" && path === "/_subscriptions") return send(res, 200, { subscriptions });
    if (req.method === "DELETE" && path === "/_tings") {
      tings.length = 0;
      subscriptions.length = 0;
      failNext = { count: 0, status: 503 };
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/_fail") {
      const { json } = await readBody(req);
      failNext = { count: Number(json?.count ?? 1), status: Number(json?.status ?? 503) };
      return send(res, 200, failNext);
    }
    if (req.method === "POST" && path === "/v1/subscriptions") {
      const body = await readBody(req);
      if (body.invalid) return error(res, 400, "invalid_json", "The body isn't JSON.", "Send { app_id, for }.");
      const v = await verifyProof(req, "subscriptions.register");
      if (!v.ok) return error(res, v.status ?? 401, v.code, v.message, "Issue a User verification proof for ting with scope subscriptions.register.");
      const { app_id, for: who } = body.json;
      if (typeof app_id !== "string" || typeof who !== "string") return error(res, 400, "invalid_request", "A subscription needs app_id and for.", "Send { app_id, for }.");
      const existing = subscriptions.find((s) => s.app_id === app_id && s.for === who);
      if (existing) return send(res, 200, existing);
      const sub = { id: crypto.randomUUID(), app_id, for: who, created_at: new Date().toISOString() };
      subscriptions.push(sub);
      return send(res, 201, sub);
    }
    if (req.method === "POST" && path === "/v1/tings") {
      if (failNext.count > 0) {
        failNext.count -= 1;
        return error(res, failNext.status, "unavailable", "The stand-in was told to fail this call.", "Retry later.");
      }
      const body = await readBody(req);
      if (body.tooLarge) return error(res, 413, "payload_too_large", "A ting can be at most 256 KiB.", "Send less data.");
      if (body.invalid) return error(res, 400, "invalid_json", "The body isn't JSON.", "Send { type, for, key, data, metadata }.");
      const v = await verifyProof(req, "tings.send");
      if (!v.ok) return error(res, v.status ?? 401, v.code, v.message, "Issue an App verification proof for ting with scope tings.send.");
      const t = body.json;
      const allowed = new Set(["type", "for", "key", "data", "metadata"]);
      const unknown = Object.keys(t).filter((k) => !allowed.has(k));
      if (unknown.length) return error(res, 400, "unknown_field", `Unknown field(s): ${unknown.join(", ")}.`, "Send only type, for, key, data, metadata.");
      if (typeof t.type !== "string" || typeof t.for !== "string" || typeof t.key !== "string" || !t.key || Buffer.byteLength(t.key) > 200) {
        return error(res, 400, "invalid_request", "A ting needs type, for and a key of at most 200 bytes.", "Send { type, for, key, data, metadata }.");
      }
      const same = tings.find((x) => x.key === t.key && x.app === (v.proof.issuing_app?.id ?? v.proof.issuing_app ?? "present"));
      if (same) {
        if (stable({ type: same.type, for: same.for, data: same.data }) !== stable({ type: t.type, for: t.for, data: t.data ?? {} })) {
          return error(res, 409, "idempotency_conflict", "This key was already used for a different ting.", "Use a new key for a new ting.");
        }
        return send(res, 200, { id: same.id, replayed: true });
      }
      const rec = {
        id: crypto.randomUUID(),
        app: v.proof.issuing_app?.id ?? v.proof.issuing_app ?? "present",
        type: t.type,
        for: t.for,
        key: t.key,
        data: t.data ?? {},
        metadata: t.metadata ?? {},
        received_at: new Date().toISOString(),
      };
      tings.push(rec);
      return send(res, 201, { id: rec.id });
    }
    return error(res, 404, "not_found", `No route for ${req.method} ${path}.`, "See the header of tools/ting-standin/server.mjs.");
  } catch (e) {
    return error(res, 500, "internal_error", String(e?.message ?? e), "Check the stand-in's output.");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ting stand-in listening on http://${HOST}:${PORT} (proof checks ${VERIFY ? "on via " + ACCOUNTS : "off"})`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
