"use client";

/**
 * The box a new comment is written in, opened right where someone clicked or dragged on the slide (or in the comments
 * panel for a whole slide or the whole deck). Signed-out visitors of a public deck that allows comments are asked to
 * sign in first, coming back to the same slide.
 */
import { useState } from "react";
import { Button } from "@/components/arc/button/button";
import { beginSignIn } from "@/lib/client/session";
import { notifyError } from "@/lib/notify";
import { createThread, withSnapshot } from "@/lib/editor/comments";
import type { Editor } from "@/lib/editor/editor";
import type { Anchor } from "@/lib/editor/types";
import { MentionInput } from "./mention-input";
import { useMembers } from "./thread-view";
import styles from "./comments.module.css";

export function CommentComposer({ editor, anchor, onDone }: { editor: Editor; anchor: Anchor; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const canComment = editor.canComment;
  const members = useMembers(editor.deckId, canComment);
  const label = withSnapshot(editor.deck(), anchor).snapshot?.label;

  if (!canComment) {
    return (
      <div className={styles.composer} data-sq="surface" role="dialog" aria-label="Comment">
        <p className={styles.composerLabel}>{label}</p>
        <p className={styles.signInText}>{editor.signInToComment ? "Sign in to comment on this deck." : "You can view this deck but not comment on it."}</p>
        <div className={styles.actionsRow}>
          <Button size="sm" variant="ghost" onClick={onDone}>
            Close
          </Button>
          {editor.signInToComment ? (
            <Button size="sm" onClick={() => beginSignIn()}>
              Sign in
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const thread = await createThread(editor.deckId, withSnapshot(editor.deck(), anchor), text, editor.me?.uuid ?? null);
      if (thread.id) {
        editor.upsertThread(thread);
        editor.ui.set({ activeThread: thread.id });
      } else void editor.loadThreads();
      onDone();
    } catch (error) {
      notifyError(error, "The comment was not posted");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={styles.composer} data-sq="surface" role="dialog" aria-label="New comment" onPointerDown={event => event.stopPropagation()}>
      <p className={styles.composerLabel}>{label}</p>
      <MentionInput
        label="Comment"
        placeholder="Add a comment. @ mentions a Carbon or Silicon"
        value={body}
        onChange={setBody}
        onSubmit={() => void send()}
        onCancel={onDone}
        members={members}
        autoFocus
        rows={3}
      />
      <div className={styles.actionsRow}>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void send()} disabled={!body.trim()} loading={sending}>
          Comment
        </Button>
      </div>
    </div>
  );
}
