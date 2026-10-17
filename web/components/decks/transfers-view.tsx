"use client";

/**
 * Transfers: what was offered to you (accept, and it becomes yours; or decline) and what you offered (cancel while it
 * waits), then the ones already answered.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Folder as FolderIcon, Presentation, X } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { LocalTime } from "@/components/foundation/time/local-time";
import { MetaLine } from "@/components/meta/meta-line";
import { notify, notifyError } from "@/lib/notify";
import { answerTransfer, listTransfers } from "@/lib/present/transfers";
import type { Transfer } from "@/lib/present/types";
import { ALWAYS_FRESH } from "@/lib/present/fresh";
import styles from "./decks.module.css";

const STATE_WORDS: Record<Transfer["state"], string> = { pending: "Waiting", accepted: "Accepted", declined: "Declined", cancelled: "Cancelled" };

export function TransfersView({ initial, me }: { initial: Transfer[]; me: { uuid: string; id: string } }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const transfers = useQuery({ queryKey: ["transfers"], queryFn: ({ signal }) => listTransfers(signal), initialData: initial, ...ALWAYS_FRESH });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const isMe = (account: Transfer["to"]) => !!account && (account.uuid === me.uuid || account.id === me.id);
  const incoming = transfers.data.filter(transfer => transfer.state === "pending" && isMe(transfer.to));
  const outgoing = transfers.data.filter(transfer => transfer.state === "pending" && isMe(transfer.from));
  const earlier = transfers.data.filter(transfer => transfer.state !== "pending");

  async function answer(transfer: Transfer, action: "accept" | "decline" | "cancel") {
    setBusy(`${transfer.id}:${action}`);
    try {
      await answerTransfer(transfer.id, action);
      const words = { accept: `“${transfer.title}” is yours now.`, decline: `You declined “${transfer.title}”.`, cancel: `The transfer of “${transfer.title}” is cancelled.` }[action];
      setNotice(words);
      notify.success(action === "accept" ? "Accepted" : action === "decline" ? "Declined" : "Cancelled", words);
      await queryClient.invalidateQueries({ queryKey: ["transfers"] });
      await queryClient.invalidateQueries({ queryKey: ["place"] });
      router.refresh();
    } catch (error) {
      notifyError(error, `Could not ${action} the transfer`);
    } finally {
      setBusy(null);
    }
  }

  const row = (transfer: Transfer, actions: React.ReactNode) => (
    <li key={transfer.id} className={styles.row} data-kind={transfer.kind}>
      {transfer.kind === "folder" ? <FolderIcon size={18} strokeWidth={1.75} aria-hidden="true" className={styles.icon} /> : <Presentation size={18} strokeWidth={1.75} aria-hidden="true" className={styles.icon} />}
      <span className={styles.main}>
        {transfer.state === "accepted" && isMe(transfer.to) && transfer.kind === "deck" ? (
          <Link className={styles.name} href={`/decks/${encodeURIComponent(transfer.resource)}`}>{transfer.title || "Untitled"}</Link>
        ) : (
          <span className={styles.name}>{transfer.title || "Untitled"}</span>
        )}
        <MetaLine
          parts={[
            transfer.kind === "folder" ? "Folder" : "Deck",
            isMe(transfer.to) ? `From ${transfer.from?.id ?? "someone"}` : `To ${transfer.to?.id ?? "someone"}`,
            transfer.state !== "pending" ? STATE_WORDS[transfer.state] : null,
            transfer.createdAt ? <LocalTime value={transfer.createdAt} prefix="Offered " /> : null,
          ]}
        />
      </span>
      {actions ? <span className={styles.rowActions}>{actions}</span> : null}
    </li>
  );

  return (
    <div className={styles.view}>
      <p className="sr-only" role="status" aria-live="polite">{notice}</p>
      <header className={styles.header}>
        <h1 className={styles.title}>Transfers</h1>
        <p className={styles.lede}>A deck or folder changes owner only when the one it is offered to accepts.</p>
      </header>

      <section aria-labelledby="incoming-title" className={styles.header}>
        <h2 id="incoming-title" className={styles.sectionTitle}>Offered to you</h2>
        {incoming.length ? (
          <ul role="list" className={styles.list}>
            {incoming.map(transfer => row(transfer, (
              <>
                <Button size="sm" onClick={() => void answer(transfer, "accept")} loading={busy === `${transfer.id}:accept`} disabled={!!busy} aria-label={`Accept ${transfer.title}`}><Check size={16} strokeWidth={1.75} aria-hidden="true" />Accept</Button>
                <Button size="sm" variant="ghost" onClick={() => void answer(transfer, "decline")} loading={busy === `${transfer.id}:decline`} disabled={!!busy} aria-label={`Decline ${transfer.title}`}><X size={16} strokeWidth={1.75} aria-hidden="true" />Decline</Button>
              </>
            )))}
          </ul>
        ) : <p className={styles.quiet}>Nothing is waiting for you.</p>}
      </section>

      <section aria-labelledby="outgoing-title" className={styles.header}>
        <h2 id="outgoing-title" className={styles.sectionTitle}>Offered by you</h2>
        {outgoing.length ? (
          <ul role="list" className={styles.list}>
            {outgoing.map(transfer => row(transfer, (
              <Button size="sm" variant="secondary" onClick={() => void answer(transfer, "cancel")} loading={busy === `${transfer.id}:cancel`} disabled={!!busy} aria-label={`Cancel transfer of ${transfer.title}`}>Cancel transfer</Button>
            )))}
          </ul>
        ) : <p className={styles.quiet}>You have not offered anything. Offer a deck or folder from its “More actions” menu.</p>}
      </section>

      {earlier.length ? (
        <section aria-labelledby="earlier-title" className={styles.header}>
          <h2 id="earlier-title" className={styles.sectionTitle}>Earlier</h2>
          <ul role="list" className={styles.list}>{earlier.map(transfer => row(transfer, null))}</ul>
        </section>
      ) : null}
    </div>
  );
}
