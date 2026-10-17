/**
 * What the editor reads from the service besides the deck document: the deck's metadata and the caller's role, and
 * comment threads. The service's answers are read loosely (lib/editor/normalize-api.ts) so a field named slightly
 * differently doesn't break the page; docs/architecture.md is the contract.
 */
import type { LiveAccount } from "@/lib/live/types";

export type Role = "owner" | "editor" | "commenter" | "viewer";
export type PublicMode = "off" | "view" | "comment" | "edit";

export interface DeckMeta {
  id: string;
  title: string;
  role: Role | null;
  publicMode: PublicMode;
  owner: LiveAccount | null;
  creator: LiveAccount | null;
  trashed: boolean;
}

export type Anchor =
  | { kind: "deck"; snapshot?: AnchorSnapshot }
  | { kind: "slide"; slide: string; snapshot?: AnchorSnapshot }
  | { kind: "point"; slide: string; x: number; y: number; element?: string; ex?: number; ey?: number; snapshot?: AnchorSnapshot }
  | { kind: "area"; slide: string; x: number; y: number; w: number; h: number; element?: string; ex?: number; ey?: number; ew?: number; eh?: number; snapshot?: AnchorSnapshot }
  | { kind: "element"; slide: string; element: string; snapshot?: AnchorSnapshot }
  | { kind: "text"; slide: string; element: string; field: string; quote: string; start?: string; end?: string; snapshot?: AnchorSnapshot };

export interface AnchorSnapshot {
  slideNumber?: number;
  elementKind?: string;
  label: string;
}

export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
  accounts: LiveAccount[];
}

export interface CommentItem {
  id: string;
  author: LiveAccount | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  reactions: Reaction[];
}

export interface Thread {
  id: string;
  anchor: Anchor;
  /** Whether what it's on (its slide or element) is still in the deck. */
  exists: boolean;
  state: "open" | "resolved";
  resolvedBy: LiveAccount | null;
  resolvedAt: string | null;
  createdAt: string;
  comments: CommentItem[];
}

export interface Me {
  uuid: string;
  id: string;
  kind: "carbon" | "silicon";
  display_name: string;
  pfp_url: string | null;
}
