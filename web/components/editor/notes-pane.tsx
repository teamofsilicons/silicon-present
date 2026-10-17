"use client";

/** Speaker notes for the current slide, under the canvas: a plain text Y.Text that everyone edits together. */
import { useMemo } from "react";
import { usePlainText } from "@/lib/editor/use-plain-text";
import { useAbilities, useCurrentSlide, useEditor, useUi } from "./editor-context";
import styles from "./editor.module.css";

export function NotesPane() {
  const editor = useEditor();
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
    <div className={styles.notes}>
      <label className={styles.notesLabel} htmlFor="speaker-notes">
        Speaker notes
      </label>
      <textarea
        id="speaker-notes"
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
