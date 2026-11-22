import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  BlobSASPermissions,
  type ContainerClient,
} from '@azure/storage-blob';
import { Readable } from 'node:stream';
import { mimeFor, normalizePath } from '@stowage/shared';
import { DEFAULT_CAPS, NotFoundError, type FileStat, type StorageAdapter, type WriteMeta } from '../types.js';
import { emptyStream, toNode, toWeb } from '../streams.js';

export interface AzureConfig {
  /** Either a connection string... */
  connectionString?: string;
  /** ...or account + key (+ optional custom endpoint, e.g. Azurite). */
  account?: string;
  accountKey?: string;
  endpoint?: string;
  container: string;
  prefix?: string;
}

export class AzureBlobAdapter implements StorageAdapter {
  readonly kind = 'azure' as const;
  readonly capabilities = { ...DEFAULT_CAPS, rename: true, rangeRead: true, multipartUpload: true, presignedUrls: true, versioning: true };
  private readonly container: ContainerClient;
  private readonly root: string;

  constructor(readonly id: string, cfg: AzureConfig) {
    if (!cfg.container) throw new Error(`azure mount ${id}: config.container is required`);
    let svc: BlobServiceClient;
    if (cfg.connectionString) svc = BlobServiceClient.fromConnectionString(cfg.connectionString);
    else if (cfg.account && cfg.accountKey)
      svc = new BlobServiceClient(
        cfg.endpoint ?? `https://${cfg.account}.blob.core.windows.net`,
        new StorageSharedKeyCredential(cfg.account, cfg.accountKey),
      );
    else throw new Error(`azure mount ${id}: connectionString or account+accountKey required`);
    this.container = svc.getContainerClient(cfg.container);
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

  async list(prefix: string, opts?: { cursor?: string; limit?: number }) {
    const p = normalizePath(prefix);
    const kp = this.key(p) + (p ? '/' : '');
    const page = await this.container
      .listBlobsByHierarchy('/', { prefix: kp })
      .byPage({ continuationToken: opts?.cursor, maxPageSize: opts?.limit ?? 1000 })
      .next();
    const seg = page.value?.segment;
    const entries: FileStat[] = [];
    for (const bp of seg?.blobPrefixes ?? []) entries.push(this.dir(this.rel(bp.name)));
    for (const b of seg?.blobItems ?? []) {
      if (b.name.endsWith('/')) continue;
      const path = this.rel(b.name);
      entries.push({
        path,
        name: path.split('/').pop() ?? '',
        size: b.properties.contentLength ?? 0,
        mime: b.properties.contentType && b.properties.contentType !== 'application/octet-stream' ? b.properties.contentType : mimeFor(path),
        etag: b.properties.etag?.replace(/"/g, ''),
        modifiedAt: (b.properties.lastModified ?? new Date(0)).toISOString(),
        isDir: false,
      });
    }
    return { entries, cursor: page.value?.continuationToken || undefined };
  }

  async stat(p: string) {
    const path = normalizePath(p);
    if (!path) return this.dir('');
    try {
      const pr = await this.container.getBlobClient(this.key(path)).getProperties();
      return {
        path,
        name: path.split('/').pop() ?? '',
        size: pr.contentLength ?? 0,
        mime: pr.contentType && pr.contentType !== 'application/octet-stream' ? pr.contentType : mimeFor(path),
        etag: pr.etag?.replace(/"/g, ''),
        modifiedAt: (pr.lastModified ?? new Date(0)).toISOString(),
        isDir: false,
      };
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e;
    }
    const it = this.container.listBlobsFlat({ prefix: this.key(path) + '/' }).byPage({ maxPageSize: 1 });
    const first = await it.next();
    return (first.value?.segment.blobItems.length ?? 0) > 0 ? this.dir(path) : null;
  }

  async read(p: string, range?: { start: number; end?: number }) {
    const path = normalizePath(p);
    const st = await this.stat(path);
    if (!st || st.isDir) throw new NotFoundError(path);
    if (st.size === 0) return emptyStream();
    const count = range?.end !== undefined ? range.end - range.start + 1 : undefined;
    const r = await this.container.getBlobClient(this.key(path)).download(range?.start ?? 0, count);
    return toWeb(r.readableStreamBody as Readable);
  }

  async write(p: string, body: ReadableStream<Uint8Array>, meta: WriteMeta) {
    const path = normalizePath(p);
    const blob = this.container.getBlockBlobClient(this.key(path));
    const headers = { blobHTTPHeaders: { blobContentType: meta.mime ?? mimeFor(path) } };
    if (meta.size === 0) await blob.upload('', 0, headers);
    else await blob.uploadStream(toNode(body), 8 * 1024 * 1024, 4, headers);
    return (await this.stat(path))!;
  }

  async delete(p: string) {
    const path = normalizePath(p);
    await this.container.getBlobClient(this.key(path)).deleteIfExists();
    for await (const b of this.container.listBlobsFlat({ prefix: this.key(path) + '/' }))
      await this.container.getBlobClient(b.name).deleteIfExists();
  }

  private async copy(src: string, dst: string) {
    const poller = await this.container.getBlobClient(dst).beginCopyFromURL(this.container.getBlobClient(src).url);
    await poller.pollUntilDone();
  }

  async move(from: string, to: string) {
    const f = normalizePath(from);
    const t = normalizePath(to);
    const st = await this.stat(f);
    if (!st) throw new NotFoundError(f);
    if (!st.isDir) {
      await this.copy(this.key(f), this.key(t));
      await this.container.getBlobClient(this.key(f)).delete();
      return;
    }
    const sp = this.key(f) + '/';
    const names: string[] = [];
    for await (const b of this.container.listBlobsFlat({ prefix: sp })) names.push(b.name);
    for (const n of names) await this.copy(n, this.key(t) + '/' + n.slice(sp.length));
    await this.delete(f);
  }

  async mkdir(p: string) {
    await this.container.getBlockBlobClient(this.key(p) + '/').upload('', 0);
  }

  async presignGet(p: string, ttlSec: number) {
    return this.container.getBlobClient(this.key(p)).generateSasUrl({
      permissions: BlobSASPermissions.parse('r'),
      expiresOn: new Date(Date.now() + ttlSec * 1000),
    });
  }

  async presignPut(p: string, ttlSec: number) {
    return this.container.getBlobClient(this.key(p)).generateSasUrl({
      permissions: BlobSASPermissions.parse('cw'),
      expiresOn: new Date(Date.now() + ttlSec * 1000),
    });
  }

  async healthCheck() {
    try {
      await this.container.createIfNotExists();
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
