/**
 * Decks and folders (docs/architecture.md, "Sharing, folders, trash, transfers"): list, create, rename, move, trash,
 * restore, delete for good, and search. Browser-side, through the kit's API proxy (`api`); Server Components read
 * the same paths with `apiFetch` and the normalisers.
 */
import { api, seg } from "../client/api";
import { listOf, toDeck, toFolder, toSearchHit } from "./normalize";
import { homeListing, listPaths, topOfShared, type Listing } from "./paths";
import type { Deck, Folder, FolderPath, ResourceKind, Scope, SearchHit } from "./types";

export { listPaths, topOfShared, type Listing } from "./paths";

const collection = (kind: ResourceKind) => (kind === "deck" ? "decks" : "folders");

/** The paths a listing reads, shared by the server page and the client view. */
/**
 * What is in one place: the top of mine, shared with me or the trash, or one folder. The decks listing may carry the
 * folders too (`{ decks, folders }`); otherwise they come from the folders listing.
 */
export async function listPlace(scope: Scope, folder: string | null, signal?: AbortSignal): Promise<Listing> {
  if (scope === "all") {
    // Folder access is checked by the service independently of the listing's scope.
    if (folder) return listPlace("mine", folder, signal);
    const [mine, shared] = await Promise.all([listPlace("mine", null, signal), listPlace("shared", null, signal)]);
    return homeListing(mine, shared);
  }
  const decks = listPaths.decks(scope, folder);
  const answer = await api.get<unknown>(decks.path, { query: decks.query, signal });
  const deckList = listOf(answer, "decks").map(toDeck);
  let folders: Folder[];
  if (answer && typeof answer === "object" && !Array.isArray(answer) && Array.isArray((answer as { folders?: unknown }).folders)) {
    folders = ((answer as { folders: unknown[] }).folders).map(toFolder);
  } else {
    const path = listPaths.folders(scope, folder);
    folders = listOf(await api.get<unknown>(path.path, { query: path.query, signal }), "folders").map(toFolder);
  }
  // A folder listing never shows the folder itself.
  const listing = { decks: deckList, folders: folders.filter(item => item.id !== folder) };
  return scope === "shared" && !folder ? topOfShared(listing) : listing;
}

export async function getDeck(id: string, signal?: AbortSignal): Promise<Deck> {
  return toDeck(await api.get<unknown>(`/v1/decks/${seg(id)}`, { signal }));
}

export async function getFolder(id: string, signal?: AbortSignal): Promise<Folder> {
  return toFolder(await api.get<unknown>(`/v1/folders/${seg(id)}`, { signal }));
}

/** A folder and its ancestors, outermost first (walks `parent` up when the service sends no path). */
export async function getFolderPath(id: string, signal?: AbortSignal): Promise<FolderPath> {
  const folder = await getFolder(id, signal);
  const ancestors: Folder[] = [];
  let parent = folder.parent;
  for (let depth = 0; parent && depth < 32; depth++) {
    try {
      const next = await getFolder(parent, signal);
      ancestors.unshift(next);
      parent = next.parent;
    } catch {
      // A folder above that the caller cannot open (shared from the middle): the path starts below it.
      break;
    }
  }
  return { folder, ancestors };
}

export async function createDeck(input: { title?: string; folder?: string | null; from?: { deck: string; version: number } }): Promise<Deck> {
  const body: Record<string, unknown> = {};
  if (input.title) body.title = input.title;
  if (input.folder) body.folder = input.folder;
  if (input.from) body.from = input.from;
  return toDeck(await api.post<unknown>("/v1/decks", body, { idempotencyKey: true }));
}

export async function createFolder(input: { name: string; parent?: string | null }): Promise<Folder> {
  return toFolder(await api.post<unknown>("/v1/folders", { name: input.name, ...(input.parent ? { parent: input.parent } : {}) }, { idempotencyKey: true }));
}

export async function renameItem(kind: ResourceKind, id: string, name: string): Promise<void> {
  await api.patch(`/v1/${collection(kind)}/${seg(id)}`, kind === "deck" ? { title: name } : { name });
}

/** Moves a deck or folder into `folder` (null: the top of the owner's decks). */
export async function moveItem(kind: ResourceKind, id: string, folder: string | null): Promise<void> {
  await api.patch(`/v1/${collection(kind)}/${seg(id)}`, kind === "deck" ? { folder } : { parent: folder });
}

export async function trashItem(kind: ResourceKind, id: string): Promise<void> {
  await api.delete(`/v1/${collection(kind)}/${seg(id)}`);
}

export async function restoreItem(kind: ResourceKind, id: string): Promise<void> {
  await api.post(`/v1/${collection(kind)}/${seg(id)}/untrash`);
}

/** Deletes for good, only from the trash: `confirm` is the deck's title or the folder's name, typed by the owner. */
export async function deleteForever(kind: ResourceKind, id: string, confirm: string): Promise<void> {
  await api.delete(`/v1/${collection(kind)}/${seg(id)}`, { query: { permanent: "true", confirm } });
}

export async function search(q: string, signal?: AbortSignal): Promise<SearchHit[]> {
  return listOf(await api.get<unknown>("/v1/search", { query: { q }, signal }), "results", "decks", "hits").map(toSearchHit);
}
