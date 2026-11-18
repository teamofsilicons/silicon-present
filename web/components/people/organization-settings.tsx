"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Select } from "@/components/arc/select/select";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { api, seg } from "@/lib/client/api";
import { ApiError } from "@/lib/errors";
import type { Account, ResourceKind, Role } from "@/lib/present/types";
import { RecipientPicker, PersonChip } from "./recipient-picker";
import styles from "./people.module.css";

interface Capabilities {
  admin: boolean;
  owner: boolean;
  team_structure: boolean;
  team_members: boolean;
  team_admins: string[];
}
interface Org {
  org_id: string;
  name: string;
  capabilities: Capabilities;
}
interface Target {
  type: "team" | "organization";
  id: string;
  name: string;
  org_id: string;
}
interface Context {
  organizations: Org[];
  share_targets: Target[];
}
interface Member {
  uuid: string;
  id: string;
  kind: "carbon" | "silicon";
  display_name: string;
  pfp_url: string | null;
  removed_at?: number | null;
}
interface Detail {
  org: { org_id: string; name: string };
  capabilities: Capabilities;
  teams: { id: string; name: string; members: string[] }[];
  members: Member[];
}
interface GroupGrant {
  principal: string;
  name: string;
  role: Role;
  inherited: boolean;
}
function useOrganizations() {
  return useQuery({
    queryKey: ["organizations"],
    queryFn: ({ signal }) => api.get<Context>("/v1/organizations", { signal }),
    retry: false,
  });
}
const roles = [
  { value: "viewer", label: "Viewer" },
  { value: "commenter", label: "Commenter" },
  { value: "editor", label: "Editor" },
];

