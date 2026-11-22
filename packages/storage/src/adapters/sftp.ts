import SftpClient from 'ssh2-sftp-client';
import { posix } from 'node:path';
import { readFile } from 'node:fs/promises';
import { mimeFor, normalizePath } from '@stowage/shared';
import { DEFAULT_CAPS, NotFoundError, type FileStat, type StorageAdapter } from '../types.js';
import { emptyStream, toNode, toWeb } from '../streams.js';

export interface SftpConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  passphrase?: string;
  root?: string;
}

export class SftpAdapter implements StorageAdapter {
  readonly kind = 'sftp' as const;
  readonly capabilities = { ...DEFAULT_CAPS, rename: true, rangeRead: true };
  private client?: SftpClient;
  private connecting?: Promise<SftpClient>;
  private readonly root: string;

  constructor(readonly id: string, private readonly cfg: SftpConfig) {
    if (!cfg.host || !cfg.username) throw new Error(`sftp mount ${id}: host and username are required`);
    this.root = '/' + normalizePath(cfg.root ?? '');
  }

  private async conn(): Promise<SftpClient> {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const c = new SftpClient(this.id);
      await c.connect({
        host: this.cfg.host,
        port: this.cfg.port ?? 22,
        username: this.cfg.username,
        password: this.cfg.password,
        privateKey: this.cfg.privateKey ?? (this.cfg.privateKeyPath ? await readFile(this.cfg.privateKeyPath) : undefined),
        passphrase: this.cfg.passphrase,
        readyTimeout: 10_000,
      });
      c.on('end', () => (this.client = undefined));
      c.on('error', () => (this.client = undefined));
      this.client = c;
      return c;
    })().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private remote(p: string) {
    return posix.join(this.root, normalizePath(p));
  }

  private mk(path: string, isDir: boolean, size: number, mtimeMs: number): FileStat {
    return {
      path,
      name: path.split('/').pop() ?? '',
      size: isDir ? 0 : size,
      mime: isDir ? 'inode/directory' : mimeFor(path),
      etag: `${size.toString(16)}-${mtimeMs.toString(16)}`,
      modifiedAt: new Date(mtimeMs).toISOString(),
      isDir,
    };
  }

  async list(prefix: string, opts?: { cursor?: string; limit?: number }) {
    const p = normalizePath(prefix);
    const c = await this.conn();
    if (!(await c.exists(this.remote(p)))) return { entries: [] };
    const items = await c.list(this.remote(p));
    const all = items
      .filter((i) => i.name !== '.' && i.name !== '..')
      .map((i) => this.mk(p ? `${p}/${i.name}` : i.name, i.type === 'd', i.size, i.modifyTime))
      .sort((a, b) => a.name.localeCompare(b.name));
    const start = opts?.cursor ? Number(opts.cursor) : 0;
    const limit = opts?.limit ?? 1000;
    return { entries: all.slice(start, start + limit), cursor: start + limit < all.length ? String(start + limit) : undefined };
  }

  async stat(p: string) {
    const path = normalizePath(p);
    const c = await this.conn();
    try {
      const s = await c.stat(this.remote(path));
      return this.mk(path, s.isDirectory, s.size, s.modifyTime);
    } catch {
      return null;
    }
  }

  async read(p: string, range?: { start: number; end?: number }) {
    const st = await this.stat(p);
    if (!st || st.isDir) throw new NotFoundError(normalizePath(p));
    if (st.size === 0) return emptyStream();
    const c = await this.conn();
    return toWeb(c.createReadStream(this.remote(p), range ? { start: range.start, end: range.end } : {}));
  }

  async write(p: string, body: ReadableStream<Uint8Array>) {
    const path = normalizePath(p);
    const c = await this.conn();
    await c.mkdir(posix.dirname(this.remote(path)), true).catch(() => {});
    await c.put(toNode(body), this.remote(path));
    const st = await this.stat(path);
    if (!st) throw new Error(`write succeeded but stat failed for ${path}`);
    return st;
  }

  async delete(p: string) {
    const c = await this.conn();
    const r = this.remote(p);
    const t = await c.exists(r);
    if (t === 'd') await c.rmdir(r, true);
    else if (t) await c.delete(r);
  }

  async move(from: string, to: string) {
    const c = await this.conn();
    const dst = this.remote(to);
    await c.mkdir(posix.dirname(dst), true).catch(() => {});
    if (await c.exists(dst)) await this.delete(to);
    await c.rename(this.remote(from), dst);
  }

  async mkdir(p: string) {
    const c = await this.conn();
    const r = this.remote(p);
    if (!(await c.exists(r))) await c.mkdir(r, true);
  }

  async healthCheck() {
    try {
      const c = await this.conn();
      if (!(await c.exists(this.root))) await c.mkdir(this.root, true);
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async close() {
    await this.client?.end().catch(() => {});
    this.client = undefined;
  }
}
