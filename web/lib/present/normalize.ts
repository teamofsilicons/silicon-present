/**
 * Turns the service's JSON into the types in ./types.ts. Tolerant on purpose (camelCase or snake_case, a bare list or a
 * list under a key, an id or an object), the same way the Rust client is, so a page shows what the service sent
 * instead of breaking on a spelling.
 */
import type { AccountKind } from "../format";
import type {
  Access, Account, Comparison, Deck, ElementChange, Folder, HistoryEvent, Member, MyRole, Presentation, PublicMode, Role,
  SearchHit, SlideChange, Transfer, TransferState, Version,
} from "./types";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

/** The first of `keys` present on `value` (each tried as written and in snake_case). */
function pick(value: Json, ...keys: string[]): unknown {
  for (const key of keys) {
    if (value[key] !== undefined) return value[key];
    const snake = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    if (value[snake] !== undefined) return value[snake];
  }
  return undefined;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : typeof value === "number" ? String(value) : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);

/** A list out of an answer that is a bare array or an object holding one under one of `keys` (or any array). */
export function listOf(value: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  for (const key of [...keys, "items", "results", "data"]) {
    const found = value[key];
    if (Array.isArray(found)) return found;
  }
  const any = Object.values(value).find(Array.isArray);
  return (any as unknown[] | undefined) ?? [];
}

/** One object out of an answer that is the object or `{ key: object }`. */
export function oneOf(value: unknown, key: string): Json {
  if (!isObject(value)) return {};
  const inner = value[key];
  if (isObject(inner) && Object.keys(value).length <= 3 && !("id" in value)) return inner;
  return value;
}

export function toAccount(value: unknown): Account | null {
  if (typeof value === "string") return value ? { uuid: value, id: value, kind: value.startsWith("si:") ? "silicon" : "carbon", displayName: "", pfpUrl: null } : null;
  if (!isObject(value)) return null;
  const id = str(pick(value, "id", "handle")) ?? "";
  const uuid = str(pick(value, "uuid", "sub")) ?? id;
  if (!uuid && !id) return null;
  const rawKind = str(pick(value, "kind"));
  const kind: AccountKind = rawKind === "silicon" || id.startsWith("si:") ? "silicon" : "carbon";
  const name = str(pick(value, "displayName", "name")) ?? "";
  // The service shows the id as the name when the account has none: keep the name empty then, so it is not shown twice.
  return { uuid, id: id || uuid, kind, displayName: name === id ? "" : name, pfpUrl: str(pick(value, "pfpUrl", "pfp", "photo", "avatarUrl")) };
}

const roles = new Set(["owner", "editor", "commenter", "viewer"]);
const toMyRole = (value: unknown): MyRole | null => (typeof value === "string" && roles.has(value) ? (value as MyRole) : null);
const modes = new Set(["off", "view", "comment", "edit"]);
const toMode = (value: unknown): PublicMode => {
  if (typeof value === "string" && modes.has(value)) return value as PublicMode;
  if (value === true) return "view";
  if (isObject(value)) return toMode(pick(value, "mode"));
  return "off";
};

const idOf = (value: unknown): string | null => (isObject(value) ? str(value.id) : str(value));

export function toDeck(value: unknown): Deck {
  const deck = oneOf(value, "deck");
  const slides = pick(deck, "slides");
  return {
    id: str(deck.id) ?? "",
    title: str(pick(deck, "title", "name")) ?? "",
    owner: toAccount(pick(deck, "owner")),
    creator: toAccount(pick(deck, "creator", "createdBy")),
    folder: idOf(pick(deck, "folder", "folderId", "parent")),
    public: toMode(pick(deck, "public", "publicMode")),
    role: toMyRole(pick(deck, "role", "myRole")),
    trashedAt: str(pick(deck, "trashedAt")),
    createdAt: str(pick(deck, "createdAt")),
    updatedAt: str(pick(deck, "updatedAt", "modifiedAt")),
    version: num(pick(deck, "version")),
    slideCount: num(pick(deck, "slideCount", "slidesCount")) ?? (Array.isArray(slides) ? slides.length : null),
  };
}

