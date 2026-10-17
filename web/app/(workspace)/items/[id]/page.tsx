/**
 * /items/[id]: the demo's detail page. An item that does not exist, or is not shared with this account, renders the
 * workspace's not-found page (apiFetch with notFound: true turns the service's 404 into notFound()).
 */
import type { Metadata } from "next";
import { ItemDetail } from "@/demo/components/item-detail";
import type { Item } from "@/demo/types";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { requireSession, tryApiFetch } from "@/lib/server/rsc";

async function load(id: string) {
  return tryApiFetch<Item>(`/v1/items/${encodeURIComponent(id)}`, { notFound: true });
}

export async function generateMetadata({ params }: PageProps<"/items/[id]">): Promise<Metadata> {
  const { id } = await params;
  const { data } = await load(id);
  return { title: data?.title ?? "Item" };
}

export default async function ItemPage({ params }: PageProps<"/items/[id]">) {
  const { id } = await params;
  const [session, { data, error }] = await Promise.all([requireSession(), load(id)]);
  return (
    <Page width="reading">
      {error ? (
        <>
          <PageHeader back={{ href: "/items", label: "Items" }} title="Item" />
          <ErrorAlert error={error} title="This item could not be loaded" />
        </>
      ) : (
        <ItemDetail initialItem={data} account={session.account} />
      )}
    </Page>
  );
}
