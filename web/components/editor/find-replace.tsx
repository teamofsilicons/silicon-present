"use client";

/**
 * Find and replace across the deck: slide text, table cells, speaker notes and the master. Each match shows where it
 * is; choosing one goes to its slide and selects its element. Replace changes the chosen match (keeping its
 * formatting), Replace all changes every match in one step (one undo).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { INLINE_ATTRS, MASTER, attrsAt, findInDeck, type TextHit } from "@silicon-present/deck";
import { useAbilities, useDeck, useEditor, useUi } from "./editor-context";
import styles from "./editor.module.css";

export function FindReplace() {
  const editor = useEditor();
  const deck = useDeck();
  const open = useUi(s => s.findOpen);
  const { canEdit } = useAbilities();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [chosen, setCurrent] = useState(0);
  const [note, setNote] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => (open && query ? findInDeck(deck, query, { matchCase }) : []), [open, deck, query, matchCase]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => input.current?.select());
  }, [open]);
  const current = Math.min(chosen, Math.max(0, hits.length - 1));

  if (!open) return null;

  const where = (hit: TextHit) => {
    if (hit.slide === MASTER) return "Master";
    const n = deck.slides.findIndex(s => s.id === hit.slide) + 1;
    const field = hit.field === "notes" ? "notes" : hit.field.startsWith("cell:") ? "table" : "text";
    return `Slide ${n} · ${field}`;
  };

  const go = (index: number) => {
    const hit = hits[index];
    if (!hit) return;
    setCurrent(index);
    if (hit.slide === MASTER) editor.setMaster(true);
    else if (hit.slide !== editor.currentSlideId()) editor.goToSlide(hit.slide);
    if (hit.element) editor.select([hit.element]);
    else editor.clearSelection();
  };

  const replaceOne = () => {
    const hit = hits[current];
    if (!hit || !canEdit) return;
    editor.change(() => {
      const text = editor.textField(hit.slide, hit.element, hit.field);
      if (!text) return;
      const rich = hit.field === "text" || hit.field.startsWith("cell:");
      const keep: Record<string, unknown> = {};
      if (rich) {
        const attrs = attrsAt(text, hit.index);
        for (const key of INLINE_ATTRS) if (attrs[key] !== undefined && attrs[key] !== null) keep[key] = attrs[key];
      }
      text.delete(hit.index, hit.length);
      if (replacement) text.insert(hit.index, replacement, rich ? keep : undefined);
    }, "Replacing");
    setNote("Replaced 1.");
  };

  const replaceAll = () => {
    if (!canEdit || !query) return;
    const count = editor.replaceAll(query, replacement, matchCase);
    setNote(count ? `Replaced ${count}.` : "Nothing to replace.");
  };

  return (
    <section className={styles.findPanel} aria-label="Find and replace" data-sq="surface" data-testid="find-panel" onKeyDown={event => event.stopPropagation()}>
      <div className={styles.findHead}>
        <h2 className={styles.findTitle}>Find and replace</h2>
        <button type="button" className={styles.codeClose} aria-label="Close find and replace" onClick={() => editor.ui.set({ findOpen: false })}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <input
        ref={input}
        className={styles.textInput}
        placeholder="Find"
        aria-label="Find"
        value={query}
        data-testid="find-input"
        onChange={event => {
          setQuery(event.target.value);
          setCurrent(0);
          setNote("");
        }}
        onKeyDown={event => {
          if (event.key === "Enter") go(hits.length ? (current + (event.shiftKey ? hits.length - 1 : 1)) % hits.length : 0);
          if (event.key === "Escape") editor.ui.set({ findOpen: false });
        }}
      />
      {canEdit ? <input className={styles.textInput} placeholder="Replace with" aria-label="Replace with" value={replacement} onChange={event => setReplacement(event.target.value)} data-testid="replace-input" /> : null}
      <label className={styles.toggle}>
        <input type="checkbox" checked={matchCase} onChange={event => setMatchCase(event.target.checked)} />
        <span>Match case</span>
      </label>
      <p className={styles.findCount} role="status">
        {query ? (hits.length ? `${current + 1} of ${hits.length}` : "No matches") : "Type to search the slides, tables and notes."} {note}
      </p>
      {hits.length ? (
        <ul className={styles.findResults}>
          {hits.slice(0, 200).map((hit, index) => (
            <li key={`${hit.slide}/${hit.element}/${hit.field}/${hit.index}`}>
              <button type="button" className={styles.findResult} data-current={index === current || undefined} onClick={() => go(index)}>
                <span className={styles.findWhere}>{where(hit)}</span>
                <span className={styles.findContext}>{hit.context}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <div className={styles.buttonRow}>
          <button type="button" className={styles.secondaryButton} data-sq="surface" disabled={!hits.length} onClick={replaceOne}>
            Replace
          </button>
          <button type="button" className={styles.smallPrimary} data-sq="surface" disabled={!hits.length} onClick={replaceAll} data-testid="replace-all">
            Replace all
          </button>
        </div>
      ) : null}
    </section>
  );
}
