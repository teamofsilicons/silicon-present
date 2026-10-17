/** /decks/[id]/presenter: the presenter view (notes, current and next slide, timer), in step with present mode. */
import type { Metadata } from "next";
import { PresenterView } from "@/components/present/presenter-view";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { Page } from "@/components/foundation/layout/layout";
import { loadDeckForViewing } from "@/lib/present/load-public";
import { requireSession } from "@/lib/server/rsc";

export const metadata: Metadata = { title: "Presenter view" };

export default async function PresenterPage({ params }: PageProps<"/decks/[id]/presenter">) {
  const { id } = await params;
  await requireSession(`/decks/${id}/presenter`);
  const loaded = await loadDeckForViewing(id, `/decks/${id}/presenter`);
  if (loaded.error) return <Page width="narrow"><ErrorAlert error={loaded.error} title="This deck could not be opened" /></Page>;
  if (!loaded.content.slides.length) return <Page width="narrow"><ErrorAlert error={{ status: 0, message: "This deck has no slides yet, so there is nothing to present.", hint: "Add a slide in the editor first." }} title="Nothing to present" /></Page>;
  return <PresenterView deckId={id} title={loaded.deck.title || "Untitled deck"} deck={loaded.content} />;
}
