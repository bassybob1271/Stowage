import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type _Object,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { mimeFor, normalizePath } from '@stowage/shared';
import { DEFAULT_CAPS, NotFoundError, type FileStat, type MultipartOps, type StorageAdapter, type WriteMeta } from '../types.js';
import { emptyStream, toNode, toWeb } from '../streams.js';

export interface S3Config {
  endpoint?: string;
  /** Endpoint used when signing URLs for the browser (e.g. public MinIO URL). Defaults to endpoint. */
  publicEndpoint?: string;
  region?: string;
  bucket: string;
  accessKey?: string;
  secretKey?: string;
  forcePathStyle?: boolean;
  /** Optional key prefix inside the bucket this mount is rooted at. */
  prefix?: string;
  /** Multipart part size in bytes (default 16 MiB). */
  partSize?: number;
  /** Create the bucket on first health check if it doesn't exist (dev convenience). */
  createBucket?: boolean;
}

const PART_SIZE = 16 * 1024 * 1024;

function encodeKey(key: string) {
  return key.split('/').map(encodeURIComponent).join('/');
}

export class S3Adapter implements StorageAdapter {
  readonly kind = 's3' as const;
  readonly capabilities = {
    ...DEFAULT_CAPS,
    rename: true,
    rangeRead: true,
    multipartUpload: true,
    presignedUrls: true,
    versioning: true,
  };
  private readonly client: S3Client;
  private readonly signer: S3Client;
  private readonly bucket: string;
  private readonly root: string;
  private readonly partSize: number;

