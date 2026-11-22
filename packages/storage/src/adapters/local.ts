import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { mimeFor, normalizePath, PathError } from '@stowage/shared';
import { DEFAULT_CAPS, NotFoundError, type FileStat, type StorageAdapter } from '../types.js';
import { toNode, toWeb } from '../streams.js';

export interface LocalConfig {
  root: string;
}

const TMP_PREFIX = '.stowage-tmp-';

/** Local filesystem adapter with a path jail (also rejects symlink escapes). */
export class LocalAdapter implements StorageAdapter {
  readonly kind = 'local' as const;
  readonly capabilities = { ...DEFAULT_CAPS, rename: true, rangeRead: true };
  private readonly root: string;
  private rootReady?: Promise<string>;

  constructor(readonly id: string, cfg: LocalConfig) {
    if (!cfg.root) throw new Error(`local mount ${id}: config.root is required`);
    this.root = nodePath.resolve(cfg.root);
  }

  /** Resolve a mount path to an absolute path inside the jail. */
  private async abs(p: string, { mustExist = false } = {}): Promise<string> {
    const rel = normalizePath(p);
    const full = nodePath.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + nodePath.sep)) throw new PathError('path escapes mount root');
    // Symlink jail: the deepest existing ancestor must resolve inside the real root.
    this.rootReady ??= fs.mkdir(this.root, { recursive: true }).then(() => fs.realpath(this.root));
    const realRoot = await this.rootReady;
    let probe = full;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (real !== realRoot && !real.startsWith(realRoot + nodePath.sep)) throw new PathError('path escapes mount root via symlink');
        break;
      } catch (e) {
        if (e instanceof PathError) throw e;
        if (mustExist && probe === full) throw new NotFoundError(rel);
        const parent = nodePath.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    return full;
  }

  private toStat(rel: string, st: import('node:fs').Stats): FileStat {
    const name = rel === '' ? '' : nodePath.posix.basename(rel);
    return {
      path: rel,
      name,
      size: st.isDirectory() ? 0 : st.size,
      mime: st.isDirectory() ? 'inode/directory' : mimeFor(rel),
      etag: `${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}`,
      modifiedAt: st.mtime.toISOString(),
      isDir: st.isDirectory(),
    };
  }

  async list(prefix: string, opts?: { cursor?: string; limit?: number }) {
    const rel = normalizePath(prefix);
    const dir = await this.abs(rel);
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => !n.startsWith(TMP_PREFIX)).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] };
      throw e;
    }
    const start = opts?.cursor ? Number(opts.cursor) : 0;
    const limit = opts?.limit ?? 1000;
    const page = names.slice(start, start + limit);
    const entries: FileStat[] = [];
    for (const n of page) {
      const childRel = rel ? `${rel}/${n}` : n;
      try {
        entries.push(this.toStat(childRel, await fs.stat(nodePath.join(dir, n))));
      } catch {
        /* vanished or broken symlink */
      }
    }
    const next = start + limit < names.length ? String(start + limit) : undefined;
    return { entries, cursor: next };
  }

  async stat(p: string) {
    const rel = normalizePath(p);
    try {
      return this.toStat(rel, await fs.stat(await this.abs(rel)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof NotFoundError) return null;
      throw e;
    }
  }

  async read(p: string, range?: { start: number; end?: number }) {
    const full = await this.abs(p, { mustExist: true });
    const st = await fs.stat(full).catch(() => null);
    if (!st || st.isDirectory()) throw new NotFoundError(normalizePath(p));
    if (st.size === 0) return toWeb(createReadStream(full));
    return toWeb(createReadStream(full, range ? { start: range.start, end: range.end } : undefined));
  }

  async write(p: string, body: ReadableStream<Uint8Array>) {
    const rel = normalizePath(p);
    const full = await this.abs(rel);
    await fs.mkdir(nodePath.dirname(full), { recursive: true });
    const tmp = nodePath.join(nodePath.dirname(full), `${TMP_PREFIX}${randomUUID()}`);
    try {
      await pipeline(toNode(body), createWriteStream(tmp));
      await fs.rename(tmp, full);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    return this.toStat(rel, await fs.stat(full));
  }

  async delete(p: string) {
    const full = await this.abs(p);
    await fs.rm(full, { recursive: true, force: true });
  }

  async move(from: string, to: string) {
    const src = await this.abs(from, { mustExist: true });
    const dst = await this.abs(to);
    await fs.mkdir(nodePath.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
  }

  async mkdir(p: string) {
    await fs.mkdir(await this.abs(p), { recursive: true });
  }

  async healthCheck() {
    try {
      await fs.mkdir(this.root, { recursive: true });
      await fs.access(this.root);
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
