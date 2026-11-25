import { Hono, type Context } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { Config } from './config.js';
import { authRoutes, canGoLive, currentCreator, mtxAllows, publicOrigin, sameOrigin, type MtxAuthRequest } from './auth.js';
import { log } from './log.js';
import type { Recorder } from './recorder.js';
import type { Recording, Store } from './store.js';
import type { Supervisor } from './supervisor.js';
import { appJs, pageHtml, type PageView } from './ui.js';

const require = createRequire(import.meta.url);
const HLS_JS = require.resolve('hls.js/dist/hls.min.js');

const csp = (mediaOrigin?: string) => [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `media-src 'self' blob:${mediaOrigin ? ' ' + mediaOrigin : ''}`,
  "worker-src 'self' blob:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export interface ServerDeps {
  store: Store;
  /** Present when LIVE_RECORD is on. */
  recorder?: Recorder;
  /** Random per-process secret in the MediaMTX auth hook URL. */
  hookSecret: string;
}

const publicRecording = (r: Recording) => ({
  id: r.id,
  slug: r.slug,
  handle: r.handle ?? null,
  title: r.title,
  startedAt: r.startedAt,
  durationSec: r.durationSec,
  bytes: r.bytes,
  url: `/rec/${r.id}.mp4`,
  page: `/replay/${r.id}`,
});

/** Stream a local file with HTTP Range support (206), for replays kept on this machine. */
function sendFile(c: Context, file: string, mime: string) {
  const size = statSync(file).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
  const headers = new Headers({ 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' });
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!range[1]) end = size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    start = Math.max(0, start);
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, { status: 206, headers });
  }
  headers.set('Content-Length', String(size));
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers });
}

