/**
 * Server-side read for the deck page: the deck's metadata and the caller's role, as the signed-in account or, for a
 * public deck, anonymously (lib/session-optional.ts). The deck's content itself comes over the live connection.
 */
import "server-only";
import { cache } from "react";
import { getOptionalSession, optionalApiFetch } from "@/lib/session-optional";
import type { ApiErrorInit } from "@/lib/errors";
import { readDeckMeta } from "./normalize-api";
import type { DeckMeta, Me } from "./types";

export interface DeckPageData {
  me: Me | null;
  meta: DeckMeta | null;
  error: ApiErrorInit | null;
}

export const loadDeckPage = cache(async (id: string): Promise<DeckPageData> => {
  const session = await getOptionalSession();
  const me: Me | null = session
    ? { uuid: session.account.uuid, id: session.account.id, kind: session.account.kind, display_name: session.account.display_name, pfp_url: session.account.pfp_url }
    : null;
  const { data, error } = await optionalApiFetch<unknown>(`/v1/decks/${encodeURIComponent(id)}`);
  return { me, meta: data ? readDeckMeta(data, id) : null, error: error ?? null };
});
