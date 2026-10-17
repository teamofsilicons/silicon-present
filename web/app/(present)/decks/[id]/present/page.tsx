/** /decks/[id]/present: present mode. Opens without signing in for a public deck. `?slide=<id>` starts there. */
import type { Metadata } from "next";
import { PresentMode } from "@/components/present/present-mode";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { Page } from "@/components/foundation/layout/layout";
import { loadDeckForViewing } from "@/lib/present/load-public";

export const metadata: Metadata = { title: "Present" };

export default async function PresentPage({ params, searchParams }: PageProps<"/decks/[id]/present">) {
  const { id } = await params;
  const query = await searchParams;
  const loaded = await loadDeckForViewing(id, `/decks/${id}/present`);
  if (loaded.error) return <Page width="narrow"><ErrorAlert error={loaded.error} title="This deck could not be opened" /></Page>;
  if (!loaded.content.slides.length) return <Page width="narrow"><ErrorAlert error={{ status: 0, message: "This deck has no slides yet, so there is nothing to present.", hint: "Add a slide in the editor first." }} title="Nothing to present" /></Page>;
  return <PresentMode deckId={id} title={loaded.deck.title || "Untitled deck"} deck={loaded.content} signedIn={loaded.signedIn} initialSlide={typeof query.slide === "string" ? query.slide : null} />;
}
