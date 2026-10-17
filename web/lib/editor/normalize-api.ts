/**
 * Reads the service's JSON into the editor's shapes. Lenient on purpose: snake_case or camelCase, an account as an
 * object or missing, a role under `role`, `my_role` or `access.role`.
 */
import type { LiveAccount } from "@/lib/live/types";
import type { Anchor, CommentItem, DeckMeta, PublicMode, Reaction, Role, Thread } from "./types";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === "object" ? (value as Obj) : {});
const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const pick = (o: Obj, ...keys: string[]): unknown => {
  for (const key of keys) if (o[key] !== undefined && o[key] !== null) return o[key];
  return undefined;
};

export function readAccount(value: unknown): LiveAccount | null {
  const o = obj(value);
  const uuid = str(pick(o, "uuid", "sub", "account_uuid"));
  const id = str(pick(o, "id", "handle", "public_id"));
  if (!uuid && !id) return null;
  const kind = str(pick(o, "kind"), id.startsWith("si:") ? "silicon" : "carbon") as LiveAccount["kind"];
  return {
    uuid: uuid || id,
    id: id || uuid,
    kind: kind === "silicon" ? "silicon" : "carbon",
    display_name: (pick(o, "display_name", "displayName", "name") as string | undefined) ?? null,
    pfp_url: (pick(o, "pfp_url", "pfpUrl", "pfp", "photo") as string | undefined) ?? null,
  };
}

const ROLES: Role[] = ["owner", "editor", "commenter", "viewer"];

export function readDeckMeta(value: unknown, fallbackId: string): DeckMeta {
  const o = obj(pick(obj(value), "deck") ?? value);
  const roleRaw = str(pick(o, "role", "my_role", "myRole", "effective_role", "effectiveRole") ?? pick(obj(o.access), "role"));
  const role = (ROLES.includes(roleRaw as Role) ? roleRaw : null) as Role | null;
  const publicRaw = pick(o, "public", "public_mode", "publicMode");
  const publicMode = (typeof publicRaw === "string" ? publicRaw : str(pick(obj(publicRaw), "mode"), "off")) as PublicMode;
  return {
    id: str(o.id, fallbackId),
    title: str(o.title, "Untitled deck"),
    role,
    publicMode: ["off", "view", "comment", "edit"].includes(publicMode) ? publicMode : "off",
    owner: readAccount(o.owner),
    creator: readAccount(o.creator),
    trashed: Boolean(pick(o, "trashed_at", "trashedAt", "trashed")),
  };
}

function readReactions(value: unknown, me: string | null): Reaction[] {
  if (Array.isArray(value)) {
    return value.map(item => {
      const o = obj(item);
      const accounts = (Array.isArray(o.accounts) ? o.accounts : Array.isArray(o.by) ? o.by : []).map(readAccount).filter(Boolean) as LiveAccount[];
      const count = typeof o.count === "number" ? o.count : accounts.length || 1;
      const mine = typeof o.mine === "boolean" ? o.mine : Boolean(me && accounts.some(a => a.uuid === me || a.id === me));
      return { emoji: str(o.emoji), count, mine, accounts };
    });
  }
  // { "👍": [account, ...] }
  return Object.entries(obj(value)).map(([emoji, list]) => {
    const accounts = (Array.isArray(list) ? list : []).map(readAccount).filter(Boolean) as LiveAccount[];
    return { emoji, count: accounts.length, mine: Boolean(me && accounts.some(a => a.uuid === me)), accounts };
  });
}

export function readComment(value: unknown, me: string | null): CommentItem {
  const o = obj(value);
  return {
    id: str(o.id),
    author: readAccount(pick(o, "author", "account", "by")),
    body: str(o.body ?? ""),
    createdAt: str(pick(o, "created_at", "createdAt")),
    editedAt: (pick(o, "edited_at", "editedAt") as string | undefined) ?? null,
    deleted: Boolean(pick(o, "deleted", "deleted_at", "deletedAt")),
    reactions: readReactions(o.reactions, me),
  };
}

export function readThread(value: unknown, me: string | null): Thread {
  const o = obj(pick(obj(value), "thread") ?? value);
  const comments = (Array.isArray(o.comments) ? o.comments : Array.isArray(o.replies) ? o.replies : []).map(c => readComment(c, me));
  const state = str(pick(o, "state", "status"), pick(o, "resolved_at", "resolvedAt") ? "resolved" : "open");
  // The service takes its own snapshot when the comment is made and sends it next to the anchor.
  const anchor = { kind: "deck", ...obj(o.anchor) } as unknown as Anchor;
  const snapshot = obj(o.snapshot);
  if (snapshot.label) (anchor as { snapshot?: unknown }).snapshot = snapshot;
  const current = obj(o.current);
  return {
    id: str(o.id),
    anchor,
    exists: current.exists === undefined ? true : Boolean(current.exists),
    state: state === "resolved" ? "resolved" : "open",
    resolvedBy: readAccount(pick(o, "resolved_by", "resolvedBy")),
    resolvedAt: (pick(o, "resolved_at", "resolvedAt") as string | undefined) ?? null,
    createdAt: str(pick(o, "created_at", "createdAt"), comments[0]?.createdAt ?? ""),
    comments,
  };
}

export function readThreads(value: unknown, me: string | null): Thread[] {
  const list = Array.isArray(value) ? value : (pick(obj(value), "threads", "items", "data") as unknown[] | undefined) ?? [];
  return list.map(t => readThread(t, me));
}

/** How an account is named on screen: the display name when known, else the c:/si: id. */
export function nameOf(account: LiveAccount | null | undefined): string {
  if (!account) return "Someone";
  return account.display_name?.trim() || account.id;
}
