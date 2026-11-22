import { useSyncExternalStore } from 'react';

/** Route: /browse/<mount>/<path...>  (path segments URI-encoded). */
export interface Location {
  mount: string | null;
  path: string;
  /** File open in the previewer, if any (?open=name). */
  open: string | null;
}

function parse(): Location {
  const u = new URL(window.location.href);
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'browse' || !parts[1]) return { mount: null, path: '', open: null };
  return {
    mount: decodeURIComponent(parts[1]),
    path: parts.slice(2).map(decodeURIComponent).join('/'),
    open: u.searchParams.get('open'),
  };
}

let current = parse();
const subs = new Set<() => void>();
window.addEventListener('popstate', () => {
  current = parse();
  subs.forEach((f) => f());
});

export function href(mount: string, path = '', open?: string | null) {
  const p = path ? '/' + path.split('/').map(encodeURIComponent).join('/') : '';
  return `/browse/${encodeURIComponent(mount)}${p}${open ? `?open=${encodeURIComponent(open)}` : ''}`;
}

export function navigate(to: string, replace = false) {
  if (to === window.location.pathname + window.location.search) return;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  current = parse();
  subs.forEach((f) => f());
}

export function useLocation(): Location {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => current,
  );
}
