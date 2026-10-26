import type { NextResponse } from "next/server";
import { secureCookies, serverEnv } from "./env";
import { seal, unseal } from "./seal";
import { normalizeViewerEmail } from "../viewer-email";

const PURPOSE = "public-deck-viewer-email";
const TTL_SECONDS = 24 * 60 * 60;
export const VIEWER_EMAIL_HEADER = "x-present-viewer-email";

export function viewerEmailCookieName(): string {
  const env = serverEnv();
  return `${secureCookies(env) ? "__Host-" : ""}${env.appId.replace(/-/g, "_")}_viewer_email`;
}

export function viewerEmailFromCookie(cookie: string | undefined, now = Date.now()): string | null {
  const value = unseal<{ email?: unknown; expires?: unknown }>(cookie, PURPOSE);
  if (!value || typeof value.expires !== "number" || value.expires <= now) return null;
  return normalizeViewerEmail(value.email);
}

export function writeViewerEmail(response: NextResponse, email: string): void {
  response.cookies.set(viewerEmailCookieName(), seal({ email, expires: Date.now() + TTL_SECONDS * 1000 }, PURPOSE), {
    httpOnly: true, secure: secureCookies(), sameSite: "lax", path: "/", maxAge: TTL_SECONDS,
  });
}

/** Incoming page headers never supply this value; only this site's sealed cookie does. */
export function viewerEmailHeaders(cookie: string | undefined): Record<string, string> {
  const email = viewerEmailFromCookie(cookie);
  return email ? { [VIEWER_EMAIL_HEADER]: email } : {};
}
