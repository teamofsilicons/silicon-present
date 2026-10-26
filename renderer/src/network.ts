/** Every converter HTTP request uses this transport, including Chromium subresources.
 * Resolve once, reject non-public addresses, then pin the checked address in the socket lookup.
 * Only exact asset URLs minted by the service may reach its private address. */
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { ConverterError } from "./errors";

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const first = parseInt(normalized.split(":")[0]!, 16);
    // Global unicast only: excludes loopback, ULA, link-local, multicast and mapped/translated IPv4.
    const second = parseInt(normalized.split(":")[1] || "0", 16);
    return first >= 0x2000 && first < 0x3ffe && first !== 0x2002 && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  }
  return false;
}

function blocked(): ConverterError {
  return new ConverterError("network_blocked", "This source is not a public HTTP(S) resource or an authorized deck asset.", "Upload the file as a deck asset, or use a public URL.");
}

/** Resolver factories come from the authenticated service request, never from deck content. */
export function assetPermission(assetUrl?: (id: string) => string): (url: URL) => boolean {
  if (!assetUrl) return () => false;
  const marker = "PresentAssetBoundary123";
  const template = assetUrl(marker);
  const parts = template.split(marker);
  if (parts.length !== 2) return () => false;
  return (url) => {
    const raw = url.href;
    if (!raw.startsWith(parts[0]!) || !raw.endsWith(parts[1]!)) return false;
    const id = raw.slice(parts[0]!.length, raw.length - parts[1]!.length || undefined);
    return /^[A-Za-z0-9_-]{1,200}$/.test(id) && assetUrl(id) === raw;
  };
}

export interface NetworkResponse { status: number; headers: Record<string, string>; data: Buffer }
export interface NetworkOptions {
  assetAllowed?: (url: URL) => boolean;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | null;
  maxBytes?: number;
}

function responseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !["set-cookie", "connection", "transfer-encoding", "keep-alive"].includes(key)) out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

async function resolveAddresses(host: string, signal: AbortSignal): Promise<Array<{ address: string; family: number }>> {
  signal.throwIfAborted();
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    lookup(host, { all: true, verbatim: true }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function networkRequest(raw: string, options: NetworkOptions = {}): Promise<NetworkResponse> {
  const signal = AbortSignal.timeout(30_000);
  let url: URL;
  try { url = new URL(raw); } catch { throw blocked(); }
  let method = options.method ?? "GET";
  let body = options.body;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw blocked();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await resolveAddresses(host, signal);
    const trustedAsset = (method === "GET" || method === "HEAD") && options.assetAllowed?.(url) === true;
    if (!addresses.length || (!trustedAsset && addresses.some((a) => !publicAddress(a.address)))) throw blocked();
    const pinned = addresses[0]!;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      // No credentials, cookies, caller-supplied Host or proxy metadata leave the converter.
      if (["accept", "accept-language", "content-type", "range", "origin", "user-agent"].includes(key.toLowerCase())) headers[key] = value;
    }
    headers["accept-encoding"] = "identity";
    const res = await new Promise<NetworkResponse>((resolve, reject) => {
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method, headers, agent: false, signal,
        lookup: (_host, opts, callback) => {
          if (opts.all) (callback as unknown as (error: null, resolved: Array<{ address: string; family: number }>) => void)(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > (options.maxBytes ?? 64 * 1024 * 1024)) {
            req.destroy(new ConverterError("asset_too_large", "The source exceeds the converter's 64 MiB download limit.", "Use a smaller file."));
          } else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 502, headers: responseHeaders(res.headers), data: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end(body ?? undefined);
    });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      if (redirects === 5) throw blocked();
      url = new URL(res.headers.location, url);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) { method = "GET"; body = undefined; }
      continue;
    }
    return res;
  }
  throw blocked();
}
