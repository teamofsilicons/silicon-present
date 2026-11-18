import { api } from "../client/api";
import { toAccount } from "./normalize";
import type { Account } from "./types";

export interface Person extends Account {
  trust: number | null;
}
export interface PeoplePage {
  items: Person[];
  total: number;
  connected: boolean;
}
interface WirePage {
  items: unknown[];
  total: number;
  connected: boolean;
}

export function person(value: unknown): Person | null {
  const a = toAccount(value);
  if (!a) return null;
  const trust = typeof value === "object" && value && "trust" in value && typeof value.trust === "number" ? value.trust : null;
  return { ...a, trust };
}
export async function findPeople(q: string, signal?: AbortSignal, contacts = false, offset = 0, limit = 20): Promise<PeoplePage> {
  const result = await api.get<WirePage>(contacts ? "/v1/contacts" : "/v1/people", { query: { q, offset, limit }, signal });
  return { ...result, items: result.items.map(person).filter((item): item is Person => item !== null) };
}

export function fuzzyMatch(q: string, a: Account): boolean {
  const needle = Array.from(q.trim().toLowerCase()).filter((c) => c.trim());
  return [a.id, a.displayName].some((value) => {
    let i = 0;
    for (const c of value.toLowerCase()) if (c === needle[i]) i++;
    return i === needle.length;
  });
}
