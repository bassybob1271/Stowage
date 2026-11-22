import { randomBytes } from 'node:crypto';
import { mimeFor, normalizePath } from '@stowage/shared';
import { DEFAULT_CAPS, NotFoundError, type FileStat, type StorageAdapter, type WriteMeta } from '../types.js';
import { emptyStream } from '../streams.js';

export interface PinningServiceConfig {
  /** IPFS Pinning Service API base URL, e.g. https://api.pinata.cloud/psa */
  endpoint: string;
  token: string;
  /** If true, a failed remote pin fails the upload. Default false (logged + reported in health). */
  required?: boolean;
}

export interface IpfsConfig {
  /** Kubo RPC base, e.g. http://kubo:5001 (never expose this publicly). */
  apiUrl: string;
  /** Optional HTTP gateway for reads, e.g. http://kubo:8080 */
  gatewayUrl?: string;
  /** MFS directory the mount is rooted at. Default /stowage */
  mfsRoot?: string;
  /** Optional basic-auth / bearer header for the RPC API. */
  authorization?: string;
  pinning?: PinningServiceConfig;
}

interface MfsStat {
  Hash: string;
  Size: number;
  CumulativeSize: number;
  Type: 'file' | 'directory';
  Mtime?: number;
}

class KuboError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`kubo ${status}: ${body}`);
  }
  get notFound() {
    return /does not exist|no link named|not found/i.test(this.body);
  }
}

/** Remote pinning per the IPFS Pinning Service API spec. */
export class PinningServiceClient {
  constructor(private readonly cfg: PinningServiceConfig) {}
  private async req(method: string, path: string, body?: unknown) {
    const res = await fetch(this.cfg.endpoint.replace(/\/$/, '') + path, {
      method,
      headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`pinning service ${res.status}: ${await res.text()}`);
    return res.status === 202 || res.status === 200 ? res.json().catch(() => ({})) : {};
  }
  pin(cid: string, name: string) {
    return this.req('POST', '/pins', { cid, name });
  }
  async unpin(cid: string) {
    const r = (await this.req('GET', `/pins?cid=${encodeURIComponent(cid)}&limit=10`)) as { results?: { requestid: string }[] };
    for (const p of r.results ?? []) await this.req('DELETE', `/pins/${p.requestid}`);
  }
  async health() {
    await this.req('GET', '/pins?limit=1');
  }
}

/**
 * IPFS via the Kubo RPC API. Folder hierarchy lives in MFS under `mfsRoot`;
 * file bytes are added (CIDv1, raw leaves, pinned) and linked into MFS with files/cp.
 * Overwriting a path produces a new CID and repoints the MFS entry.
 */
export class IpfsAdapter implements StorageAdapter {
  readonly kind = 'ipfs' as const;
  readonly capabilities = { ...DEFAULT_CAPS, rename: true, rangeRead: true, contentAddressed: true, versioning: true };
  private readonly api: string;
  private readonly gateway?: string;
  private readonly root: string;
  private readonly pinning?: PinningServiceClient;

  constructor(readonly id: string, private readonly cfg: IpfsConfig) {
    if (!cfg.apiUrl) throw new Error(`ipfs mount ${id}: config.apiUrl is required`);
    this.api = cfg.apiUrl.replace(/\/$/, '') + '/api/v0';
    this.gateway = cfg.gatewayUrl?.replace(/\/$/, '');
    this.root = '/' + normalizePath(cfg.mfsRoot ?? '/stowage');
    if (cfg.pinning) this.pinning = new PinningServiceClient(cfg.pinning);
  }

  private mfs(p: string) {
    const n = normalizePath(p);
    return n ? `${this.root}/${n}` : this.root;
  }

