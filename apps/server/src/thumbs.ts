import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { parseStream } from 'music-metadata';
import type { FileStat } from '@stowage/shared';
import { toNode, type EmulatedAdapter } from '@stowage/storage';
import type { AppContext } from './app.js';
import { signToken } from './crypto.js';
import { log } from './log.js';

const has = (bin: string) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).error === undefined;
const tools = { ffmpeg: has('ffmpeg'), ffprobe: has('ffprobe'), pdftoppm: spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).error === undefined };

const MAX_IMAGE = 200 * 1024 * 1024;
const MAX_PDF = 200 * 1024 * 1024;
const NEGATIVE = Buffer.alloc(0);

// Simple semaphore: at most 2 concurrent generations.
let active = 0;
const waiters: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}
const inflight = new Map<string, Promise<Buffer | null>>();

function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()).length > 4000 && (err = err.slice(-4000)));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(t);
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-300)}`));
    });
  });
}

const toWebp = (input: Buffer | import('node:stream').Readable, w: number) => {
  const s = sharp({ limitInputPixels: 268_402_689, failOn: 'none' }).rotate().resize(w, w, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 });
  if (Buffer.isBuffer(input)) return s.end(input), s.toBuffer();
  return input.pipe(s).toBuffer();
};

async function generate(ctx: AppContext, a: EmulatedAdapter, st: FileStat, w: number): Promise<Buffer | null> {
  const mime = st.mime;
  if (mime.startsWith('image/') && mime !== 'image/svg+xml' && st.size <= MAX_IMAGE) {
    return toWebp(toNode(await a.read(st.path)), w);
  }
  if (mime.startsWith('audio/')) {
    const meta = await parseStream(toNode(await a.read(st.path)), { mimeType: mime, size: st.size }, { skipPostHeaders: true });
    const pic = meta.common.picture?.[0];
    return pic ? toWebp(Buffer.from(pic.data), w) : null;
  }
  if (mime.startsWith('video/') && tools.ffmpeg) {
    // ffmpeg reads over HTTP with Range seeks via a short-lived signed URL to ourselves.
    const token = signToken(ctx.cfg.SESSION_SECRET, { m: a.id, p: st.path, e: Date.now() + 120_000 });
    const url = `http://127.0.0.1:${ctx.cfg.PORT}/c/${token}/v`;
    let at = 1;
    if (tools.ffprobe) {
      const d = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url]).catch(() => Buffer.from('0'))).toString());
      if (d > 0) at = d * 0.1;
    }
    const png = await run('ffmpeg', ['-v', 'error', '-ss', at.toFixed(2), '-i', url, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-f', 'image2pipe', '-vcodec', 'png', '-']);
    return toWebp(png, w);
  }
  if (mime === 'application/pdf' && tools.pdftoppm && st.size <= MAX_PDF) {
    const dir = join(tmpdir(), 'stowage-pdf-' + randomUUID());
    await mkdir(dir);
    try {
      await pipeline(toNode(await a.read(st.path)), createWriteStream(join(dir, 'in.pdf')));
      await run('pdftoppm', ['-png', '-f', '1', '-l', '1', '-singlefile', '-scale-to', String(w * 2), join(dir, 'in.pdf'), join(dir, 'out')]);
      return toWebp(await readFile(join(dir, 'out.png')), w);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return null;
}

/** Cached thumbnail keyed by etag/cid. Returns null when no thumbnail can be made. */
export async function thumbnail(ctx: AppContext, a: EmulatedAdapter, st: FileStat, w: number): Promise<Buffer | null> {
  const key = createHash('sha256').update(`${a.id}\0${st.path}\0${st.cid ?? st.etag ?? st.modifiedAt + st.size}\0${w}`).digest('hex');
  const dir = join(ctx.cfg.DATA_DIR, 'thumbs', key.slice(0, 2));
  const file = join(dir, key + '.webp');
  try {
    const s = await fsStat(file);
    return s.size === 0 ? null : await readFile(file);
  } catch {
    /* miss */
  }
  let p = inflight.get(key);
  if (!p) {
    p = slot(async () => {
      let out: Buffer | null = null;
      try {
        out = await generate(ctx, a, st, w);
      } catch (e) {
        log.debug('thumb.failed', { mount: a.id, path: st.path, error: (e as Error).message });
      }
      await mkdir(dir, { recursive: true });
      await writeFile(file, out ?? NEGATIVE);
      return out;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

export const thumbTools = tools;
