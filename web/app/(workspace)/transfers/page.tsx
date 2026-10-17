/** /transfers: decks and folders offered to you (accept or decline) and the ones you offered (cancel). */
import type { Metadata } from "next";
import { TransfersView } from "@/components/decks/transfers-view";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { Page } from "@/components/foundation/layout/layout";
import { loadTransfers } from "@/lib/present/server";
import { requireSession } from "@/lib/server/rsc";

export const metadata: Metadata = { title: "Transfers" };

export default async function TransfersPage() {
  const [session, transfers] = await Promise.all([requireSession(), loadTransfers()]);
  return (
    <Page width="reading">
      {transfers.error ? <ErrorAlert error={transfers.error} title="Transfers could not be loaded" /> : <TransfersView initial={transfers.data} me={{ uuid: session.account.uuid, id: session.account.id }} />}
    </Page>
  );
}