  private async rpc(cmd: string, args: Record<string, string | number | boolean | string[]>, init?: RequestInit): Promise<Response> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) {
      if (Array.isArray(v)) for (const x of v) q.append(k, x);
      else q.append(k, String(v));
    }
    const headers = new Headers(init?.headers);
    if (this.cfg.authorization) headers.set('authorization', this.cfg.authorization);
    const res = await fetch(`${this.api}/${cmd}?${q}`, { method: 'POST', ...init, headers });
    if (!res.ok) throw new KuboError(res.status, await res.text());
    return res;
  }

  private async json<T>(cmd: string, args: Record<string, string | number | boolean | string[]>): Promise<T> {
    return (await this.rpc(cmd, args)).json() as Promise<T>;
  }

  private async ensureRoot() {
    await this.rpc('files/mkdir', { arg: this.root, parents: true });
  }

  private toStat(path: string, s: MfsStat): FileStat {
    const isDir = s.Type === 'directory';
    return {
      path,
      name: path.split('/').pop() ?? '',
      size: isDir ? 0 : s.Size,
      mime: isDir ? 'inode/directory' : mimeFor(path),
      etag: s.Hash,
      cid: s.Hash,
      modifiedAt: new Date((s.Mtime ?? 0) * 1000).toISOString(),
      isDir,
    };
  }

  async list(prefix: string, opts?: { cursor?: string; limit?: number }) {
    const p = normalizePath(prefix);
    await this.ensureRoot();
    let r: { Entries: { Name: string; Type: number; Size: number; Hash: string }[] | null };
    try {
      r = await this.json('files/ls', { arg: this.mfs(p), long: true, U: true });
    } catch (e) {
      if (e instanceof KuboError && e.notFound) return { entries: [] };
      throw e;
    }
    const all = (r.Entries ?? [])
      .map((e) =>
        this.toStat(p ? `${p}/${e.Name}` : e.Name, {
          Hash: e.Hash,
          Size: e.Size,
          CumulativeSize: e.Size,
          Type: e.Type === 1 ? 'directory' : 'file',
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    const start = opts?.cursor ? Number(opts.cursor) : 0;
    const limit = opts?.limit ?? 1000;
    return { entries: all.slice(start, start + limit), cursor: start + limit < all.length ? String(start + limit) : undefined };
  }

  async stat(p: string) {
    const path = normalizePath(p);
    if (path === '') await this.ensureRoot();
    try {
      return this.toStat(path, await this.json<MfsStat>('files/stat', { arg: this.mfs(path) }));
    } catch (e) {
      if (e instanceof KuboError && e.notFound) return null;
      throw e;
    }
  }

  async read(p: string, range?: { start: number; end?: number }) {
    const st = await this.stat(p);
    if (!st || st.isDir) throw new NotFoundError(normalizePath(p));
    if (st.size === 0) return emptyStream();
    if (this.gateway) {
      const headers: Record<string, string> = {};
      if (range) headers.range = `bytes=${range.start}-${range.end ?? ''}`;
      const res = await fetch(`${this.gateway}/ipfs/${st.cid}`, { headers });
      if (res.ok && res.body) return res.body as ReadableStream<Uint8Array>;
      // fall through to RPC on gateway failure
    }
    const args: Record<string, string | number> = { arg: `/ipfs/${st.cid}` };
    if (range) {
      args.offset = range.start;
      if (range.end !== undefined) args.length = range.end - range.start + 1;
    }
    const res = await this.rpc('cat', args);
    return res.body as ReadableStream<Uint8Array>;
  }

  /** Stream a file into `ipfs add` as multipart/form-data without buffering. */
  private async add(body: ReadableStream<Uint8Array>, name: string): Promise<{ Hash: string; Size: string }> {
    const boundary = '----stowage' + randomBytes(12).toString('hex');
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(name)}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);
    const reader = body.getReader();
    let stage = 0;
    const multipart = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (stage === 0) {
          stage = 1;
          c.enqueue(head);
          return;
        }
        if (stage === 1) {
          const { done, value } = await reader.read();
          if (!done) {
            c.enqueue(value);
            return;
          }
          stage = 2;
          c.enqueue(tail);
          return;
        }
        c.close();
      },
      cancel: (r) => reader.cancel(r),
    });
    const res = await this.rpc(
      'add',
      { pin: true, 'cid-version': 1, 'raw-leaves': true, quieter: true },
      {
        body: multipart,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        // @ts-expect-error -- undici requires duplex for streaming request bodies
        duplex: 'half',
      },
    );
    const text = await res.text();
    const last = text.trim().split('\n').pop()!;
    return JSON.parse(last);
  }

  async write(p: string, body: ReadableStream<Uint8Array>, _meta: WriteMeta) {
    const path = normalizePath(p);
    const added = await this.add(body, path.split('/').pop() ?? 'file');
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    await this.rpc('files/mkdir', { arg: this.mfs(parent), parents: true });
    const prev = await this.stat(path);
    if (prev) await this.rpc('files/rm', { arg: this.mfs(path), recursive: true });
    await this.rpc('files/cp', { arg: [`/ipfs/${added.Hash}`, this.mfs(path)] });
    if (this.pinning) {
      try {
        await this.pinning.pin(added.Hash, path);
      } catch (e) {
        if (this.cfg.pinning?.required) throw e;
        console.warn(`[ipfs:${this.id}] remote pin failed for ${added.Hash}:`, (e as Error).message);
      }
    }
    const st = await this.stat(path);
    if (!st) throw new Error(`write succeeded but stat failed for ${path}`);
    return st;
  }

  async delete(p: string) {
    const path = normalizePath(p);
    const st = await this.stat(path);
    if (!st) return;
    await this.rpc('files/rm', { arg: this.mfs(path), recursive: true });
    // Content stays retrievable by CID until GC; we only drop our own pin.
    if (!st.isDir) {
      await this.rpc('pin/rm', { arg: st.cid! }).catch(() => {});
      await this.pinning?.unpin(st.cid!).catch(() => {});
    }
  }

  async move(from: string, to: string) {
    const t = normalizePath(to);
    const parent = t.includes('/') ? t.slice(0, t.lastIndexOf('/')) : '';
    await this.rpc('files/mkdir', { arg: this.mfs(parent), parents: true });
    try {
      await this.rpc('files/mv', { arg: [this.mfs(from), this.mfs(t)] });
    } catch (e) {
      if (e instanceof KuboError && e.notFound) throw new NotFoundError(normalizePath(from));
      throw e;
    }
  }

  async mkdir(p: string) {
    await this.rpc('files/mkdir', { arg: this.mfs(p), parents: true });
  }

  async healthCheck() {
    try {
      const id = await this.json<{ ID: string; AgentVersion: string }>('id', {});
      if (this.pinning) {
        try {
          await this.pinning.health();
        } catch (e) {
          return { ok: true, detail: `${id.AgentVersion}; remote pinning unreachable: ${(e as Error).message}` };
        }
      }
      return { ok: true, detail: id.AgentVersion };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
