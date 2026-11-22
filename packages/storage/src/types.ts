import type { AdapterKind, Capabilities, FileStat, ListResult } from '@stowage/shared';

export type { AdapterKind, Capabilities, FileStat, ListResult };

export interface ByteRange {
  start: number;
  /** Inclusive end offset. Omitted = to end of file. */
  end?: number;
}

export interface WriteMeta {
  size?: number;
  mime?: string;
}

export interface MultipartOps {
  init(path: string, meta: WriteMeta): Promise<{ uploadId: string }>;
  part(path: string, uploadId: string, partNumber: number, body: ReadableStream<Uint8Array>, size: number): Promise<{ etag: string }>;
  complete(path: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<FileStat>;
  abort(path: string, uploadId: string): Promise<void>;
}

export interface StorageAdapter {
  readonly id: string;
  readonly kind: AdapterKind;
  readonly capabilities: Capabilities;

  list(prefix: string, opts?: { cursor?: string; limit?: number }): Promise<ListResult>;
  stat(path: string): Promise<FileStat | null>;
  read(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>>;
  write(path: string, body: ReadableStream<Uint8Array>, meta: WriteMeta): Promise<FileStat>;
  delete(path: string): Promise<void>;
  move?(from: string, to: string): Promise<void>;
  mkdir?(path: string): Promise<void>;
  presignGet?(path: string, ttlSec: number): Promise<string>;
  presignPut?(path: string, ttlSec: number): Promise<string>;
  multipart?: MultipartOps;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
  /** Optional cleanup (close connections). */
  close?(): Promise<void>;
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(path: string) {
    super(`not found: ${path}`);
    this.name = 'NotFoundError';
  }
}

export class ReadOnlyError extends Error {
  readonly status = 403;
  constructor(id: string) {
    super(`mount ${id} is read-only`);
    this.name = 'ReadOnlyError';
  }
}

export class UnsupportedError extends Error {
  readonly status = 501;
  constructor(op: string, kind: string) {
    super(`${op} is not supported by ${kind} adapter`);
    this.name = 'UnsupportedError';
  }
}

export const DEFAULT_CAPS: Capabilities = {
  list: true,
  rename: false,
  delete: true,
  rangeRead: false,
  multipartUpload: false,
  presignedUrls: false,
  contentAddressed: false,
  versioning: false,
};
