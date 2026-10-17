#!/usr/bin/env node
/**
 * The demo's stand-in for an app's own service (what an app's Rust API does), so the kit can be tried and tested on its
 * own. It listens on 127.0.0.1:4261 (STUB_PORT) and answers like a Silicon service:
 *
 * - Every /v1 route needs `Authorization: Bearer <access token>`: an EdDSA JWT from Silicon Accounts whose `aud` is this
 *   app (APP_ID, default webkit) and whose `iss` is ACCOUNTS_URL, verified against {ACCOUNTS_URL}/.well-known/jwks.json
 *   with jose (keys cached, refetched for an unknown kid). The account is the token's `sub` (its uuid).
 * - Errors are `{"error": {"code", "message", "hint", "details"?}}`.
 * - Data lives in memory, per account uuid: items (owned, or shared with you by c:/si: id) and settings.
 * - Sharing resolves ids at Silicon Accounts with the app's credentials (APP_SECRET; GET /v1/accounts/by-id/{id}, then
 *   the app's user base for a display name and photo), stores uuids and shows current ids.
 *
 *   APP_SECRET=sa_app_webkit_… node demo/stub-api.mjs
 *
 * Environment: STUB_PORT (4261), APP_ID (webkit), ACCOUNTS_URL (http://localhost:9590), ACCOUNTS_API_URL
 * (http://127.0.0.1:9589), APP_SECRET (needed for sharing). Delete demo/ when an app adopts the kit.
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const PORT = Number(process.env.STUB_PORT || 4261);
const APP_ID = process.env.APP_ID || "webkit";
const ACCOUNTS_URL = (process.env.ACCOUNTS_URL || "http://localhost:9590").replace(/\/+$/, "");
const ACCOUNTS_API_URL = (process.env.ACCOUNTS_API_URL || "http://127.0.0.1:9589").replace(/\/+$/, "");
const APP_SECRET = process.env.APP_SECRET || "";
const JWKS = createRemoteJWKSet(new URL(`${ACCOUNTS_URL}/.well-known/jwks.json`), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
const MAX_BODY = 1024 * 1024;

/* ---------------------------------------------------------------------------------------------------------------- */
/* Answers                                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

class Failure extends Error {
  constructor(status, code, message, hint, details) {
    super(message);
    Object.assign(this, { status, code, hint, details });
  }
}

function send(res, status, body, headers = {}) {
  const text = body === null ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": res.requestId, ...headers });
  res.end(status === 204 ? undefined : text);
}

function sendError(res, failure) {
  const error = { code: failure.code, message: failure.message, ...(failure.hint ? { hint: failure.hint } : {}), ...(failure.details ? { details: failure.details } : {}) };
  send(res, failure.status, { error }, failure.status === 401 ? { "www-authenticate": `Bearer error="${failure.code}"` } : {});
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Failure(413, "payload_too_large", `The body is over ${MAX_BODY} bytes.`, "Send less at once.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Failure(400, "invalid_json", "The body is not valid JSON.", "Send a JSON object with Content-Type: application/json.");
  }
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Who is calling                                                                                                    */
/* ---------------------------------------------------------------------------------------------------------------- */