export function toFolder(value: unknown): Folder {
  const folder = oneOf(value, "folder");
  return {
    id: str(folder.id) ?? "",
    name: str(pick(folder, "name", "title")) ?? "",
    owner: toAccount(pick(folder, "owner")),
    creator: toAccount(pick(folder, "creator", "createdBy")),
    parent: idOf(pick(folder, "parent", "parentId", "folder")),
    role: toMyRole(pick(folder, "role", "myRole")),
    trashedAt: str(pick(folder, "trashedAt")),
    createdAt: str(pick(folder, "createdAt")),
    updatedAt: str(pick(folder, "updatedAt")),
  };
}

export function toMember(value: unknown): Member {
  const member = isObject(value) ? value : {};
  const account = toAccount(pick(member, "account"));
  const email = str(pick(member, "email"));
  const role = (toMyRole(pick(member, "role")) ?? "viewer") as Role | "owner";
  const viaRaw = pick(member, "via", "through", "inherited", "from");
  let via: Member["via"] = null;
  if (isObject(viaRaw)) via = { kind: str(pick(viaRaw, "kind")) === "deck" ? "deck" : "folder", id: str(viaRaw.id) ?? "", name: str(pick(viaRaw, "name", "title")) ?? "" };
  else if (typeof viaRaw === "string" && viaRaw) via = { kind: "folder", id: viaRaw, name: "" };
  const key = str(pick(member, "member", "key")) ?? (account ? account.uuid : email ? `email:${email}` : "");
  return { key, account, email, role, invitedBy: toAccount(pick(member, "invitedBy")), via, pending: !account && !!email };
}

export function toAccess(value: unknown): Access {
  const access = oneOf(value, "access");
  return {
    owner: toAccount(pick(access, "owner")),
    members: listOf(pick(access, "members") ?? [], "members").map(toMember),
    public: toMode(pick(access, "public", "publicMode")),
    role: toMyRole(pick(access, "role", "myRole")),
  };
}

const transferStates = new Set(["pending", "accepted", "declined", "cancelled"]);

export function toTransfer(value: unknown): Transfer {
  const transfer = isObject(value) ? value : {};
  const resource = pick(transfer, "resource", "resourceId");
  const state = str(pick(transfer, "state", "status")) ?? "pending";
  return {
    id: str(transfer.id) ?? "",
    kind: (str(pick(transfer, "kind", "resourceKind")) ?? (isObject(resource) ? str(resource.kind) : null)) === "folder" ? "folder" : "deck",
    resource: idOf(resource) ?? "",
    title: str(pick(transfer, "title", "name")) ?? (isObject(resource) ? str(pick(resource, "title", "name")) ?? "" : ""),
    from: toAccount(pick(transfer, "from", "fromAccount")),
    to: toAccount(pick(transfer, "to", "toAccount")),
    state: (transferStates.has(state) ? state : "pending") as TransferState,
    createdAt: str(pick(transfer, "createdAt")),
  };
}

export function toEvent(value: unknown): HistoryEvent {
  const event = isObject(value) ? value : {};
  const data = pick(event, "data", "details");
  return {
    id: str(event.id) ?? str(pick(event, "seq")) ?? "",
    type: str(pick(event, "type", "kind", "event")) ?? "event",
    actor: toAccount(pick(event, "actor", "account", "by", "who")),
    at: str(pick(event, "at", "createdAt", "time")),
    summary: str(pick(event, "summary", "text", "message")) ?? "",
    data: isObject(data) ? data : event,
  };
}

/** The one origin worth saying out of a version's origins (restore, undo and import before plain edits). */
function originOf(value: unknown): string | null {
  const origins = listOf(value ?? []).map(String);
  return ["restore", "undo", "import", "create"].find(origin => origins.includes(origin)) ?? origins[0] ?? null;
}

