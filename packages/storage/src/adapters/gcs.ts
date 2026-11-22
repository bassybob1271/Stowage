import { Storage, type Bucket } from '@google-cloud/storage';
import { pipeline } from 'node:stream/promises';
import { mimeFor, normalizePath } from '@stowage/shared';
import { DEFAULT_CAPS, NotFoundError, type FileStat, type StorageAdapter, type WriteMeta } from '../types.js';
import { emptyStream, toNode, toWeb } from '../streams.js';

/**
 * Native Google Cloud Storage adapter. (GCS also works through the S3 adapter
 * using HMAC keys and endpoint https://storage.googleapis.com.)
 */
export interface GcsConfig {
  bucket: string;
  projectId?: string;
  /** Path to a service-account JSON file. */
  keyFilename?: string;
  /** Inline service-account JSON. */
  credentials?: { client_email: string; private_key: string };
  /** Custom endpoint, e.g. fake-gcs-server for tests. */
  apiEndpoint?: string;
  prefix?: string;
}

export class GcsAdapter implements StorageAdapter {
  readonly kind = 'gcs' as const;
  readonly capabilities = { ...DEFAULT_CAPS, rename: true, rangeRead: true, multipartUpload: true, presignedUrls: true, versioning: true };
  private readonly bucket: Bucket;
  private readonly root: string;

  constructor(readonly id: string, cfg: GcsConfig) {
    if (!cfg.bucket) throw new Error(`gcs mount ${id}: config.bucket is required`);
    const storage = new Storage({
      projectId: cfg.projectId,
      keyFilename: cfg.keyFilename,
      credentials: cfg.credentials,
      apiEndpoint: cfg.apiEndpoint,
    });
    this.bucket = storage.bucket(cfg.bucket);
    this.root = cfg.prefix ? normalizePath(cfg.prefix) + '/' : '';
  }

  private key(p: string) {
    return this.root + normalizePath(p);
  }
  private rel(k: string) {
    return k.slice(this.root.length).replace(/\/$/, '');
  }
  private dir(path: string): FileStat {
    return { path, name: path.split('/').pop() ?? '', size: 0, mime: 'inode/directory', modifiedAt: new Date(0).toISOString(), isDir: true };
  }
  private fileStat(path: string, md: { size?: string | number; contentType?: string; etag?: string; md5Hash?: string; updated?: string }): FileStat {
    return {
      path,
      name: path.split('/').pop() ?? '',
      size: Number(md.size ?? 0),
      mime: md.contentType && md.contentType !== 'application/octet-stream' ? md.contentType : mimeFor(path),
      etag: md.md5Hash ?? md.etag,
      modifiedAt: md.updated ?? new Date(0).toISOString(),
      isDir: false,
    };
  }

  async list(prefix: string, opts?: { cursor?: string; limit?: number }) {
    const p = normalizePath(prefix);
    const kp = this.key(p) + (p ? '/' : '');
    const [files, next, resp] = await this.bucket.getFiles({
      prefix: kp,
      delimiter: '/',
      autoPaginate: false,
      pageToken: opts?.cursor,
      maxResults: opts?.limit ?? 1000,
    });
    const entries: FileStat[] = [];
    for (const pre of ((resp as { prefixes?: string[] })?.prefixes ?? [])) entries.push(this.dir(this.rel(pre)));
    for (const f of files) {
      if (f.name.endsWith('/')) continue;
      entries.push(this.fileStat(this.rel(f.name), f.metadata));
    }
    return { entries, cursor: (next as { pageToken?: string } | null)?.pageToken };
  }

  async stat(p: string) {
    const path = normalizePath(p);
    if (!path) return this.dir('');
    try {
      const [md] = await this.bucket.file(this.key(path)).getMetadata();
      return this.fileStat(path, md);
    } catch (e) {
      if ((e as { code?: number }).code !== 404) throw e;
    }
    const [files] = await this.bucket.getFiles({ prefix: this.key(path) + '/', maxResults: 1, autoPaginate: false });
    return files.length ? this.dir(path) : null;
  }

  async read(p: string, range?: { start: number; end?: number }) {
    const path = normalizePath(p);
    const st = await this.stat(path);
    if (!st || st.isDir) throw new NotFoundError(path);
    if (st.size === 0) return emptyStream();
    return toWeb(this.bucket.file(this.key(path)).createReadStream(range ? { start: range.start, end: range.end } : {}));
  }

  async write(p: string, body: ReadableStream<Uint8Array>, meta: WriteMeta) {
    const path = normalizePath(p);
    const f = this.bucket.file(this.key(path));
    const contentType = meta.mime ?? mimeFor(path);
    if (meta.size === 0) await f.save('', { contentType, resumable: false });
    else await pipeline(toNode(body), f.createWriteStream({ contentType, resumable: (meta.size ?? Infinity) > 8 * 1024 * 1024 }));
    return (await this.stat(path))!;
  }

  async delete(p: string) {
    const path = normalizePath(p);
    await this.bucket.file(this.key(path)).delete({ ignoreNotFound: true });
    await this.bucket.deleteFiles({ prefix: this.key(path) + '/', force: true });
  }

  async move(from: string, to: string) {
    const f = normalizePath(from);
    const t = normalizePath(to);
    const st = await this.stat(f);
    if (!st) throw new NotFoundError(f);
    if (!st.isDir) {
      await this.bucket.file(this.key(f)).move(this.key(t));
      return;
    }
    const sp = this.key(f) + '/';
    const [files] = await this.bucket.getFiles({ prefix: sp });
    for (const file of files) await file.move(this.key(t) + '/' + file.name.slice(sp.length));
  }

  async mkdir(p: string) {
    await this.bucket.file(this.key(p) + '/').save('', { resumable: false });
  }

  async presignGet(p: string, ttlSec: number) {
    const [url] = await this.bucket.file(this.key(p)).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + ttlSec * 1000 });
    return url;
  }

  async presignPut(p: string, ttlSec: number) {
    const [url] = await this.bucket.file(this.key(p)).getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + ttlSec * 1000 });
    return url;
  }

  async healthCheck() {
    try {
      const [exists] = await this.bucket.exists();
      return exists ? { ok: true } : { ok: false, detail: 'bucket does not exist' };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
