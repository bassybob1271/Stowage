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
  session: () => call<{ authenticated: boolean }>('/api/auth/session'),
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