async function caller(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new Failure(401, "unauthenticated", "This service needs an access token: send Authorization: Bearer <access token>.", "Sign in again.");
  try {
    const { payload } = await jwtVerify(match[1], JWKS, { issuer: ACCOUNTS_URL, audience: APP_ID, algorithms: ["EdDSA"] });
    if (typeof payload.sub !== "string") throw new Error("the token has no sub");
    return { uuid: payload.sub, id: typeof payload.id === "string" ? payload.id : null, kind: payload.kind === "silicon" ? "silicon" : "carbon" };
  } catch (error) {
    const reason = error?.code === "ERR_JWT_EXPIRED" ? "The access token expired." : error?.code === "ERR_JWT_CLAIM_VALIDATION_FAILED" ? `The access token's ${error.claim} is not accepted here (${error.reason}).` : `The access token could not be verified: ${error?.message ?? error}.`;
    throw new Failure(401, "invalid_token", reason, "Sign in again.");
  }
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Accounts: c:/si: ids to uuids, through Silicon Accounts with the app's credentials                               */
/* ---------------------------------------------------------------------------------------------------------------- */

const lookups = new Map();
const LOOKUP_TTL = 5 * 60_000;
const basic = () => `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString("base64")}`;
const ID = /^(c|si):[a-z0-9_-]{3,30}$/;

async function accountsGet(path) {
  const response = await fetch(`${ACCOUNTS_API_URL}${path}`, { headers: { authorization: basic(), accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** The account behind a c:/si: id: {uuid, kind, id, display_name?, pfp_url?}, cached for 5 minutes. */
async function resolveId(raw) {
  const id = String(raw ?? "").trim().toLowerCase();
  if (!ID.test(id)) throw new Failure(422, "invalid_id", `"${raw}" is not an account id: use c: and a handle for a Carbon, si: and a handle for a Silicon (3 to 30 of a-z, 0-9, - and _).`, "Check the id and try again.", { fields: { id: "Not an account id." } });
  const cached = lookups.get(id);
  if (cached && cached.until > Date.now()) return cached.account;
  if (!APP_SECRET) throw new Failure(503, "lookups_unavailable", "This service cannot look accounts up: it was started without APP_SECRET.", "Start it with the app's secret in APP_SECRET.");
  let found;
  try {
    found = await accountsGet(`/v1/accounts/by-id/${encodeURIComponent(id)}`);
  } catch (error) {
    throw new Failure(502, "accounts_unreachable", `Silicon Accounts could not be reached to look up ${id}: ${error.message}.`, "Wait a moment and try again.");
  }
  if (found.status === 404) throw new Failure(404, "account_not_found", found.body?.error?.message ?? `No account has the id ${id}.`, "Check the spelling; an id may have changed. Ask them for their current id.", { id });
  if (found.status !== 200 || !found.body?.uuid) throw new Failure(502, "lookup_failed", `Silicon Accounts answered ${found.status} looking up ${id}.`, "Wait a moment and try again.");
  const account = { uuid: found.body.uuid, kind: found.body.kind, id: found.body.id, display_name: null, pfp_url: null };
  // A display name and photo are shared with this app by signing in to it: read them from the app's user base.
  const member = await accountsGet(`/v1/apps/${encodeURIComponent(APP_ID)}/users/${encodeURIComponent(account.uuid)}`).catch(() => null);
  if (member?.status === 200 && member.body?.status === "active") {
    account.display_name = member.body.display_name ?? null;
    account.pfp_url = member.body.pfp_url ?? null;
  }
  lookups.set(id, { account, until: Date.now() + LOOKUP_TTL });
  return account;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Data                                                                                                              */
/* ---------------------------------------------------------------------------------------------------------------- */

const accounts = new Map(); // uuid → { items: Map, settings }
const STATUSES = ["draft", "active", "done"];
const now = () => new Date().toISOString();
const newId = () => `itm_${randomBytes(6).toString("base64url")}`;

function seed(owner) {
  const items = new Map();
  const samples = [
    ["Write the launch notes", "Summarise what changed for Carbons and Silicons, with the install command at the top.", "active", 3],
    ["Review the sign-in setup", "Check redirect URIs, allowed origins and the details the app asks for.", "active", 26],
    ["Plan the Silicon onboarding", "How a Silicon installs the app, signs in with a short-lived token and finds its things.", "draft", 52],
    ["Share the roadmap", "Share it with the Carbons and Silicons who need it, by their c: and si: ids.", "draft", 75],
    ["Move the data to account uuids", "Key every record on the Accounts uuid and keep the old ids in a mapping table.", "done", 140],
    ["Retire the old dashboard", "Everything it did is in the new workspace now.", "done", 300],
  ];
  for (const [title, description, status, hoursAgo] of samples) {
    const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const id = newId();
    items.set(id, { id, title, description, status, owner, shares: [], created_at: at, updated_at: at, history: [{ at, action: "created", by: owner.id }] });
  }
  return items;
}

function space(who) {
  let entry = accounts.get(who.uuid);
  if (!entry) {
    entry = { items: seed(who), settings: { notify_on_share: true, weekly_summary: false, show_ids: true, default_shares: [] } };
    accounts.set(who.uuid, entry);
  }
  // Keep the shown id current (it can change; the uuid never does).
  if (who.id) for (const item of entry.items.values()) if (item.owner.uuid === who.uuid) item.owner.id = who.id;
  return entry;
}

/** Every item the caller may see: its own, and those shared with it by other accounts. */
function visibleItems(who) {
  const own = [...space(who).items.values()];
  const shared = [];
  for (const [uuid, entry] of accounts) {
    if (uuid === who.uuid) continue;
    for (const item of entry.items.values()) if (item.shares.some(share => share.uuid === who.uuid)) shared.push(item);
  }
  return [...own, ...shared];
}

function findItem(who, id) {
  const item = visibleItems(who).find(candidate => candidate.id === id);
  if (!item) throw new Failure(404, "not_found", `There is no item ${id} you can see.`, "It may have been deleted, or it was never shared with your account.");
  return item;
}

function requireOwner(who, item, verb) {
  if (item.owner.uuid !== who.uuid) throw new Failure(403, "not_owner", `Only ${item.owner.id ?? "its owner"} can ${verb} this item.`, "Ask its owner to do it.");
}

/** Another account's display name and photo, from this app's user base (it shared them by signing in here). */
const profiles = new Map();
async function profileOf(uuid) {
  const cached = profiles.get(uuid);
  if (cached && cached.until > Date.now()) return cached.profile;
  let profile = { display_name: null, pfp_url: null };
  if (APP_SECRET) {
    const member = await accountsGet(`/v1/apps/${encodeURIComponent(APP_ID)}/users/${encodeURIComponent(uuid)}`).catch(() => null);
    if (member?.status === 200 && member.body?.status === "active") profile = { display_name: member.body.display_name ?? null, pfp_url: member.body.pfp_url ?? null };
  }
  profiles.set(uuid, { profile, until: Date.now() + LOOKUP_TTL });
  return profile;
}

const view = async (item, who) => ({
  id: item.id,
  title: item.title,
  description: item.description,
  status: item.status,
  owner: item.owner.uuid === who.uuid ? item.owner : { ...item.owner, ...(await profileOf(item.owner.uuid)) },
  role: item.owner.uuid === who.uuid ? "owner" : "shared",
  shares: item.shares,
  created_at: item.created_at,
  updated_at: item.updated_at,
  history: item.history.slice(-20).reverse(),
});

function validateItem(input, partial) {
  const fields = {};
  const out = {};
  if (!partial || input.title !== undefined) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) fields.title = "Give the item a title.";
    else if (title.length > 120) fields.title = `The title is ${title.length} characters; keep it to 120.`;
    else out.title = title;
  }
  if (input.description !== undefined) {
    const description = typeof input.description === "string" ? input.description.trim() : "";
    if (description.length > 2000) fields.description = `The description is ${description.length} characters; keep it to 2,000.`;
    else out.description = description;
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) fields.status = `Status is one of ${STATUSES.join(", ")}.`;
    else out.status = input.status;
  }
  if (Object.keys(fields).length) throw new Failure(422, "validation_failed", `Check ${Object.keys(fields).join(" and ")}: ${Object.values(fields).join(" ")}`, "Fix the fields shown and save again.", { fields });
  return out;
}

async function resolveAll(ids, who) {
  if (!Array.isArray(ids)) throw new Failure(422, "validation_failed", "Send the ids to share with as a list: {\"ids\": [\"c:ada\", \"si:scout\"]}.", "Send a list of c: and si: ids.");
  if (ids.length > 50) throw new Failure(422, "validation_failed", `That is ${ids.length} accounts; share with at most 50 at once.`, "Share with fewer accounts.");
  const fields = {};
  const resolved = [];
  for (const raw of [...new Set(ids.map(value => String(value).trim().toLowerCase()))]) {
    try {
      const account = await resolveId(raw);
      if (account.uuid === who.uuid) fields[raw] = "That is you; you always see your own items.";
      else resolved.push(account);
    } catch (failure) {
      if (!(failure instanceof Failure) || failure.status >= 500) throw failure;
      fields[raw] = failure.message;
    }
  }
  if (Object.keys(fields).length) throw new Failure(422, "validation_failed", Object.entries(fields).map(([id, message]) => `${id}: ${message}`).join(" "), "Remove or fix the ids shown, then save again.", { fields });
  return resolved;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Routes                                                                                                            */
/* ---------------------------------------------------------------------------------------------------------------- */

async function route(req, res, url) {
  const method = req.method ?? "GET";
  const path = url.pathname;
  if (path === "/health") return send(res, 200, { ok: true, app_id: APP_ID });
  if (!path.startsWith("/v1/")) throw new Failure(404, "not_found", `${method} ${path} is not a route of this service.`, "Routes start with /v1/.");
  const who = await caller(req);

  if (path === "/v1/me" && method === "GET") return send(res, 200, who);

  if (path === "/v1/echo") {
    // What arrived, for the kit's tests of the API proxy: method, query, the headers it forwards, and the body's size and hash.
    const body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
    const pick = ["accept", "accept-language", "content-type", "content-length", "transfer-encoding", "idempotency-key", "if-none-match", "x-request-id", "x-forwarded-for", "user-agent", "cookie", "origin", "x-custom"];
    const headers = Object.fromEntries(pick.filter(name => req.headers[name] !== undefined).map(name => [name, req.headers[name]]));
    return send(res, 200, { method, path, query: Object.fromEntries(url.searchParams), headers, authorization: req.headers.authorization ? "Bearer (verified)" : null, account: who, body_bytes: body.length, body_sha256: createHash("sha256").update(body).digest("hex") }, { etag: '"echo-1"', "x-total-count": "1", "set-cookie": "stub=1; Path=/" });
  }

  if (path === "/v1/accounts/resolve" && method === "GET") return send(res, 200, await resolveId(url.searchParams.get("id")));

  if (path === "/v1/items" && method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const status = url.searchParams.get("status");
    const items = visibleItems(who)
      .filter(item => (!q || `${item.title} ${item.description}`.toLowerCase().includes(q)) && (!status || item.status === status))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return send(res, 200, { items: await Promise.all(items.map(item => view(item, who))) });
  }
  if (path === "/v1/items" && method === "POST") {
    const input = validateItem(await readJson(req), false);
    const at = now();
    const settings = space(who).settings;
    const owner = { uuid: who.uuid, id: who.id, kind: who.kind };
    const item = { id: newId(), title: input.title, description: input.description ?? "", status: input.status ?? "draft", owner, shares: [...settings.default_shares], created_at: at, updated_at: at, history: [{ at, action: "created", by: who.id }] };
    space(who).items.set(item.id, item);
    return send(res, 201, await view(item, who), { location: `/v1/items/${item.id}` });
  }

  const itemMatch = /^\/v1\/items\/([A-Za-z0-9_-]+)(\/shares)?$/.exec(path);
  if (itemMatch) {
    const item = findItem(who, itemMatch[1]);
    if (itemMatch[2]) {
      if (method !== "PUT") throw new Failure(405, "method_not_allowed", `${method} is not allowed on ${path}.`, "Use PUT with {\"ids\": [...]}.");
      requireOwner(who, item, "share");
      const body = await readJson(req);
      item.shares = await resolveAll(body.ids ?? [], who);
      item.updated_at = now();
      item.history.push({ at: item.updated_at, action: item.shares.length ? `shared with ${item.shares.map(share => share.id).join(", ")}` : "made private", by: who.id });
      return send(res, 200, await view(item, who));
    }
    if (method === "GET") return send(res, 200, await view(item, who));
    if (method === "PATCH") {
      requireOwner(who, item, "edit");
      const input = validateItem(await readJson(req), true);
      Object.assign(item, input, { updated_at: now() });
      item.history.push({ at: item.updated_at, action: `edited ${Object.keys(input).join(", ") || "nothing"}`, by: who.id });
      return send(res, 200, await view(item, who));
    }
    if (method === "DELETE") {
      requireOwner(who, item, "delete");
      space(who).items.delete(item.id);
      return send(res, 204, null);
    }
    throw new Failure(405, "method_not_allowed", `${method} is not allowed on ${path}.`, "Use GET, PATCH or DELETE.");
  }

  if (path === "/v1/settings" && method === "GET") return send(res, 200, space(who).settings);
  if (path === "/v1/settings" && method === "PATCH") {
    const input = await readJson(req);
    const settings = space(who).settings;
    for (const key of ["notify_on_share", "weekly_summary", "show_ids"]) {
      if (input[key] === undefined) continue;
      if (typeof input[key] !== "boolean") throw new Failure(422, "validation_failed", `${key} is true or false.`, "Send a boolean.", { fields: { [key]: "true or false" } });
      settings[key] = input[key];
    }
    if (input.default_shares !== undefined) settings.default_shares = await resolveAll(input.default_shares, who);
    return send(res, 200, settings);
  }

  throw new Failure(404, "not_found", `${method} ${path} is not a route of this service.`, "See demo/stub-api.mjs for its routes.");
}

const server = createServer(async (req, res) => {
  res.requestId = `req_${randomBytes(6).toString("hex")}`;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    await route(req, res, url);
  } catch (error) {
    if (error instanceof Failure) return sendError(res, error);
    console.error(error);
    sendError(res, new Failure(500, "internal_error", `The demo service failed: ${error?.message ?? error}.`, "Look at the stub's log."));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub API for ${APP_ID} on http://127.0.0.1:${PORT} (tokens from ${ACCOUNTS_URL}${APP_SECRET ? "" : "; sharing off: no APP_SECRET"})`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
