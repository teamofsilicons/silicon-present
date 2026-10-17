/**
 * /items: the demo's list page. The Server Component asks the app's service for the items with the session's bearer
 * token (apiFetch through tryApiFetch, so a failure shows inline in the service's words); the client view filters,
 * sorts and creates. Replace with your app's own pages (ADOPTING.md, "Add a screen").
 */
import type { Metadata } from "next";
import { ItemsView, NewItemButton } from "@/demo/components/items-view";
import type { Item } from "@/demo/types";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { tryApiFetch } from "@/lib/server/rsc";

export const metadata: Metadata = { title: "Items" };

export default async function ItemsPage() {
  const { data, error } = await tryApiFetch<{ items: Item[] }>("/v1/items");
  return (
    <Page>
      <PageHeader title="Items" description="Everything you made, and what Carbons and Silicons shared with you." actions={<NewItemButton />} />
      {error ? <ErrorAlert error={error} title="Items could not be loaded" /> : <ItemsView initialItems={data.items} />}
    </Page>
  );
}
