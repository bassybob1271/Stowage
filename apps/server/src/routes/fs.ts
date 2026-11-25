import { Hono, type Context } from 'hono';
import { Readable } from 'node:stream';
import archiver from 'archiver';
import Busboy from 'busboy';
import { basename, joinPath, mimeFor, moveSchema, mkdirSchema, normalizePath, PathError } from '@stowage/shared';
import { NotFoundError, toNode, toWeb, type EmulatedAdapter } from '@stowage/storage';
import { resolveMount, type AppContext } from '../app.js';
import { accountIdOf } from '../box/service.js';
import { indexListing, unindex } from '../db/index.js';
import { serveFile, isActiveContent, contentDisposition } from '../serve.js';
import { signToken } from '../crypto.js';
import { thumbnail } from '../thumbs.js';
import { log } from '../log.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function fsRoutes(ctx: AppContext) {
  const app = new Hono();

  const mountOf = (c: Context): EmulatedAdapter => {
    const m = resolveMount(ctx, c.get('user' as never) as string | undefined, c.req.param('mount') ?? '');
    if (!m) throw new HttpError(404, 'unknown mount');
    return m.adapter;
  };
  /** BazzyBox account behind this request, if any (quota checks and usage recounts). */
  const account = (c: Context) => (ctx.box ? accountIdOf(c.get('user' as never) as string | undefined) : null);
  const touched = (c: Context) => {
    const id = account(c);
    if (id) ctx.box!.scheduleUsage(id);
  };
  const quota = async (c: Context, bytes: number) => {
    const id = account(c);
    if (id) await ctx.box!.checkUpload(id, bytes);
  };
  const q = (c: Context, k = 'path') => normalizePath(c.req.query(k) ?? '');

  app.get('/:mount/list', async (c) => {
    const a = mountOf(c);
    const path = q(c);
    const res = await a.list(path, { cursor: c.req.query('cursor'), limit: Number(c.req.query('limit') ?? 1000) });
    if (!res.entries.length && path) {
      const st = await a.stat(path);
      if (!st) throw new NotFoundError(path);
      if (!st.isDir) throw new HttpError(400, 'not a directory');
    }
    // Refresh the metadata cache; the adapter stays the source of truth.
    indexListing(ctx.db, a.id, path, res.entries, !c.req.query('cursor') && !res.cursor).catch((e) =>
      log.warn('index.failed', { mount: a.id, error: (e as Error).message }),
    );
    return c.json(res);
  });

  app.get('/:mount/stat', async (c) => {
    const st = await mountOf(c).stat(q(c));
    if (!st) throw new NotFoundError(q(c));
    return c.json(st);
  });

  const raw = (download: boolean) => async (c: Context) => {
    const a = mountOf(c);
    const st = await a.stat(q(c));
    if (!st) throw new NotFoundError(q(c));
    if (st.isDir) throw new HttpError(400, 'is a directory');
    // Direct transfer: let the browser fetch straight from the object store
    // (a different origin, so active content can't touch ours).
    if (ctx.cfg.DIRECT_TRANSFER && a.presignGet && !isActiveContent(st.mime) && !c.req.header('range')) {
      return c.redirect(await a.presignGet(st.path, 300), 302);
    }
    return serveFile(c, a, st, { download });
  };
  app.on(['GET', 'HEAD'], '/:mount/raw', raw(false));
  /**
   * Path-style alias of /raw: /api/fs/:mount/file/<path>. Relative URLs inside
   * the file resolve to siblings, which HLS playlists (.m3u8 → segments) need.
   */
  app.on(['GET', 'HEAD'], '/:mount/file/*', async (c) => {
    const a = mountOf(c);
    const prefix = `/api/fs/${c.req.param('mount')}/file/`;
    const rawPath = new URL(c.req.url).pathname;
    const path = normalizePath(decodeURIComponent(rawPath.slice(rawPath.indexOf(prefix) + prefix.length)));
    const st = await a.stat(path);
    if (!st || st.isDir) throw new NotFoundError(path);
    return serveFile(c, a, st);
  });
  app.on(['GET', 'HEAD'], '/:mount/download', raw(true));

  /** Short-lived, cookie-less URL on CONTENT_ORIGIN (or same origin) for opening a file in a new tab. */
  app.get('/:mount/link', async (c) => {
    const a = mountOf(c);
    const path = q(c);
    const token = signToken(ctx.cfg.SESSION_SECRET, { m: a.id, p: path, e: Date.now() + 3600_000 });
    const base = ctx.cfg.CONTENT_ORIGIN ?? '';
    return c.json({ url: `${base}/c/${token}/${encodeURIComponent(basename(path))}` });
  });

  app.get('/:mount/zip', async (c) => {
    const a = mountOf(c);
    const paths = (c.req.queries('paths[]') ?? c.req.queries('paths') ?? []).map(normalizePath);
    if (!paths.length) throw new HttpError(400, 'paths[] required');
    const zip = archiver('zip', { zlib: { level: 1 } });
    zip.on('warning', (e) => log.warn('zip.warning', { error: e.message }));
    zip.on('error', (e) => log.error('zip.error', { error: e.message }));
    (async () => {
      try {
        for (const p of paths) {
          const st = await a.stat(p);
          if (!st) continue;
          const root = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
          if (!st.isDir) {
            zip.append(toNode(await a.read(p)), { name: p.slice(root.length), date: new Date(st.modifiedAt) });
            continue;
          }
          for await (const e of a.walk(p)) {
            const name = e.path.slice(root.length);
            if (e.isDir) zip.append('', { name: name + '/' });
            // Wait for each entry so only one upstream stream is open at a time.
            else
              await new Promise<void>(async (res, rej) => {
                try {
                  const s = toNode(await a.read(e.path));
                  s.on('end', res).on('error', rej);
                  zip.append(s, { name, date: new Date(e.modifiedAt) });
                } catch (err) {
                  rej(err);
                }
              });
          }
        }
        await zip.finalize();
      } catch (e) {
        zip.abort();
        log.error('zip.failed', { error: (e as Error).message });
      }
    })();
    const name = paths.length === 1 ? `${basename(paths[0]!) || a.id}.zip` : `${a.id}-files.zip`;
    return new Response(toWeb(zip as unknown as Readable), {
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': contentDisposition('attachment', name), 'X-Content-Type-Options': 'nosniff' },
    });
  });

  /**
   * Streamed upload. Either multipart/form-data (fields before files:
   * `dir`; each file part's filename is joined to it — use relative paths
   * for folder uploads), or a raw body with ?path=.
   */
  app.post('/:mount/upload', async (c) => {
    const a = mountOf(c);
    const max = ctx.cfg.MAX_UPLOAD_BYTES;
    const type = c.req.header('content-type') ?? '';
    const body = c.req.raw.body;
    if (!body) throw new HttpError(400, 'empty body');

    if (!type.startsWith('multipart/form-data')) {
      const path = q(c);
      if (!path) throw new HttpError(400, 'path required');
      const len = Number(c.req.header('content-length') ?? NaN);
      if (max && len > max) throw new HttpError(413, 'file too large');
      await quota(c, Number.isFinite(len) ? len : 0);
      const st = await a.write(path, body, { size: Number.isFinite(len) ? len : undefined, mime: mimeFor(path) });
      await indexListing(ctx.db, a.id, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', [st], false);
      touched(c);
      return c.json({ files: [st] }, 201);
    }

    // Multipart sizes aren't known up front; the whole request length is the upper bound.
    await quota(c, Number(c.req.header('content-length') ?? 0) || 0);
    const results: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const bb = Busboy({ headers: { 'content-type': type }, limits: max ? { fileSize: max } : undefined, preservePath: true });
      let dir = q(c, 'dir');
      let chain = Promise.resolve();
      bb.on('field', (name, val) => {
        if (name === 'dir') dir = normalizePath(val);
      });
      bb.on('file', (_field, stream, info) => {
        const target = joinPath(dir, normalizePath(info.filename));
        if (!basename(target)) {
          stream.resume();
          return;
        }
        let truncated = false;
        stream.on('limit', () => (truncated = true));
        // Each file must be consumed before busboy continues; writes run in order.
        chain = chain.then(async () => {
          const st = await a.write(target, toWeb(stream), { mime: mimeFor(target) });
          if (truncated) {
            await a.delete(target);
            throw new HttpError(413, `${info.filename} exceeds MAX_UPLOAD_BYTES`);
          }
          results.push(st);
        });
        chain.catch(() => stream.resume());
      });
      bb.on('close', () => chain.then(resolve, reject));
      bb.on('error', reject);
      Readable.fromWeb(body as import('node:stream/web').ReadableStream).pipe(bb);
    });
    touched(c);
    return c.json({ files: results }, 201);
  });

  app.post('/:mount/mkdir', async (c) => {
    const a = mountOf(c);
    const { path } = mkdirSchema.parse(await c.req.json());
    await a.mkdir(path);
    touched(c);
    return c.json({ ok: true }, 201);
  });

  app.post('/:mount/move', async (c) => {
    const a = mountOf(c);
    const { from, to } = moveSchema.parse(await c.req.json());
    if (await a.stat(to)) throw new HttpError(409, 'destination exists');
    await a.move(from, to);
    await unindex(ctx.db, a.id, normalizePath(from));
    return c.json({ ok: true });
  });

  app.delete('/:mount', async (c) => {
    const a = mountOf(c);
    const path = q(c);
    if (!path) throw new PathError('refusing to delete mount root');
    await a.delete(path);
    await unindex(ctx.db, a.id, path);
    touched(c);
    return c.json({ ok: true });
  });

  app.get('/:mount/thumb', async (c) => {
    const a = mountOf(c);
    const st = await a.stat(q(c));
    if (!st || st.isDir) throw new NotFoundError(q(c));
    const w = Math.min(1024, Math.max(32, Number(c.req.query('w') ?? 256) || 256));
    const t = await thumbnail(ctx, a, st, w);
    if (!t) return c.body(null, 204);
    return new Response(new Uint8Array(t), {
      headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' },
    });
  });

  app.get('/:mount/presign', async (c) => {
    const a = mountOf(c);
    const op = c.req.query('op') ?? 'get';
    const path = q(c);
    if (!ctx.cfg.DIRECT_TRANSFER) throw new HttpError(403, 'DIRECT_TRANSFER is disabled');
    if (op === 'get' && a.presignGet) return c.json({ url: await a.presignGet(path, 300) });
    if (op === 'put' && a.presignPut) return c.json({ url: await a.presignPut(path, 900) });
    throw new HttpError(501, `presign ${op} not supported by ${a.kind}`);
  });

  return app;
}

export { HttpError };
