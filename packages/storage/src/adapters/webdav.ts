import { createClient, type WebDAVClient, type FileStat as DavStat } from 'webdav';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const TMP_PREFIX = '.stowage-tmp-';
import { mimeFor, normalizePath } from '@stowage/shared';
import { DEFAULT_CAPS, NotFoundError, type FileStat, type StorageAdapter, type WriteMeta } from '../types.js';
import { emptyStream, toNode, toWeb } from '../streams.js';

export interface WebdavConfig {
  url: string;
  username?: string;
  password?: string;
  /** Sub-directory on the server the mount is rooted at. */
  root?: string;
  /** Set false for servers that ignore Range headers (the wrapper will emulate). */
  rangeRead?: boolean;
}

export class WebdavAdapter implements StorageAdapter {
  readonly kind: 'webdav' | 'rclone' = 'webdav';
  readonly capabilities;
  protected readonly client: WebDAVClient;
  private readonly root: string;

  constructor(readonly id: string, cfg: WebdavConfig) {
    if (!cfg.url) throw new Error(`webdav mount ${id}: config.url is required`);
    this.client = createClient(cfg.url, { username: cfg.username, password: cfg.password });
    this.root = '/' + normalizePath(cfg.root ?? '');
    this.capabilities = { ...DEFAULT_CAPS, rename: true, rangeRead: cfg.rangeRead ?? true };
  }

  private remote(p: string) {
    const n = normalizePath(p);
    return (this.root === '/' ? '' : this.root) + '/' + n;
  }

  private toStat(path: string, s: DavStat): FileStat {
    const isDir = s.type === 'directory';
    return {
      path,
      name: path.split('/').pop() ?? '',
      size: isDir ? 0 : s.size,
      mime: isDir ? 'inode/directory' : mimeFor(path),
      etag: s.etag?.replace(/"/g, '') ?? undefined,
      modifiedAt: new Date(s.lastmod).toISOString(),
      isDir,
    };
  }

  async list(prefix: string, opts?: { cursor?: string; limit?: number }) {
    const p = normalizePath(prefix);
    let items: DavStat[];
    try {
      items = (await this.client.getDirectoryContents(this.remote(p))) as DavStat[];
    } catch (e) {
      if (status(e) === 404) return { entries: [] };
      throw e;
    }
    const all = items
      .filter((s) => !s.basename.startsWith(TMP_PREFIX))
      .map((s) => this.toStat(p ? `${p}/${s.basename}` : s.basename, s))
      .sort((a, b) => a.name.localeCompare(b.name));
    const start = opts?.cursor ? Number(opts.cursor) : 0;
    const limit = opts?.limit ?? 1000;
    return { entries: all.slice(start, start + limit), cursor: start + limit < all.length ? String(start + limit) : undefined };
  }

  async stat(p: string) {
    const path = normalizePath(p);
    try {
      return this.toStat(path, (await this.client.stat(this.remote(path))) as DavStat);
    } catch (e) {
      if (status(e) === 404) return null;
      throw e;
    }
  }

  async read(p: string, range?: { start: number; end?: number }) {
    const path = normalizePath(p);
    const st = await this.stat(path);
    if (!st || st.isDir) throw new NotFoundError(path);
    if (st.size === 0) return emptyStream();
    const useRange = range && this.capabilities.rangeRead;
    const s = this.client.createReadStream(
      this.remote(path),
      useRange ? { range: { start: range.start, end: range.end ?? st.size - 1 } } : undefined,
    );
    return toWeb(s as Readable);
  }

  async write(p: string, body: ReadableStream<Uint8Array>, meta: WriteMeta) {
    const path = normalizePath(p);
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent) await this.mkdir(parent);
    // Upload under a temp name, then MOVE into place: atomic for readers, and
    // the MOVE (bodiless) can be retried when the server reports 423 Locked.
    const tmp = (parent ? parent + '/' : '') + TMP_PREFIX + randomUUID();
    try {
      const ok = await this.client.putFileContents(this.remote(tmp), meta.size === 0 ? '' : toNode(body), {
        overwrite: true,
        contentLength: meta.size ?? false,
      });
      if (!ok) throw new Error(`webdav PUT failed for ${path}`);
      for (let attempt = 0; ; attempt++) {
        try {
          await this.client.moveFile(this.remote(tmp), this.remote(path), { overwrite: true } as never);
          break;
        } catch (e) {
          if (status(e) !== 423 || attempt >= 20) throw e;
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        }
      }
    } catch (e) {
      await this.client.deleteFile(this.remote(tmp)).catch(() => {});
      throw e;
    }
    const st = await this.stat(path);
    if (!st) throw new Error(`write succeeded but stat failed for ${path}`);
    return st;
  }

  async delete(p: string) {
    try {
      await this.client.deleteFile(this.remote(p));
    } catch (e) {
      if (status(e) !== 404) throw e;
    }
  }

  async move(from: string, to: string) {
    const t = normalizePath(to);
    const parent = t.includes('/') ? t.slice(0, t.lastIndexOf('/')) : '';
    if (parent) await this.mkdir(parent);
    try {
      await this.client.moveFile(this.remote(from), this.remote(t), { overwrite: true } as never);
    } catch (e) {
      if (status(e) === 404) throw new NotFoundError(normalizePath(from));
      throw e;
    }
  }

  async mkdir(p: string) {
    const path = normalizePath(p);
    if (!path) return;
    if (await this.client.exists(this.remote(path))) return;
    try {
      await this.client.createDirectory(this.remote(path), { recursive: true });
    } catch (e) {
      // Concurrent MKCOLs for the same folder race (405/423); fine if it exists now.
      for (let i = 0; i < 10; i++) {
        if (await this.client.exists(this.remote(path))) return;
        await new Promise((r) => setTimeout(r, 30 * (i + 1)));
      }
      throw e;
    }
  }

  async healthCheck() {
    try {
      if (this.root !== '/' && !(await this.client.exists(this.root))) await this.client.createDirectory(this.root, { recursive: true });
      await this.client.getDirectoryContents(this.remote(''));
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}

function status(e: unknown): number | undefined {
  return (e as { status?: number; response?: { status?: number } })?.status ?? (e as { response?: { status?: number } })?.response?.status;
}
