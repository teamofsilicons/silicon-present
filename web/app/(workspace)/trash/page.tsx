/** /trash: everything deleted, with its full history: restore it, or delete it for good (asks to type its name). */
import type { Metadata } from "next";
import { TrashView } from "@/components/decks/trash-view";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { Page } from "@/components/foundation/layout/layout";
import { loadPlace } from "@/lib/present/server";
import { requireSession } from "@/lib/server/rsc";

export const metadata: Metadata = { title: "Trash" };

export default async function TrashPage() {
  const [session, listing] = await Promise.all([requireSession(), loadPlace("trash", null)]);
  return (
    <Page width="reading">
      {listing.error ? <ErrorAlert error={listing.error} title="The trash could not be loaded" /> : <TrashView initial={listing.data} me={{ uuid: session.account.uuid, id: session.account.id }} />}
    </Page>
  );
}
