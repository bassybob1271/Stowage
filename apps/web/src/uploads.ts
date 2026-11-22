import * as tus from 'tus-js-client';
import { createStore } from './lib/store';

export type UploadStatus = 'queued' | 'uploading' | 'paused' | 'done' | 'error' | 'needs-file';

export interface UploadItem {
  id: string;
  name: string;
  relPath: string;
  size: number;
  mount: string;
  dir: string;
  bytes: number;
  speed: number; // bytes/sec (smoothed)
  status: UploadStatus;
  error?: string;
}

interface Persisted {
  id: string;
  file: File;
  meta: Omit<UploadItem, 'bytes' | 'speed' | 'status' | 'error'>;
}

export const uploadsStore = createStore<UploadItem[]>([]);
const CONCURRENCY = 3;
const running = new Map<string, tus.Upload>();
const files = new Map<string, File>();
const listeners = new Set<(item: UploadItem) => void>();

/** Called when any upload completes (to refresh listings). */
export function onUploadDone(f: (item: UploadItem) => void) {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

function patch(id: string, p: Partial<UploadItem>) {
  uploadsStore.set((list) => list.map((u) => (u.id === id ? { ...u, ...p } : u)));
}
const get = (id: string) => uploadsStore.get().find((u) => u.id === id);

// ---------- IndexedDB: keep File handles so a refresh can resume without re-picking ----------
const DB = 'stowage-uploads';
function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('u', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function idbDo(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<unknown> {
  const db = await idb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('u', mode);
      const req = fn(tx.objectStore('u'));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}
const persist = (p: Persisted) => idbDo('readwrite', (s) => s.put(p)).catch(() => {});
const unpersist = (id: string) => idbDo('readwrite', (s) => s.delete(id)).catch(() => {});

// ---------- scheduling ----------
function pump() {
  const active = uploadsStore.get().filter((u) => u.status === 'uploading').length;
  let slots = CONCURRENCY - active;
  for (const u of uploadsStore.get()) {
    if (slots <= 0) break;
    if (u.status === 'queued') {
      slots--;
      void begin(u.id);
    }
  }
}

async function begin(id: string) {
  const item = get(id);
  const file = files.get(id);
  if (!item) return;
  if (!file) return patch(id, { status: 'needs-file' });
  patch(id, { status: 'uploading', error: undefined });
  let last = { t: performance.now(), b: item.bytes };

  const up = new tus.Upload(file, {
    endpoint: '/api/tus',
    chunkSize: 8 * 1024 * 1024,
    retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
    removeFingerprintOnSuccess: true,
    storeFingerprintForResuming: true,
    metadata: { mount: item.mount, dir: item.dir, filename: item.name, relativePath: item.relPath, filetype: file.type },
    onProgress(sent) {
      const now = performance.now();
      const dt = (now - last.t) / 1000;
      if (dt > 0.4) {
        const inst = (sent - last.b) / dt;
        const prev = get(id)?.speed ?? 0;
        patch(id, { bytes: sent, speed: prev ? prev * 0.7 + inst * 0.3 : inst });
        last = { t: now, b: sent };
      } else patch(id, { bytes: sent });
    },
    onSuccess() {
      running.delete(id);
      files.delete(id);
      void unpersist(id);
      patch(id, { status: 'done', bytes: file.size, speed: 0 });
      const done = get(id);
      if (done) listeners.forEach((f) => f(done));
      pump();
    },
    onError(err) {
      running.delete(id);
      const body = (err as tus.DetailedError).originalResponse?.getBody?.();
      patch(id, { status: 'error', error: (body || err.message).toString().slice(0, 200), speed: 0 });
      pump();
    },
  });
  running.set(id, up);
  try {
    const prev = await up.findPreviousUploads();
    if (prev[0]) up.resumeFromPreviousUpload(prev[0]);
  } catch {
    /* no previous */
  }
  up.start();
}

// ---------- public API ----------
export function enqueue(entries: { file: File; relPath: string }[], mount: string, dir: string) {
  const items: UploadItem[] = entries.map(({ file, relPath }) => {
    const id = crypto.randomUUID();
    files.set(id, file);
    const meta = { id, name: file.name, relPath, size: file.size, mount, dir };
    void persist({ id, file, meta });
    return { ...meta, bytes: 0, speed: 0, status: 'queued' as const };
  });
  uploadsStore.set((l) => [...l, ...items]);
  pump();
}

export function pause(id: string) {
  void running.get(id)?.abort(false);
  running.delete(id);
  patch(id, { status: 'paused', speed: 0 });
  pump();
}

export function resume(id: string) {
  patch(id, { status: 'queued' });
  pump();
}

export function retry(id: string) {
  resume(id);
}

export function cancel(id: string) {
  // abort(true) also DELETEs the partial upload on the server.
  void running.get(id)?.abort(true);
  running.delete(id);
  files.delete(id);
  void unpersist(id);
  uploadsStore.set((l) => l.filter((u) => u.id !== id));
  pump();
}

/** Re-attach a file for an upload restored without its handle; tus fingerprint resumes it. */
export function reattach(id: string, file: File) {
  const u = get(id);
  if (!u || file.size !== u.size || file.name !== u.name) return false;
  files.set(id, file);
  void persist({ id, file, meta: { id, name: u.name, relPath: u.relPath, size: u.size, mount: u.mount, dir: u.dir } });
  resume(id);
  return true;
}

export function clearFinished() {
  uploadsStore.set((l) => l.filter((u) => u.status !== 'done'));
}

/** On page load: restore unfinished uploads from IndexedDB and resume them. */
export async function restoreUploads() {
  const rows = ((await idbDo('readonly', (s) => s.getAll())) as Persisted[] | undefined) ?? [];
  if (!rows.length) return;
  const items: UploadItem[] = [];
  for (const r of rows) {
    let ok = r.file instanceof Blob;
    if (ok) {
      try {
        await r.file.slice(0, 1).arrayBuffer(); // file still readable?
      } catch {
        ok = false;
      }
    }
    if (ok) files.set(r.id, r.file);
    items.push({ ...r.meta, bytes: 0, speed: 0, status: ok ? 'queued' : 'needs-file' });
  }
  uploadsStore.set((l) => [...l, ...items]);
  pump();
}
