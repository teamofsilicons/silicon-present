import type { Element, Op, Slide } from "@silicon-present/deck";

export type LayerDirection = "front" | "back" | "forward" | "backward";
/** Edges in the visible front-to-back list: before is in front, after is behind. */
export type LayerDropEdge = "before" | "after";
type Layer = Pick<Element, "id" | "group" | "locked">;

/** Group selection is all-or-nothing; a locked member protects the whole group. */
function movableSelection(elements: readonly Layer[], selectedIds: readonly string[]): Set<string> {
  const selected = new Set(selectedIds);
  const groups = new Set(elements.filter(element => selected.has(element.id) && element.group).map(element => element.group));
  const lockedGroups = new Set(elements.filter(element => element.locked && element.group).map(element => element.group));
  return new Set(elements.filter(element => !element.locked && !lockedGroups.has(element.group)
    && (selected.has(element.id) || element.group && groups.has(element.group))).map(element => element.id));
}

export function movableLayerIds(elements: readonly Layer[], selectedIds: readonly string[]): string[] {
  return [...movableSelection(elements, selectedIds)];
}

/** Move a selection around a row (or its whole group), preserving both selected and unselected order. */
export function layerDropOrder(elements: readonly Layer[], selectedIds: readonly string[], targetId: string, edge: LayerDropEdge): string[] {
  const original = elements.map(element => element.id);
  const target = elements.find(element => element.id === targetId);
  if (!target) return original;
  const selected = new Set(selectedIds);
  // Dropping onto the selection cannot split it, including a member of an implicitly selected group.
  if (selected.has(targetId) || target.group && elements.some(element => element.group === target.group && selected.has(element.id))) return original;
  const moving = movableSelection(elements, selectedIds);
  if (!moving.size) return original;
  const rest = elements.filter(element => !moving.has(element.id));
  const targetIndexes = rest.flatMap((element, index) => element.id === targetId || target.group && element.group === target.group ? [index] : []);
  // A grouped target is one boundary even if an older edit left its members interleaved.
  const at = edge === "before" ? targetIndexes.at(-1)! + 1 : targetIndexes[0]!;
  const order = rest.map(element => element.id);
  order.splice(at, 0, ...moving);
  return order;
}

export function canMoveLayers(elements: readonly Layer[], selectedIds: readonly string[], targetId: string, edge: LayerDropEdge): boolean {
  return layerDropOrder(elements, selectedIds, targetId, edge).some((id, index) => id !== elements[index]!.id);
}

/** Drag moves touch only movable sources; the target and locked elements never receive an operation. */
export function moveLayersOps(slide: Pick<Slide, "id" | "elements">, selectedIds: readonly string[], targetId: string, edge: LayerDropEdge): Op[] {
  const target = layerDropOrder(slide.elements, selectedIds, targetId, edge);
  const current = slide.elements.map(element => element.id);
  if (target.every((id, index) => id === current[index])) return [];
  const moving = movableLayerIds(slide.elements, selectedIds);
  // Insert each source immediately before the same surviving neighbor. This also handles selections
  // originally on both sides of the drop, without reversing them or moving an unselected object.
  const anchor = target[target.indexOf(moving[0]!) + moving.length];
  const ops: Op[] = [];
  for (const id of moving) {
    const from = current.indexOf(id);
    const before = anchor ? current.indexOf(anchor) : current.length;
    const to = before - (from < before ? 1 : 0);
    if (from === to) continue;
    ops.push({ op: "reorder_element", slide: slide.id, element: id, to });
    current.splice(from, 1);
    current.splice(to, 0, id);
  }
  return ops;
}

/** Bottom-to-top order. Selected runs move together, never reversing at a stack boundary. */
export function layerOrder(elements: readonly Layer[], selectedIds: readonly string[], to: LayerDirection): string[] {
  const moving = movableSelection(elements, selectedIds);
  if (to === "front" || to === "back") {
    const selected = elements.filter(element => moving.has(element.id));
    const rest = elements.filter(element => !moving.has(element.id));
    return (to === "front" ? [...rest, ...selected] : [...selected, ...rest]).map(element => element.id);
  }
  // Backward is the same operation with the stack reversed.
  const stack = to === "backward" ? [...elements].reverse() : [...elements];
  for (let end = stack.length - 2; end >= 0; end--) {
    if (!moving.has(stack[end]!.id) || moving.has(stack[end + 1]!.id)) continue;
    let start = end;
    while (start > 0 && moving.has(stack[start - 1]!.id)) start--;
    let neighborEnd = end + 1;
    const group = stack[neighborEnd]!.group;
    // A neighboring group is a single layer step, so inserting behind it cannot split it.
    while (group && neighborEnd + 1 < stack.length && stack[neighborEnd + 1]!.group === group && !moving.has(stack[neighborEnd + 1]!.id)) neighborEnd++;
    const selection = stack.slice(start, end + 1);
    const neighbor = stack.slice(end + 1, neighborEnd + 1);
    stack.splice(start, neighborEnd - start + 1, ...neighbor, ...selection);
    end = start;
  }
  return (to === "backward" ? stack.reverse() : stack).map(element => element.id);
}

export function canReorderSelection(elements: readonly Layer[], selectedIds: readonly string[], to: LayerDirection): boolean {
  return layerOrder(elements, selectedIds, to).some((id, index) => id !== elements[index]!.id);
}

/** Numeric moves touch only movable objects, and compose into one validated Yjs transaction. */
export function layerOrderOps(slide: Pick<Slide, "id" | "elements">, selectedIds: readonly string[], to: LayerDirection): Op[] {
  const target = layerOrder(slide.elements, selectedIds, to);
  const current = slide.elements.map(element => element.id);
  const moving = movableSelection(slide.elements, selectedIds);
  const sequence = to === "front" || to === "forward" ? [...target].reverse() : target;
  const ops: Op[] = [];
  for (const id of sequence) {
    if (!moving.has(id)) continue;
    const from = current.indexOf(id), index = target.indexOf(id);
    if (from === index) continue;
    ops.push({ op: "reorder_element", slide: slide.id, element: id, to: index });
    current.splice(from, 1);
    current.splice(index, 0, id);
  }
  return ops;
}