export function toVersion(value: unknown): Version {
  const version = isObject(value) ? value : {};
  return {
    version: num(pick(version, "version", "seq", "to")) ?? 0,
    from: num(pick(version, "from", "fromVersion", "fromSeq")),
    author: toAccount(pick(version, "author", "account")),
    startedAt: str(pick(version, "startedAt", "from_at", "start")),
    endedAt: str(pick(version, "endedAt", "at", "end", "createdAt")),
    summary: str(pick(version, "summary")) ?? "",
    name: str(pick(version, "name")),
    namedBy: toAccount(pick(version, "namedBy")),
    origin: str(pick(version, "origin")) ?? originOf(pick(version, "origins")),
    events: listOf(pick(version, "events") ?? []).map(toEvent),
  };
}

/**
 * The versions list. The service may send the events between versions inside each version or beside them in one list
 * (`{ versions, events }`); either way each version ends up carrying the events that happened after it and before the
 * next newer one, sorted newest first.
 */
export function toVersions(value: unknown): Version[] {
  const versions = listOf(value, "versions").map(toVersion).sort((a, b) => b.version - a.version);
  const loose = isObject(value) && Array.isArray(value.events) ? (value.events as unknown[]).map(toEvent) : [];
  if (loose.length && versions.length) {
    for (const event of loose) {
      const at = event.at ? Date.parse(event.at) : NaN;
      const seq = num(event.data.afterVersion ?? event.data.after_version ?? event.data.seq);
      let owner = versions[versions.length - 1]!;
      for (const version of versions) {
        if (seq !== null ? version.version <= seq : !Number.isNaN(at) && version.endedAt && Date.parse(version.endedAt) <= at) {
          owner = version;
          break;
        }
      }
      owner.events.push(event);
    }
  }
  for (const version of versions) version.events.sort((a, b) => (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0));
  return versions;
}

const changes = new Set(["added", "removed", "changed", "moved", "unchanged"]);
const toChange = (value: unknown) => (typeof value === "string" && changes.has(value) ? value : "changed");

function toElementChange(value: unknown): ElementChange {
  const change = isObject(value) ? value : {};
  return {
    element: str(pick(change, "element", "id")) ?? "",
    change: toChange(pick(change, "change", "status", "type")) as ElementChange["change"],
    kind: str(pick(change, "kind", "elementKind")),
    label: str(pick(change, "label", "summary", "text")) ?? "",
    by: listOf(pick(change, "by", "authors") ?? []).map(toAccount).filter((a): a is Account => !!a),
  };
}

function toSlideChange(value: unknown): SlideChange {
  const change = isObject(value) ? value : {};
  return {
    slide: str(pick(change, "slide", "id")) ?? "",
    change: toChange(pick(change, "change", "status", "type")) as SlideChange["change"],
    fromNumber: num(pick(change, "fromNumber", "fromIndex", "before")),
    toNumber: num(pick(change, "toNumber", "toIndex", "after", "number")),
    label: str(pick(change, "label", "summary", "title")) ?? "",
    by: listOf(pick(change, "by", "authors") ?? []).map(toAccount).filter((a): a is Account => !!a),
    elements: listOf(pick(change, "elements") ?? []).map(toElementChange),
  };
}

/**
 * The comparison. The service sends `{ from, to, summary, diff: { slidesAdded, slidesRemoved, slidesMoved,
 * slidesChanged }, authors: { <slideId>: [Account] } }` (present-deck's DeckDiff); a flat `{ slides: [...] }` or
 * `{ added, removed, changed }` is read too. Everything becomes one list of slide changes.
 */
