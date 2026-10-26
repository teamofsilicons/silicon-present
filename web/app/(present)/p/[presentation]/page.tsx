/**
 * /p/[presentation]: follow a presentation live. Anyone who can view the deck can follow, and anyone at all when the
 * deck is public (no sign-in).
 */
import type { Metadata } from "next";
import { FollowView } from "@/components/present/follow-view";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { Page } from "@/components/foundation/layout/layout";
import { loadDeckForViewing } from "@/lib/present/load-public";
import { toPresentation } from "@/lib/present/normalize";
import { optionalApiFetch, signInHref } from "@/lib/session-optional";
import { redirect } from "next/navigation";
import { ViewerEmailGate } from "@/components/share/viewer-email-gate";

export const metadata: Metadata = { title: "Follow along" };

export default async function FollowPage({ params }: PageProps<"/p/[presentation]">) {
  const { presentation: id } = await params;
  const here = `/p/${id}`;
  const answer = await optionalApiFetch<unknown>(`/v1/presentations/${encodeURIComponent(id)}`);
  if (answer.error) {
    if (answer.error.code === "email_required") return <ViewerEmailGate />;
    if (!answer.signedIn && [401, 403].includes(answer.error.status)) redirect(signInHref(here));
    return <Page width="narrow"><ErrorAlert error={answer.error} title={answer.error.status === 404 ? "This presentation is not running" : "This presentation could not be opened"} /></Page>;
  }
  const presentation = toPresentation(answer.data);
  const loaded = await loadDeckForViewing(presentation.deck, here);
  if (loaded.error?.code === "email_required") return <ViewerEmailGate />;
  if (loaded.error) return <Page width="narrow"><ErrorAlert error={loaded.error} title="The deck could not be opened" /></Page>;
  return <FollowView presentation={presentation} deck={loaded.content} title={loaded.deck.title || "Untitled deck"} />;
}
