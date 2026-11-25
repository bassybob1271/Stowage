import type { FileStat, ListResult, MountInfo } from '@stowage/shared';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
  }
}

/** Fired on any 401 so the app can drop back to the access gate. */
export const authEvents = new EventTarget();

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  if (res.status === 401 && !path.startsWith('/api/auth/')) authEvents.dispatchEvent(new Event('unauthorized'));
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? res.statusText, data);
  return data as T;
}

const enc = (p: string) => encodeURIComponent(p);

export type BoxPlanId = 'free' | 'flex' | 'studio';

export interface Session {
  authenticated: boolean;
  /** 'box' when BazzyBox accounts are on; 'code' for the access-code gate. */
  provider?: 'box' | 'code';
  account?: boolean;
  admin?: boolean;
  /** "Sign in with Bazzy TV" is configured. */
  bazzy?: boolean;
}

export interface BoxPlan {
  id: BoxPlanId;
  label: string;
  priceCredits: number;
  includedBytes: number;
  overageCreditsPerTbMonth: number | null;
  sendFreeBytes: number;
}

export interface BoxSummary {
  account: { id: string; email: string; createdAt: string };
  plan: { id: BoxPlanId; label: string; priceCredits: number; includedBytes: number; periodEnd: number | null; overageCreditsPerTbMonth: number | null };
  usage: { usedBytes: number; allowedBytes: number; measuredAt: number | null; sendBytes: number; sendFreeBytes: number };
  wallet: { credits: number; dailyChargeCredits: number };
  plans: BoxPlan[];
  packs: Record<string, { usdCents: number; credits: number }>;
  payments: 'stripe' | 'dev' | 'none';
  history: { at: string; credits: number; kind: string; note: string }[];
}

export interface BoxShare {
  token: string;
  path: string;
  expiresAt: string | null;
  downloads: number;
  url: string;
}

export interface PlaylistTrack {
  path: string;
  title: string;
  kind: 'audio' | 'video' | null;
}
export interface Playlist {
  id: string;
  title: string;
  description: string;
  tracks: PlaylistTrack[];
  hasCover: boolean;
  coverUrl: string | null;
  shareUrl: string | null;
  views: number;
  updatedAt: string;
}

/** URL for streaming a file (path-style, so relative references like HLS segments resolve). */
export function fileUrl(mount: string, path: string) {
  return `/api/fs/${enc(mount)}/file/${path.split('/').map(enc).join('/')}`;
}
export const rawUrl = (mount: string, path: string) => `/api/fs/${enc(mount)}/raw?path=${enc(path)}`;
export const downloadUrl = (mount: string, path: string) => `/api/fs/${enc(mount)}/download?path=${enc(path)}`;
export const thumbUrl = (mount: string, f: FileStat, w = 256) =>
  `/api/fs/${enc(mount)}/thumb?path=${enc(f.path)}&w=${w}&v=${enc(f.etag ?? f.cid ?? f.modifiedAt)}`;
export const zipUrl = (mount: string, paths: string[]) =>
  `/api/fs/${enc(mount)}/zip?${paths.map((p) => `paths[]=${enc(p)}`).join('&')}`;

