"use client";

import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/arc/input/input";
import { AccountChip } from "@/components/foundation/account/account-chip";
import { findPeople, fuzzyMatch, type Person } from "@/lib/present/people";
import { resolveAccount } from "@/lib/present/sharing";
import type { Account } from "@/lib/present/types";
import styles from "./people.module.css";

export function useDelayedText(value: string) {
  const [delayed, setDelayed] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDelayed(value), 180);
    return () => clearTimeout(timer);
  }, [value]);
  return delayed;
}
export function PersonChip({ account }: { account: Account }) {
  return <AccountChip account={{ ...account, display_name: account.displayName, pfp_url: account.pfpUrl }} />;
}
interface Props {
  label: string;
  value: string;
  onChange: (value: string, account?: Account) => void;
  error?: string;
  placeholder?: string;
  autoFocus?: boolean;
  email?: boolean;
  selected?: Account | null;
  allowed?: Account[];
}
export function RecipientPicker({
  label,
  value,
  onChange,
  error,
  placeholder = "Name, c:id or si:id",
  autoFocus,
  email,
  selected,
  allowed,
}: Props) {
  const list = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const searchText = selected && value.trim() === selected.id ? "" : value.trim();
  const q = useDelayedText(searchText);
  const isEmail = !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q);
  const results = useQuery({
    queryKey: ["people", q],
    queryFn: ({ signal }) => findPeople(q, signal),
    enabled: open && !q.includes("@"),
    retry: false,
  });
  const exact = useQuery({
    queryKey: ["recipient", q],
    queryFn: ({ signal }) => resolveAccount(q, signal),
    enabled: !selected && (isEmail || /^(si|c):[\w.-]{3,}$/i.test(q)),
    retry: false,
  });
  const fresh = q === searchText;
  const remote = results.data?.items ?? [];
  const matches: Person[] = allowed
    ? [
        ...remote.filter((a) => allowed.some((m) => m.uuid === a.uuid)),
        ...allowed.filter((a) => !remote.some((m) => m.uuid === a.uuid) && fuzzyMatch(q, a)).map((a) => ({ ...a, trust: null })),
      ]
    : remote;
  const items = fresh && open && !isEmail ? matches : [];
  const candidate = selected ?? (fresh ? exact.data : null);
  const preview = candidate && (!allowed || allowed.some((a) => a.uuid === candidate.uuid)) ? candidate : null;
  function pick(account: Account) {
    onChange(account.id, account);
    setOpen(false);
    setActive(-1);
  }
  return (
    <div
      className={styles.picker}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Input
        label={label}
        value={value}
        placeholder={placeholder}
        error={error}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={!!items.length}
        aria-controls={list}
        aria-activedescendant={items[active] ? list + "-" + active : undefined}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
          if (!items.length) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (e.key === "ArrowDown" ? (i + 1) % items.length : i <= 0 ? items.length - 1 : i - 1));
          }
          if (e.key === "Enter" && items[active]) {
            e.preventDefault();
            pick(items[active]!);
          }
        }}
      />
      {items.length > 0 && (
        <ul id={list} className={styles.options} role="listbox" aria-label={label + " suggestions"} data-sq="surface">
          {items.map((a, i) => (
            <li
              key={a.uuid}
              id={list + "-" + i}
              aria-selected={active === i}
              role="option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(a)}
              onPointerMove={() => setActive(i)}
            >
              <PersonChip account={a} />
              {a.trust !== null && <small>Trust {a.trust}</small>}
            </li>
          ))}
        </ul>
      )}
      {preview && (
        <div className={styles.preview} aria-label="Selected recipient">
          <PersonChip account={preview} />
        </div>
      )}
      {open && fresh && results.error && !isEmail && (
        <small role="status">Suggestions could not load. You can still enter an account ID.</small>
      )}
    </div>
  );
}
