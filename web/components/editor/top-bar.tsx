"use client";

/**
 * The editor's top bar: back to the decks, the deck's title (edited in place), a quiet word on saving and the
 * connection, who is here (Silicons exactly like Carbons), then Comment, history, download, Share and Present.
 */
import Link from "next/link";
import { ChevronLeft, Clock, MessageSquare, Play } from "lucide-react";
import { Avatar } from "@/components/arc/avatar/avatar";
import { InlineEdit } from "@/components/arc/inline-edit/inline-edit";
import { Tooltip } from "@/components/arc/tooltip/tooltip";
import { AppMark } from "@/components/foundation/brand/app-mark";
import { ButtonLink } from "@/components/foundation/button-link";
import { ExportMenu } from "@/components/export";
import { ShareButton } from "@/components/share";
import { beginSignIn } from "@/lib/client/session";
import { kindNoun } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import { renameItem } from "@/lib/present/decks";
import { keyLabel } from "@/lib/editor/keys";
import { nameOf } from "@/lib/editor/normalize-api";
import { safeColor } from "@/lib/editor/people";
import { useStore } from "@/lib/editor/store";
import type { PresenceState } from "@/lib/live/types";
import { useAbilities, useEditor, useMeta, useUi } from "./editor-context";
import styles from "./editor.module.css";

function Status() {
  const editor = useEditor();
  const { status, synced } = useStore(editor.status, s => s);
  const { canEdit } = useAbilities();
  const words =
    status === "offline"
      ? canEdit
        ? "Offline · your changes are kept here"
        : "Offline"
      : status === "connecting" || !synced
        ? "Connecting…"
        : status === "saving"
          ? "Saving…"
          : canEdit
            ? "All changes saved"
            : "Up to date";
  return (
    <span className={styles.status} role="status" data-status={status} data-testid="connection-status">
      <i className={styles.statusDot} aria-hidden="true" />
      {words}
    </span>
  );
}

function People() {
  const editor = useEditor();
  const { others } = useStore(editor.presence, s => s);
  // One avatar per account (a Carbon may have the deck open twice), Silicons and Carbons alike.
  const byAccount = new Map<string, PresenceState>();
  for (const other of others) if (other.account && !byAccount.has(other.account.uuid)) byAccount.set(other.account.uuid, other);
  const people = [...byAccount.values()];
  if (!people.length) return null;
  const slides = editor.deck().slides;
  return (
    <div className={styles.people} aria-label={`${people.length} more ${people.length === 1 ? "person" : "people"} here`} data-testid="people-here">
      {people.slice(0, 5).map(person => {
        const index = slides.findIndex(s => s.id === person.slide);
        return (
          <Tooltip key={person.account.uuid} content={`${nameOf(person.account)} · ${person.account.id} · ${kindNoun(person.account.kind)}${index >= 0 ? ` · slide ${index + 1}` : ""}`} side="bottom">
            <button
              type="button"
              className={styles.person}
              style={{ ["--ring" as string]: safeColor(person.color, person.account.uuid) }}
              onClick={() => person.slide && slides.some(s => s.id === person.slide) && editor.goToSlide(person.slide)}
              aria-label={`${nameOf(person.account)}, ${kindNoun(person.account.kind)}${index >= 0 ? `, on slide ${index + 1}. Go there` : ""}`}
              data-person={person.account.id}
            >
              <Avatar name={person.account.display_name || person.account.id.replace(/^(c|si):/, "")} src={person.account.pfp_url ?? undefined} size="sm" />
            </button>
          </Tooltip>
        );
      })}
      {people.length > 5 ? <span className={styles.morePeople}>+{people.length - 5}</span> : null}
    </div>
  );
}

export function TopBar({ phone = false }: { phone?: boolean }) {
  const editor = useEditor();
  const meta = useMeta();
  const { canEdit, canComment, signInToComment, signedIn } = useAbilities();
  const { commentMode, panel, panelOpen } = useUi(s => ({ commentMode: s.commentMode, panel: s.panel, panelOpen: s.panelOpen }));
  const slideId = useUi(s => s.slideId);
  const rename = async (title: string) => {
    const next = title.trim() || "Untitled deck";
    const before = meta.title;
    editor.meta.set({ title: next });
    try {
      await renameItem("deck", editor.deckId, next);
    } catch (error) {
      editor.meta.set({ title: before });
      notifyError(error, "The deck was not renamed");
      throw error;
    }
  };
  const commentsOpen = panelOpen && panel === "comments";
  return (
    <header className={styles.topBar}>
      <div className={styles.topLeft}>
        {signedIn ? (
          <Link href="/decks" className={styles.back} aria-label="Back to your decks">
            <ChevronLeft size={16} aria-hidden="true" />
            <AppMark size={26} />
          </Link>
        ) : (
          <Link href="/" className={styles.back} aria-label="Silicon Present">
            <AppMark size={26} />
          </Link>
        )}
        <div className={styles.titleBox}>
          {canEdit && !phone ? (
            <InlineEdit value={meta.title} onSave={rename} label="Deck title" variant="title" />
          ) : (
            <h1 className={styles.title} data-testid="deck-title">
              {meta.title}
            </h1>
          )}
          {!phone ? <Status /> : null}
        </div>
      </div>
      <div className={styles.topRight}>
        {!phone ? <People /> : null}
        {canEdit && !phone ? (
          <Tooltip content={`Comment mode · ${keyLabel("Mod+Alt+M")}`} side="bottom">
            <button type="button" className={styles.topButton} aria-pressed={commentMode} data-active={commentMode || undefined} onClick={() => editor.ui.set({ commentMode: !commentMode, panel: "comments", panelOpen: true, editing: null })} data-testid="comment-mode" data-sq="surface">
              <MessageSquare size={16} aria-hidden="true" />
              <span>Comment</span>
            </button>
          </Tooltip>
        ) : null}
        {!canEdit && (canComment || signInToComment || phone) ? (
          <button type="button" className={styles.topButton} aria-pressed={commentsOpen} data-active={commentsOpen || undefined} onClick={() => editor.ui.set({ panel: "comments", panelOpen: !commentsOpen })} data-testid="toggle-comments" data-sq="surface">
            <MessageSquare size={16} aria-hidden="true" />
            <span>Comments</span>
          </button>
        ) : null}
        {canEdit && !phone ? (
          <Tooltip content="Version history" side="bottom">
            <Link href={`/decks/${encodeURIComponent(editor.deckId)}/history`} className={styles.topIcon} aria-label="Version history" data-sq="surface">
              <Clock size={16} aria-hidden="true" />
            </Link>
          </Tooltip>
        ) : null}
        {!phone ? <ExportMenu deck={editor.deckId} slide={slideId} iconOnly label="Download" /> : null}
        {(meta.role === "owner" || meta.role === "editor") && !phone ? <ShareButton kind="deck" id={editor.deckId} name={meta.title} selfId={editor.me?.id} role={meta.role} size="sm" onChanged={access => editor.meta.set({ publicMode: access.public })} /> : null}
        {!signedIn ? (
          <button type="button" className={styles.topButton} onClick={() => beginSignIn()} data-sq="surface">
            Sign in
          </button>
        ) : null}
        <ButtonLink href={`/decks/${encodeURIComponent(editor.deckId)}/present${slideId ? `?slide=${encodeURIComponent(slideId)}` : ""}`} size="sm" data-testid="present">
          <Play size={14} aria-hidden="true" /> Present
        </ButtonLink>
      </div>
    </header>
  );
}
