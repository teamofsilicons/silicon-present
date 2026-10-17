/**
 * Comments: the service calls (docs/architecture.md, "Comments"), and building anchors with their snapshot labels, so a
 * comment still says what it was on after its slide or element is gone.
 */
import * as Y from "yjs";
import { richTextToPlain, type DeckJson, type Element } from "@silicon-present/deck";
import { api, seg } from "@/lib/client/api";
import { fromBase64, toBase64 } from "@/lib/live/base64";
import type { LiveAccount } from "@/lib/live/types";
import { readAccount, readThread } from "./normalize-api";
import type { Anchor, AnchorSnapshot, Thread } from "./types";

export async function createThread(deckId: string, anchor: Anchor, body: string, me: string | null): Promise<Thread> {
  const answer = await api.post<unknown>(`/v1/decks/${seg(deckId)}/threads`, { anchor, body }, { idempotencyKey: true });
  return readThread(answer, me);
}

export async function replyTo(threadId: string, body: string, me: string | null): Promise<Thread | null> {
  const answer = await api.post<unknown>(`/v1/threads/${seg(threadId)}/replies`, { body }, { idempotencyKey: true });
  const thread = readThread(answer, me);
  return thread.id ? thread : null;
}

export async function setResolved(threadId: string, resolved: boolean, me: string | null): Promise<Thread | null> {
  const answer = await api.post<unknown>(`/v1/threads/${seg(threadId)}/${resolved ? "resolve" : "reopen"}`);
  const thread = readThread(answer, me);
  return thread.id ? thread : null;
}

export async function editComment(commentId: string, body: string): Promise<void> {
  await api.patch(`/v1/comments/${seg(commentId)}`, { body });
}

export async function deleteComment(commentId: string): Promise<void> {
  await api.delete(`/v1/comments/${seg(commentId)}`);
}

export async function react(commentId: string, emoji: string, on: boolean): Promise<void> {
  if (on) await api.put(`/v1/comments/${seg(commentId)}/reactions/${seg(emoji)}`);
  else await api.delete(`/v1/comments/${seg(commentId)}/reactions/${seg(emoji)}`);
}

/** Accounts a mention can name: anyone the service can resolve by c:/si: id (or a prefix of one). */
export async function resolveAccounts(q: string): Promise<LiveAccount[]> {
  if (!q.trim()) return [];
  try {
    const answer = await api.get<unknown>("/v1/accounts/resolve", { query: { q } });
    const o = (answer ?? {}) as { account?: unknown; accounts?: unknown[]; matches?: unknown[] };
    const list = Array.isArray(answer) ? answer : (o.accounts ?? o.matches ?? (o.account ? [o.account] : [answer]));
    return list.map(readAccount).filter(Boolean) as LiveAccount[];
  } catch {
    return [];
  }
}

/** Everyone the deck is shared with (and its owner), for @ suggestions. Viewers may not be allowed to list them. */
export async function deckMembers(deckId: string): Promise<LiveAccount[]> {
  try {
    const answer = await api.get<unknown>(`/v1/decks/${seg(deckId)}/access`);
    const o = (answer ?? {}) as Record<string, unknown>;
    const list = (Array.isArray(answer) ? answer : (o.members ?? o.access ?? o.items ?? [])) as unknown[];
    const out: LiveAccount[] = [];
    const owner = readAccount(o.owner);
    if (owner) out.push(owner);
    for (const item of list) {
      const entry = (item ?? {}) as Record<string, unknown>;
      const account = readAccount(entry.account ?? entry.member ?? entry);
      if (account && account.id.includes(":")) out.push(account);
    }
    return out;
  } catch {
    return [];
  }
}

// ---- anchors ----

const KIND_NAMES: Record<Element["kind"], string> = {
  text: "Text",
  shape: "Shape",
  image: "Image",
  video: "Video",
  audio: "Audio",
  table: "Table",
  chart: "Chart",
  html: "HTML element",
};

function clip(text: string, max = 48): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** A few words that say which element this is: "Text “Q4 results”", "Chart “Revenue”", "HTML element". */
export function elementLabel(element: Element): string {
  const kind = KIND_NAMES[element.kind] ?? "Element";
  let words = "";
  if (element.kind === "text" || element.kind === "shape") words = richTextToPlain(element.text);
  else if (element.kind === "chart") words = element.chart.title ?? "";
  else if (element.kind === "image" || element.kind === "video" || element.kind === "audio") words = element.alt;
  else if (element.kind === "table") words = element.cells[0]?.map(cell => richTextToPlain(cell.text)).join(" ") ?? "";
  words = clip(words);
  return words ? `${kind} “${words}”` : kind;
}

function slideTitle(deck: DeckJson, slideId: string): string {
  const slide = deck.slides.find(s => s.id === slideId);
  const text = slide?.elements.find(e => e.kind === "text" && richTextToPlain(e.text).trim());
  return text && (text.kind === "text" || text.kind === "shape") ? clip(richTextToPlain(text.text), 40) : "";
}

export function slideNumberOf(deck: DeckJson, slideId: string): number | undefined {
  const index = deck.slides.findIndex(s => s.id === slideId);
  return index >= 0 ? index + 1 : undefined;
}

export function snapshotFor(deck: DeckJson, anchor: Anchor): AnchorSnapshot {
  if (anchor.kind === "deck") return { label: "The whole deck" };
  const slideNumber = slideNumberOf(deck, anchor.slide);
  const where = slideNumber ? `slide ${slideNumber}` : "the master";
  const slide = anchor.slide === "master" ? { elements: deck.master.elements } : deck.slides.find(s => s.id === anchor.slide);
  const element = "element" in anchor && anchor.element ? slide?.elements.find(e => e.id === anchor.element) : undefined;
  const base = { slideNumber, ...(element ? { elementKind: element.kind } : {}) };
  switch (anchor.kind) {
    case "slide": {
      const title = slideTitle(deck, anchor.slide);
      return { ...base, label: title ? `Slide ${slideNumber} “${title}”` : `Slide ${slideNumber ?? ""}`.trim() };
    }
    case "element":
      return { ...base, label: element ? `${elementLabel(element)} on ${where}` : `An element on ${where}` };
    case "text":
      return { ...base, label: `“${clip(anchor.quote, 60)}” in ${element ? elementLabel(element) : "a text"} on ${where}` };
    case "point":
      return { ...base, label: element ? `A point on ${elementLabel(element)}, ${where}` : `A point on ${where}` };
    case "area":
      return { ...base, label: element ? `An area of ${elementLabel(element)}, ${where}` : `An area of ${where}` };
  }
}

export function withSnapshot(deck: DeckJson, anchor: Anchor): Anchor {
  return { ...anchor, snapshot: snapshotFor(deck, anchor) } as Anchor;
}

export function encodeRelative(text: Y.Text, index: number): string {
  return toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index)));
}

export function decodeRelative(doc: Y.Doc, value: string | undefined): number | null {
  if (!value) return null;
  try {
    const absolute = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(value)), doc);
    return absolute ? absolute.index : null;
  } catch {
    return null;
  }
}

/** The slide an anchor is on (null for the whole deck). */
export function anchorSlide(anchor: Anchor): string | null {
  return anchor.kind === "deck" ? null : anchor.slide;
}

export function anchorElement(anchor: Anchor): string | null {
  return "element" in anchor && anchor.element ? anchor.element : null;
}

/** Mentions in a body: @c:handle and @si:handle. */
export const MENTION_RE = /@((?:c|si):[a-z0-9][a-z0-9._-]*)/gi;
