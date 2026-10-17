/** /settings: the demo's settings page (switches, default sharing, the signed-in account). */
import type { Metadata } from "next";
import { SettingsView } from "@/demo/components/settings-view";
import type { Settings } from "@/demo/types";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { requireSession, tryApiFetch } from "@/lib/server/rsc";
import { accountsOrigin } from "@/lib/server/site";
import { appConfig } from "@/lib/app.config";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const [session, { data, error }] = await Promise.all([requireSession(), tryApiFetch<Settings>("/v1/settings")]);
  return (
    <Page width="narrow">
      <PageHeader title="Settings" description={`How ${appConfig.name} behaves for your account. Nobody else sees these choices.`} />
      {error ? <ErrorAlert error={error} title="Settings could not be loaded" /> : <SettingsView initialSettings={data} account={session.account} accountsUrl={accountsOrigin()} />}
    </Page>
  );
}
