/**
 * A <textarea> bound to a plain Y.Text (speaker notes, an HTML element's HTML/CSS/JS): typing goes in as a minimal diff
 * with LOCAL_ORIGIN (so it merges with others' typing and undo tracks it), and others' changes come in without moving
 * the caret away from what you were typing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { setPlainText } from "@silicon-present/deck";
import { LOCAL_ORIGIN } from "@/lib/live/provider";

export function usePlainText(text: Y.Text | null, editable: boolean) {
  const [value, setValue] = useState(() => text?.toString() ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  // Another field (the next slide's notes, another tab of code): show its text at once.
  const [bound, setBound] = useState(text);
  if (bound !== text) {
    setBound(text);
    setValue(text?.toString() ?? "");
  }

  useEffect(() => {
    if (!text) return;
    const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      const next = text.toString();
      const node = ref.current;
      if (transaction.origin === LOCAL_ORIGIN && transaction.local) {
        setValue(next);
        return;
      }
      // Shift the caret by what was inserted or deleted before it.
      if (node && document.activeElement === node) {
        let start = node.selectionStart;
        let end = node.selectionEnd;
        let index = 0;
        for (const op of event.delta) {
          if (op.retain) index += op.retain;
          else if (typeof op.insert === "string") {
            if (index <= start) start += op.insert.length;
            if (index < end) end += op.insert.length;
            index += op.insert.length;
          } else if (op.delete) {
            if (index < start) start -= Math.min(op.delete, start - index);
            if (index < end) end -= Math.min(op.delete, end - index);
          }
        }
        setValue(next);
        requestAnimationFrame(() => node.setSelectionRange(start, end));
      } else setValue(next);
    };
    text.observe(observer);
    return () => text.unobserve(observer);
  }, [text]);

  const onChange = useCallback(
    (next: string) => {
      setValue(next);
      if (!text || !editable) return;
      text.doc?.transact(() => setPlainText(text, next), LOCAL_ORIGIN);
    },
    [text, editable],
  );

  return { value, onChange, ref };
}
