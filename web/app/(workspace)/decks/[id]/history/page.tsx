/**
 * /decks/[id]/history: every version of a deck, newest first, with who made it and the events between (renames,
 * sharing, the public switch, trash, transfers). Open any version read-only, compare two slide by slide, restore a
 * whole version or bring back one slide or element, undo one account's changes since a version, name a version, or
 * make a new deck from it. Anyone who can edit the deck.
 */
import type { Metadata } from "next";
import { HistoryView } from "@/components/history/history-view";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { loadDeck, loadVersions } from "@/lib/present/server";
import { can } from "@/lib/present/types";
import { requireSession } from "@/lib/server/rsc";

export async function generateMetadata({ params }: PageProps<"/decks/[id]/history">): Promise<Metadata> {
  const { id } = await params;
  const deck = await loadDeck(id);
  return { title: deck.data ? `History of ${deck.data.title || "Untitled deck"}` : "History" };
}

export default async function HistoryPage({ params }: PageProps<"/decks/[id]/history">) {
  const { id } = await params;
  const [session, deck, versions] = await Promise.all([requireSession(), loadDeck(id), loadVersions(id)]);
  if (deck.error) return <Page width="reading"><PageHeader title="History" /><ErrorAlert error={deck.error} title="This deck could not be opened" /></Page>;
  const role = deck.data.owner?.uuid === session.account.uuid ? "owner" : deck.data.role;
  return (
    <Page>
      {versions.error ? (
        <>
          <PageHeader title="History" back={{ href: `/decks/${encodeURIComponent(id)}`, label: "Back to the deck" }} />
          <ErrorAlert error={versions.error} title={can.edit(role) ? "The history could not be loaded" : "Only people who can edit see the history"} />
        </>
      ) : (
        <HistoryView deck={deck.data} initial={versions.data} canEdit={can.edit(role)} />
      )}
    </Page>
  );
}
