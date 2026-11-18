import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { OrganizationSettings } from "@/components/people/organization-settings";
import { requireSession } from "@/lib/server/rsc";
export const metadata = { title: "Organizations" };
export default async function OrganizationsPage() {
  await requireSession();
  return (
    <Page width="reading">
      <PageHeader title="Organizations" />
      <OrganizationSettings />
    </Page>
  );
}
