import { useSyncExternalStore } from 'react';

/** Tiny observable store (no dependency). */
export function createStore<T>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(next: T | ((s: T) => T)) {
      state = typeof next === 'function' ? (next as (s: T) => T)(state) : next;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

export function useStore<T, S = T>(store: ReturnType<typeof createStore<T>>, select: (s: T) => S = (s) => s as unknown as S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

/** localStorage with try/catch (private mode etc.). */
export const local = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, v: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
};
