/** Keyboard shortcut labels (⌘ on Apple devices, Ctrl elsewhere) and the list the "?" dialog shows. */

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export function mod(): string {
  return isMac() ? "⌘" : "Ctrl";
}

export function alt(): string {
  return isMac() ? "⌥" : "Alt";
}

export function keyLabel(combo: string): string {
  return combo.replace(/Mod/g, mod()).replace(/Alt/g, alt()).replace(/Shift/g, isMac() ? "⇧" : "Shift").replace(/\+/g, isMac() ? "" : "+");
}

export function editorTypingTarget(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), .ql-editor, [role=textbox]"));
}

/** Canvas shortcuts must leave typing, open menus and native control activation alone. */
export function editorShortcutAllowed(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || editorTypingTarget(event.target)) return false;
  const target = event.target as HTMLElement | null;
  if (target?.closest("[role=dialog], [data-radix-popper-content-wrapper]")) return false;
  return !((event.key === "Enter" || event.key === " ") && target?.closest("button, a, [role=button], [role=link], [role=checkbox], [role=switch], [role=slider]"));
}

export interface ShortcutGroup {
  title: string;
  items: { keys: string; what: string }[];
}

export const SHORTCUTS: ShortcutGroup[] = [
  { title: "Tools", items: [
    { keys: "V", what: "Select objects" },
    { keys: "H / hold Space", what: "Hand tool / pan the canvas" },
    { keys: "T", what: "Add a text box" },
    { keys: "R / O", what: "Draw a rectangle / ellipse" },
    { keys: "L / Shift+L", what: "Draw a line / arrow" },
    { keys: "Shift while drawing", what: "Make a square/circle or snap a line to 45°" },
    { keys: "Mod+Shift+K", what: "Add images or videos" },
    { keys: "C", what: "Comment on a point or area" },
    { keys: "Escape", what: "Cancel drawing or a comment, then return to Select" },
  ] },
  {
    title: "Everywhere",
    items: [
      { keys: "Mod+Z", what: "Undo" },
      { keys: "Mod+Shift+Z", what: "Redo" },
      { keys: "Mod+F", what: "Find and replace" },
      { keys: "Mod+Alt+M", what: "Comment (on the selection, or click where)" },
      { keys: "Mod+Enter", what: "Present" },
      { keys: "?", what: "Show these shortcuts" },
    ],
  },
  {
    title: "Slides",
    items: [
      { keys: "Mod+M", what: "New slide" },
      { keys: "PageUp / PageDown", what: "Previous or next slide" },
      { keys: "↑ / ↓ in the slide list", what: "Move between slides" },
      { keys: "Delete in the slide list", what: "Delete the slide" },
    ],
  },
  {
    title: "Elements",
    items: [
      { keys: "Arrows", what: "Nudge 1 px (with Shift, 10 px)" },
      { keys: "Delete", what: "Delete" },
      { keys: "Mod+D", what: "Duplicate" },
      { keys: "Mod+C / Mod+X / Mod+V", what: "Copy, cut, paste (also into another deck)" },
      { keys: "Mod+A", what: "Select all" },
      { keys: "Mod+G / Mod+Shift+G", what: "Group, ungroup" },
      { keys: "Mod+Shift+L", what: "Lock or unlock" },
      { keys: "Mod+] / Mod+[", what: "Bring forward, send backward" },
      { keys: "Mod+Shift+] / Mod+Shift+[", what: "Bring to front, send to back" },
      { keys: "Enter", what: "Edit the selected text" },
      { keys: "Escape", what: "Stop editing, then deselect" },
      { keys: "Shift while dragging", what: "Keep the ratio, or move straight" },
      { keys: "Alt while dragging", what: "Move without snapping" },
    ],
  },
  {
    title: "Text",
    items: [
      { keys: "Mod+B / Mod+I / Mod+U", what: "Bold, italic, underline" },
      { keys: "Tab / Shift+Tab in a list", what: "Indent, outdent" },
    ],
  },
  {
    title: "View",
    items: [
      { keys: "Mod+= / Mod+-", what: "Zoom in, out" },
      { keys: "Mod+0", what: "Fit the slide to the window" },
      { keys: "↑ / ↓ in comments", what: "Move between threads" },
    ],
  },
];
