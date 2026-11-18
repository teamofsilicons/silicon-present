"use client";

/**
 * A comment field with @ mentions: typing "@" suggests the deck's people (its owner and everyone it's shared with) and
 * anyone the service resolves by c:/si: id, and picking one writes "@c:ada " into the text. Cmd/Ctrl+Enter sends,
 * Escape cancels.
 */
import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Avatar } from "@/components/arc/avatar/avatar";
import { kindNoun } from "@/lib/format";
import type { LiveAccount } from "@/lib/live/types";
import {useQueries,useQuery} from "@tanstack/react-query";
import {findPeople,fuzzyMatch} from "@/lib/present/people";
import {resolveAccount} from "@/lib/present/sharing";
import {PersonChip,useDelayedText} from "@/components/people/recipient-picker";
import styles from "./comments.module.css";

export interface MentionInputHandle {
  focus(): void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  members: LiveAccount[];
  placeholder?: string;
  label: string;
  autoFocus?: boolean;
  rows?: number;
}

const TOKEN = /(^|\s)@([a-z]{0,2}:?[a-z0-9._-]*)$/i;

export const MentionInput = forwardRef<MentionInputHandle, Props>(function MentionInput({ value, onChange, onSubmit, onCancel, members, placeholder, label, autoFocus, rows = 2 }, ref) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const delayed=useDelayedText(query??"");
  const search=useQuery({queryKey:["people",delayed],queryFn:({signal})=>findPeople(delayed,signal),enabled:query!==null,retry:false});
  const [active, setActive] = useState(0);
  const handles=Array.from(new Set(Array.from(value.matchAll(/@((?:c|si):[a-z0-9][a-z0-9._-]{2,})(?=\s|$)/gi),m=>m[1]!))).slice(0,24);
  const previews=useQueries({queries:handles.map(id=>({queryKey:["recipient",id],queryFn:({signal}:{signal:AbortSignal})=>resolveAccount(id,signal),retry:false}))});
  const listId = useId();
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), []);

  useEffect(() => {
    if (autoFocus) area.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const suggestions=useMemo(()=>{
    if(query===null)return [];
    const fromContacts:LiveAccount[]=(delayed===query?search.data?.items??[]:[]).map(a=>({...a,display_name:a.displayName,pfp_url:a.pfpUrl}));
    const matches=members.filter(a=>fuzzyMatch(query,{...a,displayName:a.display_name??"",pfpUrl:a.pfp_url??null})&&!fromContacts.some(p=>p.uuid===a.uuid));
    return [...fromContacts,...matches].slice(0,8);
  },[members,query,delayed,search.data]);

  const updateQuery = (text: string, caret: number) => {
    const match = TOKEN.exec(text.slice(0, caret));
    setQuery(match ? match[2]! : null);
    setActive(0);
  };

  const pick = (account: LiveAccount) => {
    const node = area.current;
    if (!node) return;
    const caret = node.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@([a-z]{0,2}:?[a-z0-9._-]*)$/i, `@${account.id} `);
    const next = before + value.slice(caret);
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(before.length, before.length);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (suggestions.length && query !== null) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive(i => (i + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive(i => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(suggestions[active] ?? suggestions[0]!);
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (query !== null) setQuery(null);
      else onCancel?.();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className={styles.mentionWrap}>
      <textarea
        ref={area}
        className={styles.field}
        data-sq="surface"
        aria-label={label}
        placeholder={placeholder}
        rows={rows}
        value={value}
        onChange={event => {
          onChange(event.target.value);
          updateQuery(event.target.value, event.target.selectionStart ?? event.target.value.length);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={event => event.stopPropagation()}
        onClick={event => updateQuery(value, (event.target as HTMLTextAreaElement).selectionStart ?? value.length)}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        role="combobox"
        aria-expanded={suggestions.length > 0 && query !== null}
        aria-autocomplete="list"
        aria-controls={listId}
      />
      {previews.some(p=>p.data) && <div aria-label="Mentioned people">{previews.map((p,i)=>p.data ? <PersonChip key={handles[i]} account={p.data}/> : null)}</div>}
      {query !== null && suggestions.length > 0 ? (
        <ul id={listId} className={styles.suggestions} role="listbox" aria-label="People to mention" data-sq="surface">
          {suggestions.map((account, index) => (
            <li key={account.id} role="option" aria-selected={index === active}>
              <button type="button" className={styles.suggestion} data-active={index === active || undefined} onMouseDown={event => event.preventDefault()} onClick={() => pick(account)}>
                <Avatar name={account.display_name || account.id.replace(/^(c|si):/, "")} src={account.pfp_url ?? undefined} size="sm" />
                <span className={styles.suggestionText}>
                  <span>{account.display_name || account.id}</span>
                  <span className={styles.muted}>
                    {account.id} · {kindNoun(account.kind)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});
