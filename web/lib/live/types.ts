/**
 * What the service's live stream (`GET /v1/decks/{id}/live`) sends, as docs/architecture.md ("Live editing") names it.
 * The account shape is read loosely: the service shows Carbons and Silicons by their current c:/si: id, display name
 * and photo, keyed on the uuid.
 */

export interface LiveAccount {
  uuid: string;
  id: string;
  kind: "carbon" | "silicon";
  display_name?: string | null;
  pfp_url?: string | null;
}

export interface LiveCursor {
  x: number;
  y: number;
}

export interface PresenceState {
  session: string;
  account: LiveAccount;
  slide: string | null;
  selection: string[];
  cursor: LiveCursor | null;
  color: string;
  /** When this browser last heard from that session (epoch ms). */
  seenAt: number;
}

export interface SyncEvent {
  update: string;
  sv: string;
  version: number;
}

export interface UpdateEvent {
  update: string;
  author: LiveAccount | null;
  version: number;
  origin?: string;
  summary?: string | null;
  touched?: string[];
}

export interface DeckMetaEvent {
  title?: string;
  [key: string]: unknown;
}

export type ConnectionStatus =
  /** Opening the stream for the first time. */
  | "connecting"
  /** The stream is open and nothing waits to be sent. */
  | "live"
  /** Local changes are on their way to the service. */
  | "saving"
  /** The stream dropped; changes are kept here (and in IndexedDB) and sent when it is back. */
  | "offline";
