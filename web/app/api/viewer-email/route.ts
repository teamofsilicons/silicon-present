import type { NextRequest } from "next/server";
import { normalizeViewerEmail } from "@/lib/viewer-email";
import { json } from "@/lib/server/responses";
import { errorBody, sameOriginProblem } from "@/lib/server/session";
import { writeViewerEmail } from "@/lib/server/viewer-email";

export async function POST(request: NextRequest) {
  const problem = sameOriginProblem(request);
  if (problem) return json(403, errorBody("cross_site_request", problem, "Use this site's own pages."));
  // A small bounded body, even when Content-Length is omitted or untrusted.
  let text: string;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("empty");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 2048) { await reader.cancel(); return json(413, errorBody("body_too_large", "The email request is too large.", "Enter one email address.")); }
      chunks.push(part.value);
    }
    text = Buffer.concat(chunks).toString("utf8");
  } catch {
    return json(400, errorBody("invalid_email", "Enter an email address to continue."));
  }
  let email: string | null = null;
  try { email = normalizeViewerEmail(JSON.parse(text)?.email); } catch { /* Invalid JSON is a field error. */ }
  if (!email) return json(400, errorBody("invalid_email", "Enter a valid email address, such as name@example.com."));
  return json(200, { ok: true }, response => writeViewerEmail(response, email));
}
