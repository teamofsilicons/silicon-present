/**
 * Loading a deck for a page that may be signed out (present mode, follow-along): its metadata and its content, as the
 * signed-in account or anonymously for a public deck. A private deck seen signed out sends the browser to sign in and
 * back; anything else that fails comes back as the service's error.
 */
import "server-only";
import { redirect } from "next/navigation";
import type { DeckJson } from "@silicon-present/deck";
import type { ApiErrorInit } from "../errors";
import { optionalApiFetch, signInHref } from "../session-optional";
import { toDeck } from "./normalize";
import type { Deck } from "./types";

export type DeckLoad = { deck: Deck; content: DeckJson; signedIn: boolean; error: null } | { deck: null; content: null; signedIn: boolean; error: ApiErrorInit };

export async function loadDeckForViewing(id: string, returnTo: string): Promise<DeckLoad> {
  const meta = await optionalApiFetch<unknown>(`/v1/decks/${encodeURIComponent(id)}`);
  if (meta.error) {
    if (meta.error.code !== "email_required" && !meta.signedIn && [401, 403, 404].includes(meta.error.status)) redirect(signInHref(returnTo));
    return { deck: null, content: null, signedIn: meta.signedIn, error: meta.error };
  }
  const content = await optionalApiFetch<DeckJson>(`/v1/decks/${encodeURIComponent(id)}/content`, { query: { format: "json" } });
  if (content.error) return { deck: null, content: null, signedIn: content.signedIn, error: content.error };
  const deck = toDeck(meta.data);
  return { deck, content: { ...content.data, title: content.data.title ?? deck.title }, signedIn: meta.signedIn, error: null };
}
