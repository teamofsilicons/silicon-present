"use client";

/**
 * The demo's settings page body: switches that save as you flip them (Arc: a toggle acts at once and confirms in
 * place), default sharing for new items with the share-with-accounts control, and the signed-in account as Silicon
 * Accounts shows it, with a link to manage it there.
 */
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Switch } from "@/components/arc/switch/switch";
import { AccountChip } from "@/components/foundation/account/account-chip";
import { ShareWithAccounts } from "@/components/foundation/account/share-with-accounts";
import { ButtonLink } from "@/components/foundation/button-link";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { Section, SettingsGroup, SettingsRow, Surface } from "@/components/foundation/layout/layout";
import type { SessionAccount } from "@/lib/account";
import { ApiError } from "@/lib/errors";
import { notify } from "@/lib/notify";
import { resolveAccount, useSettings, useUpdateSettings } from "../api";
import type { Settings } from "../types";
import styles from "./demo.module.css";

type Toggle = "notify_on_share" | "weekly_summary" | "show_ids";

const TOGGLES: Array<{ key: Toggle; label: string; description: string }> = [
  { key: "notify_on_share", label: "Tell me when something is shared with me", description: "A notice in the app when a Carbon or a Silicon shares an item with you." },
  { key: "weekly_summary", label: "Weekly summary", description: "Every Monday: what changed in the items you own and the ones shared with you." },
  { key: "show_ids", label: "Show account ids next to names", description: "Handy when two accounts have similar display names." },
];

export function SettingsView({ initialSettings, account, accountsUrl }: { initialSettings: Settings; account: SessionAccount; accountsUrl: string }) {
  const { data } = useSettings(initialSettings);
  const settings = data ?? initialSettings;
  const update = useUpdateSettings();

  return (
    <>
      <Section title="Notifications" description="Saved as soon as you change them.">
        <SettingsGroup label="Notifications">
          {TOGGLES.map(toggle => (
            <SettingsRow key={toggle.key} label={toggle.label} description={toggle.description} inline>
              {ids => (
                <Switch
                  checked={settings[toggle.key]}
                  aria-labelledby={ids.labelId}
                  aria-describedby={ids.descriptionId}
                  disabled={update.isPending && update.variables && toggle.key in update.variables}
                  onCheckedChange={checked => update.mutate({ [toggle.key]: checked })}
                />
              )}
            </SettingsRow>
          ))}
        </SettingsGroup>
      </Section>

      <DefaultSharing settings={settings} account={account} />

      <Section title="Your account" description={`You signed in to this app with Silicon Accounts. Your name, photo and id are managed there.`}>
        <Surface className={styles.accountCard}>
          <AccountChip account={account} note={account.kind === "silicon" && account.custodian ? `looked after by ${account.custodian.id}` : undefined} />
          <ButtonLink href={accountsUrl} external variant="secondary" size="sm" target="_blank" rel="noopener">
            Manage at Silicon Accounts<ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
          </ButtonLink>
        </Surface>
      </Section>
    </>
  );
}

function DefaultSharing({ settings, account }: { settings: Settings; account: SessionAccount }) {
  const update = useUpdateSettings();
  const saved = settings.default_shares.map(entry => entry.id);
  const [ids, setIds] = useState<string[]>(saved);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const dirty = ids.join(" ") !== saved.join(" ");

  async function save() {
    setFailure(null);
    try {
      const next = await update.mutateAsync({ default_shares: ids });
      setIds(next.default_shares.map(entry => entry.id));
      notify.success("Default sharing saved", next.default_shares.length ? "New items start shared with these accounts." : "New items start private.");
    } catch (error) {
      setFailure(ApiError.from(error));
    }
  }

  return (
    <Section title="Default sharing" description="New items start shared with these accounts. Items you already made keep their own sharing.">
      <Surface className={styles.sharing}>
        <ShareWithAccounts
          label="Share new items with"
          ids={ids}
          onIdsChange={next => {
            setIds(next);
            setFailure(null);
          }}
          known={settings.default_shares}
          resolve={resolveAccount}
          errors={failure?.fields}
          selfId={account.id}
          description="Carbons by c: id, Silicons by si: id. Leave it empty to keep new items private."
        />
        {failure && !Object.keys(failure.fields).length ? <ErrorAlert error={failure} title="Default sharing was not saved" /> : null}
        <div className={styles.formActions}>
          <Button variant="ghost" disabled={!dirty || update.isPending} onClick={() => { setIds(saved); setFailure(null); }}>Undo changes</Button>
          <Button onClick={() => void save()} loading={update.isPending} disabled={!dirty}>Save default sharing</Button>
        </div>
      </Surface>
    </Section>
  );
}
