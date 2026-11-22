import { createStore, local } from './store';

/** Recent and Starred are kept per browser (localStorage). */
export interface Place {
  mount: string;
  path: string;
  name: string;
  isDir: boolean;
}

export const recentStore = createStore<Place[]>(local.get('recent', []));
export const starredStore = createStore<Place[]>(local.get('starred', []));
recentStore.subscribe(() => local.set('recent', recentStore.get()));
starredStore.subscribe(() => local.set('starred', starredStore.get()));

const same = (a: Place, b: { mount: string; path: string }) => a.mount === b.mount && a.path === b.path;

export function addRecent(p: Place) {
  recentStore.set((l) => [p, ...l.filter((x) => !same(x, p))].slice(0, 30));
}

export function toggleStar(p: Place) {
  starredStore.set((l) => (l.some((x) => same(x, p)) ? l.filter((x) => !same(x, p)) : [...l, p]));
}

export const isStarred = (l: Place[], p: { mount: string; path: string }) => l.some((x) => same(x, p));

/** Keep Recent/Starred in sync after renames and deletes. */
export function forgetPlace(mount: string, path: string) {
  const keep = (x: Place) => !(x.mount === mount && (x.path === path || x.path.startsWith(path + '/')));
  recentStore.set((l) => l.filter(keep));
  starredStore.set((l) => l.filter(keep));
}
