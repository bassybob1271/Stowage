/**
 * Recordings: MediaMTX writes each show's original feed to LIVE_DATA_DIR/recordings/<path>/<start>.mp4
 * (fragmented MP4, split every LIVE_RECORD_SEGMENT). Every 20 s this looks for finished files,
 * reads their length with ffprobe, uploads them to Bazzy Live's Backblaze B2 bucket and lists them
 * for replay. Without B2 they stay on this machine and are served from here.
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from './config.js';
import { log } from './log.js';
import { newId, type Recording, type Store } from './store.js';
import { slugOf } from './supervisor.js';

/** A file is finished once MediaMTX hasn't touched it for this long (it appends every second while recording). */
const SETTLE_MS = 45_000;
/** Shorter recordings (a test connect, an OBS hiccup) are dropped. */
const MIN_SECONDS = 10;

export interface RecordingSink {
  put(key: string, file: string, mime: string): Promise<void>;
  url(key: string, ttlSec: number): Promise<string>;
  remove(key: string): Promise<void>;
  /** Origin to allow in the page CSP (media-src), when replays play straight from the bucket. */
  origin?: string;
}

export function b2Sink(cfg: Config): RecordingSink {
  const endpoint = cfg.LIVE_B2_ENDPOINT!;
  const s3 = new S3Client({
    endpoint,
    // B2's region is the middle of the endpoint host: s3.<region>.backblazeb2.com
    region: cfg.LIVE_B2_REGION || /s3\.([a-z0-9-]+)\./.exec(new URL(endpoint).host)?.[1] || 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.LIVE_B2_KEY_ID!, secretAccessKey: cfg.LIVE_B2_APP_KEY! },
  });
  const Bucket = cfg.LIVE_B2_BUCKET!;
  return {
    origin: new URL(endpoint).origin,
    async put(Key, file, ContentType) {
      await new Upload({
        client: s3,
        params: { Bucket, Key, Body: createReadStream(file), ContentType, CacheControl: 'public, max-age=31536000, immutable' },
        partSize: 64 * 1024 * 1024,
        queueSize: 3,
      }).done();
    },
    url: (Key, expiresIn) => getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn }),
    async remove(Key) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key }));
    },
  };
}

/** Seconds of media in a file, via ffprobe (0 when unreadable). */
export function probeDuration(ffprobe: string, file: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 60_000 });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(0));
    p.on('close', () => resolve(Math.max(0, Number.parseFloat(out.trim())) || 0));
  });
}

/** "2026-11-25_21-04-05-123456" → ISO time (MediaMTX names files after the local start time). */
export function startedAtFromName(name: string, fallback: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return fallback.toISOString();
  const d = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  return Number.isNaN(d.getTime()) ? fallback.toISOString() : d.toISOString();
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile() && e.name.endsWith('.mp4')) out.push(p);
  }
  return out;
}

export class Recorder {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly livePaths: () => Set<string>,
    readonly sink?: RecordingSink,
    private readonly probe: (file: string) => Promise<number> = (f) => probeDuration(join(cfg.binDir, 'ffprobe'), f),
  ) {}

  start() {
    this.timer ??= setInterval(() => void this.scan(), 20_000);
    void this.scan();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over the recordings folder. Safe to call any time; overlapping calls are skipped. */
  async scan(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const files = await walk(this.cfg.recordDir);
      const live = this.livePaths();
      // The newest file of a path that is still live may just be paused: leave it alone.
      const newest = new Map<string, string>();
      for (const f of files) {
        const dir = relative(this.cfg.recordDir, f).split(sep).slice(0, -1).join('/');
        if (!newest.has(dir) || f > newest.get(dir)!) newest.set(dir, f);
      }
      for (const file of files.sort()) {
        const src = relative(this.cfg.recordDir, file).split(sep).join('/');
        if (this.store.handled(src)) continue;
        const path = src.split('/').slice(0, -1).join('/');
        if (live.has(path) && newest.get(path) === file) continue;
        const st = await stat(file).catch(() => null);
        if (!st || now - st.mtimeMs < SETTLE_MS) continue;
        await this.finish(file, src, path, st.size, st.mtime).catch((e) => log.warn('record.failed', { src, error: (e as Error).message }));
      }
    } finally {
      this.busy = false;
    }
  }

  private async finish(file: string, src: string, path: string, bytes: number, mtime: Date) {
    const durationSec = Math.round(await this.probe(file));
    if (durationSec < MIN_SECONDS) {
      await this.store.skip(src);
      await rm(file, { force: true });
      log.info('record.dropped', { src, durationSec });
      return;
    }
    const slug = slugOf(path);
    const handle = path.startsWith('live/') ? path.slice(5) : undefined;
    const creator = handle ? this.store.creatorByHandle(handle) : undefined;
    const startedAt = startedAtFromName(src.split('/').pop()!, mtime);
    const id = newId();
    const name = src.split('/').pop()!;
    let storage: Recording['storage'] = 'local';
    let key = src;
    if (this.sink) {
      key = `${this.cfg.LIVE_B2_PREFIX}${slug}/${name}`;
      const t0 = Date.now();
      await this.sink.put(key, file, 'video/mp4');
      storage = 'b2';
      log.info('record.uploaded', { key, bytes, ms: Date.now() - t0 });
    }
    await this.store.addRecording({
      id,
      path,
      slug,
      handle: creator?.handle,
      title: creator?.name ?? path.replace(/^live\//, ''),
      startedAt,
      durationSec,
      bytes,
      mime: 'video/mp4',
      storage,
      key,
      src,
      createdAt: new Date().toISOString(),
    });
    if (storage === 'b2' && !this.cfg.LIVE_RECORD_KEEP_LOCAL) await rm(file, { force: true });
    log.info('record.saved', { id, path, durationSec, storage });
  }

  /** Delete a recording everywhere. */
  async remove(id: string) {
    const r = await this.store.removeRecording(id);
    if (!r) return false;
    if (r.storage === 'b2' && this.sink) await this.sink.remove(r.key).catch((e) => log.warn('record.remove_failed', { id, error: (e as Error).message }));
    await rm(join(this.cfg.recordDir, r.src), { force: true });
    return true;
  }

  localFile(r: Recording) {
    return join(this.cfg.recordDir, r.src);
  }
}
