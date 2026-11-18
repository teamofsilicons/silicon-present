"use client";
import { useState, type FormEvent } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { api, seg } from "@/lib/client/api";
import { ApiError } from "@/lib/errors";
import { findPeople } from "@/lib/present/people";
import type { Account } from "@/lib/present/types";
import { RecipientPicker, PersonChip, useDelayedText } from "./recipient-picker";
import styles from "./people.module.css";

export function Contacts() {
  const cache = useQueryClient();
  const [search, setSearch] = useState("");
  const q = useDelayedText(search);
  const [offset, setOffset] = useState(0);
  const [id, setId] = useState("");
  const [selected, setSelected] = useState<Account | null>(null);
  const [name, setName] = useState("");
  const [trust, setTrust] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const book = useQuery({
    queryKey: ["contacts", q, offset],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => findPeople(q, signal, true, offset, 25),
  });
  async function change(work: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await work();
      await Promise.all(["contacts", "people", "recipient", "access"].map((key) => cache.invalidateQueries({ queryKey: [key] })));
      setNotice(message);
      return true;
    } catch (e) {
      setError(ApiError.from(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (
      await change(
        () => api.post("/v1/contacts", { id: selected?.uuid ?? id.trim(), name: name.trim(), trust }),
        "Contact saved in Silicon Contacts.",
      )
    ) {
      setId("");
      setSelected(null);
      setName("");
      setTrust(1);
    }
  }
  if (book.isPending) return <p role="status">Loading contacts…</p>;
  if (book.error) return <ErrorAlert error={book.error} />;
  return (
    <div className={styles.section}>
      {error && <ErrorAlert error={error} />}
      <span aria-live="polite">{notice}</span>
      {!book.data?.connected ? (
        <>
          <p>Connect your Silicon Contacts address book to use saved names, pictures and trust when sharing in Present.</p>
          <Button
            loading={busy}
            onClick={() => void change(() => api.put("/v1/contacts/connection", { connected: true }), "Contacts connected.")}
          >
            Connect Silicon Contacts
          </Button>
        </>
      ) : (
        <>
          <form onSubmit={save} className={styles.form}>
            <h2>Save a contact</h2>
            <RecipientPicker
              label="Carbon or Silicon"
              value={id}
              selected={selected}
              onChange={(v, a) => {
                setId(v);
                setSelected(a ?? null);
                if (a) {
                  setName(a.displayName || a.id);
                  setTrust("trust" in a && typeof a.trust === "number" ? a.trust : 1);
                }
              }}
            />
            <Input label="Saved name" value={name} required onChange={(e) => setName(e.target.value)} maxLength={200} />
            <Input
              label="Trust"
              type="number"
              min={1}
              max={255}
              required
              value={trust || ""}
              onChange={(e) => setTrust(e.target.valueAsNumber || 0)}
            />
            <Button type="submit" loading={busy}>
              Save contact
            </Button>
          </form>
          <h2>Saved contacts</h2>
          <Input
            label="Search contacts"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
          {!book.data.items.length && <p>{q ? "No matching contacts." : "Your address book is empty."}</p>}
          <ul className={styles.rows}>
            {book.data.items.map((a) => (
              <li key={a.uuid} className={styles.row}>
                <PersonChip account={a} />
                <small>Trust {a.trust}</small>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setId(a.id);
                    setSelected(a);
                    setName(a.displayName || a.id);
                    setTrust(a.trust ?? 1);
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Remove " + (a.displayName || a.id) + " from Silicon Contacts?"))
                      void change(() => api.delete("/v1/contacts/" + seg(a.uuid)), "Contact removed.");
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            {offset > 0 && (
              <Button variant="secondary" onClick={() => setOffset(offset - 25)}>
                Previous
              </Button>
            )}
            {offset + 25 < book.data.total && (
              <Button variant="secondary" onClick={() => setOffset(offset + 25)}>
                Next
              </Button>
            )}
          </div>
          <Button
            variant="ghost"
            loading={busy}
            onClick={() => void change(() => api.put("/v1/contacts/connection", { connected: false }), "Contacts disconnected.")}
          >
            Disconnect Contacts
          </Button>
        </>
      )}
      <h2>Notifications</h2>
      <p>Shares, comments, mentions and ownership transfers arrive in your Ting inbox. You can also register a local webhook in Ting.</p>
      <div className={styles.actions}>
        <a href="https://ting.teamofsilicons.com/#inbox">Open Ting inbox</a>
        <a href="https://ting.teamofsilicons.com/#connections">Manage optional webhook</a>
      </div>
    </div>
  );
}
