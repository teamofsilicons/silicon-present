/**
 * /decks/[id]: the deck. Editors get the editor; commenters, viewers and visitors of a public deck get the same canvas
 * to read and (when they may) comment on. The deck's content comes over the live connection in the browser; the server
 * only reads the deck's metadata and the caller's role, so the page opens at once.
 */
import type { Metadata } from "next";
import { FileWarning, LockKeyhole } from "lucide-react";
import { Problem } from "@/components/foundation/feedback/problem";
import { ButtonLink } from "@/components/foundation/button-link";
import { EditorApp } from "@/components/editor/editor-app";
import { loadDeckPage } from "@/lib/editor/server";
import { ViewerEmailGate } from "@/components/share/viewer-email-gate";

export async function generateMetadata({ params }: PageProps<"/decks/[id]">): Promise<Metadata> {
  const { id } = await params;
  const { meta } = await loadDeckPage(id);
  return { title: meta?.title ?? "Deck" };
}

export default async function DeckPage({ params, searchParams }: PageProps<"/decks/[id]">) {
  const { id } = await params;
  const query = await searchParams;
  const slide = typeof query.slide === "string" ? query.slide : null;
  const thread = typeof query.thread === "string" ? query.thread : null;
  const { me, meta, error } = await loadDeckPage(id);
  if (error?.code === "email_required") return <ViewerEmailGate />;
  if (!meta) {
    const status = error?.status ?? 0;
    const signedOut = !me;
    const back = new URLSearchParams(Object.entries({ slide, thread }).filter(([, v]) => v) as [string, string][]).toString();
    const here = `/decks/${encodeURIComponent(id)}${back ? `?${back}` : ""}`;
    if (status === 401 || status === 403 || (signedOut && status === 404)) {
      return (
        <Problem
          icon={<LockKeyhole size={20} />}
          title={signedOut ? "Sign in to open this deck" : "You can't open this deck"}
          actions={
            signedOut ? (
              <ButtonLink href={`/auth/sign-in?return_to=${encodeURIComponent(here)}`}>Sign in</ButtonLink>
            ) : (
              <ButtonLink href="/decks" variant="secondary">
                Go to your decks
              </ButtonLink>
            )
          }
        >
          {signedOut
            ? "This deck isn't public. If it was shared with you, sign in with that account."
            : `${error?.message ?? "It wasn't shared with you."} ${error?.hint ?? "Ask its owner to share it with you."}`}
        </Problem>
      );
    }
    return (
      <Problem icon={<FileWarning size={20} />} title={status === 404 ? "There is no deck at this address" : "This deck could not be opened"} actions={<ButtonLink href="/decks" variant="secondary">Go to your decks</ButtonLink>}>
        {error ? `${error.message} ${error.hint ?? ""}` : "Check the link, or open the deck from your decks."}
      </Problem>
    );
  }
  return <EditorApp deckId={id} meta={meta} me={me} initialSlide={slide} initialThread={thread} />;
}
