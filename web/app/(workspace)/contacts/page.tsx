import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { Contacts } from "@/components/people/contacts";
import { requireSession } from "@/lib/server/rsc";
export const metadata = { title: "Contacts" };
export default async function ContactsPage() {
  await requireSession();
  return (
    <Page width="reading">
      <PageHeader title="Contacts" />
      <Contacts />
    </Page>
  );
}
