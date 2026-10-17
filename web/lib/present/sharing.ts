/**
 * Sharing a deck or folder (docs/architecture.md): who has access, inviting by c:id, si:id or email with a role,
 * changing and removing members, and a deck's public switch. Plus resolving an id for the invite field.
 */
import { api, seg } from "../client/api";
import { toAccess, toAccount } from "./normalize";
import type { Access, Account, PublicMode, ResourceKind, Role } from "./types";

const base = (kind: ResourceKind, id: string) => `/v1/${kind === "deck" ? "decks" : "folders"}/${seg(id)}`;

export async function getAccess(kind: ResourceKind, id: string, signal?: AbortSignal): Promise<Access> {
  return toAccess(await api.get<unknown>(`${base(kind, id)}/access`, { signal }));
}

/** `to` is "c:ada", "si:writer" or an email address. */
export async function invite(kind: ResourceKind, id: string, to: string, role: Role): Promise<void> {
  await api.post(`${base(kind, id)}/access`, { to, role }, { idempotencyKey: true });
}

export async function changeRole(kind: ResourceKind, id: string, member: string, role: Role): Promise<void> {
  await api.patch(`${base(kind, id)}/access/${seg(member)}`, { role });
}

export async function removeMember(kind: ResourceKind, id: string, member: string): Promise<void> {
  await api.delete(`${base(kind, id)}/access/${seg(member)}`);
}

export async function setPublic(id: string, mode: PublicMode): Promise<void> {
  await api.put(`/v1/decks/${seg(id)}/public`, { mode });
}

/** Who a c:/si: id is, for the invite field. Null when nobody has it. */
export async function resolveAccount(q: string, signal?: AbortSignal): Promise<Account | null> {
  const answer = await api.get<unknown>("/v1/accounts/resolve", { query: { q }, signal });
  const value = answer && typeof answer === "object" && "account" in answer ? (answer as { account: unknown }).account : answer;
  return toAccount(value);
}

/** The link to a deck that anyone with it can open (when it is public). */
export function deckLink(id: string, origin: string = typeof window === "undefined" ? "" : window.location.origin): string {
  return `${origin}/decks/${encodeURIComponent(id)}`;
}
