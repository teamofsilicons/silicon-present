/**
 * Files (docs/architecture.md, "Files"): opening a file as a new deck (with upload progress), downloading a deck in
 * any format, one slide as an image, and asset links.
 */
import { ApiError, errorFromResponse } from "../errors";
import { ensureFreshSession, markSignedOut } from "../client/session";
import { toDeck } from "./normalize";
import type { Deck, ExportFormat } from "./types";

/** The browser link that downloads a deck (or one slide) in `format`; the proxy streams it with its file name. */
export function exportUrl(deck: string, format: ExportFormat, options: { version?: number | null; slide?: string | null } = {}): string {
  const query = new URLSearchParams({ format });
  if (options.version) query.set("version", String(options.version));
  if (options.slide) query.set("slide", options.slide);
  return `/api/v1/decks/${encodeURIComponent(deck)}/export?${query.toString()}`;
}

export function renderUrl(deck: string, slide: string, options: { format?: "png" | "jpg"; width?: number; version?: number | null; at?: number } = {}): string {
  const query = new URLSearchParams({ format: options.format ?? "png", width: String(options.width ?? 1920) });
  if (options.version) query.set("version", String(options.version));
  if (options.at !== undefined) query.set("at", String(options.at));
  return `/api/v1/decks/${encodeURIComponent(deck)}/slides/${encodeURIComponent(slide)}/render?${query.toString()}`;
}

/** Where the browser loads `asset:<id>` from. */
export const assetUrl = (id: string) => `/api/v1/assets/${encodeURIComponent(id)}`;

/** Resolves an element's `src` ("asset:<id>" or a URL) for the browser. */
export function resolveSrc(src: string): string {
  return src.startsWith("asset:") ? assetUrl(src.slice("asset:".length)) : src;
}

export interface ImportProgress {
  /** 0..1 of the upload; null while the size is unknown. */
  uploaded: number | null;
  /** "uploading" while bytes go up, "converting" once they are all there and the service builds the deck. */
  phase: "uploading" | "converting";
}

/** A content type for a file whose browser type is empty (Keynote, some PowerPoint files). */
function contentTypeOf(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const known: Record<string, string> = {
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ppt: "application/vnd.ms-powerpoint",
    key: "application/vnd.apple.keynote",
    odp: "application/vnd.oasis.opendocument.presentation",
    pdf: "application/pdf",
    html: "text/html",
    htm: "text/html",
  };
  return known[ext] ?? "application/octet-stream";
}

/**
 * Opens a file as a new deck (`POST /v1/imports`, or on top of `onto` as its next version), reporting progress. Uses
 * XMLHttpRequest because fetch cannot report upload progress. Resolves with the new (or updated) deck.
 */
export async function importFile(file: File, options: { folder?: string | null; onto?: string; onProgress?: (progress: ImportProgress) => void; signal?: AbortSignal } = {}): Promise<Deck> {
  await ensureFreshSession();
  const path = options.onto ? `/v1/decks/${encodeURIComponent(options.onto)}/imports` : "/v1/imports";
  const query = options.folder ? `?folder=${encodeURIComponent(options.folder)}` : "";
  return new Promise<Deck>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api${path}${query}`);
    xhr.setRequestHeader("Content-Type", contentTypeOf(file));
    // Header values are ASCII: the name travels percent-encoded (the service decodes it).
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = event => options.onProgress?.({ uploaded: event.lengthComputable ? event.loaded / event.total : null, phase: event.lengthComputable && event.loaded >= event.total ? "converting" : "uploading" });
    xhr.upload.onload = () => options.onProgress?.({ uploaded: 1, phase: "converting" });
    xhr.onerror = () => reject(new ApiError({ status: 0, code: "network_error", message: `Could not reach this site to open ${file.name}.`, hint: "Check your connection, then try again." }));
    xhr.onabort = () => reject(new ApiError({ status: 0, code: "aborted", message: `Opening ${file.name} was cancelled.` }));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(toDeck(body));
      const response = new Response(null, { status: xhr.status, headers: { "x-request-id": xhr.getResponseHeader("x-request-id") ?? "" } });
      const error = errorFromResponse(response, body, "POST", path);
      if (error.status === 401) markSignedOut();
      reject(error);
    };
    options.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