export function GroupSharing({ kind, id, editable }: { kind: ResourceKind; id: string; editable: boolean }) {
  const org = useOrganizations();
  const cache = useQueryClient();
  const path = "/v1/" + (kind === "deck" ? "decks" : "folders") + "/" + seg(id) + "/groups";
  const groups = useQuery({
    queryKey: ["group-grants", kind, id],
    queryFn: ({ signal }) => api.get<{ groups: GroupGrant[] }>(path, { signal }),
  });
  const [key, setKey] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const targets = org.data?.share_targets ?? [];
  async function grant(principal: string, newRole: Role | null) {
    setError(null);
    setBusy(true);
    try {
      const response = await api.put(path, { principal, role: newRole });
      cache.setQueryData(["group-grants", kind, id], response);
    } catch (e) {
      setError(ApiError.from(e));
    } finally {
      setBusy(false);
    }
  }
  if (!org.error && !groups.error && !targets.length && !groups.data?.groups.length) return null;
  return (
    <section className={styles.section}>
      <h3>Organizations and teams</h3>
      {(error || org.error || groups.error) && <ErrorAlert error={error || org.error || groups.error!} />}
      {editable && targets.length > 0 && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void grant(key || targets[0]!.type + ":" + targets[0]!.id, role);
          }}
        >
          <Select
            label="Organization or team"
            value={key || targets[0]!.type + ":" + targets[0]!.id}
            onValueChange={setKey}
            options={targets.map((t) => ({ value: t.type + ":" + t.id, label: t.name + " · " + t.type + " · " + t.org_id }))}
          />
          <Select label="Group role" value={role} onValueChange={(v) => setRole(v as Role)} options={roles} />
          <Button type="submit" variant="secondary" loading={busy}>
            Share with group
          </Button>
        </form>
      )}
      <ul className={styles.rows}>
        {groups.data?.groups.map((g, i) => (
          <li className={styles.row} key={g.principal + i}>
            <strong>{g.name}</strong>
            <span>
              {g.role}
              {g.inherited ? " · Through a folder" : ""}
            </span>
            {!g.inherited && editable && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void grant(g.principal, null)}>
                Remove {g.name}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function OrganizationSettings() {
  const ctx = useOrganizations();
  const [selected, setSelected] = useState("");
  const org = ctx.data?.organizations.find((o) => o.org_id === selected) ?? ctx.data?.organizations[0];
  return (
    <div className={styles.section}>
      {ctx.error && <ErrorAlert error={ctx.error} />}
      {ctx.isPending && <p role="status">Loading organizations…</p>}
      {ctx.data && !org && <p>This account has no organization with access to Present.</p>}
      <a href="/auth/sign-in?prompt=select_account&return_to=%2Forganizations">Choose a work account</a>
      {org && (
        <>
          {ctx.data!.organizations.length > 1 && (
            <Select
              label="Organization"
              value={org.org_id}
              onValueChange={setSelected}
              options={ctx.data!.organizations.map((o) => ({ label: o.name, value: o.org_id }))}
            />
          )}
          <OrganizationDetail key={org.org_id} org={org} />
        </>
      )}
    </div>
  );
}
function OrganizationDetail({ org }: { org: Org }) {
  const cache = useQueryClient();
  const path = "/v1/organizations/" + seg(org.org_id);
  const detail = useQuery({ queryKey: ["organization", org.org_id], queryFn: ({ signal }) => api.get<Detail>(path, { signal }) });
  const [name, setName] = useState(org.name);
  const [teamName, setTeamName] = useState("");
  const [team, setTeam] = useState("");
  const [who, setWho] = useState("");
  const [selected, setSelected] = useState<Account | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const retry = useRef<{ fingerprint: string; key: string } | null>(null);
  async function act(body: Record<string, string>, message: string) {
    setError(null);
    setNotice("");
    setBusy(true);
    const fingerprint = JSON.stringify(body);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: crypto.randomUUID() };
    try {
      await api.post(path + "/actions", body, { idempotencyKey: retry.current.key });
      retry.current = null;
      await Promise.all([detail.refetch(), cache.invalidateQueries({ queryKey: ["organizations"] })]);
      setNotice(message);
    } catch (e) {
      const err = ApiError.from(e);
      setError(err);
      if (err.status >= 400 && err.status < 500) retry.current = null;
    } finally {
      setBusy(false);
    }
  }
  if (detail.isPending) return <p role="status">Loading teams…</p>;
  if (detail.error) return <ErrorAlert error={detail.error} />;
  const data = detail.data!,
    caps = data.capabilities,
    active = data.teams.find((t) => t.id === team) ?? data.teams[0];
  const members = data.members
    .filter((m) => !m.removed_at)
    .map((m) => ({ uuid: m.uuid, id: m.id, kind: m.kind, displayName: m.display_name, pfpUrl: m.pfp_url }));
  const canManage = !!active && (caps.team_members || caps.team_admins.includes(active.id));
  return (
    <>
      <h2>{data.org.name}</h2>
      {error && <ErrorAlert error={error} />}
      <span aria-live="polite">{notice}</span>
      {caps.admin && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void act({ action: "update", name: name.trim() }, "Organization name saved.");
          }}
        >
          <h3>Organization settings</h3>
          <Input label="Organization name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Button type="submit" loading={busy} variant="secondary">
            Save name
          </Button>
        </form>
      )}
      <h3>Teams</h3>
      {caps.team_structure && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void act({ action: "team_create", name: teamName.trim() }, "Team created.");
          }}
        >
          <Input label="New team name" value={teamName} required onChange={(e) => setTeamName(e.target.value)} />
          <Button type="submit" variant="secondary" loading={busy}>
            Create team
          </Button>
        </form>
      )}
      {active ? (
        <>
          <Select
            label="Team"
            value={active.id}
            onValueChange={(v) => {
              setTeam(v);
              setWho("");
              setSelected(null);
            }}
            options={data.teams.map((t) => ({ value: t.id, label: t.name }))}
          />
          <ul className={styles.rows}>
            {members
              .filter((m) => active.members.includes(m.uuid))
              .map((a) => (
                <li key={a.uuid} className={styles.row}>
                  <PersonChip account={a} />
                  {canManage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy}
                      onClick={() => void act({ action: "team_member_remove", team: active.id, member: a.uuid }, "Member removed.")}
                    >
                      Remove {a.id}
                    </Button>
                  )}
                </li>
              ))}
          </ul>
          {canManage && (
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault();
                const member = members.find((m) => m.uuid === selected?.uuid || m.id === who.trim());
                if (member) void act({ action: "team_member_add", team: active.id, member: member.uuid }, "Member added.");
              }}
            >
              <RecipientPicker
                label="Add organization member"
                value={who}
                selected={selected}
                allowed={members.filter((m) => !active.members.includes(m.uuid))}
                onChange={(v, a) => {
                  setWho(v);
                  setSelected(a ?? null);
                }}
              />
              <Button
                type="submit"
                variant="secondary"
                loading={busy}
                disabled={!members.some((m) => (m.uuid === selected?.uuid || m.id === who.trim()) && !active.members.includes(m.uuid))}
              >
                Add to team
              </Button>
            </form>
          )}
        </>
      ) : (
        <p>No teams are visible to this account.</p>
      )}
      <a href="https://organizations.teamofsilicons.com/">Open Silicon Organizations</a>
    </>
  );
}
