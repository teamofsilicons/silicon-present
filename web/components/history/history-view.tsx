"use client";

/**
 * A deck's history. On the left, one list, newest first: each version reads as who did what ("si:designer changed
 * slide 4"), with its name if someone gave it one, and the events that happened between versions in quieter rows. On
 * the right, the version that is open, read-only, drawn by `@silicon-present/render`: its slides, one large, from
 * which a slide or an element can be brought back; or the comparison of two versions, slide by slide.
 *
 * Going back never deletes anything: restoring (a whole version, a slide, an element) and undoing an account's changes
 * each become a new version.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, Eye, GitCompareArrows, History as HistoryIcon, Pencil, RotateCcw, Undo2 } from "lucide-react";
import type { DeckJson } from "@silicon-present/deck";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { Select } from "@/components/arc/select/select";
import { NameDialog } from "@/components/decks/dialogs";
import { ExportMenu } from "@/components/export";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { LocalTime } from "@/components/foundation/time/local-time";
import { ActionMenu } from "@/components/menu/action-menu";
import { SlideStyles, SlideView } from "@/components/slides/slide-view";
import { ApiError } from "@/lib/errors";
import { notify, notifyError } from "@/lib/notify";
import { compare, deckFromVersion, getContent, listVersions, nameVersion, restore, undoAccount } from "@/lib/present/versions";
import type { Account, Comparison, Deck, HistoryEvent, Version } from "@/lib/present/types";
import styles from "./history.module.css";

type Panel = { type: "version"; version: number } | { type: "compare"; from: number; to: number } | null;

const who = (account: Account | null) => account?.id ?? "Someone";

/** Words for an event the service sends without a sentence of its own. */
function eventWords(event: HistoryEvent): string {
  if (event.summary) return event.summary;
  const actor = who(event.actor);
  const data = event.data as Record<string, unknown>;
  const text = (key: string) => (typeof data[key] === "string" ? (data[key] as string) : "");
  switch (event.type) {
    case "rename": case "renamed": case "deck.renamed": return `${actor} renamed it to “${text("title") || text("to") || text("name")}”`;
    case "move": case "moved": case "deck.moved": return `${actor} moved it`;
    case "share": case "shared": case "access.added": return `${actor} shared it with ${text("to") || text("member") || "someone"}`;
    case "access.changed": return `${actor} changed what ${text("member") || "someone"} can do`;
    case "access.removed": case "unshared": return `${actor} removed ${text("member") || "someone"}`;
    case "public": case "public.changed": return text("mode") === "off" ? `${actor} made it private` : `${actor} made it public (${text("mode") || "view"})`;
    case "trash": case "trashed": return `${actor} moved it to the trash`;
    case "untrash": case "restored": return `${actor} restored it from the trash`;
    case "transfer": case "transferred": case "transfer.accepted": return `${actor} became the owner`;
    case "version.named": return `${actor} named a version “${text("name")}”`;
    default: return `${actor}: ${event.type.replace(/[._]/g, " ")}`;
  }
}

