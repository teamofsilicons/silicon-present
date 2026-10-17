/**
 * The normalisers in lib/present read the service's answers as it really sends them (crates/present-service/src/views.rs
 * and routes/*.rs), and stay tolerant of small differences in shape.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toAccess, toAccount, toComparison, toDeck, toPresentation, toSearchHit, toTransfer, toVersions } from "../lib/present/normalize";
import { listPaths, topOfShared, transfersFrom } from "../lib/present/paths";
import { can } from "../lib/present/types";

const ada = { uuid: "0b6c-ada", id: "c:ada", kind: "carbon", displayName: "Ada Lovelace", pfp: "https://iris.example/pfp/carbon?id=ada" };
const scout = { uuid: "5f1e-scout", id: "si:scout", kind: "silicon", displayName: "si:scout", pfp: "https://iris.example/pfp/silicon?id=scout" };

test("an account keeps its id, kind and photo; a name that is only the id is no name", () => {
  assert.deepEqual(toAccount(ada), { uuid: "0b6c-ada", id: "c:ada", kind: "carbon", displayName: "Ada Lovelace", pfpUrl: "https://iris.example/pfp/carbon?id=ada" });
  const silicon = toAccount(scout)!;
  assert.equal(silicon.kind, "silicon");
  assert.equal(silicon.displayName, "", "the service shows the id as the name when there is none");
  assert.equal(toAccount(null), null);
  assert.equal(toAccount({ uuid: "u1", id: "", kind: "carbon", displayName: "" })!.id, "u1", "an account the service could not name is shown by its key, never as blank");
});

test("a deck as the service sends it (views.rs deck_json)", () => {
  const deck = toDeck({ id: "dk7Hq2mP9xRt", title: "Q4 review", owner: ada, creator: scout, folder: null, publicMode: "comment", role: "owner", version: 42, trashedAt: null, createdAt: "2026-10-17T08:00:00Z", updatedAt: "2026-10-17T09:00:00Z", link: "http://x/decks/dk7Hq2mP9xRt" });
  assert.equal(deck.public, "comment");
  assert.equal(deck.role, "owner");
  assert.equal(deck.version, 42);
  assert.equal(deck.creator?.id, "si:scout");
  assert.equal(deck.folder, null);
  assert.equal(toDeck({ deck: { id: "a", title: "Wrapped" } }).title, "Wrapped", "a deck wrapped in a key is read too");
});

test("who has access: owner, members through a folder, pending email invites (sharing.rs)", () => {
  const access = toAccess({
    owner: ada,
    publicMode: "view",
    role: "editor",
    members: [
      { member: "5f1e-scout", account: scout, email: null, pending: false, role: "editor", invitedBy: ada, via: null },
      { member: "email:bo@example.test", account: null, email: "bo@example.test", pending: true, role: "viewer", invitedBy: ada, via: null },
      { member: "0b6c-ada", account: ada, role: "commenter", via: { kind: "folder", id: "fd1", name: "Plans" } },
    ],
  });
  assert.equal(access.public, "view");
  assert.equal(access.role, "editor");
  assert.equal(access.members[0]!.key, "5f1e-scout");
  assert.equal(access.members[1]!.key, "email:bo@example.test");
  assert.equal(access.members[1]!.pending, true);
  assert.deepEqual(access.members[2]!.via, { kind: "folder", id: "fd1", name: "Plans" });
});

test("listings ask for the top of My decks explicitly; the top of Shared with me shows folder decks in their folder", () => {
  assert.deepEqual(listPaths.decks("mine", null).query, { scope: "mine", folder: "root" });
  assert.deepEqual(listPaths.folders("mine", null).query, { scope: "mine", parent: "root" });
  assert.deepEqual(listPaths.decks("shared", null).query, { scope: "shared", folder: undefined });
  assert.deepEqual(listPaths.decks("mine", "fd1").query, { scope: "mine", folder: "fd1" });
  const top = topOfShared({
    folders: [toDeck({ id: "fd1" }) as never],
    decks: [toDeck({ id: "d1", folder: "fd1" }), toDeck({ id: "d2", folder: null }), toDeck({ id: "d3", folder: "private" })],
  });
  assert.deepEqual(top.decks.map(deck => deck.id), ["d2", "d3"]);
});

test("transfers come as incoming and outgoing, the resource carrying its kind and name", () => {
  const list = transfersFrom({
    incoming: [{ id: "t1", resource: { kind: "folder", id: "fd1", name: "Plans" }, from: scout, to: ada, state: "pending", createdAt: "2026-10-17T08:00:00Z" }],
    outgoing: [{ id: "t2", resource: { kind: "deck", id: "dk1", name: "Q4" }, from: ada, to: scout, state: "declined" }],
  });
  assert.deepEqual(list.map(item => [item.id, item.kind, item.resource, item.title, item.state]), [["t1", "folder", "fd1", "Plans", "pending"], ["t2", "deck", "dk1", "Q4", "declined"]]);
  assert.equal(toTransfer({ id: "t3", status: "accepted" }).state, "accepted");
});

test("versions newest first, each with the events after it, and the origin worth saying", () => {
  const versions = toVersions({
    versions: [
      { version: 3, from: 3, author: ada, startedAt: "2026-10-17T08:00:00Z", endedAt: "2026-10-17T08:00:00Z", origins: ["edit"], summary: "c:ada added a slide", name: null },
      { version: 9, from: 4, author: scout, startedAt: "2026-10-17T09:00:00Z", endedAt: "2026-10-17T09:10:00Z", origins: ["ops", "restore"], summary: "si:scout restored version 3", name: "Sent to the client", namedBy: ada },
    ],
    events: [
      { id: 1, kind: "deck.renamed", actor: ada, data: { from: "A", to: "B" }, createdAt: "2026-10-17T08:30:00Z" },
      { id: 2, kind: "shared", actor: ada, data: { member: "si:scout" }, createdAt: "2026-10-17T09:30:00Z" },
    ],
  });
  assert.deepEqual(versions.map(version => version.version), [9, 3]);
  assert.equal(versions[0]!.origin, "restore");
  assert.equal(versions[0]!.name, "Sent to the client");
  assert.equal(versions[0]!.namedBy?.id, "c:ada");
  assert.deepEqual(versions[0]!.events.map(event => event.type), ["shared"], "after the newest version");
  assert.deepEqual(versions[1]!.events.map(event => event.type), ["deck.renamed"], "between version 3 and version 9");
});

test("a comparison from present-deck's DeckDiff becomes one list of slide changes with who changed them", () => {
  const comparison = toComparison({
    from: 3,
    to: 9,
    summary: "…",
    diff: {
      deckFields: [],
      slidesAdded: [{ id: "s_new001", number: 2 }],
      slidesRemoved: [{ id: "s_old001", number: 3 }],
      slidesMoved: [{ id: "s_mov001", number: 1, from: 4 }],
      slidesChanged: [{ id: "s_chg001", number: 1, fields: ["notes"], elementsAdded: [{ id: "e_a00001", kind: "text" }], elementsRemoved: [], elementsChanged: [{ id: "e_c00001", kind: "shape", fields: ["x", "y"] }], elementsReordered: false }],
    },
    authors: { s_new001: [scout], s_chg001: [ada, scout] },
  }, 3, 9);
  const byId = Object.fromEntries(comparison.slides.map(slide => [slide.slide, slide]));
  assert.equal(byId.s_new001!.change, "added");
  assert.equal(byId.s_new001!.toNumber, 2);
  assert.deepEqual(byId.s_new001!.by.map(account => account.id), ["si:scout"]);
  assert.equal(byId.s_old001!.change, "removed");
  assert.equal(byId.s_old001!.fromNumber, 3);
  assert.equal(byId.s_mov001!.fromNumber, 4);
  assert.equal(byId.s_chg001!.label, "notes");
  assert.deepEqual(byId.s_chg001!.elements.map(element => [element.change, element.label]), [["added", "text"], ["changed", "shape (x, y)"]]);
});

test("a presentation and a search hit as the service sends them", () => {
  const presentation = toPresentation({ id: "pr1", deck: "dk1", presenter: ada, slide: "s_abc123", slideNumber: 2, step: 1, followUrl: "http://x/p/pr1", endedAt: null });
  assert.deepEqual([presentation.deck, presentation.slide, presentation.step, presentation.presenter?.id], ["dk1", "s_abc123", 1, "c:ada"]);
  const hit = toSearchHit({ deck: { id: "dk1", title: "Q4" }, matches: [{ where: "text", slide: "s_1", slideNumber: 3, text: "…pelican migration…" }] });
  assert.equal(hit.where, "slide 3");
  assert.equal(hit.excerpt, "…pelican migration…");
});

test("what a role allows", () => {
  assert.ok(can.edit("owner") && can.edit("editor") && !can.edit("commenter") && !can.edit(null));
  assert.ok(can.comment("commenter") && !can.comment("viewer"));
  assert.ok(can.own("owner") && !can.own("editor"));
});
