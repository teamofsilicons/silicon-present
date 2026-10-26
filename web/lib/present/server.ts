/**
 * Server Component reads of the Present service (the pages' first paint), built on the kit's tryApiFetch and the same
 * normalisers the browser uses. Failures come back as data (`error`) so the page shows the service's own words.
 */
import "server-only";
import type { ApiErrorInit } from "../errors";
import { tryApiFetch } from "../server/rsc";
import { homeListing, listPaths, topOfShared, transfersFrom, type Listing } from "./paths";
import { listOf, toDeck, toFolder, toVersions } from "./normalize";
import type { Deck, Folder, FolderPath, Scope, Transfer, Version } from "./types";

export type Loaded<T> = { data: T; error: null } | { data: null; error: ApiErrorInit };

const query = (values: Record<string, string | undefined>) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Record<string, string>;

export async function loadPlace(scope: Scope, folder: string | null): Promise<Loaded<Listing>> {
  if (scope === "all") {
    if (folder) return loadPlace("mine", folder);
    const [mine, shared] = await Promise.all([loadPlace("mine", null), loadPlace("shared", null)]);
    if (mine.error) return mine;
    if (shared.error) return shared;
    return { data: homeListing(mine.data, shared.data), error: null };
  }
  const decks = listPaths.decks(scope, folder);
  const answer = await tryApiFetch<unknown>(decks.path, { query: query(decks.query) });
  if (answer.error) return answer;
  const body = answer.data;
  let folders: Folder[];
  if (body && typeof body === "object" && !Array.isArray(body) && Array.isArray((body as { folders?: unknown }).folders)) {
    folders = (body as { folders: unknown[] }).folders.map(toFolder);
  } else {
    const path = listPaths.folders(scope, folder);
    const listed = await tryApiFetch<unknown>(path.path, { query: query(path.query) });
    if (listed.error) return listed;
    folders = listOf(listed.data, "folders").map(toFolder);
  }
  const listing = { decks: listOf(body, "decks").map(toDeck), folders: folders.filter(item => item.id !== folder) };
  return { data: scope === "shared" && !folder ? topOfShared(listing) : listing, error: null };
}

export async function loadFolderPath(id: string): Promise<Loaded<FolderPath>> {
  const first = await tryApiFetch<unknown>(`/v1/folders/${encodeURIComponent(id)}`, { notFound: true });
  if (first.error) return first;
  const folder = toFolder(first.data);
  const ancestors: Folder[] = [];
  let parent = folder.parent;
  for (let depth = 0; parent && depth < 32; depth++) {
    const next = await tryApiFetch<unknown>(`/v1/folders/${encodeURIComponent(parent)}`);
    if (next.error) break;
    const above = toFolder(next.data);
    ancestors.unshift(above);
    parent = above.parent;
  }
  return { data: { folder, ancestors }, error: null };
}

export async function loadDeck(id: string): Promise<Loaded<Deck>> {
  const answer = await tryApiFetch<unknown>(`/v1/decks/${encodeURIComponent(id)}`, { notFound: true });
  return answer.error ? answer : { data: toDeck(answer.data), error: null };
}

export async function loadTransfers(): Promise<Loaded<Transfer[]>> {
  const answer = await tryApiFetch<unknown>("/v1/transfers", { query: { state: "all" } });
  return answer.error ? answer : { data: transfersFrom(answer.data), error: null };
}

export async function loadVersions(deck: string): Promise<Loaded<Version[]>> {
  const answer = await tryApiFetch<unknown>(`/v1/decks/${encodeURIComponent(deck)}/versions`);
  return answer.error ? answer : { data: toVersions(answer.data), error: null };
}
