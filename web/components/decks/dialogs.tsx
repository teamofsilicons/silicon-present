"use client";

/**
 * The small dialogs of the decks pages: naming something (a new deck, a new folder, renaming), moving a deck or folder
 * into one of your folders, and transferring it to another Carbon or Silicon.
 */
import { useEffect, useState, type FormEvent } from "react";
import { ChevronRight, Folder as FolderIcon } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { Input } from "@/components/arc/input/input";
import { ApiError } from "@/lib/errors";
import { parseAccountId } from "@/lib/ids";
import { listPlace } from "@/lib/present/decks";
import type { Folder, ResourceKind } from "@/lib/present/types";
import styles from "./decks.module.css";

export interface NameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  initial?: string;
  submitLabel: string;
  /** An empty name is allowed (the service names it). */
  optional?: boolean;
  pending?: boolean;
  onSubmit: (value: string) => void | Promise<void>;
}

export function NameDialog(props: NameDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent title={props.title} description={props.description}>
        {/* The form mounts each time the dialog opens, so it starts from the name it is about. */}
        <NameForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

function NameForm({ onOpenChange, label, placeholder, initial = "", submitLabel, optional, pending, onSubmit }: NameDialogProps) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = value.trim();
    if (!text && !optional) {
      setError(`Type a ${label.toLowerCase()}.`);
      return;
    }
    if (text.length > 200) {
      setError(`That is ${text.length} characters; keep it to 200.`);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <Input label={label} value={value} placeholder={placeholder} onChange={event => { setValue(event.target.value); setError(null); }} error={error ?? undefined} autoFocus maxLength={240} />
      <div className={styles.formActions}>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" loading={busy || pending} disabled={busy || pending}>{submitLabel}</Button>
      </div>
    </form>
  );
}

export interface MoveDialogProps {
  kind: ResourceKind;
  id: string;
  name: string;
  /** The folder it is in now (null: the top of My decks). */
  current: string | null;
  onClose: () => void;
  onMove: (destination: { id: string | null; name: string }) => void | Promise<void>;
}

/** Pick one of your folders (or the top of My decks), going down folder by folder. */
export function MoveDialog({ kind, id, name, current, onClose, onMove }: MoveDialogProps) {
  const [trail, setTrail] = useState<Folder[]>([]);
  // What was loaded, with the folder it is for: switching folders shows "Loading" until that folder answers.
  const [loaded, setLoaded] = useState<{ at: string | null; folders: Folder[] | null; error: ApiError | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const at = trail[trail.length - 1] ?? null;

  useEffect(() => {
    const controller = new AbortController();
    const place = at?.id ?? null;
    listPlace("mine", place, controller.signal)
      .then(listing => setLoaded({ at: place, folders: listing.folders.filter(folder => !(kind === "folder" && folder.id === id)), error: null }))
      .catch(failure => { const problem = ApiError.from(failure); if (problem.code !== "aborted") setLoaded({ at: place, folders: null, error: problem }); });
    return () => controller.abort();
  }, [at?.id, id, kind]);
  const fresh = loaded && loaded.at === (at?.id ?? null) ? loaded : null;
  const folders = fresh?.folders ?? null;
  const error = fresh?.error ?? null;

  const here = { id: at?.id ?? null, name: at?.name || "My decks" };
  const already = (at?.id ?? null) === (current ?? null);

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent title={`Move “${name}”`} description="Choose one of your folders.">
        <nav aria-label="Folder to move into" className={styles.crumbs}>
          <ol role="list">
            <li><button type="button" className={styles.crumbButton} onClick={() => setTrail([])} aria-current={trail.length === 0 ? "location" : undefined}>My decks</button></li>
            {trail.map((folder, index) => (
              <li key={folder.id}><ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" /><button type="button" className={styles.crumbButton} onClick={() => setTrail(trail.slice(0, index + 1))} aria-current={index === trail.length - 1 ? "location" : undefined}>{folder.name || "Untitled folder"}</button></li>
            ))}
          </ol>
        </nav>
        {error ? <p className={styles.formError} role="alert">{[error.message, error.hint].filter(Boolean).join(" ")}</p> : null}
        {folders === null && !error ? <p className={styles.muted}>Loading your folders…</p> : null}
        {folders && folders.length ? (
          <ul role="list" className={styles.pickList}>
            {folders.map(folder => (
              <li key={folder.id}>
                <button type="button" className={styles.pick} data-sq="surface" onClick={() => setTrail([...trail, folder])}>
                  <FolderIcon size={16} strokeWidth={1.75} aria-hidden="true" />
                  <span>{folder.name || "Untitled folder"}</span>
                  <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" className={styles.pickChevron} />
                </button>
              </li>
            ))}
          </ul>
        ) : folders ? <p className={styles.muted}>{at ? "No folders inside this one." : "You have no folders yet. Make one with New folder."}</p> : null}
        <div className={styles.formActions}>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={busy || already} loading={busy} onClick={async () => { setBusy(true); try { await onMove(here); } finally { setBusy(false); } }}>
            {already ? "It is already here" : `Move to ${here.name}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface TransferDialogProps {
  kind: ResourceKind;
  name: string;
  selfId: string;
  onClose: () => void;
  onTransfer: (to: string) => Promise<void>;
}

/** Offer a deck or folder to another Carbon or Silicon; it moves only once they accept. */
export function TransferDialog({ kind, name, selfId, onClose, onTransfer }: TransferDialogProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseAccountId(value);
    if (!parsed.ok) return setError(parsed.message);
    if (parsed.value.id === selfId.toLowerCase()) return setError(`It is already yours. Type the id of the Carbon or Silicon to give it to.`);
    setBusy(true);
    try {
      await onTransfer(parsed.value.id);
    } catch (failure) {
      const problem = ApiError.from(failure);
      setError([problem.message, problem.hint].filter(Boolean).join(" "));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent title={`Transfer “${name}”`} description={`The ${kind} becomes theirs once they accept, with its full history${kind === "folder" ? " and everything in it" : ""}. Until then you can cancel.`}>
        <form className={styles.form} onSubmit={submit} noValidate>
          <Input label="Give it to" placeholder="c:ada or si:writer" value={value} onChange={event => { setValue(event.target.value); setError(null); }} error={error ?? undefined} autoFocus autoComplete="off" spellCheck={false} autoCapitalize="none" />
          <div className={styles.formActions}>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={busy} disabled={busy}>Offer transfer</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