export const api = {
  session: () => call<Session>('/api/auth/session'),
  boxSignup: (email: string, password: string) => call<{ ok: true }>('/api/auth/box/signup', { method: 'POST', body: JSON.stringify({ email, password }) }),
  boxLogin: (email: string, password: string) => call<{ ok: true }>('/api/auth/box/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  box: {
    me: () => call<BoxSummary>('/api/box/me'),
    refreshUsage: () => call<BoxSummary>('/api/box/usage/refresh', { method: 'POST' }),
    setPlan: (plan: BoxPlanId) => call<BoxSummary>('/api/box/plan', { method: 'POST', body: JSON.stringify({ plan }) }),
    buy: (pack: string) => call<BoxSummary | { checkoutUrl: string }>('/api/box/credits', { method: 'POST', body: JSON.stringify({ pack }) }),
    shares: () => call<{ shares: BoxShare[] }>('/api/box/shares'),
    share: (path: string, days = 7) => call<{ url: string; expiresAt: string }>('/api/box/shares', { method: 'POST', body: JSON.stringify({ path, days }) }),
    unshare: (token: string) => call(`/api/box/shares/${enc(token)}`, { method: 'DELETE' }),
    playlists: {
      list: () => call<{ playlists: Playlist[] }>('/api/box/playlists'),
      get: (id: string) => call<Playlist>(`/api/box/playlists/${enc(id)}`),
      create: (title: string, items: string[] = []) =>
        call<Playlist>('/api/box/playlists', { method: 'POST', body: JSON.stringify({ title, items }) }),
      update: (id: string, patch: { title?: string; description?: string; items?: string[] }) =>
        call<Playlist>(`/api/box/playlists/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      remove: (id: string) => call(`/api/box/playlists/${enc(id)}`, { method: 'DELETE' }),
      setCover: async (id: string, blob: Blob) => {
        const r = await fetch(`/api/box/playlists/${enc(id)}/cover`, { method: 'PUT', body: blob, headers: { 'content-type': blob.type }, credentials: 'same-origin' });
        const body = (await r.json().catch(() => ({}))) as Playlist & { error?: string };
        if (!r.ok) throw new Error(body.error ?? 'could not upload the picture');
        return body as Playlist;
      },
      removeCover: (id: string) => call<Playlist>(`/api/box/playlists/${enc(id)}/cover`, { method: 'DELETE' }),
      share: (id: string) => call<{ url: string }>(`/api/box/playlists/${enc(id)}/share`, { method: 'POST' }),
      unshare: (id: string) => call(`/api/box/playlists/${enc(id)}/share`, { method: 'DELETE' }),
    },
  },
  login: (code: string) => call<{ ok: true }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ code }) }),
  logout: () => call('/api/auth/logout', { method: 'POST' }),
  mounts: (fresh = false) => call<{ mounts: MountInfo[]; directTransfer: boolean }>(`/api/mounts${fresh ? '?fresh=1' : ''}`),
  createMount: (def: unknown) => call<MountInfo>('/api/mounts', { method: 'POST', body: JSON.stringify(def) }),
  deleteMount: (id: string) => call(`/api/mounts/${enc(id)}`, { method: 'DELETE' }),
  async listAll(mount: string, path: string): Promise<FileStat[]> {
    const out: FileStat[] = [];
    let cursor: string | undefined;
    do {
      const r: ListResult = await call(`/api/fs/${enc(mount)}/list?path=${enc(path)}${cursor ? `&cursor=${enc(cursor)}` : ''}`);
      out.push(...r.entries);
      cursor = r.cursor;
    } while (cursor);
    return out;
  },
  stat: (mount: string, path: string) => call<FileStat>(`/api/fs/${enc(mount)}/stat?path=${enc(path)}`),
  mkdir: (mount: string, path: string) => call(`/api/fs/${enc(mount)}/mkdir`, { method: 'POST', body: JSON.stringify({ path }) }),
  move: (mount: string, from: string, to: string) =>
    call(`/api/fs/${enc(mount)}/move`, { method: 'POST', body: JSON.stringify({ from, to }) }),
  remove: (mount: string, path: string) => call(`/api/fs/${enc(mount)}?path=${enc(path)}`, { method: 'DELETE' }),
  link: (mount: string, path: string) => call<{ url: string }>(`/api/fs/${enc(mount)}/link?path=${enc(path)}`),
  search: (q: string) => call<{ results: (FileStat & { mount: string })[] }>(`/api/search?q=${enc(q)}`),
  /** Small text save (editor). Large files go through tus. */
  saveText: (mount: string, path: string, text: string) =>
    call(`/api/fs/${enc(mount)}/upload?path=${enc(path)}`, { method: 'POST', body: new Blob([text]) }),
  async readText(mount: string, path: string, maxBytes: number): Promise<string> {
    const res = await fetch(rawUrl(mount, path), { headers: { range: `bytes=0-${maxBytes - 1}` } });
    if (!res.ok && res.status !== 206) throw new ApiError(res.status, res.statusText);
    return res.text();
  },
};
