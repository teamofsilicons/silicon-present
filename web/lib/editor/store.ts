/**
 * A tiny external store for the editor's UI state (React reads it with useSyncExternalStore through a selector, so a
 * component re-renders only when the part it reads changes). The deck itself lives in the Y.Doc (lib/editor/mirror.ts).
 */
import { useCallback, useRef, useSyncExternalStore } from "react";

export interface Store<T> {
  get(): T;
  set(next: Partial<T> | ((state: T) => Partial<T>)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const patch = typeof next === "function" ? next(state) : next;
      let changed = false;
      for (const key of Object.keys(patch) as (keyof T)[]) {
        if (!Object.is(state[key], patch[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...patch };
      listeners.forEach(listener => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every(key => Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Reads `select(state)` and re-renders only when it changes (shallowly). */
export function useStore<T, S>(store: Store<T>, select: (state: T) => S, equal: (a: S, b: S) => boolean = shallowEqual): S {
  const last = useRef<{ state: T; value: S } | null>(null);
  const getSnapshot = useCallback(() => {
    const state = store.get();
    if (last.current && Object.is(last.current.state, state)) return last.current.value;
    const value = select(state);
    if (last.current && equal(last.current.value, value)) {
      last.current = { state, value: last.current.value };
      return last.current.value;
    }
    last.current = { state, value };
    return value;
    // `select` is usually an inline arrow: reading it fresh each time is what we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, select]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
