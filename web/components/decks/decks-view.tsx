"use client";

/**
 * One place of decks: the top of My decks or Shared with me, or one folder (with its breadcrumbs). One quiet list,
 * folders first, then decks; each row has a "More actions" menu (open, rename, share, move, transfer, move to trash) as
 * the caller's role allows. Above it: New deck (the one primary action), New folder, Open a file (a new deck from any
 * supported file, with progress), and search across every deck the caller can open.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, ChevronRight, ExternalLink, Folder as FolderIcon, FolderInput, FolderPlus, History as HistoryIcon, MonitorPlay, Pencil, Plus, Presentation, Trash2, Upload, UserPlus } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Progress } from "@/components/arc/progress/progress";
import { SearchField } from "@/components/arc/search-field/search-field";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { LocalTime } from "@/components/foundation/time/local-time";
import { ActionMenu, type ActionMenuItem } from "@/components/menu/action-menu";
import { ShareDialog } from "@/components/share";
import { ApiError } from "@/lib/errors";
import { notify, notifyError } from "@/lib/notify";
import { createDeck, createFolder, listPlace, moveItem, renameItem, search, trashItem, type Listing } from "@/lib/present/decks";
import { importFile, type ImportProgress } from "@/lib/present/files";
import { ALWAYS_FRESH } from "@/lib/present/fresh";
import { startTransfer } from "@/lib/present/transfers";
import { can, IMPORT_ACCEPT, type Deck, type Folder, type FolderPath, type ResourceKind, type Scope, type SearchHit } from "@/lib/present/types";
import { MoveDialog, NameDialog, TransferDialog } from "./dialogs";
import styles from "./decks.module.css";

export interface DecksViewProps {
  scope: Scope;
  folder: string | null;
  path: FolderPath | null;
  initial: Listing;
  me: { uuid: string; id: string };
}

type Item = { kind: "folder"; item: Folder } | { kind: "deck"; item: Deck };
type Dialog =
  | { type: "new-deck" }
  | { type: "new-folder" }
  | { type: "rename"; target: Item }
  | { type: "move"; target: Item }
  | { type: "transfer"; target: Item }
  | { type: "share"; target: Item }
  | null;

const nameOf = (entry: Item) => (entry.kind === "deck" ? entry.item.title || "Untitled deck" : entry.item.name || "Untitled folder");

/** Where a listing lives on this site. */
export function placeHref(scope: Scope, folder?: string | null): string {
  const query = new URLSearchParams();
  if (scope === "shared") query.set("scope", "shared");
  if (folder) query.set("folder", folder);
  const text = query.toString();
  return `/decks${text ? `?${text}` : ""}`;
}

/** The caller's role on an item: the service's answer, or owner when the caller owns it. */
function roleOf(entry: Item, me: DecksViewProps["me"]) {
  if (entry.item.owner?.uuid === me.uuid || entry.item.owner?.id === me.id) return "owner" as const;
  return entry.item.role;
}

