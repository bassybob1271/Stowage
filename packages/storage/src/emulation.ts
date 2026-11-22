import { normalizePath, joinPath, type CapabilityName } from '@stowage/shared';
import {
  NotFoundError,
  ReadOnlyError,
  type ByteRange,
  type FileStat,
  type StorageAdapter,
  type WriteMeta,
} from './types.js';
import { sliceStream } from './streams.js';

export interface EmulatedAdapter extends StorageAdapter {
  move(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  readonly emulated: CapabilityName[];
  readonly readOnly: boolean;
  readonly inner: StorageAdapter;
  /** Walk a directory tree (depth-first). */
  walk(prefix: string): AsyncGenerator<FileStat>;
}

/**
 * Wrap an adapter so every capability the API relies on exists:
 *  - all paths are normalized (and `..` rejected) before reaching the adapter
 *  - move   → copy + delete (recursive for directories)
 *  - range  → read whole stream, skip bytes, stop early
 *  - mkdir  → no-op (object stores have implicit prefixes)
 *  - readOnly mounts reject every mutation
 */
export function withEmulation(inner: StorageAdapter, opts: { readOnly?: boolean } = {}): EmulatedAdapter {
  const readOnly = opts.readOnly ?? false;
  const emulated: CapabilityName[] = [];
  if (!inner.move) emulated.push('rename');
  if (!inner.capabilities.rangeRead) emulated.push('rangeRead');

  const guard = () => {
    if (readOnly) throw new ReadOnlyError(inner.id);
  };

  const locks = new Map<string, Promise<unknown>>();
  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    locks.set(key, run);
    try {
      return await run;
    } finally {
      if (locks.get(key) === run) locks.delete(key);
    }
  }

  async function* walk(prefix: string): AsyncGenerator<FileStat> {
    let cursor: string | undefined;
    do {
      const res = await inner.list(prefix, { cursor });
      for (const e of res.entries) {
        yield e;
        if (e.isDir) yield* walk(e.path);
      }
      cursor = res.cursor;
    } while (cursor);
  }

  async function copyFile(from: string, to: string, st: FileStat) {
    const body = await inner.read(from);
    await inner.write(to, body, { size: st.size, mime: st.mime });
  }

  const wrapped: EmulatedAdapter = {
    id: inner.id,
    kind: inner.kind,
    capabilities: { ...inner.capabilities, rename: true, rangeRead: true },
    emulated,
    readOnly,
    inner,
    walk: (p) => walk(normalizePath(p)),

    list: async (prefix, o) => inner.list(normalizePath(prefix), o),
    stat: async (p) => inner.stat(normalizePath(p)),

    async read(p: string, range?: ByteRange) {
      const path = normalizePath(p);
      if (!range || inner.capabilities.rangeRead) return inner.read(path, range);
      const s = await inner.read(path);
      return sliceStream(s, range.start, range.end);
    },

    async write(p: string, body: ReadableStream<Uint8Array>, meta: WriteMeta) {
      guard();
      const path = normalizePath(p);
      // Serialize same-path writes within this process: Azure block lists and
      // WebDAV locks (423) reject overlapping uploads to one name.
      return withLock(path, () => inner.write(path, body, meta));
    },

    async delete(p: string) {
      guard();
      const path = normalizePath(p);
      if (path === '') throw new Error('refusing to delete mount root');
      return inner.delete(path);
    },

    async mkdir(p: string) {
      guard();
      const path = normalizePath(p);
      if (inner.mkdir) return inner.mkdir(path);
    },

    async move(f: string, t: string) {
      guard();
      const from = normalizePath(f);
      const to = normalizePath(t);
      if (from === '' || to === '') throw new Error('cannot move mount root');
      if (from === to) return;
      if (to.startsWith(from + '/')) throw new Error('cannot move a folder into itself');
      if (inner.move) return inner.move(from, to);
      const st = await inner.stat(from);
      if (!st) throw new NotFoundError(from);
      if (!st.isDir) {
        await copyFile(from, to, st);
        await inner.delete(from);
        return;
      }
      if (inner.mkdir) await inner.mkdir(to);
      // Materialize the listing first so we don't walk entries we're creating.
      const all: FileStat[] = [];
      for await (const e of walk(from)) all.push(e);
      for (const e of all) {
        const rel = e.path.slice(from.length + 1);
        const dest = joinPath(to, rel);
        if (e.isDir) {
          if (inner.mkdir) await inner.mkdir(dest);
        } else {
          await copyFile(e.path, dest, e);
        }
      }
      await inner.delete(from);
    },

    presignGet: inner.presignGet?.bind(inner),
    presignPut: inner.presignPut ? (p, ttl) => (guard(), inner.presignPut!(normalizePath(p), ttl)) : undefined,
    multipart: inner.multipart,
    healthCheck: () =>
      inner.healthCheck().catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) })),
    close: inner.close?.bind(inner),
  };
  return wrapped;
}
