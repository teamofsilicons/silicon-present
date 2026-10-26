import * as Y from "yjs";

export interface TextRange {
  index: number;
  length: number;
}

/** A blurred inspector must keep pointing at the same passage while other editors type around it. */
export class SavedTextSelection {
  private saved: { start: Y.RelativePosition; end: Y.RelativePosition; hadSelection: boolean } | null = null;

  constructor(private readonly text: Y.Text) {}

  remember(range: TextRange | null) {
    if (!range) return;
    const start = Math.max(0, Math.min(range.index, this.text.length));
    const end = Math.max(start, Math.min(range.index + range.length, this.text.length));
    this.saved = {
      start: Y.createRelativePositionFromTypeIndex(this.text, start),
      // Boundary insertions outside a selected passage should not become part of that passage.
      end: Y.createRelativePositionFromTypeIndex(this.text, end, range.length ? -1 : 0),
      hadSelection: range.length > 0,
    };
  }

  resolve(): (TextRange & { hadSelection: boolean }) | null {
    if (!this.saved || !this.text.doc) return null;
    const start = Y.createAbsolutePositionFromRelativePosition(this.saved.start, this.text.doc);
    const end = Y.createAbsolutePositionFromRelativePosition(this.saved.end, this.text.doc);
    if (!start || !end || start.type !== this.text || end.type !== this.text) return null;
    return { index: start.index, length: Math.max(0, end.index - start.index), hadSelection: this.saved.hadSelection };
  }
}

interface FormattingEditor {
  setSelection(index: number, length: number, source: "silent"): unknown;
  getLength(): number;
  formatText(index: number, length: number, name: string, value: unknown, source: "user"): unknown;
  format(name: string, value: unknown, source: "user"): unknown;
}

export function applySavedTextFormat(quill: FormattingEditor, selection: SavedTextSelection, name: string, value: unknown): boolean {
  const range = selection.resolve();
  // A remotely deleted passage is not an intentional caret. Never widen it to the whole text box.
  if (!range || (range.hadSelection && range.length === 0)) return false;
  quill.setSelection(range.index, range.length, "silent");
  // Focusing Quill may briefly restore its own older numeric range before setSelection completes.
  selection.remember(range);
  if (!range.hadSelection && !["align", "list", "indent", "heading", "lineHeight"].includes(name)) {
    quill.formatText(0, quill.getLength(), name, value, "user");
  } else {
    quill.format(name, value, "user");
  }
  return true;
}
