"use client";

/**
 * One thread: what it is on, its comments (author, time, body with mentions, reactions), a reply field, and
 * resolve/reopen. Your own comments can be edited and deleted.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, MoreHorizontal, RotateCcw, SmilePlus } from "lucide-react";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Button } from "@/components/arc/button/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/arc/popover/popover";
import { formatRelative, formatDateTime, kindNoun } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import type { LiveAccount } from "@/lib/live/types";
import { anchorText, deckMembers, deleteComment, editComment, MENTION_RE, react, replyTo, setResolved } from "@/lib/editor/comments";
import { nameOf } from "@/lib/editor/normalize-api";
import type { CommentItem, Thread } from "@/lib/editor/types";
import type { Editor } from "@/lib/editor/editor";
import { MentionInput } from "./mention-input";
import styles from "./comments.module.css";

export const REACTIONS = ["👍", "❤️", "🎉", "😄", "👀", "✅"];

const memberCache = new Map<string, Promise<LiveAccount[]>>();

export function useMembers(deckId: string, enabled: boolean): LiveAccount[] {
  const [members, setMembers] = useState<LiveAccount[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    if (!memberCache.has(deckId)) memberCache.set(deckId, deckMembers(deckId));
    void memberCache.get(deckId)!.then(list => {
      if (alive) setMembers(list);
    });
    return () => {
      alive = false;
    };
  }, [deckId, enabled]);
  return members;
}

export function CommentBody({ body }: { body: string }) {
  const parts = useMemo(() => {
    const out: { text: string; mention: boolean }[] = [];
    let last = 0;
    for (const match of body.matchAll(MENTION_RE)) {
      if (match.index! > last) out.push({ text: body.slice(last, match.index), mention: false });
      out.push({ text: match[0], mention: true });
      last = match.index! + match[0].length;
    }
    if (last < body.length) out.push({ text: body.slice(last), mention: false });
    return out;
  }, [body]);
  return (
    <p className={styles.body}>
      {parts.map((part, index) =>
        part.mention ? (
          <span key={index} className={styles.mention}>
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

function Person({ account }: { account: LiveAccount | null }) {
  const name = nameOf(account);
  return (
    <span className={styles.person}>
      <Avatar name={account?.display_name || account?.id.replace(/^(c|si):/, "") || "?"} src={account?.pfp_url ?? undefined} size="sm" />
      <span className={styles.personText}>
        <span className={styles.personName}>{name}</span>
        {account ? (
          <span className={styles.personId}>
            {account.display_name && account.display_name !== account.id ? `${account.id} · ` : ""}
            {kindNoun(account.kind)}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function CommentRow({ comment, thread, editor, canComment, members }: { comment: CommentItem; thread: Thread; editor: Editor; canComment: boolean; members: LiveAccount[] }) {
  const me = editor.me;
  const mine = Boolean(me && comment.author && (comment.author.uuid === me.uuid || comment.author.id === me.id));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const patchComment = (patch: Partial<CommentItem>) => {
    editor.upsertThread({ ...thread, comments: thread.comments.map(c => (c.id === comment.id ? { ...c, ...patch } : c)) });
  };

  const toggleReaction = async (emoji: string) => {
    setPickerOpen(false);
    const existing = comment.reactions.find(r => r.emoji === emoji);
    const on = !existing?.mine;
    const reactions = existing
      ? comment.reactions.map(r => (r.emoji === emoji ? { ...r, mine: on, count: Math.max(0, r.count + (on ? 1 : -1)) } : r)).filter(r => r.count > 0)
      : [...comment.reactions, { emoji, count: 1, mine: true, accounts: [] }];
    patchComment({ reactions });
    try {
      await react(comment.id, emoji, on);
    } catch (error) {
      notifyError(error, "The reaction was not saved");
      void editor.loadThreads();
    }
  };

  const save = async () => {
    const body = draft.trim();
    if (!body) return;
    setEditing(false);
    patchComment({ body, editedAt: new Date().toISOString() });
    try {
      await editComment(comment.id, body);
    } catch (error) {
      notifyError(error, "The comment was not changed");
      void editor.loadThreads();
    }
  };

  const remove = async () => {
    setMenuOpen(false);
    const first = thread.comments[0]?.id === comment.id;
    if (first && thread.comments.length === 1) editor.removeThread(thread.id);
    else patchComment({ deleted: true });
    try {
      await deleteComment(comment.id);
    } catch (error) {
      notifyError(error, "The comment was not deleted");
      void editor.loadThreads();
    }
  };

  if (comment.deleted) {
    return (
      <li className={styles.comment}>
        <p className={styles.deleted}>This comment was deleted.</p>
      </li>
    );
  }

  return (
    <li className={styles.comment}>
      <div className={styles.commentHead}>
        <Person account={comment.author} />
        <time className={styles.time} dateTime={comment.createdAt} title={formatDateTime(comment.createdAt)}>
          {formatRelative(comment.createdAt)}
          {comment.editedAt ? " · edited" : ""}
        </time>
        {mine ? (
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={styles.iconButton} aria-label="Comment actions">
                <MoreHorizontal size={16} aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className={styles.menu}>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  setMenuOpen(false);
                  setDraft(comment.body);
                  setEditing(true);
                }}
              >
                Edit
              </button>
              <button type="button" className={styles.menuItem} data-danger onClick={() => void remove()}>
                Delete
              </button>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
      {editing ? (
        <div className={styles.editBox}>
          <MentionInput label="Edit comment" value={draft} onChange={setDraft} onSubmit={() => void save()} onCancel={() => setEditing(false)} members={members} autoFocus />
          <div className={styles.actionsRow}>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={!draft.trim()}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <CommentBody body={comment.body} />
      )}
      <div className={styles.reactions}>
        {comment.reactions.map(reaction => (
          <button
            key={reaction.emoji}
            type="button"
            className={styles.reaction}
            data-mine={reaction.mine || undefined}
            data-sq="surface"
            disabled={!canComment}
            onClick={() => void toggleReaction(reaction.emoji)}
            aria-label={`${reaction.emoji} ${reaction.count}${reaction.mine ? ", you reacted" : ""}`}
            aria-pressed={reaction.mine}
          >
            <span aria-hidden="true">{reaction.emoji}</span> {reaction.count}
          </button>
        ))}
        {canComment ? (
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={styles.iconButton} aria-label="React">
                <SmilePlus size={15} aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className={styles.picker}>
              {REACTIONS.map(emoji => (
                <button key={emoji} type="button" className={styles.pickerItem} onClick={() => void toggleReaction(emoji)} aria-label={`React with ${emoji}`}>
                  {emoji}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    </li>
  );
}

export function ThreadView({ thread, editor, canComment, compact, onClose }: { thread: Thread; editor: Editor; canComment: boolean; compact?: boolean; onClose?: () => void }) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const members = useMembers(editor.deckId, canComment);
  const me = editor.me?.uuid ?? null;

  const send = async () => {
    const body = reply.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const next = await replyTo(thread.id, body, me);
      setReply("");
      if (next) editor.upsertThread(next);
      else void editor.loadThreads();
    } catch (error) {
      notifyError(error, "The reply was not sent");
    } finally {
      setSending(false);
    }
  };

  const toggleResolved = async () => {
    const resolved = thread.state !== "resolved";
    editor.upsertThread({ ...thread, state: resolved ? "resolved" : "open", resolvedAt: resolved ? new Date().toISOString() : null });
    try {
      const next = await setResolved(thread.id, resolved, me);
      if (next) editor.upsertThread(next);
      if (resolved) onClose?.();
    } catch (error) {
      notifyError(error, resolved ? "The thread was not resolved" : "The thread was not reopened");
      void editor.loadThreads();
    }
  };

  return (
    <div className={styles.thread} data-compact={compact || undefined} data-state={thread.state}>
      <div className={styles.threadHead}>
        <span className={styles.anchorLabel} title={anchorText(thread.anchor)}>
          {anchorText(thread.anchor)}
          {thread.exists ? "" : " · no longer in the deck"}
        </span>
        {canComment ? (
          <button type="button" className={styles.resolve} onClick={() => void toggleResolved()} aria-label={thread.state === "resolved" ? "Reopen thread" : "Resolve thread"} title={thread.state === "resolved" ? "Reopen" : "Resolve"}>
            {thread.state === "resolved" ? <RotateCcw size={15} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
            <span>{thread.state === "resolved" ? "Reopen" : "Resolve"}</span>
          </button>
        ) : null}
      </div>
      {thread.state === "resolved" ? <p className={styles.resolvedNote}>Resolved{thread.resolvedBy ? ` by ${nameOf(thread.resolvedBy)}` : ""}</p> : null}
      <ul className={styles.comments}>
        {thread.comments.map(comment => (
          <CommentRow key={comment.id} comment={comment} thread={thread} editor={editor} canComment={canComment} members={members} />
        ))}
      </ul>
      {canComment ? (
        <div className={styles.replyBox}>
          <MentionInput label="Reply" placeholder="Reply" value={reply} onChange={setReply} onSubmit={() => void send()} onCancel={onClose} members={members} rows={1} />
          {reply.trim() ? (
            <div className={styles.actionsRow}>
              <Button size="sm" onClick={() => void send()} loading={sending}>
                Reply
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