export function toComparison(value: unknown, from: number, to: number): Comparison {
  const body = isObject(value) ? value : {};
  if (Array.isArray(body.slides)) return { from, to, slides: body.slides.map(toSlideChange) };
  const authors = isObject(body.authors) ? body.authors : {};
  const by = (slide: string) => listOf(authors[slide] ?? []).map(toAccount).filter((a): a is Account => !!a);
  const diff = isObject(body.diff) ? body.diff : null;
  if (diff) {
    const slides: SlideChange[] = [];
    const ref = (item: unknown, change: SlideChange["change"]): SlideChange => {
      const r = isObject(item) ? item : {};
      const id = str(r.id) ?? "";
      const number = num(r.number);
      return { slide: id, change, fromNumber: change === "added" ? null : change === "moved" ? num(r.from) : number, toNumber: change === "removed" ? null : number, label: "", by: by(id), elements: [] };
    };
    for (const item of listOf(pick(diff, "slidesAdded") ?? [])) slides.push(ref(item, "added"));
    for (const item of listOf(pick(diff, "slidesRemoved") ?? [])) slides.push(ref(item, "removed"));
    for (const item of listOf(pick(diff, "slidesChanged") ?? [])) {
      const r = isObject(item) ? item : {};
      const id = str(r.id) ?? "";
      const fields = listOf(r.fields ?? []).map(String);
      const elements: ElementChange[] = [];
      const add = (list: unknown, change: ElementChange["change"]) => {
        for (const element of listOf(list ?? [])) {
          const e = isObject(element) ? element : {};
          const changedFields = listOf(e.fields ?? []).map(String);
          elements.push({ element: str(e.id) ?? "", change, kind: str(e.kind), label: `${str(e.kind) ?? "element"}${changedFields.length ? ` (${changedFields.join(", ")})` : ""}`, by: [] });
        }
      };
      add(pick(r, "elementsAdded"), "added");
      add(pick(r, "elementsRemoved"), "removed");
      add(pick(r, "elementsChanged"), "changed");
      if (r.elementsReordered === true || r.elements_reordered === true) elements.push({ element: "", change: "moved", kind: null, label: "the order of elements", by: [] });
      slides.push({ slide: id, change: "changed", fromNumber: num(r.number), toNumber: num(r.number), label: fields.length ? fields.join(", ") : "", by: by(id), elements });
    }
    for (const item of listOf(pick(diff, "slidesMoved") ?? [])) slides.push(ref(item, "moved"));
    return { from, to, slides };
  }
  const slides: SlideChange[] = [];
  for (const kind of ["added", "removed", "changed", "moved"] as const) {
    const group = isObject(body.slides) ? (body.slides as Json)[kind] : body[kind];
    for (const item of listOf(group ?? [])) slides.push({ ...toSlideChange(typeof item === "string" ? { slide: item } : item), change: kind });
  }
  return { from, to, slides };
}

export function toPresentation(value: unknown): Presentation {
  const presentation = oneOf(value, "presentation");
  const slide = pick(presentation, "slide", "slideId");
  return {
    id: str(presentation.id) ?? "",
    deck: idOf(pick(presentation, "deck", "deckId")) ?? "",
    followUrl: str(pick(presentation, "followUrl", "url", "link")) ?? "",
    slide: isObject(slide) ? str(slide.id) : str(slide),
    step: num(pick(presentation, "step")) ?? 0,
    presenter: toAccount(pick(presentation, "presenter", "account", "by")),
    endedAt: str(pick(presentation, "endedAt")),
  };
}

export function toSearchHit(value: unknown): SearchHit {
  const hit = isObject(value) ? value : {};
  const deck = isObject(hit.deck) ? hit.deck : hit;
  // The service sends `matches: [{ where, slideNumber?, text }]`: say where the first one is and quote it.
  const first = listOf(hit.matches ?? []).find(isObject) as Json | undefined;
  if (first) {
    const number = num(pick(first, "slideNumber"));
    const where = str(pick(first, "where"));
    const place = number ? `slide ${number}${where === "notes" ? " notes" : ""}` : where === "title" ? "title" : where;
    return { deck: toDeck(deck), where: place, excerpt: str(pick(first, "text", "snippet")) };
  }
  return { deck: toDeck(deck), where: str(pick(hit, "where", "field", "match")), excerpt: str(pick(hit, "excerpt", "snippet", "text")) };
}
