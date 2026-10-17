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
  const synced = editor.status.get().synced;
  // The Y.Text exists once the slide does; reading it never creates anything for someone who can't edit.
  const text = useMemo(() => (slideId && synced ? (editor.textField(slideId, null, "notes") ?? null) : null), [editor, slideId, synced]);
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
