import {
  LAYOUTS, deepEqual, isLayout, layoutElements, newElementId, normalizeElement, richTextToPlain,
  type Element, type Op, type Size, type Slide, type Theme,
} from "@silicon-present/deck";

type Role = "title" | "body" | "image" | "decoration";
type Slot = { element: Element; role: Role };
const boxKeys = ["x", "y", "w", "h"] as const;

function slots(layout: string, theme: Theme, size: Size): Slot[] {
  let firstText = true;
  return layoutElements(layout, theme, size).map(input => {
    const element = normalizeElement(input);
    const role: Role = element.kind === "image" ? "image" : element.kind === "shape" ? "decoration"
      : firstText && layout !== "image-caption" ? "title" : "body";
    if (element.kind === "text") firstText = false;
    return { element, role };
  });
}

function sameBox(element: Element, template: Element): boolean {
  return element.kind === template.kind && boxKeys.every(key => Math.abs(element[key] - template[key]) <= 1)
    && (element.kind !== "shape" || template.kind === "shape" && element.shape === template.shape);
}

function authored(element: Element): boolean {
  if (element.kind === "text") return richTextToPlain(element.text).length > 0;
  if (element.kind === "image") return element.src.length > 0;
  return false;
}

function containsLabel(graphic: Element, text: Element, size: Size): boolean {
  if (graphic.kind === "text" || graphic.kind === "audio" || text.kind !== "text") return false;
  // Background artwork must not prevent the slide's main title and body from reflowing.
  const coversSlide = graphic.x <= size.width * .05 && graphic.y <= size.height * .05
    && graphic.x + graphic.w >= size.width * .95 && graphic.y + graphic.h >= size.height * .95;
  return !coversSlide && text.x >= graphic.x - 1 && text.y >= graphic.y - 1
    && text.x + text.w <= graphic.x + graphic.w + 1 && text.y + text.h <= graphic.y + graphic.h + 1;
}

/** A layout is a bounded rearrangement, never a replacement of the slide's authored content. */
export function layoutChangeOps(slide: Slide, layout: string, theme: Theme, size: Size, makeId = newElementId): Op[] {
  if (!isLayout(layout)) throw new Error(`Unknown slide layout: ${layout}`);
  const target = slots(layout, theme, size);
  // Older versions changed only slide.layout, so it cannot identify the actual placeholders.
  const templates = LAYOUTS.flatMap(name => slots(name, theme, size));
  const candidates = slide.elements.map((element, index) => {
    const canonical = templates.find(slot => sameBox(element, slot.element));
    // Empty elements with authored formatting, alt text, links, animation, or protection are not disposable.
    const disposable = templates.some(slot => deepEqual({ ...element, id: "" }, { ...slot.element, id: "" }));
    const heading = element.kind === "text" && element.text.paragraphs.some(paragraph => paragraph.heading);
    const role: Role = element.kind === "image" ? "image" : heading ? "title" : canonical?.role ?? "body";
    return { element, index, canonical, disposable, role, authored: authored(element) };
  });
  // Separate text labels and their graphics form a composition even when they were never grouped.
  // Moving only the label (or its picture) would detach it and can make its colour unreadable.
  const composed = new Set<string>();
  for (const graphic of candidates) {
    if (graphic.disposable) continue;
    for (const candidate of candidates) {
      // Layout-owned picture/title boxes can overlap after switching to a layout with fewer slots.
      // Keep them eligible so switching back can restore those slots instead of duplicating them.
      if (graphic.canonical && candidate.canonical) continue;
      if (containsLabel(graphic.element, candidate.element, size)) {
        composed.add(graphic.element.id);
        composed.add(candidate.element.id);
      }
    }
  }
  const used = new Set<string>();
  const ops: Op[] = slide.layout === layout ? [] : [{ op: "update_slide", slide: slide.id, set: { layout } }];
  for (const [index, slot] of target.entries()) {
    const available = candidates.filter(candidate => {
      const element = candidate.element;
      return !used.has(element.id) && !composed.has(element.id) && !element.locked && !element.group && element.rotation === 0
        && element.kind === slot.element.kind
        && (slot.role === "decoration" ? candidate.disposable : candidate.authored || candidate.disposable);
    });
    const score = (candidate: typeof candidates[number]) => {
      const element = candidate.element;
      const distance = Math.abs(element.x - slot.element.x) / size.width + Math.abs(element.y - slot.element.y) / size.height;
      return (candidate.role === slot.role ? 10_000 : 0) + (candidate.authored ? 1_000 : 0)
        + (candidate.canonical ? 500 : 0) - Math.min(2, distance) * 50
        + Math.min(1, element.w * element.h / (size.width * size.height)) * 250;
    };
    available.sort((a, b) => score(b) - score(a) || a.index - b.index);
    const chosen = available[0];
    if (!chosen) {
      // Missing slots go behind extra custom objects, which keep their relative stacking order.
      ops.push({ op: "add_element", slide: slide.id, element: { ...slot.element, id: makeId() }, z: index });
      continue;
    }
    used.add(chosen.element.id);
    const set: Record<string, unknown> = {};
    for (const key of boxKeys) if (chosen.element[key] !== slot.element[key]) set[key] = slot.element[key];
    if (chosen.disposable) {
      // An untouched empty box should acquire the target placeholder's typing defaults.
      if (!deepEqual(chosen.element.style, slot.element.style)) set.style = slot.element.style;
      if (chosen.element.kind === "text" && slot.element.kind === "text" && !deepEqual(chosen.element.text, slot.element.text)) set.text = slot.element.text;
    }
    // Authored elements receive geometry only: their ID, Y.Text, source, style, and other metadata stay intact.
    if (Object.keys(set).length) ops.push({ op: "update_element", slide: slide.id, element: chosen.element.id, set });
  }
  for (const candidate of candidates) {
    if (candidate.disposable && !composed.has(candidate.element.id) && !used.has(candidate.element.id)) ops.push({ op: "delete_element", slide: slide.id, element: candidate.element.id });
  }
  return ops;
}
