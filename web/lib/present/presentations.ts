/**
 * Presenting (docs/architecture.md, "Presenting"): start a presentation others can follow, move it, stop it, and the
 * live stream followers read.
 */
import { api, seg } from "../client/api";
import { toPresentation } from "./normalize";
import type { Presentation } from "./types";

export async function startPresentation(deck: string, at?: { slide?: string; step?: number }): Promise<Presentation> {
  return toPresentation(await api.post<unknown>(`/v1/decks/${seg(deck)}/presentations`, at ?? {}, { idempotencyKey: true }));
}

export async function getPresentation(id: string, signal?: AbortSignal): Promise<Presentation> {
  return toPresentation(await api.get<unknown>(`/v1/presentations/${seg(id)}`, { signal }));
}

export async function movePresentation(id: string, slide: string, step: number): Promise<void> {
  await api.put(`/v1/presentations/${seg(id)}`, { slide, step });
}

export async function stopPresentation(id: string): Promise<void> {
  await api.delete(`/v1/presentations/${seg(id)}`);
}

/** The server-sent events a follower reads (`state`, `ended`), through the proxy. */
export const presentationLiveUrl = (id: string) => `/api/v1/presentations/${encodeURIComponent(id)}/live`;

/** The follow link on this site (the service's followUrl may point at its own origin). */
export const followPath = (id: string) => `/p/${encodeURIComponent(id)}`;
