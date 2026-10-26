/** Shared presentation keyboard behavior, without taking activation keys from controls. */
export function presentationShortcutAllowed(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  return !target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]");
}

export function presentKeys(event: KeyboardEvent, controls: { next: () => void; previous: () => void; firstSlide: () => void; lastSlide: () => void }): boolean {
  if (!presentationShortcutAllowed(event)) return false;
  const target = event.target as HTMLElement | null;
  if ((event.key === "Enter" || event.key === " ") && target?.closest("button, a, [role=button], [role=link]")) return false;
  switch (event.key) {
    case "ArrowRight": case "ArrowDown": case "PageDown": case " ": case "Enter": case "n": case "N":
      controls.next(); return true;
    case "ArrowLeft": case "ArrowUp": case "PageUp": case "Backspace": case "p": case "P":
      controls.previous(); return true;
    case "Home": controls.firstSlide(); return true;
    case "End": controls.lastSlide(); return true;
    default: return false;
  }
}

export function presentationSwipe(start: { x: number; y: number; t: number }, end: { x: number; y: number; t: number }): "next" | "previous" | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) <= 50 || Math.abs(dx) <= Math.abs(dy) * 1.5 || end.t - start.t >= 800) return null;
  return dx < 0 ? "next" : "previous";
}