  constructor(readonly id: string, cfg: S3Config) {
    if (!cfg.bucket) throw new Error(`s3 mount ${id}: config.bucket is required`);
    const base = {
      region: cfg.region ?? 'us-east-1',
      forcePathStyle: cfg.forcePathStyle ?? Boolean(cfg.endpoint),
      credentials:
        cfg.accessKey && cfg.secretKey ? { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey } : undefined,
      // Many S3-compatibles (B2, R2, older MinIO, Garage) reject the newer default checksum headers.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.client = new S3Client({ ...base, endpoint: cfg.endpoint });
    this.signer = cfg.publicEndpoint ? new S3Client({ ...base, endpoint: cfg.publicEndpoint }) : this.client;
    this.bucket = cfg.bucket;
    this.root = cfg.prefix ? normalizePath(cfg.prefix) + '/' : '';
    this.partSize = cfg.partSize ?? PART_SIZE;
    this.createBucket = cfg.createBucket ?? false;
  }
  private readonly createBucket: boolean;

  private key(p: string) {
    return this.root + normalizePath(p);
  }
  private rel(key: string) {
    return key.slice(this.root.length).replace(/\/$/, '');
  }

  private objStat(o: { Key?: string; Size?: number; ETag?: string; LastModified?: Date }, contentType?: string): FileStat {
    const path = this.rel(o.Key!);
    return {
      path,
      name: path.split('/').pop() ?? '',
      size: o.Size ?? 0,
      mime: contentType && contentType !== 'application/octet-stream' ? contentType : mimeFor(path),
      etag: o.ETag?.replace(/"/g, ''),
      modifiedAt: (o.LastModified ?? new Date(0)).toISOString(),
      isDir: false,
    };
  }

  private dirStat(path: string): FileStat {
    return { path, name: path.split('/').pop() ?? '', size: 0, mime: 'inode/directory', modifiedAt: new Date(0).toISOString(), isDir: true };
  }

  async list(prefix: string, opts?: { cursor?: string; limit?: number }) {
    const p = normalizePath(prefix);
    const keyPrefix = this.key(p) + (p ? '/' : '');
    const res = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: keyPrefix,
        Delimiter: '/',
        ContinuationToken: opts?.cursor,
        MaxKeys: opts?.limit ?? 1000,
      }),
    );
    const entries: FileStat[] = [];
    for (const cp of res.CommonPrefixes ?? []) if (cp.Prefix) entries.push(this.dirStat(this.rel(cp.Prefix)));
    for (const o of res.Contents ?? []) {
      if (!o.Key || o.Key === keyPrefix || o.Key.endsWith('/')) continue; // folder markers
      entries.push(this.objStat(o));
    }
    return { entries, cursor: res.IsTruncated ? res.NextContinuationToken : undefined };
  }

  async stat(p: string) {
    const path = normalizePath(p);
    if (path === '') return this.dirStat('');
    try {
      const h = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(path) }));
      return this.objStat({ Key: this.key(path), Size: h.ContentLength, ETag: h.ETag, LastModified: h.LastModified }, h.ContentType);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    const l = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.key(path) + '/', MaxKeys: 1 }));
    return (l.KeyCount ?? 0) > 0 ? this.dirStat(path) : null;
  }

  async read(p: string, range?: { start: number; end?: number }) {
    const path = normalizePath(p);
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.key(path),
          Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined,
        }),
      );
      if (!res.Body) return emptyStream();
      return toWeb(res.Body as Readable);
    } catch (e) {
      if (isNotFound(e)) throw new NotFoundError(path);
      // Range on a 0-byte object → 416; return empty.
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 416) return emptyStream();
      throw e;
    }
  }

  async write(p: string, body: ReadableStream<Uint8Array>, meta: WriteMeta) {
    const path = normalizePath(p);
    const ContentType = meta.mime ?? mimeFor(path);
    if (meta.size === 0) {
      await body.cancel().catch(() => {});
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(path), Body: '', ContentType }));
    } else {
      const up = new Upload({
        client: this.client,
        params: { Bucket: this.bucket, Key: this.key(path), Body: toNode(body), ContentType },
        partSize: this.partSize,
        queueSize: 4,
        leavePartsOnError: false,
      });
      await up.done();
    }
    const st = await this.stat(path);
    if (!st) throw new Error(`write succeeded but stat failed for ${path}`);
    return st;
  }

  private async *keysUnder(prefixKey: string): AsyncGenerator<_Object> {
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefixKey, ContinuationToken: token }));
      for (const o of r.Contents ?? []) yield o;
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }

  async delete(p: string) {
    const path = normalizePath(p);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(path) }));
    let batch: { Key: string }[] = [];
    const flush = async () => {
      if (!batch.length) return;
      await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch, Quiet: true } }));
      batch = [];
    };
    for await (const o of this.keysUnder(this.key(path) + '/')) {
      batch.push({ Key: o.Key! });
      if (batch.length === 1000) await flush();
    }
    await flush();
  }

  private async copyKey(src: string, dst: string) {
    await this.client.send(
      new CopyObjectCommand({ Bucket: this.bucket, Key: dst, CopySource: `${this.bucket}/${encodeKey(src)}` }),
    );
  }

  /** Server-side copy then delete. (Objects > 5 GB would need UploadPartCopy; see DECISIONS.md.) */
  async move(from: string, to: string) {
    const f = normalizePath(from);
    const t = normalizePath(to);
    const st = await this.stat(f);
    if (!st) throw new NotFoundError(f);
    if (!st.isDir) {
      await this.copyKey(this.key(f), this.key(t));
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(f) }));
      return;
    }
    const srcPrefix = this.key(f) + '/';
    const dstPrefix = this.key(t) + '/';
    const keys: string[] = [];
    for await (const o of this.keysUnder(srcPrefix)) keys.push(o.Key!);
    for (const k of keys) await this.copyKey(k, dstPrefix + k.slice(srcPrefix.length));
    await this.delete(f);
  }

  async mkdir(p: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(p) + '/', Body: '' }));
  }

  presignGet(p: string, ttlSec: number) {
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.bucket, Key: this.key(p) }), { expiresIn: ttlSec });
  }

  presignPut(p: string, ttlSec: number) {
    return getSignedUrl(this.signer, new PutObjectCommand({ Bucket: this.bucket, Key: this.key(p) }), { expiresIn: ttlSec });
  }

  readonly multipart: MultipartOps = {
    init: async (p, meta) => {
      const r = await this.client.send(
        new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: this.key(p), ContentType: meta.mime ?? mimeFor(p) }),
      );
      return { uploadId: r.UploadId! };
    },
    part: async (p, uploadId, partNumber, body, size) => {
      const r = await this.client.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: this.key(p),
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: toNode(body),
          ContentLength: size,
        }),
      );
      return { etag: r.ETag! };
    },
    complete: async (p, uploadId, parts) => {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.key(p),
          UploadId: uploadId,
          MultipartUpload: { Parts: parts.map((x) => ({ PartNumber: x.partNumber, ETag: x.etag })) },
        }),
      );
      const st = await this.stat(p);
      if (!st) throw new NotFoundError(p);
      return st;
    },
    abort: async (p, uploadId) => {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: this.key(p), UploadId: uploadId }));
    },
  };

  async healthCheck() {
    try {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch (e) {
        if (!this.createBucket || !isNotFound(e)) throw e;
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).name + ': ' + (e as Error).message };
    }
  }

  async close() {
    this.client.destroy();
    if (this.signer !== this.client) this.signer.destroy();
  }
}

function isNotFound(e: unknown) {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;
}