export function createServer(cfg: Config, sup: Supervisor, deps: ServerDeps) {
  const app = new Hono();
  const { store, recorder } = deps;
  const CSP = csp(recorder?.sink?.origin);
  const page = (c: Context, view: PageView) =>
    c.html(
      pageHtml({
        title: cfg.LIVE_TITLE,
        view,
        boxUrl: cfg.LIVE_BOX_URL,
        tvUrl: cfg.LIVE_TV_URL,
        studio: cfg.bazzy,
        signedIn: Boolean(currentCreator(c, cfg, store)),
      }),
    );

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    if (!c.res.headers.has('Content-Security-Policy')) c.header('Content-Security-Policy', CSP);
  });

  app.get('/healthz', (c) => c.json({ ok: true, encoder: sup.encoder, live: sup.streams().filter((s) => s.status === 'live').length }));

  app.get('/api/streams', (c) =>
    c.json({
      streams: sup.streams().map((s) => ({
        slug: s.slug,
        name: s.name,
        status: s.status,
        startedAt: s.startedAt,
        source: s.source ? `${s.source.width}x${s.source.height}@${Math.round(s.source.fps)}` : null,
        rungs: s.rungs.map((r) => ({ name: r.name, width: r.width, height: r.height, kbps: r.videoKbps + r.audioKbps })),
        master: `/hls/${s.slug}/master.m3u8`,
      })),
    }),
  );

  // HLS: playlists must never be cached (they change every segment); segments are immutable.
  app.get('/hls/:slug/*', (c) => {
    const slug = c.req.param('slug');
    if (!/^[a-z0-9_-]+$/.test(slug)) return c.text('bad stream', 400);
    const rel = c.req.path.slice(`/hls/${slug}/`.length);
    if (!/^[A-Za-z0-9_./-]+$/.test(rel) || rel.includes('..')) return c.text('bad path', 400);
    const base = join(cfg.hlsDir, slug);
    const file = normalize(join(base, rel));
    if (!file.startsWith(base + sep) || !existsSync(file)) return c.text('not found', 404);
    const st = statSync(file);
    if (!st.isFile()) return c.text('not found', 404);
    const playlist = file.endsWith('.m3u8');
    const headers = new Headers({
      'Content-Type': playlist ? 'application/vnd.apple.mpegurl' : file.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream',
      'Content-Length': String(st.size),
      'Cache-Control': playlist ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600, immutable',
      'Access-Control-Allow-Origin': '*',
    });
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers });
  });

  app.get('/static/hls.min.js', (c) => {
    c.header('Cache-Control', 'public, max-age=86400');
    return new Response(Readable.toWeb(createReadStream(HLS_JS)) as ReadableStream, {
      headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
    });
  });
  app.get('/static/app.js', (c) => c.body(appJs, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }));

  app.get('/', (c) => page(c, { kind: 'home' }));
  app.get('/watch/:slug', (c) => {
    const slug = c.req.param('slug');
    if (!/^[a-z0-9_-]+$/.test(slug)) return c.text('bad stream', 400);
    return page(c, { kind: 'watch', slug });
  });

  /* ── MediaMTX asks here before every publish and read ── */
  app.post('/internal/mtx-auth/:secret', async (c) => {
    const secret = c.req.param('secret');
    const ok = secret.length === deps.hookSecret.length && timingSafeEqual(Buffer.from(secret), Buffer.from(deps.hookSecret));
    // Never reachable through the tunnel: Cloudflare adds cf-connecting-ip to everything it forwards.
    if (!ok || c.req.header('cf-connecting-ip')) return c.text('not found', 404);
    const body = (await c.req.json().catch(() => ({}))) as MtxAuthRequest;
    const d = mtxAllows(cfg, store, body);
    if (body.action === 'publish') log[d.ok ? 'info' : 'warn'](d.ok ? 'publish.allowed' : 'publish.denied', { path: body.path, user: body.user, who: d.who, ip: body.ip, protocol: body.protocol });
    return d.ok ? c.body(null, 200) : c.body(null, 401);
  });

  /* ── Sign in with Bazzy TV + Studio ── */
  if (cfg.bazzy) app.route('/', authRoutes(cfg, store));
  app.get('/studio', (c) => page(c, { kind: 'studio' }));

  app.get('/api/me', (c) => {
    c.header('Cache-Control', 'no-store');
    const me = currentCreator(c, cfg, store);
    if (!me) return c.json({ bazzy: cfg.bazzy, signedIn: false });
    const key = store.streamKey(me) ?? '';
    const host = cfg.LIVE_INGEST_HOST === '0.0.0.0' ? new URL(publicOrigin(c, cfg)).hostname : cfg.LIVE_INGEST_HOST;
    const server = cfg.LIVE_RTMP_PUBLIC_URL ?? `rtmp://${host}:${cfg.LIVE_RTMP_PORT}/live`;
    const allowed = canGoLive(cfg, me);
    return c.json({
      bazzy: true,
      signedIn: true,
      name: me.name,
      handle: me.handle,
      canGoLive: allowed,
      watch: `${publicOrigin(c, cfg)}/watch/live-${me.handle}`,
      obs: allowed ? { server, streamKey: `${me.handle}?user=${encodeURIComponent(me.handle)}&pass=${encodeURIComponent(key)}` } : null,
      srt: allowed ? `srt://${host}:${cfg.LIVE_SRT_PORT}?streamid=publish:live/${me.handle}:${me.handle}:${key}` : null,
      recording: Boolean(recorder),
    });
  });

  app.post('/api/me/key', async (c) => {
    if (!sameOrigin(c, cfg)) return c.json({ error: 'forbidden' }, 403);
    const me = currentCreator(c, cfg, store);
    if (!me) return c.json({ error: 'sign in first' }, 401);
    await store.rotateKey(me.sub);
    log.info('studio.key_rotated', { handle: me.handle });
    return c.json({ ok: true });
  });

  /* ── Recordings / replay ── */
  app.get('/api/recordings', (c) => {
    const slug = c.req.query('slug');
    const mine = c.req.query('mine') === '1' ? currentCreator(c, cfg, store) : null;
    let list = store.recordings();
    if (slug) list = list.filter((r) => r.slug === slug);
    if (mine) list = list.filter((r) => r.handle === mine.handle);
    c.header('Cache-Control', 'no-store');
    return c.json({ recording: Boolean(recorder), recordings: list.slice(0, 60).map(publicRecording) });
  });

  app.get('/api/recordings/:id', (c) => {
    const r = store.recording(c.req.param('id'));
    return r ? c.json(publicRecording(r)) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/api/recordings/:id', async (c) => {
    if (!sameOrigin(c, cfg)) return c.json({ error: 'forbidden' }, 403);
    const me = currentCreator(c, cfg, store);
    const r = store.recording(c.req.param('id'));
    if (!r) return c.json({ error: 'not found' }, 404);
    if (!me || r.handle !== me.handle) return c.json({ error: 'only the creator can delete this' }, 403);
    await recorder?.remove(r.id);
    if (!recorder) await store.removeRecording(r.id);
    return c.json({ ok: true });
  });

  app.get('/replay/:id', (c) => {
    const id = c.req.param('id');
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(id) || !store.recording(id)) return c.text('not found', 404);
    return page(c, { kind: 'replay', id });
  });

  app.on(['GET', 'HEAD'], '/rec/:file', async (c) => {
    const id = c.req.param('file').replace(/\.mp4$/, '');
    const r = store.recording(id);
    if (!r) return c.text('not found', 404);
    if (r.storage === 'b2') {
      if (!recorder?.sink) return c.text('replay storage is not configured', 503);
      c.header('Cache-Control', 'private, max-age=300');
      return c.redirect(await recorder.sink.url(r.key, 6 * 3600), 302);
    }
    const file = recorder ? recorder.localFile(r) : '';
    if (!file || !existsSync(file)) return c.text('not found', 404);
    return sendFile(c, file, r.mime);
  });

  return app;
}
