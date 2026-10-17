/**
 * The pure parts of the service's shapes that Server Components and the browser share: which paths a listing reads,
 * how the top of Shared with me is trimmed, and how the transfers answer is read. No browser or server APIs here.
 */
import { listOf, toTransfer } from "./normalize";
import type { Deck, Folder, Scope, Transfer } from "./types";

export interface Listing {
  decks: Deck[];
  folders: Folder[];
}

/**
 * The paths a listing reads, shared by the server page and the client view. At the top of My decks the service is asked
 * for `folder=root` / `parent=root` (without it, scope=mine lists every deck and folder the caller owns).
 */
export const listPaths = {
  decks: (scope: Scope, folder?: string | null) => ({ path: "/v1/decks", query: { scope, folder: folder ?? (scope === "mine" ? "root" : undefined) } }),
  folders: (scope: Scope, parent?: string | null) => ({ path: "/v1/folders", query: { scope, parent: parent ?? (scope === "mine" ? "root" : undefined) } }),
};

/**
 * At the top of Shared with me the service lists every deck shared with the caller, also those inside shared folders;
 * those show inside their folder instead (decks deeper down in a shared folder's subfolders still show at the top).
 */
export function topOfShared(listing: Listing): Listing {
  const shared = new Set(listing.folders.map(folder => folder.id));
  return { folders: listing.folders, decks: listing.decks.filter(deck => !deck.folder || !shared.has(deck.folder)) };
}

/** Every transfer in an answer: the service sends `{ incoming, outgoing }`; a plain list is read too. */
export function transfersFrom(answer: unknown): Transfer[] {
  if (answer && typeof answer === "object" && !Array.isArray(answer) && ("incoming" in answer || "outgoing" in answer)) {
    const body = answer as { incoming?: unknown; outgoing?: unknown };
    return [...listOf(body.incoming ?? []), ...listOf(body.outgoing ?? [])].map(toTransfer);
  }
  return listOf(answer, "transfers").map(toTransfer);
}