export function HistoryView({ deck, initial, canEdit }: { deck: Deck; initial: Version[]; canEdit: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const versions = useQuery({ queryKey: ["versions", deck.id], queryFn: ({ signal }) => listVersions(deck.id, signal), initialData: initial });
  const list = versions.data;
  const latest = list[0]?.version ?? deck.version ?? 0;
  const [panel, setPanel] = useState<Panel>(list[0] ? { type: "version", version: list[0].version } : null);
  const [naming, setNaming] = useState<Version | null>(null);
  const [undoing, setUndoing] = useState<Version | null>(null);
  const [restoring, setRestoring] = useState<Version | null>(null);
  const [notice, setNotice] = useState("");

  const refresh = async (message: string) => {
    setNotice(message);
    await queryClient.invalidateQueries({ queryKey: ["versions", deck.id] });
    await queryClient.invalidateQueries({ queryKey: ["content", deck.id] });
    router.refresh();
  };

  async function newDeck(version: Version) {
    try {
      const made = await deckFromVersion(deck.id, version.version, `${deck.title || "Untitled deck"} (version ${version.version})`);
      notify.success("New deck made", `“${made.title}” starts as this deck was at version ${version.version}.`);
      router.push(`/decks/${encodeURIComponent(made.id)}`);
    } catch (error) {
      notifyError(error, "Could not make a new deck from this version");
    }
  }

  return (
    <div className={styles.view}>
      <p className="sr-only" role="status" aria-live="polite">{notice}</p>
      <header className={styles.header}>
        <Link href={`/decks/${encodeURIComponent(deck.id)}`} className={styles.back}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />Back to the deck</Link>
        <h1 className={styles.title}>History</h1>
        <p className={styles.lede}>{deck.title || "Untitled deck"}. Every change is kept with who made it; going back never deletes anything.</p>
      </header>

      {!canEdit ? <ErrorAlert error={{ status: 403, message: "Only the owner and editors can open versions, compare and restore.", hint: "Ask the owner to make you an editor." }} title="You can look, not restore" /> : null}

      <div className={styles.columns}>
        <section className={styles.listColumn} aria-labelledby="versions-title">
          <div className={styles.listHead}>
            <h2 id="versions-title" className={styles.sectionTitle}>Versions</h2>
            {list.length > 1 ? (
              <Button size="sm" variant="ghost" onClick={() => setPanel({ type: "compare", from: list[1]!.version, to: list[0]!.version })}>
                <GitCompareArrows size={16} strokeWidth={1.75} aria-hidden="true" />
                Compare
              </Button>
            ) : null}
          </div>
          {list.length ? (
            <ol role="list" className={styles.list}>
              {list.map((version, index) => {
                const open = panel?.type === "version" && panel.version === version.version;
                return (
                  <li key={version.version} className={styles.entry}>
                    {version.events.map((event, eventIndex) => (
                      <p key={`${event.id}-${eventIndex}`} className={styles.event} data-testid="history-event">
                        <span className={styles.eventDot} aria-hidden="true" />
                        <span>{eventWords(event)}</span>
                        {event.at ? <LocalTime value={event.at} className={styles.eventTime} /> : null}
                      </p>
                    ))}
                    <div className={styles.version} data-open={open ? "" : undefined} data-testid="version">
                      <button type="button" className={styles.versionMain} onClick={() => setPanel({ type: "version", version: version.version })} aria-current={open ? "true" : undefined} aria-label={`Open version ${version.version}: ${version.name ? `${version.name}, ` : ""}${version.summary || who(version.author)}`}>
                        {version.name ? <span className={styles.versionName}>{version.name}</span> : null}
                        <span className={styles.versionSummary}>{version.summary || `${who(version.author)} changed the deck`}</span>
                        <span className={styles.versionMeta}>
                          {who(version.author)}
                          {version.endedAt ? <> · <LocalTime value={version.endedAt} format="datetime" /></> : null}
                          {index === 0 ? " · Current" : ""}
                          {version.origin === "restore" ? " · Restore" : version.origin === "undo" ? " · Undo" : version.origin === "import" ? " · Opened from a file" : ""}
                        </span>
                      </button>
                      {canEdit ? (
                        <ActionMenu
                          label={`Actions for version ${version.version}`}
                          iconOnly
                          icon={<HistoryIcon size={16} strokeWidth={1.75} />}
                          items={[
                            { label: "Open this version", icon: <Eye size={16} strokeWidth={1.75} />, onSelect: () => setPanel({ type: "version", version: version.version }) },
                            { label: version.name ? "Rename this version" : "Name this version", icon: <Pencil size={16} strokeWidth={1.75} />, onSelect: () => setNaming(version) },
                            ...(index > 0 ? [{ label: "Compare with the current deck", icon: <GitCompareArrows size={16} strokeWidth={1.75} />, onSelect: () => setPanel({ type: "compare", from: version.version, to: latest }) }] : []),
                            ...(index > 0 ? [{ label: "Restore this version", icon: <RotateCcw size={16} strokeWidth={1.75} />, onSelect: () => setRestoring(version) }] : []),
                            ...(index > 0 ? [{ label: "Undo one account's changes since this version", icon: <Undo2 size={16} strokeWidth={1.75} />, onSelect: () => setUndoing(version) }] : []),
                            { label: "Make a new deck from this version", icon: <Copy size={16} strokeWidth={1.75} />, separatorBefore: true, onSelect: () => void newDeck(version) },
                          ]}
                        />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className={styles.quiet}>No changes yet. Every change appears here the moment it is made.</p>
          )}
        </section>

        <section className={styles.panelColumn} aria-label={panel?.type === "compare" ? "Comparison" : "Open version"}>
          {panel?.type === "version" ? (
            <VersionPanel key={panel.version} deck={deck} version={list.find(item => item.version === panel.version) ?? null} number={panel.version} latest={latest} canEdit={canEdit} onRestore={version => setRestoring(version)} onChanged={refresh} />
          ) : panel?.type === "compare" ? (
            <ComparePanel deck={deck} versions={list} from={panel.from} to={panel.to} onChange={(from, to) => setPanel({ type: "compare", from, to })} />
          ) : (
            <p className={styles.quiet}>Open a version to see the deck as it was.</p>
          )}
        </section>
      </div>

      {naming ? (
        <NameDialog
          open
          onOpenChange={open => !open && setNaming(null)}
          title={`Name version ${naming.version}`}
          description="A name like “Sent to the client” makes a version easy to find again."
          label="Name"
          initial={naming.name ?? ""}
          submitLabel="Save name"
          onSubmit={async value => {
            try {
              await nameVersion(deck.id, naming.version, value);
              setNaming(null);
              await refresh(`Version ${naming.version} is now named ${value}.`);
            } catch (error) {
              notifyError(error, "Could not name the version");
            }
          }}
        />
      ) : null}
      {restoring ? (
        <ConfirmDialog
          title={`Restore version ${restoring.version}?`}
          text={`The deck goes back to how it was at version ${restoring.version}${restoring.name ? ` (“${restoring.name}”)` : ""}. That becomes a new version: nothing after it is lost, and you can go back again.`}
          action="Restore this version"
          onClose={() => setRestoring(null)}
          onConfirm={async () => {
            await restore(deck.id, { version: restoring.version });
            setRestoring(null);
            notify.success("Restored", `The deck is as it was at version ${restoring.version}, as a new version.`);
            await refresh(`Restored version ${restoring.version}.`);
            setPanel(null);
          }}
        />
      ) : null}
      {undoing ? <UndoAccountDialog deck={deck} since={undoing} versions={list} onClose={() => setUndoing(null)} onDone={async message => { setUndoing(null); notify.success("Undone", message); await refresh(message); }} /> : null}
    </div>
  );
}

function VersionPanel({ deck, version, number, latest, canEdit, onRestore, onChanged }: { deck: Deck; version: Version | null; number: number; latest: number; canEdit: boolean; onRestore: (version: Version) => void; onChanged: (message: string) => Promise<void> }) {
  const content = useQuery({ queryKey: ["content", deck.id, number], queryFn: ({ signal }) => getContent(deck.id, number, signal), staleTime: Infinity });
  const [slideId, setSlideId] = useState<string | null>(null);
  const [element, setElement] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const json = content.data;
  const slide = json ? json.slides.find(item => item.id === slideId) ?? json.slides[0] ?? null : null;
  const isCurrent = number === latest;

  async function bringBack(target: { slide: string; element?: string }) {
    setBusy(true);
    try {
      await restore(deck.id, { version: number, ...target });
      const what = target.element ? "The element is back" : "The slide is back";
      notify.success(what, `${what} as it was at version ${number}, as a new version.`);
      await onChanged(`${what} from version ${number}.`);
      setElement(null);
    } catch (error) {
      notifyError(error, target.element ? "Could not bring the element back" : "Could not bring the slide back");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelText}>
          <h2 className={styles.sectionTitle}>{version?.name ? `“${version.name}”` : `Version ${number}`}{isCurrent ? " (current)" : ""}</h2>
          <p className={styles.versionMeta}>
            {version ? who(version.author) : null}
            {version?.endedAt ? <> · <LocalTime value={version.endedAt} format="datetime" /></> : null}
            {json ? ` · ${json.slides.length} ${json.slides.length === 1 ? "slide" : "slides"}` : null}
          </p>
        </div>
        <div className={styles.panelActions}>
          <ExportMenu deck={deck.id} version={number} />
          {canEdit && !isCurrent && version ? <Button size="sm" onClick={() => onRestore(version)}><RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />Restore this version</Button> : null}
        </div>
      </div>
      {content.error ? <ErrorAlert error={content.error} title={`Version ${number} could not be opened`} /> : null}
      {!json && !content.error ? <div className={styles.placeholder} aria-busy="true">Opening version {number}…</div> : null}
      {json ? (
        <>
          <SlideStyles deck={json} />
          {slide ? (
            <>
              <div className={styles.large} data-sq="clip">
                <SlideView deck={json} slide={slide.id} label={`Slide ${json.slides.indexOf(slide) + 1} at version ${number}`} selected={element ? [element] : []} onElementClick={canEdit && !isCurrent ? id => setElement(id) : undefined} />
              </div>
              {canEdit && !isCurrent ? (
                <div className={styles.restoreBar}>
                  <span className={styles.hint}>{element ? "An element is selected." : "Click an element on the slide to bring back only that element."}</span>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void bringBack({ slide: slide.id })}>Bring back this slide</Button>
                  {element ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void bringBack({ slide: slide.id, element })}>Bring back this element</Button> : null}
                </div>
              ) : null}
              <ol role="list" className={styles.strip} aria-label="Slides in this version">
                {json.slides.map((item, index) => (
                  <li key={item.id}>
                    <button type="button" className={styles.thumb} data-sq="clip" aria-current={item.id === slide.id ? "true" : undefined} aria-label={`Slide ${index + 1}${item.skipped ? " (skipped)" : ""}`} onClick={() => { setSlideId(item.id); setElement(null); }}>
                      <SlideView deck={json} slide={item.id} html="static" media="static" links={false} />
                      <span className={styles.thumbNumber}>{index + 1}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </>
          ) : <p className={styles.quiet}>This version has no slides.</p>}
        </>
      ) : null}
    </div>
  );
}

const CHANGE_WORDS = { added: "Added", removed: "Removed", changed: "Changed", moved: "Moved", unchanged: "Unchanged" } as const;

function ComparePanel({ deck, versions, from, to, onChange }: { deck: Deck; versions: Version[]; from: number; to: number; onChange: (from: number, to: number) => void }) {
  const comparison = useQuery({ queryKey: ["compare", deck.id, from, to], queryFn: ({ signal }) => compare(deck.id, from, to, signal) });
  const before = useQuery({ queryKey: ["content", deck.id, from], queryFn: ({ signal }) => getContent(deck.id, from, signal), staleTime: Infinity });
  const after = useQuery({ queryKey: ["content", deck.id, to], queryFn: ({ signal }) => getContent(deck.id, to, signal), staleTime: Infinity });
  const options = useMemo(() => versions.map(version => ({ value: String(version.version), label: `${version.name ? `${version.name} · ` : ""}v${version.version} · ${who(version.author)}` })), [versions]);
  const changed = (comparison.data?.slides ?? []).filter(slide => slide.change !== "unchanged");

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <h2 className={styles.sectionTitle}>Compare two versions</h2>
      </div>
      <div className={styles.compareControls}>
        <Select label="From" options={options} value={String(from)} onValueChange={value => onChange(Number(value), to)} />
        <Select label="To" options={options} value={String(to)} onValueChange={value => onChange(from, Number(value))} />
      </div>
      {comparison.error ? <ErrorAlert error={comparison.error} title="The comparison could not be made" /> : null}
      {!comparison.data && !comparison.error ? <div className={styles.placeholder} aria-busy="true">Comparing…</div> : null}
      {comparison.data ? (
        changed.length ? (
          <>
            {before.data ? <SlideStyles deck={before.data} /> : null}
            {after.data ? <SlideStyles deck={after.data} /> : null}
            <ol role="list" className={styles.changes} data-testid="comparison">
              {changed.map(slide => (
                <CompareRow key={`${slide.slide}-${slide.change}`} slide={slide} before={before.data} after={after.data} />
              ))}
            </ol>
          </>
        ) : <p className={styles.quiet}>No slide changed between these two versions.</p>
      ) : null}
    </div>
  );
}

function CompareRow({ slide, before, after }: { slide: Comparison["slides"][number]; before?: DeckJson; after?: DeckJson }) {
  const inBefore = before?.slides.find(item => item.id === slide.slide);
  const inAfter = after?.slides.find(item => item.id === slide.slide);
  const number = slide.toNumber ?? slide.fromNumber ?? (after && inAfter ? after.slides.indexOf(inAfter) + 1 : before && inBefore ? before.slides.indexOf(inBefore) + 1 : null);
  return (
    <li className={styles.change} data-change={slide.change}>
      <p className={styles.changeTitle}>
        <span className={styles.badge} data-change={slide.change}>{CHANGE_WORDS[slide.change]}</span>
        {number ? `Slide ${number}` : "A slide"}
        {slide.label ? ` · ${slide.label}` : ""}
        {slide.by.length ? <span className={styles.versionMeta}> · by {slide.by.map(account => account.id).join(", ")}</span> : null}
      </p>
      <div className={styles.pair}>
        <figure className={styles.side}>
          <figcaption>Before</figcaption>
          {before && inBefore ? <div data-sq="clip" className={styles.small}><SlideView deck={before} slide={inBefore.id} html="static" media="static" links={false} /></div> : <div className={styles.none}>Not there</div>}
        </figure>
        <figure className={styles.side}>
          <figcaption>After</figcaption>
          {after && inAfter ? <div data-sq="clip" className={styles.small}><SlideView deck={after} slide={inAfter.id} html="static" media="static" links={false} /></div> : <div className={styles.none}>Removed</div>}
        </figure>
      </div>
      {slide.elements.length ? (
        <ul role="list" className={styles.elementChanges}>
          {slide.elements.map(element => (
            <li key={`${element.element}-${element.change}`}>{CHANGE_WORDS[element.change]} {element.label || element.kind || "an element"}{element.by.length ? ` (${element.by.map(account => account.id).join(", ")})` : ""}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ConfirmDialog({ title, text, action, onClose, onConfirm }: { title: string; text: string; action: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent title={title}>
        <p className={styles.dialogText}>{text}</p>
        {error ? <ErrorAlert error={error} /> : null}
        <div className={styles.dialogActions}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={busy} onClick={async () => { setBusy(true); setError(null); try { await onConfirm(); } catch (failure) { setError(ApiError.from(failure)); } finally { setBusy(false); } }}>{action}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UndoAccountDialog({ deck, since, versions, onClose, onDone }: { deck: Deck; since: Version; versions: Version[]; onClose: () => void; onDone: (message: string) => Promise<void> }) {
  // Everyone who changed the deck after this version.
  const authors = useMemo(() => {
    const seen = new Map<string, Account>();
    for (const version of versions) if (version.version > since.version && version.author && !seen.has(version.author.uuid)) seen.set(version.author.uuid, version.author);
    return [...seen.values()];
  }, [versions, since]);
  const [account, setAccount] = useState(authors[0]?.uuid ?? "");
  const chosen = authors.find(item => item.uuid === account);
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent title="Undo one account's changes" description={`Since version ${since.version}${since.name ? ` (“${since.name}”)` : ""}.`}>
        <UndoBody authors={authors} account={account} setAccount={setAccount} since={since} chosen={chosen} onClose={onClose} onConfirm={async () => {
          if (!chosen) return;
          await undoAccount(deck.id, chosen.uuid, since.version);
          await onDone(`${chosen.id}'s changes since version ${since.version} are undone.`);
        }} />
      </DialogContent>
    </Dialog>
  );
}

function UndoBody({ authors, account, setAccount, since, chosen, onClose, onConfirm }: { authors: Account[]; account: string; setAccount: (value: string) => void; since: Version; chosen: Account | undefined; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  if (!authors.length) {
    return (
      <>
        <p className={styles.dialogText}>Nobody changed the deck after version {since.version}.</p>
        <div className={styles.dialogActions}><Button variant="ghost" onClick={onClose}>Close</Button></div>
      </>
    );
  }
  return (
    <>
      <Select label="Whose changes" options={authors.map(item => ({ value: item.uuid, label: `${item.id}${item.displayName ? ` (${item.displayName})` : ""}` }))} value={account} onValueChange={setAccount} />
      <p className={styles.dialogText}>Everything {chosen?.id ?? "they"} changed after version {since.version} goes away; everyone else&apos;s changes stay. It becomes a new version, so it can be undone too.</p>
      {error ? <ErrorAlert error={error} /> : null}
      <div className={styles.dialogActions}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button loading={busy} disabled={busy || !chosen} onClick={async () => { setBusy(true); setError(null); try { await onConfirm(); } catch (failure) { setError(ApiError.from(failure)); } finally { setBusy(false); } }}>{chosen ? `Undo ${chosen.id}'s changes` : "Undo"}</Button>
      </div>
    </>
  );
}
