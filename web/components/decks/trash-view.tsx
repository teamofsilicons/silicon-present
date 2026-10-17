"use client";

/**
 * The trash: decks and folders that were deleted, each with its full history. Restore puts it back where it was;
 * Delete forever (the owner only) asks to type its name first, because that is the only way anything in Present is
 * ever truly gone.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder as FolderIcon, Presentation, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { Input } from "@/components/arc/input/input";
import { LocalTime } from "@/components/foundation/time/local-time";
import { ApiError } from "@/lib/errors";
import { notify, notifyError } from "@/lib/notify";
import { deleteForever, listPlace, restoreItem, type Listing } from "@/lib/present/decks";
import type { ResourceKind } from "@/lib/present/types";
import { ALWAYS_FRESH } from "@/lib/present/fresh";
import styles from "./decks.module.css";

type Entry = { kind: ResourceKind; id: string; name: string; trashedAt: string | null; owner: { uuid: string; id: string } | null };

export function TrashView({ initial, me }: { initial: Listing; me: { uuid: string; id: string } }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const listing = useQuery({ queryKey: ["place", "trash", ""], queryFn: ({ signal }) => listPlace("trash", null, signal), initialData: initial, ...ALWAYS_FRESH });
  const [confirming, setConfirming] = useState<Entry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const entries: Entry[] = [
    ...listing.data.folders.map(folder => ({ kind: "folder" as const, id: folder.id, name: folder.name || "Untitled folder", trashedAt: folder.trashedAt, owner: folder.owner })),
    ...listing.data.decks.map(deck => ({ kind: "deck" as const, id: deck.id, name: deck.title || "Untitled deck", trashedAt: deck.trashedAt, owner: deck.owner })),
  ];

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["place"] });
    router.refresh();
  };

  async function restore(entry: Entry) {
    setBusy(entry.id);
    try {
      await restoreItem(entry.kind, entry.id);
      setNotice(`${entry.name} restored.`);
      notify.success("Restored", `“${entry.name}” is back where it was, with its full history.`);
      await refresh();
    } catch (error) {
      notifyError(error, `Could not restore “${entry.name}”`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.view}>
      <p className="sr-only" role="status" aria-live="polite">{notice}</p>
      <header className={styles.header}>
        <h1 className={styles.title}>Trash</h1>
        <p className={styles.lede}>Deleted decks and folders keep their full history here until their owner deletes them for good.</p>
      </header>
      {entries.length ? (
        <ul role="list" className={styles.list} aria-label="Trash">
          {entries.map(entry => {
            const owned = !entry.owner || entry.owner.uuid === me.uuid;
            return (
              <li key={`${entry.kind}:${entry.id}`} className={styles.row} data-kind={entry.kind}>
                {entry.kind === "folder" ? <FolderIcon size={18} strokeWidth={1.75} aria-hidden="true" className={styles.icon} /> : <Presentation size={18} strokeWidth={1.75} aria-hidden="true" className={styles.icon} />}
                <span className={styles.main}>
                  <span className={styles.name}>{entry.name}</span>
                  <span className={styles.meta}>
                    {entry.kind === "folder" ? "Folder" : "Deck"}
                    {entry.owner && !owned ? <> · Owner {entry.owner.id}</> : null}
                    {entry.trashedAt ? <> · <LocalTime value={entry.trashedAt} prefix="Deleted " /></> : null}
                  </span>
                </span>
                <span className={styles.rowActions}>
                  <Button size="sm" variant="secondary" onClick={() => void restore(entry)} loading={busy === entry.id} disabled={busy === entry.id} aria-label={`Restore ${entry.name}`}>
                    <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
                    Restore
                  </Button>
                  {owned ? (
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(entry)} aria-label={`Delete forever: ${entry.name}`}>
                      <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                      Delete forever
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>The trash is empty</p>
          <p className={styles.emptyText}>Decks and folders you move to the trash appear here, and can be restored at any time.</p>
        </div>
      )}
      {confirming ? (
        <DeleteForeverDialog
          entry={confirming}
          onClose={() => setConfirming(null)}
          onDeleted={async () => {
            setNotice(`${confirming.name} deleted for good.`);
            notify.success("Deleted for good", `“${confirming.name}” and its history are gone.`);
            setConfirming(null);
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function DeleteForeverDialog({ entry, onClose, onDeleted }: { entry: Entry; onClose: () => void; onDeleted: () => Promise<void> }) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const matches = typed.trim() === entry.name.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!matches) return setError(`Type “${entry.name}” exactly to delete it for good.`);
    setBusy(true);
    try {
      await deleteForever(entry.kind, entry.id, entry.name);
      await onDeleted();
    } catch (failure) {
      const problem = ApiError.from(failure);
      setError([problem.message, problem.hint].filter(Boolean).join(" "));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent title={`Delete “${entry.name}” forever?`}>
        <form className={styles.form} onSubmit={submit} noValidate>
          <p className={styles.confirmText}>
            The {entry.kind}{entry.kind === "folder" ? ", everything in it" : ""} and every version of it go for good. This cannot be undone. Type <strong>{entry.name}</strong> to confirm.
          </p>
          <Input label={`Type the ${entry.kind === "deck" ? "deck's title" : "folder's name"}`} value={typed} onChange={event => { setTyped(event.target.value); setError(null); }} error={error ?? undefined} autoFocus autoComplete="off" spellCheck={false} />
          <div className={styles.formActions}>
            <Button type="button" variant="ghost" onClick={onClose}>Keep it</Button>
            <Button type="submit" variant="danger" disabled={!matches || busy} loading={busy}>Delete forever</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