export function DecksView({ scope, folder, path, initial, me }: DecksViewProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const queryKey = ["place", scope, folder ?? ""] as const;
  const listing = useQuery({ queryKey, queryFn: ({ signal }) => listPlace(scope, folder, signal), initialData: initial, ...ALWAYS_FRESH });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [q, setQ] = useState("");
  const [importing, setImporting] = useState<{ name: string; progress: ImportProgress } | null>(null);
  const [importError, setImportError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = async (message?: string) => {
    if (message) setNotice(message);
    await queryClient.invalidateQueries({ queryKey: ["place"] });
    router.refresh();
  };

  // Search: a short pause after typing, then every deck the caller can open whose words match. Results are kept with
  // the words they answer, so a cleared or changed box never shows stale ones.
  const [found, setFound] = useState<{ q: string; hits: SearchHit[] | null; error: ApiError | null } | null>(null);
  const searching = q.trim();
  useEffect(() => {
    if (!searching) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      search(searching, controller.signal)
        .then(result => setFound({ q: searching, hits: result, error: null }))
        .catch(error => { const failure = ApiError.from(error); if (failure.code !== "aborted") setFound({ q: searching, hits: null, error: failure }); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [searching]);
  const current = searching && found?.q === searching ? found : null;
  const hits = searching ? current?.hits ?? (current?.error ? null : []) : null;
  const searchError = current?.error ?? null;

  const create = useMutation({
    mutationFn: (title: string) => createDeck({ title: title || undefined, folder }),
    meta: { errorTitle: "Could not create the deck" },
    onSuccess: deck => router.push(`/decks/${encodeURIComponent(deck.id)}`),
  });
  const newFolder = useMutation({
    mutationFn: (name: string) => createFolder({ name, parent: folder }),
    meta: { errorTitle: "Could not create the folder" },
    onSuccess: made => { setDialog(null); void refresh(`Folder “${made.name}” created.`); },
  });

  async function openFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImportError(null);
    setImporting({ name: file.name, progress: { uploaded: 0, phase: "uploading" } });
    try {
      const deck = await importFile(file, { folder, onProgress: progress => setImporting({ name: file.name, progress }) });
      setImporting(null);
      notify.success("Opened as a new deck", `${file.name} is now “${deck.title || file.name}”.`);
      router.push(`/decks/${encodeURIComponent(deck.id)}`);
    } catch (error) {
      setImporting(null);
      setImportError(ApiError.from(error));
    }
  }

  async function trash(entry: Item) {
    try {
      await trashItem(entry.kind, entry.item.id);
      notify.success("Moved to the trash", `“${nameOf(entry)}” is in the trash with its full history. Restore it from there at any time.`);
      await refresh(`${nameOf(entry)} moved to the trash.`);
    } catch (error) {
      notifyError(error, `Could not move “${nameOf(entry)}” to the trash`);
    }
  }

  const items: Item[] = [
    ...listing.data.folders.map(item => ({ kind: "folder" as const, item })),
    ...listing.data.decks.map(item => ({ kind: "deck" as const, item })),
  ];
  const here = path?.folder ?? null;
  const hereRole = here ? roleOf({ kind: "folder", item: here }, me) : scope === "mine" ? "owner" : null;
  const canAddHere = scope === "mine" || can.edit(hereRole);
  const title = here ? here.name || "Untitled folder" : scope === "shared" ? "Shared with me" : "Decks";

  function menuFor(entry: Item): ActionMenuItem[] {
    const role = roleOf(entry, me);
    const open = entry.kind === "deck" ? `/decks/${encodeURIComponent(entry.item.id)}` : placeHref(scope, entry.item.id);
    const list: ActionMenuItem[] = [{ label: "Open", icon: <ExternalLink size={16} strokeWidth={1.75} />, onSelect: () => router.push(open) }];
    if (entry.kind === "deck") {
      list.push({ label: "Present", icon: <MonitorPlay size={16} strokeWidth={1.75} />, onSelect: () => router.push(`/decks/${encodeURIComponent(entry.item.id)}/present`) });
      if (can.edit(role)) list.push({ label: "History", icon: <HistoryIcon size={16} strokeWidth={1.75} />, onSelect: () => router.push(`/decks/${encodeURIComponent(entry.item.id)}/history`) });
    }
    if (can.edit(role)) list.push({ label: "Rename", icon: <Pencil size={16} strokeWidth={1.75} />, onSelect: () => setDialog({ type: "rename", target: entry }) });
    list.push({ label: can.share(role) ? "Share" : "Who has access", icon: <UserPlus size={16} strokeWidth={1.75} />, onSelect: () => setDialog({ type: "share", target: entry }) });
    if (can.own(role)) {
      list.push({ label: "Move", icon: <FolderInput size={16} strokeWidth={1.75} />, onSelect: () => setDialog({ type: "move", target: entry }) });
      list.push({ label: "Transfer to someone", icon: <ArrowRightLeft size={16} strokeWidth={1.75} />, onSelect: () => setDialog({ type: "transfer", target: entry }) });
      list.push({ label: "Move to trash", icon: <Trash2 size={16} strokeWidth={1.75} />, destructive: true, separatorBefore: true, onSelect: () => void trash(entry) });
    }
    return list;
  }

  const target = dialog && "target" in dialog ? dialog.target : null;

  return (
    <div className={styles.view}>
      <p className="sr-only" role="status" aria-live="polite">{notice}</p>
      <header className={styles.header}>
        {path ? (
          <nav aria-label="Folder path" className={styles.crumbs}>
            <ol role="list">
              <li><Link href={placeHref(scope)}>{scope === "shared" ? "Shared with me" : "My decks"}</Link></li>
              {path.ancestors.map(ancestor => (
                <li key={ancestor.id}><ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" /><Link href={placeHref(scope, ancestor.id)}>{ancestor.name || "Untitled folder"}</Link></li>
              ))}
              <li><ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" /><span aria-current="page">{title}</span></li>
            </ol>
          </nav>
        ) : null}
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{title}</h1>
          {canAddHere ? (
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => fileInput.current?.click()} disabled={!!importing}>
                <Upload size={16} strokeWidth={1.75} aria-hidden="true" />
                Open a file
              </Button>
              <Button variant="secondary" onClick={() => setDialog({ type: "new-folder" })}>
                <FolderPlus size={16} strokeWidth={1.75} aria-hidden="true" />
                New folder
              </Button>
              <Button onClick={() => setDialog({ type: "new-deck" })}>
                <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
                New deck
              </Button>
              <input ref={fileInput} type="file" accept={IMPORT_ACCEPT} className="sr-only" tabIndex={-1} aria-label="File to open as a new deck" onChange={openFile} />
            </div>
          ) : null}
        </div>
        {here?.owner && here.owner.uuid !== me.uuid ? <p className={styles.lede}>Owned by {here.owner.id}. Decks you make here belong to {here.owner.id}, and still show you made them.</p> : null}
      </header>

      <div className={styles.tools}>
        {path ? null : (
          <SegmentedControl
            label="Which decks"
            value={scope}
            onValueChange={value => router.push(placeHref(value as Scope))}
            options={[{ value: "mine", label: "My decks" }, { value: "shared", label: "Shared with me" }]}
          />
        )}
        <div className={styles.search}>
          <SearchField label="Search decks" placeholder="Search every deck you can open" value={q} onValueChange={setQ} />
        </div>
      </div>

      {importing ? (
        <div className={styles.importing} role="status" aria-live="polite">
          <span className={styles.importName}>{importing.progress.phase === "converting" ? `Building a deck from ${importing.name}…` : `Uploading ${importing.name}…`}</span>
          <Progress value={importing.progress.phase === "converting" ? 100 : Math.round((importing.progress.uploaded ?? 0) * 100)} label={`Opening ${importing.name}`} showValue={importing.progress.phase === "uploading"} />
        </div>
      ) : null}
      {importError ? <ErrorAlert error={importError} title="The file could not be opened" action={<Button size="sm" variant="secondary" onClick={() => setImportError(null)}>Dismiss</Button>} /> : null}

      {hits !== null || searchError ? (
        <section aria-label="Search results">
          {searchError ? <ErrorAlert error={searchError} title="Search did not work" /> : null}
          {hits && hits.length ? (
            <ul role="list" className={styles.list}>
              {hits.map(hit => (
                <li key={hit.deck.id} className={styles.row}>
                  <Presentation size={18} strokeWidth={1.75} aria-hidden="true" className={styles.icon} />
                  <span className={styles.main}>
                    <Link className={styles.name} href={`/decks/${encodeURIComponent(hit.deck.id)}`}>{hit.deck.title || "Untitled deck"}</Link>
                    <span className={styles.meta}>{[hit.deck.owner?.id ? `Owner ${hit.deck.owner.id}` : null, hit.where, hit.excerpt].filter(Boolean).join(" · ")}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : hits && current ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>No deck matches “{q.trim()}”</p>
              <p className={styles.emptyText}>Search looks in titles, slide text, speaker notes and tables of every deck you can open.</p>
              <Button size="sm" variant="secondary" onClick={() => setQ("")}>Clear the search</Button>
            </div>
          ) : null}
        </section>
      ) : listing.error && !listing.data ? (
        <ErrorAlert error={listing.error} title="This list could not be loaded" />
      ) : items.length ? (
        <ul role="list" className={styles.list} aria-label={title}>
          {items.map(entry => {
            const href = entry.kind === "deck" ? `/decks/${encodeURIComponent(entry.item.id)}` : placeHref(scope, entry.item.id);
            const owner = entry.item.owner;
            const creator = entry.item.creator;
            const when = entry.kind === "deck" ? entry.item.updatedAt ?? entry.item.createdAt : entry.item.updatedAt ?? entry.item.createdAt;
            const mine = owner?.uuid === me.uuid;
            return (
              <li key={`${entry.kind}:${entry.item.id}`} className={styles.row} data-kind={entry.kind}>
                {entry.kind === "folder" ? <FolderIcon size={18} strokeWidth={1.75} aria-hidden="true" className={styles.icon} /> : <Presentation size={18} strokeWidth={1.75} aria-hidden="true" className={styles.icon} />}
                <span className={styles.main}>
                  <Link className={styles.name} href={href}>{nameOf(entry)}</Link>
                  <span className={styles.meta}>
                    {entry.kind === "folder" ? "Folder" : entry.item.public !== "off" ? "Public deck" : "Deck"}
                    {owner && !mine ? <> · Owner {owner.id}</> : null}
                    {creator && owner && creator.uuid !== owner.uuid ? <> · Made by {creator.id}</> : null}
                    {when ? <> · <LocalTime value={when} prefix={entry.kind === "deck" ? "Edited " : "Changed "} /></> : null}
                  </span>
                </span>
                <ActionMenu label={`More actions for ${nameOf(entry)}`} iconOnly icon={<MoreIcon />} items={menuFor(entry)} />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{here ? "This folder is empty" : scope === "shared" ? "Nothing is shared with you yet" : "No decks yet"}</p>
          <p className={styles.emptyText}>
            {scope === "shared" && !here
              ? "Decks and folders that Carbons and Silicons share with you appear here."
              : "Make a new deck, open a PowerPoint, Keynote, OpenDocument or PDF file, or let a Silicon build one with the present command line."}
          </p>
          {canAddHere ? <Button size="sm" onClick={() => setDialog({ type: "new-deck" })}><Plus size={16} strokeWidth={1.75} aria-hidden="true" />New deck</Button> : null}
        </div>
      )}

      <NameDialog
        open={dialog?.type === "new-deck"}
        onOpenChange={open => !open && setDialog(null)}
        title="New deck"
        description={here ? `It goes into “${title}”.` : undefined}
        label="Title"
        placeholder="Untitled deck"
        submitLabel="Create deck"
        optional
        pending={create.isPending}
        onSubmit={value => create.mutate(value)}
      />
      <NameDialog
        open={dialog?.type === "new-folder"}
        onOpenChange={open => !open && setDialog(null)}
        title="New folder"
        description={here ? `It goes into “${title}”.` : undefined}
        label="Name"
        submitLabel="Create folder"
        pending={newFolder.isPending}
        onSubmit={value => newFolder.mutate(value)}
      />
      {target && dialog?.type === "rename" ? (
        <NameDialog
          open
          onOpenChange={open => !open && setDialog(null)}
          title={target.kind === "deck" ? "Rename deck" : "Rename folder"}
          label={target.kind === "deck" ? "Title" : "Name"}
          initial={nameOf(target)}
          submitLabel="Rename"
          onSubmit={async value => {
            try {
              await renameItem(target.kind, target.item.id, value);
              setDialog(null);
              await refresh(`Renamed to ${value}.`);
            } catch (error) {
              notifyError(error, "Could not rename it");
            }
          }}
        />
      ) : null}
      {target && dialog?.type === "move" ? (
        <MoveDialog
          kind={target.kind}
          id={target.item.id}
          name={nameOf(target)}
          current={target.kind === "deck" ? target.item.folder : target.item.parent}
          onClose={() => setDialog(null)}
          onMove={async destination => {
            try {
              await moveItem(target.kind, target.item.id, destination.id);
              setDialog(null);
              await refresh(`Moved to ${destination.name}.`);
              notify.success("Moved", `“${nameOf(target)}” is now in ${destination.id ? `“${destination.name}”` : "My decks"}.`);
            } catch (error) {
              notifyError(error, `Could not move “${nameOf(target)}”`);
            }
          }}
        />
      ) : null}
      {target && dialog?.type === "transfer" ? (
        <TransferDialog
          kind={target.kind as ResourceKind}
          name={nameOf(target)}
          selfId={me.id}
          onClose={() => setDialog(null)}
          onTransfer={async to => {
            await startTransfer(target.kind, target.item.id, to);
            setDialog(null);
            notify.success("Transfer offered", `${to} has to accept before “${nameOf(target)}” becomes theirs. Follow it in Transfers.`);
            await refresh();
          }}
        />
      ) : null}
      {target && dialog?.type === "share" ? (
        <ShareDialog kind={target.kind} id={target.item.id} name={nameOf(target)} open onOpenChange={open => !open && setDialog(null)} selfId={me.id} role={roleOf(target, me)} onChanged={() => void refresh()} />
      ) : null}
    </div>
  );
}

function MoreIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}
