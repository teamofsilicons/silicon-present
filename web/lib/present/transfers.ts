/** Transfers: giving a deck or folder to another Carbon or Silicon, who accepts or declines; the giver can cancel. */
import { api, seg } from "../client/api";
import { listOf, toTransfer } from "./normalize";
import type { ResourceKind, Transfer } from "./types";

export async function listTransfers(signal?: AbortSignal): Promise<Transfer[]> {
  return listOf(await api.get<unknown>("/v1/transfers", { signal }), "transfers").map(toTransfer);
}

export async function startTransfer(kind: ResourceKind, id: string, to: string): Promise<Transfer> {
  return toTransfer(await api.post<unknown>(`/v1/${kind === "deck" ? "decks" : "folders"}/${seg(id)}/transfer`, { to }, { idempotencyKey: true }));
}

export async function answerTransfer(id: string, action: "accept" | "decline" | "cancel"): Promise<void> {
  await api.post(`/v1/transfers/${seg(id)}/${action}`);
}
