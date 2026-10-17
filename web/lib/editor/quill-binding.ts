/**
 * Binds a Quill editor to a Y.Text in both directions (the same idea as y-quill, without its awareness and cursor
 * dependencies, which presence here does on the canvas instead):
 *
 * - Quill → Y: every user change is applied as its delta in one transaction with LOCAL_ORIGIN, so it merges with
 *   concurrent typing and the undo manager tracks it.
 * - Y → Quill: remote (and undo/redo) changes are applied to Quill as their delta; Quill keeps the caret in place.
 *
 * Quill's own history is replaced by the editor's Y.UndoManager, so Cmd+Z inside a text box undoes exactly what it
 * undoes elsewhere.
 */
import type * as Y from "yjs";
import type Quill from "quill/core";
import { LOCAL_ORIGIN } from "@/lib/live/provider";

type DeltaOps = { insert?: unknown; retain?: number; delete?: number; attributes?: Record<string, unknown> }[];

export class QuillBinding {
  private applying = false;

  constructor(
    private readonly text: Y.Text,
    private readonly quill: Quill,
    editable: boolean,
  ) {
    // A text whose last paragraph isn't closed can't hold that paragraph's attributes (alignment, list): close it.
    if (editable && (text.length === 0 || !text.toString().endsWith("\n"))) {
      text.doc?.transact(() => text.insert(text.length, "\n"), LOCAL_ORIGIN);
    }
    quill.setContents(text.toDelta() as never, "silent");
    text.observe(this.onY);
    quill.on("text-change", this.onQuill);
  }

  private onY = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (this.applying && transaction.origin === LOCAL_ORIGIN) return;
    this.quill.updateContents(event.delta as never, "silent");
  };

  private onQuill = (delta: { ops: DeltaOps }, _old: unknown, source: string) => {
    if (source === "silent") return;
    const doc = this.text.doc;
    if (!doc) return;
    this.applying = true;
    try {
      doc.transact(() => this.text.applyDelta(delta.ops as never), LOCAL_ORIGIN);
    } finally {
      this.applying = false;
    }
  };

  destroy() {
    this.text.unobserve(this.onY);
    this.quill.off("text-change", this.onQuill);
  }
}
