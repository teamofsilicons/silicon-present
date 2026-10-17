"use client";

/**
 * The demo's data hooks: TanStack Query over lib/client/api.ts (the browser calls /api/v1/…, the server adds the bearer
 * token). Seed each with what the Server Component fetched (`initialData`), so a page paints without a second request.
 * Mutations toast failures with the service's words unless the page shows them inline (`meta.toast: false`).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, seg } from "@/lib/client/api";
import type { ChipAccount } from "@/components/foundation/account/account-chip";
import type { Item, ItemStatus, Settings } from "./types";

export const keys = {
  items: ["items"] as const,
  item: (id: string) => ["items", id] as const,
  settings: ["settings"] as const,
};

export function useItems(initialData?: Item[]) {
  return useQuery({ queryKey: keys.items, queryFn: ({ signal }) => api.get<{ items: Item[] }>("/v1/items", { signal }).then(body => body.items), initialData });
}

export function useItem(id: string, initialData?: Item) {
  return useQuery({ queryKey: keys.item(id), queryFn: ({ signal }) => api.get<Item>(`/v1/items/${seg(id)}`, { signal }), initialData });
}

export interface ItemInput {
  title: string;
  description: string;
  status: ItemStatus;
}

export function useCreateItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ItemInput) => api.post<Item>("/v1/items", input, { idempotencyKey: true }),
    meta: { toast: false },
    onSuccess: item => {
      client.setQueryData(keys.item(item.id), item);
      return client.invalidateQueries({ queryKey: keys.items, exact: true });
    },
  });
}

export function useUpdateItem(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<ItemInput>) => api.patch<Item>(`/v1/items/${seg(id)}`, input),
    meta: { toast: false },
    onSuccess: item => {
      client.setQueryData(keys.item(id), item);
      return client.invalidateQueries({ queryKey: keys.items, exact: true });
    },
  });
}

export function useShareItem(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.put<Item>(`/v1/items/${seg(id)}/shares`, { ids }),
    meta: { toast: false },
    onSuccess: item => {
      client.setQueryData(keys.item(id), item);
      return client.invalidateQueries({ queryKey: keys.items, exact: true });
    },
  });
}

export function useDeleteItem(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/v1/items/${seg(id)}`),
    meta: { errorTitle: "Could not delete the item" },
    onSuccess: () => {
      client.removeQueries({ queryKey: keys.item(id), exact: true });
      return client.invalidateQueries({ queryKey: keys.items, exact: true });
    },
  });
}

export function useSettings(initialData?: Settings) {
  return useQuery({ queryKey: keys.settings, queryFn: ({ signal }) => api.get<Settings>("/v1/settings", { signal }), initialData });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Omit<Settings, "default_shares">> & { default_shares?: string[] }) => api.patch<Settings>("/v1/settings", patch),
    meta: { errorTitle: "Could not save the setting" },
    onSuccess: settings => client.setQueryData(keys.settings, settings),
  });
}

/** Looks a c:/si: id up through the service (which asks Silicon Accounts with the app's credentials). */
export function resolveAccount(id: string, signal: AbortSignal): Promise<ChipAccount> {
  return api.get<ChipAccount>("/v1/accounts/resolve", { query: { id }, signal });
}
