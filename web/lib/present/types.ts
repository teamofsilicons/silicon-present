/**
 * What the Present service sends and accepts (docs/architecture.md, "The service"), typed for the pages. Field names
 * are camelCase on the wire; the normalisers in ./normalize.ts also accept snake_case spellings and answers that wrap a
 * list or an object in a key, so a page never breaks on a small difference in shape.
 *
 * Isomorphic: no browser or Node APIs. The editor imports these too.
 */
import type { AccountKind } from "../format";

export type Role = "editor" | "commenter" | "viewer";
/** The caller's own role on a deck or folder: the three invite roles, or the owner. */
export type MyRole = Role | "owner";
export type PublicMode = "off" | "view" | "comment" | "edit";
export type ResourceKind = "deck" | "folder";
export type Scope = "mine" | "shared" | "trash";

/** A Carbon or Silicon as Present shows them: always by c:/si: id and display name, keyed by uuid. */
export interface Account {
  uuid: string;
  id: string;
  kind: AccountKind;
  displayName: string;
  pfpUrl: string | null;
}

export interface Deck {
  id: string;
  title: string;
  owner: Account | null;
  creator: Account | null;
  /** The folder it is in, or null at the top of the owner's decks. */
  folder: string | null;
  public: PublicMode;
  /** The caller's effective role (null for an anonymous visitor of a public deck: then `public` says what they may do). */
  role: MyRole | null;
  trashedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  version: number | null;
  slideCount: number | null;
}

export interface Folder {
  id: string;
  name: string;
  owner: Account | null;
  creator: Account | null;
  parent: string | null;
  role: MyRole | null;
  trashedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A folder and the way down to it from the top (first = outermost), for breadcrumbs. */
export interface FolderPath {
  folder: Folder;
  ancestors: Folder[];
}

export interface Member {
  /** The key for PATCH/DELETE .../access/{member}: an account uuid or `email:<address>`. */
  key: string;
  account: Account | null;
  /** A pending email invite (no account yet). */
  email: string | null;
  role: Role | "owner";
  invitedBy: Account | null;
  /** Set when the access comes through a folder (then it is changed on that folder). */
  via: { kind: ResourceKind; id: string; name: string } | null;
  pending: boolean;
}

export interface Access {
  owner: Account | null;
  members: Member[];
  /** Decks only. */
  public: PublicMode;
  /** The caller's own role on it. */
  role: MyRole | null;
}

export type TransferState = "pending" | "accepted" | "declined" | "cancelled";

export interface Transfer {
  id: string;
  kind: ResourceKind;
  resource: string;
  title: string;
  from: Account | null;
  to: Account | null;
  state: TransferState;
  createdAt: string | null;
}

/** A non-content event shown in the history next to versions (renames, sharing, public switch, trash, transfers…). */
export interface HistoryEvent {
  id: string;
  type: string;
  actor: Account | null;
  at: string | null;
  /** The service's own sentence for it, when it sends one. */
  summary: string;
  data: Record<string, unknown>;
}

export interface Version {
  /** The version number: the last update in the run (open the deck at it with `version=N`). */
  version: number;
  /** The first update in the run. */
  from: number | null;
  author: Account | null;
  startedAt: string | null;
  endedAt: string | null;
  summary: string;
  name: string | null;
  namedBy: Account | null;
  origin: string | null;
  /** Events that happened after this version and before the next newer one. */
  events: HistoryEvent[];
}

export type ChangeKind = "added" | "removed" | "changed" | "moved";

export interface ElementChange {
  element: string;
  change: ChangeKind;
  kind: string | null;
  label: string;
  by: Account[];
}

export interface SlideChange {
  slide: string;
  change: ChangeKind | "unchanged";
  /** 1-based numbers in each version (null when it is not there). */
  fromNumber: number | null;
  toNumber: number | null;
  label: string;
  by: Account[];
  elements: ElementChange[];
}

export interface Comparison {
  from: number;
  to: number;
  slides: SlideChange[];
}

export interface Presentation {
  id: string;
  deck: string;
  followUrl: string;
  /** The slide being shown: its id. */
  slide: string | null;
  step: number;
  presenter: Account | null;
  endedAt: string | null;
}

export interface Asset {
  id: string;
  url: string;
  contentType: string;
  size: number;
}

export interface SearchHit {
  deck: Deck;
  /** Where it matched ("title", "slide 3", "notes"…) and a short excerpt, when the service sends them. */
  where: string | null;
  excerpt: string | null;
}

export const ROLES: readonly Role[] = ["editor", "commenter", "viewer"];
export const PUBLIC_MODES: readonly PublicMode[] = ["off", "view", "comment", "edit"];

export const ROLE_WORDS: Record<Role | "owner", { label: string; text: string }> = {
  owner: { label: "Owner", text: "Owns it" },
  editor: { label: "Editor", text: "Can edit, comment and invite others" },
  commenter: { label: "Commenter", text: "Can view and comment" },
  viewer: { label: "Viewer", text: "Can only view" },
};

/** What a role allows, in one place (the Share dialog and the pages ask this, not the role names). */
export const can = {
  edit: (role: MyRole | null | undefined) => role === "owner" || role === "editor",
  comment: (role: MyRole | null | undefined) => role === "owner" || role === "editor" || role === "commenter",
  share: (role: MyRole | null | undefined) => role === "owner" || role === "editor",
  own: (role: MyRole | null | undefined) => role === "owner",
};

/** Export formats (UNDERSTANDING.md "Formats"; docs/architecture.md `GET /v1/decks/{id}/export`). */
export type ExportFormat = "pptx" | "ppt" | "key" | "odp" | "pdf" | "html" | "png" | "jpg";

export const EXPORT_FORMATS: ReadonlyArray<{ format: ExportFormat; label: string; extension: string; note?: string }> = [
  { format: "pptx", label: "PowerPoint", extension: ".pptx" },
  { format: "ppt", label: "PowerPoint 97–2003", extension: ".ppt" },
  { format: "key", label: "Keynote", extension: ".key" },
  { format: "odp", label: "OpenDocument", extension: ".odp" },
  { format: "pdf", label: "PDF", extension: ".pdf" },
  { format: "html", label: "Web page", extension: ".html", note: "One file; HTML elements stay live" },
  { format: "png", label: "PNG images", extension: ".zip", note: "One image per slide, in a .zip" },
  { format: "jpg", label: "JPG images", extension: ".zip", note: "One image per slide, in a .zip" },
];

/** Files Present opens (UNDERSTANDING.md "Formats", plus a deck's own pictures, video and audio as slides). */
export const IMPORT_ACCEPT = [
  ".pptx", ".ppt", ".key", ".odp", ".pdf", ".html", ".htm",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".m4a", ".ogg",
].join(",");
