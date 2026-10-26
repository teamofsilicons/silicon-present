/** The previous slide for a drop before/after a card. Undefined means no move. */
export function slideDropAfter(ids: readonly string[], moving: string, target: string, afterTarget: boolean): string | null | undefined {
  if (moving === target || !ids.includes(moving) || !ids.includes(target)) return undefined;
  const remaining = ids.filter(id => id !== moving);
  const index = remaining.indexOf(target) + (afterTarget ? 1 : 0);
  const previous = index ? remaining[index - 1]! : null;
  return (ids[ids.indexOf(moving) - 1] ?? null) === previous ? undefined : previous;
}
