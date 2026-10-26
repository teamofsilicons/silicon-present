/**
 * What the API proxy (app/api/[...path]/route.ts) passes between the browser and the app's service, as plain functions
 * so the unit tests can pin it down. The rule: forward what describes the request, never what authenticates the browser
 * to this site (cookies stay here, and the browser's own Authorization is replaced by the session's bearer token).
 */
import { appConfig } from "../app.config";

/** Request headers passed to the app's service (plus appConfig.api.forwardHeaders). */
export const FORWARD_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "content-length",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "range",
  "idempotency-key",
  "x-request-id",
] as const;

/**
 * Response headers passed back to the browser (plus appConfig.api.exposeHeaders). Content-Length and Content-Encoding
 * are not: the body is streamed through after fetch has decoded it, so Next frames it again.
 */
export const RELAY_RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "content-security-policy",
  "content-language",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "location",
  "retry-after",
  "link",
  "x-request-id",
] as const;

const lower = (names: readonly string[] | undefined) => (names ?? []).map(name => name.toLowerCase());

/**
 * The headers for the call to the app's service: the allowlist, the client's address and agent, and the bearer token
 * (none for an anonymous read of a public deck, see publicReadPath).
 */
export function forwardRequestHeaders(incoming: Headers, token: string | null, client: Record<string, string>, extra: readonly string[] = appConfig.api?.forwardHeaders ?? []): Headers {
  const out = new Headers();
  for (const name of [...FORWARD_REQUEST_HEADERS, ...lower(extra)]) {
    if (name === "authorization" || name === "cookie" || name === "host" || name === "x-present-viewer-email") continue;
    const value = incoming.get(name);
    if (value !== null) out.set(name, value);
  }
  for (const [name, value] of Object.entries(client)) out.set(name, value);
  if (token) out.set("authorization", `Bearer ${token}`);
  return out;
}

/** The headers of the answer the browser gets: the allowlist, never cached by anything shared, never sniffed. */
export function relayResponseHeaders(upstream: Headers, extra: readonly string[] = appConfig.api?.exposeHeaders ?? []): Headers {
  const out = new Headers();
  for (const name of [...RELAY_RESPONSE_HEADERS, ...lower(extra)]) {
    if (name === "set-cookie" || name === "content-length" || name === "content-encoding" || name === "transfer-encoding") continue;
    const value = upstream.get(name);
    if (value !== null) out.set(name, value);
  }
  // Answers carry one account's data: no shared cache (a CDN in front of this site) may keep them.
  out.set("cache-control", "private, no-store");
  out.set("x-content-type-options", "nosniff");
  return out;
}

/**
 * The service path for what follows `/api/` in the browser's address (still percent-encoded, passed on exactly), or
 * null when a segment is empty, a dot segment, or an encoded slash, backslash or dot that could climb out of the
 * service's path once decoded.
 */
export function upstreamPath(rest: string): string | null {
  if (!rest) return null;
  for (const segment of rest.split("/")) {
    if (segment === "") return null;
    // ".", "..", "%2e", "%2E%2e", ".%2e": what a server reads as "this" or "the parent" folder once decoded.
    if (/^(?:\.|%2e)+$/i.test(segment) && segment.replace(/%2e/gi, ".").length <= 2) return null;
    if (/%2f|%5c|\\/i.test(segment)) return null;
  }
  return rest;
}

/**
 * Reads that work without signing in when the deck is public (UNDERSTANDING.md: "Viewing a public deck never needs
 * signing in"; docs/architecture.md: a public deck, its content, live updates, comments, assets, renders, exports and a
 * presentation of it). For a browser with no session the proxy forwards these without a token instead of answering
 * 401; the service decides (a private deck answers 401 or 404, and the page then offers to sign in). Everything else
 * still needs a session. Paths are what follows `/api/` (no leading slash), still percent-encoded.
 */
const PUBLIC_READS: readonly RegExp[] = [
  /^v1\/decks\/[^/]+$/,
  /^v1\/decks\/[^/]+\/(content|live|threads|export)$/,
  /^v1\/decks\/[^/]+\/slides\/[^/]+\/render$/,
  /^v1\/assets\/[^/]+$/,
  /^v1\/presentations\/[^/]+$/,
  /^v1\/presentations\/[^/]+\/live$/,
];

export function publicReadPath(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") return false;
  return PUBLIC_READS.some(pattern => pattern.test(path));
}
