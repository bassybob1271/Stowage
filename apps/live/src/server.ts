import { Hono } from 'hono';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { Config } from './config.js';
import type { Supervisor } from './supervisor.js';
import { appJs, pageHtml } from './ui.js';

const require = createRequire(import.meta.url);
const HLS_JS = require.resolve('hls.js/dist/hls.min.js');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function createServer(cfg: Config, sup: Supervisor) {
  const app = new Hono();

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

  app.get('/', (c) => c.html(pageHtml({ title: cfg.LIVE_TITLE, slug: null, boxUrl: cfg.LIVE_BOX_URL })));
  app.get('/watch/:slug', (c) => {
    const slug = c.req.param('slug');
    if (!/^[a-z0-9_-]+$/.test(slug)) return c.text('bad stream', 400);
    return c.html(pageHtml({ title: cfg.LIVE_TITLE, slug, boxUrl: cfg.LIVE_BOX_URL }));
  });

  return app;
}
