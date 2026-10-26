"use client";

/**
 * Sharing a deck or folder, in one dialog (UNDERSTANDING.md "Sharing"): invite Carbons and Silicons by c:id, si:id or
 * email with a role; everyone with access and their roles, pending email invites included; change or remove them;
 * and, for a deck, the public switch (anyone with the link can view, comment or edit) and the link to copy.
 *
 *   import { ShareDialog, ShareButton } from "@/components/share";
 *   <ShareButton kind="deck" id={deck.id} name={deck.title} />                 a "Share" button that opens it
 *   <ShareDialog kind="deck" id={deck.id} name={deck.title} open={open} onOpenChange={setOpen} />
 *
 * Self-contained: it reads and writes the service through lib/present/sharing.ts itself (no query client needed), so
 * the editor can mount it anywhere inside a page that has the kit's toast stack (Providers). Only the owner and editors
 * can invite and change; commenters and viewers see who has access, read only (the service decides; the dialog follows
 * the role it reports).
 */
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Globe, Link2, Lock, Mail, RefreshCw, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { Input } from "@/components/arc/input/input";
import { Select } from "@/components/arc/select/select";
import { Switch } from "@/components/arc/switch/switch";
import { AccountChip } from "@/components/foundation/account/account-chip";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { ApiError } from "@/lib/errors";
import { formatDate, formatDateTime, formatTime } from "@/lib/format";
import { parseAccountId } from "@/lib/ids";
import { notifyError } from "@/lib/notify";
import { changeRole, deckLink, getAccess, getDeckViewers, invite, removeMember, setPublic } from "@/lib/present/sharing";
import { can, ROLE_WORDS, type Access, type DeckViewer, type Member, type MyRole, type PublicMode, type ResourceKind, type Role } from "@/lib/present/types";
import styles from "./share.module.css";

export interface ShareDialogProps {
  kind: ResourceKind;
  id: string;
  /** The deck's title or the folder's name, for the dialog's title. */
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The signed-in account's c:/si: id ("You" next to it in the list). */
  selfId?: string;
  /** The caller's role on it, when the page knows it (the access answer's own role wins when it has one). */
  role?: MyRole | null;
  /** Called after anything changed (an invite, a role, a removal, the public switch), with the new access. */
  onChanged?: (access: Access) => void;
}

