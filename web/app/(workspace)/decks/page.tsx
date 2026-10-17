/**
 * /decks: My decks and Shared with me, folders inside them with breadcrumbs (`?folder=<id>`), search, a new deck, a new
 * folder and opening a file. `?scope=shared` is Shared with me. The first paint comes from the service here; the list
 * then lives in DecksView (components/decks).
 */
import type { Metadata } from "next";
import { DecksView } from "@/components/decks/decks-view";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { loadFolderPath, loadPlace } from "@/lib/present/server";
import type { Scope } from "@/lib/present/types";
import { requireSession } from "@/lib/server/rsc";

export const metadata: Metadata = { title: "Decks" };

export default async function DecksPage({ searchParams }: PageProps<"/decks">) {
  const params = await searchParams;
  const scope: Scope = params.scope === "shared" ? "shared" : "mine";
  const folder = typeof params.folder === "string" && params.folder ? params.folder : null;
  const [session, listing, path] = await Promise.all([requireSession(), loadPlace(scope, folder), folder ? loadFolderPath(folder) : Promise.resolve(null)]);
  return (
    <Page width="reading">
      {listing.error ? (
        <>
          <PageHeader title={scope === "shared" ? "Shared with me" : "Decks"} />
          <ErrorAlert error={listing.error} title="Your decks could not be loaded" />
        </>
      ) : (
        <DecksView key={`${scope}:${folder ?? ""}`} scope={scope} folder={folder} path={path && !path.error ? path.data : null} initial={listing.data} me={{ uuid: session.account.uuid, id: session.account.id }} />
      )}
    </Page>
  );
}
