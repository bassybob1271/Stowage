/**
 * Small JSON-file store for creators and recordings (LIVE_DATA_DIR/state.json).
 * Bazzy Live has a handful of creators and a few recordings a day, so a file written atomically
 * (temp + rename) after each change is enough; no database to run.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Creator {
  /** Bazzy TV account id (OAuth `sub`). */
  sub: string;
  /** Channel name: streams publish to live/<handle> and play at /watch/live-<handle>. */
  handle: string;
  name: string;
  email?: string;
  role?: string;
  /** Stream key, AES-256-GCM encrypted (base64url iv.tag.data). */
  key: string;
  createdAt: string;
}

export interface Recording {
  id: string;
  /** MediaMTX path, e.g. live/bob */
  path: string;
  /** Watch slug, e.g. live-bob */
  slug: string;
  /** Creator handle when the path belongs to one. */
  handle?: string;
  title: string;
  startedAt: string;
  durationSec: number;
  bytes: number;
  mime: string;
  /** Where the file lives: an object key in the B2 bucket, or a path under the local recordings dir. */
  storage: 'b2' | 'local';
  key: string;
  /** Local source file (relative to the recordings dir), so the scanner never handles it twice. */
  src: string;
  createdAt: string;
}

interface State {
  creators: Creator[];
  recordings: Recording[];
  /** Local files already handled that have no recording entry (too short, or deleted). */
  skipped: string[];
}

const RESERVED = new Set(['admin', 'api', 'hls', 'live', 'publisher', 'static', 'studio', 'replay', 'replays', 'rec', 'watch', 'auth', 'bazzy', 'all', 'internal']);

export function handleFrom(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    const h = (c ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/@.*$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/, '');
    if (h.length >= 3) return h;
  }
  return 'creator';
}

export const newStreamKey = () => randomBytes(18).toString('base64url');
export const newId = () => randomBytes(9).toString('base64url');

export class Store {
  private state: State = { creators: [], recordings: [], skipped: [] };
  private queue: Promise<void> = Promise.resolve();
  private readonly aes?: Buffer;

  constructor(
    private readonly file: string,
    secret?: string,
    private readonly reservedHandles: string[] = [],
  ) {
    if (secret) this.aes = createHash('sha256').update(`bazzy-live/stream-key/${secret}`).digest();
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<State>;
      this.state = { creators: raw.creators ?? [], recordings: raw.recordings ?? [], skipped: raw.skipped ?? [] };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return this;
  }

  private save() {
    const data = JSON.stringify(this.state, null, 1);
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.queue;
  }

  /* ── stream keys ── */
  private seal(key: string) {
    if (!this.aes) throw new Error('LIVE_SESSION_SECRET is not set');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.aes, iv);
    const data = Buffer.concat([c.update(key, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
  }

  private open(sealed: string): string | null {
    if (!this.aes) return null;
    try {
      const [iv, tag, data] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
      const d = createDecipheriv('aes-256-gcm', this.aes, iv!);
      d.setAuthTag(tag!);
      return Buffer.concat([d.update(data!), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  streamKey(c: Creator) {
    return this.open(c.key);
  }

  /** Constant-time check of a presented stream key. */
  checkKey(c: Creator, presented: string) {
    const real = this.open(c.key);
    if (!real || !presented) return false;
    const a = createHash('sha256').update(real).digest();
    const b = createHash('sha256').update(presented).digest();
    return timingSafeEqual(a, b);
  }

  /* ── creators ── */
  creatorBySub(sub: string) {
    return this.state.creators.find((c) => c.sub === sub);
  }

  creatorByHandle(handle: string) {
    return this.state.creators.find((c) => c.handle === handle);
  }

  /** Find or create the creator for a Bazzy TV account; profile fields are refreshed on every sign-in. */
  async upsertCreator(p: { sub: string; name?: string; email?: string; role?: string }) {
    const existing = this.creatorBySub(p.sub);
    if (existing) {
      existing.name = p.name || existing.name;
      existing.email = p.email ?? existing.email;
      existing.role = p.role ?? existing.role;
      await this.save();
      return existing;
    }
    const base = handleFrom(p.name, p.email);
    let handle = base;
    for (let i = 2; RESERVED.has(handle) || this.reservedHandles.includes(handle) || this.creatorByHandle(handle); i++) handle = `${base}-${i}`;
    const c: Creator = {
      sub: p.sub,
      handle,
      name: p.name || handle,
      email: p.email,
      role: p.role,
      key: this.seal(newStreamKey()),
      createdAt: new Date().toISOString(),
    };
    this.state.creators.push(c);
    await this.save();
    return c;
  }

  async rotateKey(sub: string) {
    const c = this.creatorBySub(sub);
    if (!c) return null;
    c.key = this.seal(newStreamKey());
    await this.save();
    return c;
  }

  /* ── recordings ── */
  recordings() {
    return [...this.state.recordings].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  recording(id: string) {
    return this.state.recordings.find((r) => r.id === id);
  }

  handled(src: string) {
    return this.state.skipped.includes(src) || this.state.recordings.some((r) => r.src === src);
  }

  async addRecording(r: Recording) {
    this.state.recordings.push(r);
    await this.save();
  }

  async skip(src: string) {
    this.state.skipped.push(src);
    if (this.state.skipped.length > 5000) this.state.skipped.splice(0, 1000);
    await this.save();
  }

  async removeRecording(id: string) {
    const i = this.state.recordings.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const [r] = this.state.recordings.splice(i, 1);
    this.state.skipped.push(r!.src);
    await this.save();
    return r!;
  }

  async flush() {
    await this.queue;
  }
}
