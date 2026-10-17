"use client";

/**
 * An HTML element's code: HTML, CSS and JS tabs, each a plain Y.Text everyone edits together. The element on the
 * canvas is the live preview (it reruns as the code changes); Run starts it again from scratch, Pause stops it.
 */
import { useMemo, useState } from "react";
import { Pause, Play, X } from "lucide-react";
import { usePlainText } from "@/lib/editor/use-plain-text";
import { useAbilities, useCurrentSlide, useEditor, useUi } from "./editor-context";
import styles from "./editor.module.css";

type Field = "html" | "css" | "js";
const TABS: { value: Field; label: string }[] = [
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "js", label: "JS" },
];

function CodeField({ slideId, elementId, field, editable }: { slideId: string; elementId: string; field: Field; editable: boolean }) {
  const editor = useEditor();
  const text = useMemo(() => editor.textField(slideId, elementId, field), [editor, slideId, elementId, field]);
  const { value, onChange, ref } = usePlainText(text, editable);
  return (
    <textarea
      ref={ref}
      className={styles.codeField}
      value={value}
      readOnly={!editable}
      spellCheck={false}
      aria-label={`${field.toUpperCase()} code`}
      data-testid={`code-${field}`}
      onChange={event => onChange(event.target.value)}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Tab" && editable) {
          event.preventDefault();
          const node = event.currentTarget;
          const start = node.selectionStart;
          const next = `${node.value.slice(0, start)}  ${node.value.slice(node.selectionEnd)}`;
          onChange(next);
          requestAnimationFrame(() => node.setSelectionRange(start + 2, start + 2));
        }
      }}
    />
  );
}

export function CodePanel() {
  const editor = useEditor();
  const id = useUi(s => s.codeElement);
  const slide = useCurrentSlide();
  const { canEdit } = useAbilities();
  const [tab, setTab] = useState<Field>("html");
  const [paused, setPaused] = useState(false);
  const element = slide?.elements.find(e => e.id === id && e.kind === "html");
  if (!element || !slide) return null;
  return (
    <section className={styles.codePanel} aria-label="HTML element code" data-testid="code-panel">
      <div className={styles.codeHead}>
        <div className={styles.codeTabs} role="tablist" aria-label="Code">
          {TABS.map(t => (
            <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} className={styles.codeTab} data-active={tab === t.value || undefined} onClick={() => setTab(t.value)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className={styles.codeActions}>
          <button
            type="button"
            className={styles.codeButton}
            onClick={() => {
              setPaused(false);
              window.dispatchEvent(new CustomEvent("present:run-html", { detail: element.id }));
            }}
            data-testid="code-run"
          >
            <Play size={14} aria-hidden="true" /> Run
          </button>
          <button
            type="button"
            className={styles.codeButton}
            onClick={() => {
              setPaused(p => !p);
              window.dispatchEvent(new CustomEvent("present:pause-html", { detail: element.id }));
            }}
            aria-pressed={paused}
            data-testid="code-pause"
          >
            {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />} {paused ? "Resume" : "Pause"}
          </button>
          <button type="button" className={styles.codeClose} aria-label="Close the code" onClick={() => editor.ui.set({ codeElement: null })}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <CodeField key={`${element.id}/${tab}`} slideId={slide.id} elementId={element.id} field={tab} editable={canEdit} />
    </section>
  );
}
