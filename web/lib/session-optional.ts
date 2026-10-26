/**
 * For pages that open without signing in when the deck is public (UNDERSTANDING.md: "Viewing a public deck never needs
 * signing in"): the deck page (`/decks/[id]`, the editor's view and comment mode), present mode and `/p/[presentation]`.
 *
 *   import { getOptionalSession, optionalApiFetch } from "@/lib/session-optional";
 *
 *   const session = await getOptionalSession();                // PublicSession | null (no redirect)
 *   const { data, error, signedIn } = await optionalApiFetch<unknown>(`/v1/decks/${id}`);
 *   if (error?.status === 401 || error?.status === 403 && !signedIn) redirect(signInHref(`/decks/${id}`));
 *
 * How the rest fits together:
 * - proxy.ts lets these addresses render signed out (`isPublicPage`), instead of sending the browser to sign in.
 * - The API proxy forwards the public reads without a token when there is no session (lib/server/forward.ts
 *   `publicReadPath`: the deck, its content, live stream, threads, export, renders, assets, presentations). Writes
 *   (comments, edits, presence) still need a session: send the visitor to `signInHref(here)` when they try.
 * - In the browser, `api.get(...)` works the same for both; only a 401 sends the page to sign in.
 * - A layout for these pages must not call `requireSession()`. Mount the kit's `Providers` with
 *   `session={sessionView(session)}` (its session keeper does nothing while signed out).
 */
import "server-only";
import { cookies, headers } from "next/headers";
import type { SessionView } from "./account";
import { ApiError, errorFromResponse, networkError, type ApiErrorInit } from "./errors";
import { serverEnv } from "./server/env";
import { getSession, type PublicSession } from "./server/rsc";
import { clientHeaders, sessionCookieName, sessionFromCookie } from "./server/session";
import { viewerEmailCookieName, viewerEmailHeaders } from "./server/viewer-email";

export type { PublicSession };

/** The signed-in account, or null. Never redirects. */
export async function getOptionalSession(): Promise<PublicSession | null> {
  return getSession();
}

/** What the kit's `Providers` take, for a page that may be signed out. */
export function sessionView(session: PublicSession | null): SessionView {
  return session ? { signedIn: true, account: session.account, expiresAt: session.expiresAt } : { signedIn: false, account: null, expiresAt: null };
}

/** The sign-in address that comes back to `returnTo` (a path on this site). */
export function signInHref(returnTo: string): string {
  const back = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  return `/auth/sign-in?return_to=${encodeURIComponent(back)}`;
}

export type OptionalResult<T> = { data: T; error: null; signedIn: boolean } | { data: null; error: ApiErrorInit; signedIn: boolean };

/**
 * Calls the service as the signed-in account when there is one, or anonymously when there is none (for a public deck).
 * Never redirects and never throws an ApiError: a failure comes back as `error` (the service's code, message and
 * hint) so the page can show it or offer to sign in. An access token that is about to expire is used anyway (proxy.ts
 * refreshed it on this page load if it could).
 */
export async function optionalApiFetch<T>(path: string, init: { query?: Record<string, string | number | undefined>; signal?: AbortSignal } = {}): Promise<OptionalResult<T>> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`optionalApiFetch needs the service's own path, starting with one "/": got "${path}".`);
  const store = await cookies();
  const session = sessionFromCookie(store.get(sessionCookieName())?.value);
  const signedIn = !!session && session.ae > Date.now();
  const env = serverEnv();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(init.query ?? {})) if (value !== undefined && value !== "") params.set(key, String(value));
  const url = `${env.appApiUrl}${path}${params.size ? `?${params.toString()}` : ""}`;
  const outgoing: Record<string, string> = { Accept: "application/json", ...clientHeaders({ headers: await headers() }), ...viewerEmailHeaders(store.get(viewerEmailCookieName())?.value) };
  if (signedIn) outgoing.Authorization = `Bearer ${session!.at}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: outgoing, cache: "no-store", redirect: "manual", signal: init.signal ?? AbortSignal.timeout(30_000) });
  } catch (error) {
    return { data: null, error: networkError(error, "GET", path, "the service").toJSON(), signedIn };
  }
  const text = response.status === 204 ? "" : await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (response.ok) return { data: body as T, error: null, signedIn };
  return { data: null, error: errorFromResponse(response, body, "GET", path).toJSON(), signedIn };
}

export { ApiError };
