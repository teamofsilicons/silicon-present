"use client";

/**
 * The demo's list page body: search and filters (Arc's filter toolbar), the items in Arc's sortable data table, and an
 * empty state for "nothing yet" and for "nothing matches". The Server Component fetched the first answer; React Query
 * keeps it fresh after creating, editing or deleting.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { FileText, Filter, Inbox, Plus, Users } from "lucide-react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { FilterMenu, FilterToolbar, type FilterChip, type FilterField } from "@/components/arc/filter-toolbar/filter-toolbar";
import { SearchField } from "@/components/arc/search-field/search-field";
import { SortableDataTable, type DataColumn } from "@/components/arc/sortable-data-table/sortable-data-table";
import { AccountChip } from "@/components/foundation/account/account-chip";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { useRegisterCommands } from "@/lib/commands";
import { LocalTime } from "@/components/foundation/time/local-time";
import { plural } from "@/lib/format";
import { notify } from "@/lib/notify";
import { useCreateItem, useItems } from "../api";
import { STATUS_LABELS, STATUS_TONES, type Item, type ItemStatus } from "../types";
import { ItemFormDialog } from "./item-form";
import styles from "./demo.module.css";

type Row = Record<string, unknown> & { id: string; title: string; status: ItemStatus; statusLabel: string; owner: string; shared: number; updated: number; item: Item };

const NO_ITEMS: Item[] = [];

const FIELDS: FilterField[] = [
  { id: "status", label: "Status", icon: <FileText size={16} strokeWidth={1.75} />, options: (Object.keys(STATUS_LABELS) as ItemStatus[]).map(value => ({ value, label: STATUS_LABELS[value] })) },
  { id: "role", label: "Owner", icon: <Users size={16} strokeWidth={1.75} />, options: [{ value: "owner", label: "Mine" }, { value: "shared", label: "Shared with me" }] },
];

export function NewItemButton() {
  const [open, setOpen] = useState(false);
  const create = useCreateItem();
  useRegisterCommands(() => [{ id: "items.create", label: "New item", description: "Create an item", group: "Items", icon: <Plus size={16} strokeWidth={1.75} />, keywords: ["create", "add"], run: () => setOpen(true) }], []);
  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus size={16} strokeWidth={2} aria-hidden="true" />New item</Button>
      <ItemFormDialog
        open={open}
        onOpenChange={setOpen}
        mode="create"
        onSubmit={async input => {
          const item = await create.mutateAsync(input);
          notify.success("Item created", `"${item.title}" is yours alone until you share it.`);
        }}
      />
    </>
  );
}

export function ItemsView({ initialItems }: { initialItems: Item[] }) {
  const query = useItems(initialItems);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<FilterChip[]>([]);
  const items = query.data ?? NO_ITEMS;

  const rows = useMemo<Row[]>(() => {
    const status = filters.find(filter => filter.id === "status");
    const role = filters.find(filter => filter.id === "role");
    const needle = search.trim().toLowerCase();
    return items
      .filter(item => !needle || `${item.title} ${item.description}`.toLowerCase().includes(needle))
      .filter(item => !status || STATUS_LABELS[item.status] === status.value)
      .filter(item => !role || (role.value === "Mine" ? item.role === "owner" : item.role === "shared"))
      .map(item => ({ id: item.id, title: item.title, status: item.status, statusLabel: STATUS_LABELS[item.status], owner: item.owner.id, shared: item.shares.length, updated: Date.parse(item.updated_at), item }));
  }, [items, filters, search]);

  const columns: DataColumn<Row>[] = [
    {
      key: "title",
      label: "Title",
      render: (_value, row) => (
        <span className={styles.titleCell}>
          <Link href={`/items/${encodeURIComponent(row.id)}`} className={styles.rowLink}>{row.title}</Link>
          {row.item.description ? <span className={styles.rowDescription}>{row.item.description}</span> : null}
        </span>
      ),
    },
    { key: "statusLabel", label: "Status", width: 120, render: (_value, row) => <Badge tone={STATUS_TONES[row.status]} size="sm">{row.statusLabel}</Badge> },
    // On a phone the table folds into cards without column headers, so each cell says what it is there.
    { key: "owner", label: "Owner", width: 210, render: (_value, row) => (row.item.role === "owner" ? <span className={styles.muted}><span className={styles.onWide}>You</span><span className={styles.onPhone}>Yours</span></span> : <AccountChip account={row.item.owner} />) },
    { key: "shared", label: "Sharing", width: 150, numeric: false, render: (_value, row) => <span className={styles.muted}>{row.shared ? `With ${plural(row.shared, "account")}` : "Private"}</span> },
    { key: "updated", label: "Updated", width: 140, numeric: false, render: (_value, row) => <span className={styles.muted}><span className={styles.onPhone}>Updated </span><LocalTime value={row.item.updated_at} /></span> },
  ];

  const clear = () => {
    setFilters([]);
    setSearch("");
  };
  const addFilter = (chip: FilterChip) => setFilters(current => [...current.filter(filter => filter.id !== chip.id), chip]);
  const removeFilter = (id: string) => setFilters(current => current.filter(filter => filter.id !== id));

  if (query.error && !items.length) {
    return <ErrorAlert error={query.error} title="Items could not be loaded" action={<Button variant="secondary" size="sm" onClick={() => void query.refetch()}>Try again</Button>} />;
  }

  return (
    <div className={styles.listBlock}>
      {/* Wide screens: the search beside Arc's filter toolbar. Phones: the search and the Add filter menu on one line, and
          the toolbar (chips and Clear all) only once a filter is on. */}
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <SearchField label="Search items" value={search} onValueChange={setSearch} placeholder="Search titles and descriptions" />
        </div>
        <div className={styles.filtersWide}>
          <FilterToolbar label="Item filters" filters={filters} onRemove={removeFilter} onClearAll={() => setFilters([])} addFilter={{ fields: FIELDS, onAdd: addFilter, label: "Add filter" }} />
        </div>
        <div className={styles.filtersPhone}>
          <FilterMenu fields={FIELDS} onSelect={addFilter} active={filters} label="Filter" align="end" />
        </div>
      </div>
      {filters.length ? (
        <div className={styles.chipsPhone}>
          <FilterToolbar label="Item filters" filters={filters} onRemove={removeFilter} onClearAll={() => setFilters([])} />
        </div>
      ) : null}
      {items.length === 0 ? (
        <div className={styles.emptyFrame} data-sq="surface">
          <EmptyState icon={<Inbox width={24} height={24} strokeWidth={1.5} />} title="No items yet" description="Create your first item. It is yours alone until you share it with a Carbon or a Silicon." action={<NewItemButton />} />
        </div>
      ) : rows.length === 0 ? (
        <div className={styles.emptyFrame} data-sq="surface">
          <EmptyState icon={<Filter width={24} height={24} strokeWidth={1.5} />} title="Nothing matches" description={`None of your ${plural(items.length, "item")} match this search and these filters.`} action={<Button variant="secondary" onClick={clear}>Clear search and filters</Button>} />
        </div>
      ) : (
        <SortableDataTable<Row> rows={rows} columns={columns} rowKey="id" caption="Items" defaultSort={{ key: "updated", direction: "desc" }} itemName={{ one: "item", other: "items" }} />
      )}
    </div>
  );
}
