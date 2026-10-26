"use client";

/** Speaker notes for the current slide, under the canvas: a plain text Y.Text that everyone edits together. */
import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, StickyNote } from "lucide-react";
import { usePlainText } from "@/lib/editor/use-plain-text";
import { useAbilities, useCurrentSlide, useEditor, useUi } from "./editor-context";
import styles from "./editor.module.css";

export function NotesPane() {
  const editor = useEditor();
  const [open, setOpen] = useState(true);
  const slide = useCurrentSlide();
  const master = useUi(s => s.master);
  const { canEdit } = useAbilities();
  const slideId = slide && !slide.isMaster ? slide.id : null;
  // The Y.Text exists once the slide does (from this browser's copy or the service); reading it never creates
  // anything. Looked up again whenever the slide is read again, so a slide that arrives later binds too.
  const text = useMemo(() => (slideId && slide ? (editor.textField(slideId, null, "notes") ?? null) : null), [editor, slideId, slide]);
  const { value, onChange, ref } = usePlainText(text, canEdit);
  if (master || !slideId) return null;
  if (!canEdit && !value) return null;
  return (
    <div className={styles.notes} data-collapsed={!open || undefined}>
      <button type="button" className={styles.notesToggle} aria-expanded={open} aria-controls="speaker-notes" onClick={() => setOpen(!open)}>
        <StickyNote size={14} aria-hidden="true" /><span>Speaker notes</span>{open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
      </button>
      <textarea
        id="speaker-notes"
        aria-label="Speaker notes"
        hidden={!open}
        ref={ref}
        className={styles.notesField}
        value={value}
        readOnly={!canEdit}
        placeholder="Click to add speaker notes"
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => event.stopPropagation()}
        data-testid="speaker-notes"
      />
    </div>
  );
}
