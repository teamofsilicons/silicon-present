/**
 * Versions (docs/architecture.md, "Versions"): the history, a deck at any version, comparing two, naming one,
 * restoring (whole, one slide or one element), undoing one account's changes since a version, and a new deck from a
 * version.
 */
import type { DeckJson } from "@silicon-present/deck";
import { api, seg } from "../client/api";
import { toComparison, toDeck, toVersions } from "./normalize";
import type { Comparison, Deck, Version } from "./types";

export async function listVersions(deck: string, signal?: AbortSignal): Promise<Version[]> {
  return toVersions(await api.get<unknown>(`/v1/decks/${seg(deck)}/versions`, { signal }));
}

/** The deck's content as JSON, live or at `version`. */
export async function getContent(deck: string, version?: number | null, signal?: AbortSignal): Promise<DeckJson> {
  return api.get<DeckJson>(`/v1/decks/${seg(deck)}/content`, { query: { format: "json", version: version ?? undefined }, signal });
}

export async function compare(deck: string, from: number, to: number, signal?: AbortSignal): Promise<Comparison> {
  return toComparison(await api.get<unknown>(`/v1/decks/${seg(deck)}/compare`, { query: { from, to }, signal }), from, to);
}

export async function nameVersion(deck: string, version: number, name: string): Promise<void> {
  await api.post(`/v1/decks/${seg(deck)}/versions/${version}/name`, { name });
}

export async function restore(deck: string, input: { version: number; slide?: string; element?: string }): Promise<void> {
  await api.post(`/v1/decks/${seg(deck)}/restore`, input, { idempotencyKey: true });
}

/** `account` is the uuid of the Carbon or Silicon whose changes since `since` go away. */
export async function undoAccount(deck: string, account: string, since: number): Promise<void> {
  await api.post(`/v1/decks/${seg(deck)}/undo-account`, { account, since }, { idempotencyKey: true });
}

export async function deckFromVersion(deck: string, version: number, title?: string): Promise<Deck> {
  return toDeck(await api.post<unknown>("/v1/decks", { from: { deck, version }, ...(title ? { title } : {}) }, { idempotencyKey: true }));
}