const ROLE_OPTIONS = (["editor", "commenter", "viewer"] as const).map(role => ({ value: role, label: ROLE_WORDS[role].label }));
const PUBLIC_OPTIONS: Array<{ value: Exclude<PublicMode, "off">; label: string }> = [
  { value: "view", label: "Can view" },
  { value: "comment", label: "Can comment" },
  { value: "edit", label: "Can edit" },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What the invite field holds: a c:/si: id, an email, or why it is neither. */
function checkInvitee(text: string): { ok: true; to: string } | { ok: false; message: string } {
  const value = text.trim();
  if (!value) return { ok: false, message: "Type a Carbon's c: id, a Silicon's si: id, or an email address." };
  if (value.includes("@")) return EMAIL.test(value) ? { ok: true, to: value.toLowerCase() } : { ok: false, message: `"${value}" is not a whole email address. Check it, or invite by c: or si: id.` };
  const parsed = parseAccountId(value);
  return parsed.ok ? { ok: true, to: parsed.value.id } : { ok: false, message: parsed.message };
}

function memberLabel(member: Member): string {
  return member.account?.id ?? member.email ?? member.key;
}

export function ShareDialog(props: ShareDialogProps) {
  // Access and viewer data from one resource or signed-in account must never be reused for another.
  return <ShareDialogBody key={`${props.kind}:${props.id}:${props.selfId ?? ""}`} {...props} />;
}

function ShareDialogBody({ kind, id, name, open, onOpenChange, selfId, role: knownRole, onChanged }: ShareDialogProps) {
  const [access, setAccess] = useState<Access | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const listId = useId();

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await getAccess(kind, id, signal);
      setAccess(next);
      setLoadError(null);
      return next;
    } catch (error) {
      const failure = ApiError.from(error);
      if (failure.code !== "aborted") setLoadError(failure);
      return null;
    }
  }, [kind, id]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    getAccess(kind, id, controller.signal)
      .then(next => { if (!controller.signal.aborted) { setAccess(next); setLoadError(null); } })
      .catch(error => { const failure = ApiError.from(error); if (failure.code !== "aborted") setLoadError(failure); });
    return () => controller.abort();
  }, [open, kind, id]);

  const after = async (message: string) => {
    setNotice(message);
    const next = await load();
    if (next) onChanged?.(next);
  };

  // The owner is the owner whatever the answer says; otherwise the access answer's role, then the page's.
  const myRole: MyRole | null = access?.owner && selfId && access.owner.id === selfId ? "owner" : access?.role ?? knownRole ?? null;
  const canShare = !!access && can.share(myRole);
  // Sensitive viewer data requires the access answer to confirm ownership, not just a caller's cached role.
  const confirmedOwner = !!access && (access.role === "owner" || !!selfId && access.owner?.id === selfId);

  async function submitInvite(event: FormEvent) {
    event.preventDefault();
    const check = checkInvitee(draft);
    if (!check.ok) {
      setInviteError(check.message);
      return;
    }
    setInviting(true);
    setInviteError(null);
    try {
      await invite(kind, id, check.to, role);
      setDraft("");
      await after(check.to.includes("@") ? `Invited ${check.to} as ${ROLE_WORDS[role].label.toLowerCase()}. They get an email to join.` : `${check.to} can now open it as ${ROLE_WORDS[role].label.toLowerCase()}.`);
    } catch (error) {
      const failure = ApiError.from(error);
      setInviteError([failure.message, failure.hint].filter(Boolean).join(" "));
    } finally {
      setInviting(false);
    }
  }

  async function updateRole(member: Member, next: Role) {
    setBusy(member.key);
    try {
      await changeRole(kind, id, member.key, next);
      await after(`${memberLabel(member)} is now ${ROLE_WORDS[next].label.toLowerCase()}.`);
    } catch (error) {
      notifyError(error, `Could not change ${memberLabel(member)}'s role`);
    } finally {
      setBusy(null);
    }
  }

  async function remove(member: Member) {
    setBusy(member.key);
    try {
      await removeMember(kind, id, member.key);
      await after(`${memberLabel(member)} no longer has access.`);
    } catch (error) {
      notifyError(error, `Could not remove ${memberLabel(member)}`);
    } finally {
      setBusy(null);
    }
  }

  async function changePublic(mode: PublicMode) {
    setBusy("public");
    try {
      await setPublic(id, mode);
      await after(mode === "off" ? "The link stopped working: only people with access can open it." : `Anyone with the link ${PUBLIC_OPTIONS.find(option => option.value === mode)?.label.toLowerCase()}.`);
    } catch (error) {
      notifyError(error, "Could not change who can open the link");
    } finally {
      setBusy(null);
    }
  }

  async function changeEmailRequirement(requireEmail: boolean) {
    if (!confirmedOwner || !access || access.public === "off") return;
    setBusy("public");
    try {
      await setPublic(id, access.public, requireEmail);
      await after(requireEmail ? "Public visitors now provide an email before viewing." : "Public visitors can view without providing an email.");
    } catch (error) {
      notifyError(error, "Could not change the email requirement");
    } finally {
      setBusy(null);
    }
  }

  const link = deckLink(id);
  const publicMode = access?.public ?? "off";
  const what = kind === "deck" ? "deck" : "folder";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Share ${name ? `“${name}”` : `this ${what}`}`} description={kind === "folder" ? "Sharing a folder shares everything in it, including what is added later." : undefined} className={`${styles.dialog}${kind === "deck" && confirmedOwner ? ` ${styles.ownerDialog}` : ""}`}>
        <p className={`sr-only ${styles.status}`} role="status" aria-live="polite">{notice}</p>
        {loadError ? <ErrorAlert error={loadError} title="Who has access could not be loaded" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>} /> : null}

        {access && canShare ? (
          <form className={styles.invite} onSubmit={submitInvite} noValidate>
            <div className={styles.inviteField}>
              <Input
                label="Invite"
                placeholder="c:ada, si:writer or an email"
                value={draft}
                onChange={event => { setDraft(event.target.value); setInviteError(null); }}
                error={inviteError ?? undefined}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
              />
            </div>
            <div className={styles.inviteRole}>
              <Select label="Role" options={ROLE_OPTIONS} value={role} onValueChange={value => setRole(value as Role)} />
            </div>
            <Button type="submit" className={styles.inviteButton} loading={inviting} disabled={inviting}>
              <UserPlus size={16} strokeWidth={1.75} aria-hidden="true" />
              Invite
            </Button>
          </form>
        ) : null}

        {access ? (
          <section className={styles.block} aria-labelledby={`${listId}-people`}>
            <h3 id={`${listId}-people`} className={styles.heading}>People with access</h3>
            <ul role="list" className={styles.list}>
              {access.owner ? (
                <li className={styles.row}>
                  <AccountChip account={{ ...access.owner, display_name: access.owner.displayName, pfp_url: access.owner.pfpUrl }} note={access.owner.id === selfId ? "You" : undefined} />
                  <span className={styles.roleText}>Owner</span>
                </li>
              ) : null}
              {access.members.filter(member => member.role !== "owner").map(member => {
                const label = memberLabel(member);
                const locked = !canShare || !!member.via || busy === member.key;
                return (
                  <li key={member.key} className={styles.row} data-pending={member.pending ? "" : undefined}>
                    {member.account ? (
                      <AccountChip account={{ ...member.account, display_name: member.account.displayName, pfp_url: member.account.pfpUrl }} note={member.account.id === selfId ? "You" : undefined} />
                    ) : (
                      <span className={styles.email}>
                        <span className={styles.emailAddress}>{member.email}</span>
                        <span className={styles.meta}>Invite sent: joins when they sign in to Silicon Accounts with this email</span>
                      </span>
                    )}
                    <span className={styles.controls}>
                      {member.via ? <span className={styles.via}>Through {member.via.name ? `“${member.via.name}”` : "a folder"}</span> : null}
                      {locked && !member.via && !canShare ? <span className={styles.roleText}>{ROLE_WORDS[member.role].label}</span> : null}
                      {canShare && !member.via ? (
                        <>
                          <span className={styles.quietSelect}>
                            <Select label={`Role for ${label}`} options={ROLE_OPTIONS} value={member.role === "owner" ? "editor" : member.role} disabled={busy === member.key} onValueChange={value => void updateRole(member, value as Role)} />
                          </span>
                          <button type="button" className={styles.iconButton} data-sq="surface" aria-label={`Remove ${label}`} disabled={busy === member.key} onClick={() => void remove(member)}>
                            <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                          </button>
                        </>
                      ) : member.via ? <span className={styles.roleText}>{ROLE_WORDS[member.role].label}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            {access.members.filter(member => member.role !== "owner").length === 0 ? <p className={styles.empty}>Nobody else has access yet.</p> : null}
          </section>
        ) : !loadError ? <p className={styles.empty}>Loading who has access…</p> : null}

        {access && kind === "deck" ? (
          <section className={styles.block} aria-labelledby={`${listId}-link`}>
            <h3 id={`${listId}-link`} className={styles.heading}>Link</h3>
            <div className={styles.publicRow}>
              <span className={styles.publicIcon} data-sq="surface" aria-hidden="true">{publicMode === "off" ? <Lock size={16} strokeWidth={1.75} /> : <Globe size={16} strokeWidth={1.75} />}</span>
              <span className={styles.publicText}>
                <span className={styles.publicLabel} id={`${listId}-public`}>Anyone with the link</span>
                <span className={styles.meta}>
                  {publicMode === "off" ? "Off: only people with access can open it." : access.requireEmail ? "An email is required to view. Sign in to comment or edit when allowed." : publicMode === "view" ? "Can open it without signing in. Nothing is listed anywhere." : "Can open it without signing in, and sign in to comment or edit."}
                </span>
              </span>
              <Switch aria-labelledby={`${listId}-public`} checked={publicMode !== "off"} disabled={!can.own(myRole) || busy === "public"} onCheckedChange={next => void changePublic(next ? "view" : "off")} />
            </div>
            {publicMode !== "off" ? (
              <div className={styles.publicMode}>
                <Select label="What anyone with the link can do" options={PUBLIC_OPTIONS} value={publicMode} disabled={!can.own(myRole) || busy === "public"} onValueChange={value => void changePublic(value as PublicMode)} />
              </div>
            ) : null}
            {publicMode !== "off" && confirmedOwner ? (
              <div className={styles.publicRow}>
                <span className={styles.publicIcon} data-sq="surface" aria-hidden="true"><Mail size={16} strokeWidth={1.75} /></span>
                <span className={styles.publicText}>
                  <span className={styles.publicLabel} id={`${listId}-require-email`}>Require email to view</span>
                  <span className={styles.meta} id={`${listId}-email-help`}>Public visitors provide an email before viewing. Signed-in visitors use their account email when available.</span>
                </span>
                <Switch aria-labelledby={`${listId}-require-email`} aria-describedby={`${listId}-email-help`} checked={access.requireEmail} disabled={busy === "public"} onCheckedChange={next => void changeEmailRequirement(next)} />
              </div>
            ) : null}
            <div className={styles.linkRow}>
              <Link2 size={16} strokeWidth={1.75} aria-hidden="true" className={styles.linkIcon} />
              <span className={styles.link} title={link}>{link}</span>
              <CopyButton value={link} label="Copy link" variant="outline" />
            </div>
          </section>
        ) : null}
        {open && kind === "deck" && confirmedOwner ? <ViewerList key={id} id={id} requireEmail={access!.requireEmail} onAccessDenied={load} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ViewerTime({ value }: { value: string | null }) {
  if (!value || Number.isNaN(Date.parse(value))) return <span className={styles.meta}>Not recorded</span>;
  return <time dateTime={value} title={formatDateTime(value)} className={styles.viewerTime}>
    <span>{formatDate(value)}</span>
    <span className={styles.meta}>{formatTime(value)}</span>
  </time>;
}

function ViewerList({ id, requireEmail, onAccessDenied }: { id: string; requireEmail: boolean; onAccessDenied: () => Promise<unknown> }) {
  const [viewers, setViewers] = useState<DeckViewer[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const headingId = useId();
  const reload = () => { setLoading(true); setRefresh(value => value + 1); };

  useEffect(() => {
    const controller = new AbortController();
    getDeckViewers(id, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      setViewers(next);
      setError(null);
    }).catch(failure => {
      if (controller.signal.aborted) return;
      const next = ApiError.from(failure);
      setError(next);
      setViewers(null);
      if (next.status === 403 || next.status === 404) void onAccessDenied();
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, refresh, onAccessDenied]);

  return <section className={styles.block} aria-labelledby={headingId}>
    <div className={styles.viewerHeading}>
      <h3 id={headingId} className={styles.heading}>Who viewed</h3>
      <Button variant="ghost" size="sm" loading={loading} disabled={loading} aria-label="Refresh viewers" onClick={reload}>
        <RefreshCw size={14} aria-hidden="true" /> Refresh
      </Button>
    </div>
    <p className={styles.viewerHelp}>Only you can see this list. Entered emails are not verified. Repeat opens within 30 minutes count as one view.</p>
    {error ? <ErrorAlert error={error} title="Viewers could not be loaded" action={<Button size="sm" variant="secondary" onClick={reload} disabled={loading}>Try again</Button>} /> : null}
    {loading && viewers === null ? <p className={styles.empty} role="status">Loading viewers…</p> : null}
    {viewers?.length === 0 && !loading ? <div className={styles.empty}>
      <p>No viewer emails recorded yet.</p>
      <p>{requireEmail ? "Emails will appear after visitors open the deck." : "Turn on Require email to view to start recording viewer emails."}</p>
    </div> : null}
    {viewers && viewers.length > 0 ? <div className={styles.viewerScroll} role="region" aria-label="Viewer history" tabIndex={0} aria-busy={loading}>
      <table className={styles.viewerTable}>
        <caption className="sr-only">Viewer emails and visits, visible only to the deck owner</caption>
        <thead><tr><th scope="col">Email</th><th scope="col">Source</th><th scope="col">First viewed</th><th scope="col">Last viewed</th><th scope="col">Views</th></tr></thead>
        <tbody>{viewers.map(viewer => <tr key={`${viewer.source}:${viewer.email}`}>
          <th scope="row" className={styles.viewerEmail}>{viewer.email}</th>
          <td><span className={styles.meta}>{viewer.source === "account" ? "Account email" : "Entered email · unverified"}</span></td>
          <td><ViewerTime value={viewer.firstViewedAt} /></td>
          <td><ViewerTime value={viewer.lastViewedAt} /></td>
          <td className={styles.viewCount}>{viewer.views.toLocaleString("en-US")}</td>
        </tr>)}</tbody>
      </table>
    </div> : null}
  </section>;
}

export interface ShareButtonProps extends Omit<ShareDialogProps, "open" | "onOpenChange"> {
  /** The button's look: "secondary" (default) or "primary". */
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  label?: string;
}

/** A "Share" button that opens the dialog. */
export function ShareButton({ variant = "secondary", size = "md", label = "Share", ...props }: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)} aria-haspopup="dialog">
        <UserPlus size={16} strokeWidth={1.75} aria-hidden="true" />
        {label}
      </Button>
      <ShareDialog {...props} open={open} onOpenChange={setOpen} />
    </>
  );
}
