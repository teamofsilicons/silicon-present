/** Who is calling, as the service sees them. */
import { api } from "../client/api";
import { toAccount } from "./normalize";
import type { Account } from "./types";

export async function getMe(signal?: AbortSignal): Promise<Account | null> {
  const answer = await api.get<unknown>("/v1/me", { signal });
  const value = answer && typeof answer === "object" && "account" in answer ? (answer as { account: unknown }).account : answer;
  return toAccount(value);
}
