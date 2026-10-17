import { ConverterError } from "./errors";

// assetBase (from the service) says where the converter fetches "asset:<id>": a URL template with "{id}", or a prefix
// the id is appended to. e.g. "http://127.0.0.1:4321/v1/assets/{id}?sig=abc" or "http://127.0.0.1:4321/v1/assets/".

export function assetUrlFrom(assetBase: string | undefined): (id: string) => string {
  const base = assetBase ?? "";
  return (id: string) => (base.includes("{id}") ? base.replaceAll("{id}", encodeURIComponent(id)) : base + encodeURIComponent(id));
}

export interface Fetched {
  data: Buffer;
  contentType: string;
}

const cache = new WeakMap<object, Map<string, Promise<Fetched>>>();

/** Fetch an image/media source ("asset:<id>", http(s) URL or data: URL) as bytes, once per export. */
export function makeFetcher(assetBase: string | undefined) {
  const url = assetUrlFrom(assetBase);
  const key = {};
  const memo = new Map<string, Promise<Fetched>>();
  cache.set(key, memo);
  return async function fetchSrc(src: string): Promise<Fetched> {
    if (!memo.has(src)) memo.set(src, load(src));
    return memo.get(src)!;
  };
  async function load(src: string): Promise<Fetched> {
    if (src.startsWith("data:")) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
      if (!m) throw new ConverterError("bad_data_url", "A data: URL in the deck could not be read.", "Re-upload the file as an asset.");
      return { contentType: m[1] ?? "application/octet-stream", data: m[2] ? Buffer.from(m[3]!, "base64") : Buffer.from(decodeURIComponent(m[3]!)) };
    }
    const u = src.startsWith("asset:") ? url(src.slice(6)) : src;
    if (!/^https?:\/\//.test(u)) throw new ConverterError("asset_unreachable", `The asset ${src} has no URL the converter can fetch.`, "Pass assetBase with the request so asset:<id> sources can be fetched.");
    const res = await fetch(u, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new ConverterError("asset_unreachable", `Fetching ${src} failed with HTTP ${res.status}.`, "Check the asset exists and the converter's signed asset URL is still valid.", 502);
    return { contentType: res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream", data: Buffer.from(await res.arrayBuffer()) };
  }
}
export type FetchSrc = ReturnType<typeof makeFetcher>;
