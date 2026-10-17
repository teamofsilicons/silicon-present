"use client";

/**
 * The demo's detail page body: the item's header and actions (Edit opens the form dialog; Delete is a hold-to-confirm,
 * Arc's rule for destructive actions), then tabs: Overview (the details), Sharing (the share-with-accounts control and
 * who can see it) and History. Only the owner can edit, share or delete; a Carbon a thing was shared with reads it.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { HoldToConfirm } from "@/components/arc/hold-to-confirm/hold-to-confirm";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { AccountChip } from "@/components/foundation/account/account-chip";
import { ShareWithAccounts } from "@/components/foundation/account/share-with-accounts";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { DescriptionItem, DescriptionList, PageHeader, Section, Surface } from "@/components/foundation/layout/layout";
import type { SessionAccount } from "@/lib/account";
import { ApiError } from "@/lib/errors";
import { LocalTime } from "@/components/foundation/time/local-time";
import { plural } from "@/lib/format";
import { notify } from "@/lib/notify";
import { resolveAccount, useDeleteItem, useItem, useShareItem, useUpdateItem } from "../api";
import { STATUS_LABELS, STATUS_TONES, type Item } from "../types";
import { ItemFormDialog } from "./item-form";
import styles from "./demo.module.css";

export function ItemDetail({ initialItem, account }: { initialItem: Item; account: SessionAccount }) {
  const router = useRouter();
  const { data } = useItem(initialItem.id, initialItem);
  const item = data ?? initialItem;
  const owner = item.role === "owner";
  const [editing, setEditing] = useState(false);
  const update = useUpdateItem(item.id);
  const remove = useDeleteItem(item.id);

  return (
    <>
      <PageHeader
        back={{ href: "/items", label: "Items" }}
        size="entity"
        title={item.title}
        description={item.description || "No description yet."}
        actions={owner ? (
          <>
            <Button variant="secondary" onClick={() => setEditing(true)}><Pencil size={16} strokeWidth={1.75} aria-hidden="true" />Edit</Button>
            <HoldToConfirm
              label="Hold to delete"
              confirmedLabel="Deleted"
              tone="danger"
              icon={<Trash2 strokeWidth={1.75} />}
              disabled={remove.isPending}
              onConfirm={() => remove.mutate(undefined, {
                onSuccess: () => {
                  notify.success("Item deleted", `"${item.title}" is gone, for you and everyone it was shared with.`);
                  router.push("/items", { transitionTypes: ["nav-fade"] });
                },
              })}
            />
          </>
        ) : null}
      >
        <div className={styles.headerMeta}>
          <Badge tone={STATUS_TONES[item.status]}>{STATUS_LABELS[item.status]}</Badge>
          <LocalTime value={item.updated_at} prefix="Updated " className={styles.muted} />
        </div>
      </PageHeader>

      <Tabs defaultValue="overview" className={styles.tabs}>
        <TabsList aria-label="Item">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="sharing">Sharing</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Surface>
            <DescriptionList>
              <DescriptionItem label="Title">{item.title}</DescriptionItem>
              <DescriptionItem label="Description">{item.description || <span className={styles.muted}>None</span>}</DescriptionItem>
              <DescriptionItem label="Status"><Badge tone={STATUS_TONES[item.status]} size="sm">{STATUS_LABELS[item.status]}</Badge></DescriptionItem>
              <DescriptionItem label="Owner"><AccountChip account={owner ? { ...item.owner, display_name: account.display_name, pfp_url: account.pfp_url } : item.owner} note={owner ? "You" : undefined} /></DescriptionItem>
              <DescriptionItem label="Created"><LocalTime value={item.created_at} format="datetime" /></DescriptionItem>
              <DescriptionItem label="Item id"><code>{item.id}</code></DescriptionItem>
            </DescriptionList>
          </Surface>
        </TabsContent>
        <TabsContent value="sharing">
          {owner ? <SharingPanel item={item} account={account} /> : <ReadOnlySharing item={item} />}
        </TabsContent>
        <TabsContent value="history">
          <Surface>
            <ol className={styles.history} role="list" aria-label="History, newest first">
              {item.history.map((event, index) => (
                <li key={`${event.at}-${index}`}>
                  <span className={styles.historyDot} data-sq="surface" aria-hidden="true" />
                  <span><strong>{event.by ?? "Someone"}</strong> {event.action}</span>
                  <LocalTime value={event.at} format="datetime" className={styles.muted} />
                </li>
              ))}
            </ol>
          </Surface>
        </TabsContent>
      </Tabs>

      <ItemFormDialog
        open={editing}
        onOpenChange={setEditing}
        mode="edit"
        initial={{ title: item.title, description: item.description, status: item.status }}
        onSubmit={async input => {
          await update.mutateAsync(input);
          notify.success("Saved", "Your changes are in.");
          router.refresh();
        }}
      />
    </>
  );
}

function SharingPanel({ item, account }: { item: Item; account: SessionAccount }) {
  const share = useShareItem(item.id);
  const saved = item.shares.map(entry => entry.id);
  const [ids, setIds] = useState<string[]>(saved);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const dirty = ids.join(" ") !== saved.join(" ");

  async function save() {
    setFailure(null);
    try {
      const next = await share.mutateAsync(ids);
      setIds(next.shares.map(entry => entry.id));
      notify.success(next.shares.length ? "Sharing saved" : "Only you can see it now", next.shares.length ? `${plural(next.shares.length, "account")} can see "${next.title}".` : undefined);
    } catch (error) {
      setFailure(ApiError.from(error));
    }
  }

  return (
    <Section title="Who can see this item" description="You always can. Add Carbons and Silicons by their id; they see it the next time they look. A Carbon also sees what its Silicons keep.">
      <Surface className={styles.sharing}>
        <ShareWithAccounts
          label="Share with"
          ids={ids}
          onIdsChange={next => {
            setIds(next);
            setFailure(null);
          }}
          known={item.shares}
          resolve={resolveAccount}
          errors={failure?.fields}
          selfId={account.id}
          description="Type c: and a handle for a Carbon, si: and a handle for a Silicon, then press Enter."
        />
        {failure && !Object.keys(failure.fields).length ? <ErrorAlert error={failure} title="Sharing was not saved" /> : null}
        <div className={styles.formActions}>
          <Button variant="ghost" disabled={!dirty || share.isPending} onClick={() => { setIds(saved); setFailure(null); }}>Undo changes</Button>
          <Button onClick={() => void save()} loading={share.isPending} disabled={!dirty}>Save sharing</Button>
        </div>
      </Surface>
    </Section>
  );
}

function ReadOnlySharing({ item }: { item: Item }) {
  return (
    <Section title="Who can see this item" description="Only its owner can change who sees it.">
      <Surface>
        <ul className={styles.accountList} role="list">
          <li><AccountChip account={item.owner} note="Owner" /></li>
          {item.shares.map(entry => <li key={entry.uuid}><AccountChip account={entry} /></li>)}
        </ul>
      </Surface>
    </Section>
  );
}
