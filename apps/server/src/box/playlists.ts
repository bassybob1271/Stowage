/**
 * BazzyBox Playlist Maker.
 *
 * Owners build playlists from audio and video in their own folder, add a cover picture and
 * share one public link. The link opens a player page (/p/:token) anyone can use; streamed
 * bytes count against the owner's send allowance, exactly like a share link.
 *
 * Owner API (signed in, under /api/box/playlists):
 *   GET    /                      list
 *   POST   /                      create {title, description?, items?}
 *   GET    /:id                   one playlist with its tracks
 *   PATCH  /:id                   {title?, description?, items?}
 *   DELETE /:id
 *   PUT    /:id/cover             raw JPEG/PNG/WebP body (≤ 1.5 MB; the web app resizes first)
 *   DELETE /:id/cover
 *   GET    /:id/cover
 *   POST   /:id/share             turn the public link on → {url}
 *   DELETE /:id/share             turn it off (the old link stops working)
 *
 * Public: GET /p/:token (player page), /p/:token/cover, /p/:token/t/:index/:name (Range), /p.js
 */
import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { mimeFor, normalizePath } from '@stowage/shared';
import type { AppContext } from '../app.js';
import { parseRange, serveFile } from '../serve.js';
import { log } from '../log.js';
import { BoxError, accountIdOf, type BoxService } from './service.js';
import { SITE_CSP } from './site.js';

export const MAX_ITEMS = 200;
export const MAX_COVER_BYTES = 1_500_000;
const VIDEO_OK = new Set(['video/mp4', 'video/x-m4v', 'video/webm', 'video/quicktime', 'video/ogg']);

/** Audio of any kind, plus the video formats browsers can play. */
export function playableKind(path: string): 'audio' | 'video' | null {
  const m = mimeFor(path);
  if (m.startsWith('audio/')) return 'audio';
  if (VIDEO_OK.has(m)) return 'video';
  return null;
}

/** "02 - Night Drive (mix 3).wav" → "02 - Night Drive (mix 3)" */
export const trackTitle = (path: string) => {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};

function coverType(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

const createSchema = z.object({
  title: z.string().trim().min(1, 'give the playlist a name').max(120),
  description: z.string().trim().max(1000).default(''),
  items: z.array(z.string().min(1).max(1024)).max(MAX_ITEMS).default([]),
});
const patchSchema = createSchema.partial();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const parseItems = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export function playlistRoutes(ctx: AppContext, box: BoxService) {
  const app = new Hono();
  const t = ctx.db.t.playlists;
  const orm = ctx.db.orm;

  const me = (c: Context) => {
    const id = accountIdOf(c.get('user' as never) as string | undefined);
    if (!id) throw new BoxError(403, 'sign in with a BazzyBox account');
    return id;
  };
  const wrap = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof BoxError) return c.json({ error: e.message, code: e.code }, e.status as 400);
      if (e instanceof z.ZodError) return c.json({ error: e.issues[0]?.message ?? 'invalid request' }, 400);
      throw e;
    }
  };
  const own = async (c: Context) => {
    const [p] = await orm.select().from(t).where(and(eq(t.id, c.req.param('id') ?? ''), eq(t.accountId, me(c))));
    if (!p) throw new BoxError(404, 'playlist not found');
    return p;
  };

  /** Normalize, de-duplicate and check every path: it must exist in the owner's folder and be playable. */
  const checkItems = async (account: string, items: string[]) => {
    const seen = new Set<string>();
    const paths = items.map((p) => normalizePath(p)).filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
    const a = box.mountFor(account).adapter;
    const stats = await Promise.all(paths.map((p) => a.stat(p).catch(() => null)));
    paths.forEach((p, i) => {
      const st = stats[i];
      if (!st || st.isDir) throw new BoxError(400, `“${trackTitle(p)}” isn’t in your BazzyBox anymore`);
      if (!playableKind(p)) throw new BoxError(400, `“${st.name}” isn’t an audio or video file a browser can play`);
    });
    return paths;
  };

  const shareUrl = (c: Context, token: string | null) =>
    token ? `${(ctx.cfg.APP_ORIGIN ?? new URL(c.req.url).origin).replace(/\/$/, '')}/p/${token}` : null;

  const view = (c: Context, p: typeof t.$inferSelect) => {
    const items = parseItems(p.items);
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      tracks: items.map((path) => ({ path, title: trackTitle(path), kind: playableKind(path) })),
      hasCover: Boolean(p.cover),
      coverUrl: p.cover ? `/api/box/playlists/${p.id}/cover?v=${encodeURIComponent(p.updatedAt)}` : null,
      shareUrl: shareUrl(c, p.shareToken),
      views: p.plays,
      updatedAt: p.updatedAt,
    };
  };

  app.get(
    '/',
    wrap(async (c) => {
      const rows = await orm.select().from(t).where(eq(t.accountId, me(c))).orderBy(desc(t.updatedAt));
      return c.json({ playlists: rows.map((p) => view(c, p)) });
    }),
  );

  app.post(
    '/',
    wrap(async (c) => {
      const account = me(c);
      const body = createSchema.parse(await c.req.json().catch(() => ({})));
      const count = (await orm.select({ id: t.id }).from(t).where(eq(t.accountId, account))).length;
      if (count >= 500) throw new BoxError(400, 'you have reached 500 playlists');
      const now = new Date().toISOString();
      const row = {
        id: randomBytes(9).toString('base64url'),
        accountId: account,
        title: body.title,
        description: body.description,
        items: JSON.stringify(await checkItems(account, body.items)),
        cover: null,
        coverType: null,
        shareToken: null,
        plays: 0,
        createdAt: now,
        updatedAt: now,
      };
      await orm.insert(t).values(row);
      log.info('box.playlist_create', { account, playlist: row.id });
      return c.json(view(c, row), 201);
    }),
  );

  app.get('/:id', wrap(async (c) => c.json(view(c, await own(c)))));

  app.patch(
    '/:id',
    wrap(async (c) => {
      const p = await own(c);
      const body = patchSchema.parse(await c.req.json().catch(() => ({})));
      const set: Partial<typeof t.$inferInsert> = { updatedAt: new Date().toISOString() };
      if (body.title !== undefined) set.title = body.title;
      if (body.description !== undefined) set.description = body.description;
      if (body.items !== undefined) set.items = JSON.stringify(await checkItems(p.accountId, body.items));
      await orm.update(t).set(set).where(eq(t.id, p.id));
      return c.json(view(c, { ...p, ...set } as typeof p));
    }),
  );

  app.delete(
    '/:id',
    wrap(async (c) => {
      const p = await own(c);
      await orm.delete(t).where(eq(t.id, p.id));
      return c.json({ ok: true });
    }),
  );

  app.put(
    '/:id/cover',
    wrap(async (c) => {
      const p = await own(c);
      const len = Number(c.req.header('content-length') ?? 0);
      if (len > MAX_COVER_BYTES) throw new BoxError(413, 'cover picture is too large (1.5 MB max)');
      const buf = Buffer.from(await c.req.arrayBuffer());
      if (buf.length > MAX_COVER_BYTES) throw new BoxError(413, 'cover picture is too large (1.5 MB max)');
      const type = coverType(buf);
      if (!type) throw new BoxError(415, 'use a JPEG, PNG or WebP picture');
      const set = { cover: buf.toString('base64'), coverType: type, updatedAt: new Date().toISOString() };
      await orm.update(t).set(set).where(eq(t.id, p.id));
      return c.json(view(c, { ...p, ...set }));
    }),
  );

  app.delete(
    '/:id/cover',
    wrap(async (c) => {
      const p = await own(c);
      const set = { cover: null, coverType: null, updatedAt: new Date().toISOString() };
      await orm.update(t).set(set).where(eq(t.id, p.id));
      return c.json(view(c, { ...p, ...set }));
    }),
  );

  app.get(
    '/:id/cover',
    wrap(async (c) => {
      const p = await own(c);
      if (!p.cover || !p.coverType) return c.text('no cover', 404);
      c.header('Content-Type', p.coverType);
      c.header('Cache-Control', 'private, max-age=86400');
      return c.body(Buffer.from(p.cover, 'base64'));
    }),
  );

  app.post(
    '/:id/share',
    wrap(async (c) => {
      const p = await own(c);
      const token = p.shareToken ?? randomBytes(15).toString('base64url');
      if (!p.shareToken) await orm.update(t).set({ shareToken: token, updatedAt: new Date().toISOString() }).where(eq(t.id, p.id));
      return c.json({ url: shareUrl(c, token) });
    }),
  );

  app.delete(
    '/:id/share',
    wrap(async (c) => {
      const p = await own(c);
      await orm.update(t).set({ shareToken: null, updatedAt: new Date().toISOString() }).where(eq(t.id, p.id));
      return c.json({ ok: true });
    }),
  );

  return app;
}

// ---------- public player ----------

export function publicPlaylistRoutes(ctx: AppContext, box: BoxService) {
  const app = new Hono();
  const t = ctx.db.t.playlists;
  const orm = ctx.db.orm;

  const byToken = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(token)) return null;
    const [p] = await orm.select().from(t).where(eq(t.shareToken, token));
    return p ?? null;
  };
  const gone = (c: Context) => {
    c.header('Content-Security-Policy', SITE_CSP);
    return c.html(pageShell('Playlist not found', `<main class="empty"><h1>This playlist isn’t shared anymore.</h1><p>Ask whoever sent it for a new link.</p><a class="btn" href="/">What is BazzyBox?</a></main>`), 404);
  };

  app.get('/p.js', (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(playerJs);
  });

  app.get('/p/:token', async (c) => {
    const p = await byToken(c.req.param('token'));
    if (!p) return gone(c);
    await orm.update(t).set({ plays: p.plays + 1 }).where(eq(t.id, p.id));
    const origin = (ctx.cfg.APP_ORIGIN ?? new URL(c.req.url).origin).replace(/\/$/, '');
    c.header('Content-Security-Policy', SITE_CSP);
    c.header('Cache-Control', 'no-cache');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(playerHtml(p, c.req.param('token'), origin));
  });

  app.get('/p/:token/cover', async (c) => {
    const p = await byToken(c.req.param('token'));
    if (!p?.cover || !p.coverType) return c.text('not found', 404);
    c.header('Content-Type', p.coverType);
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(Buffer.from(p.cover, 'base64'));
  });

  app.on(['GET', 'HEAD'], '/p/:token/t/:index/:name?', async (c) => {
    const p = await byToken(c.req.param('token'));
    if (!p) return c.text('not found', 404);
    const items = parseItems(p.items);
    const i = Number(c.req.param('index'));
    const path = Number.isInteger(i) ? items[i] : undefined;
    if (!path || !playableKind(path)) return c.text('not found', 404);
    const a = box.mountFor(p.accountId).adapter;
    const st = await a.stat(path).catch(() => null);
    if (!st || st.isDir) return c.text('This track was removed.', 404);
    if (c.req.method === 'GET') {
      const r = parseRange(c.req.header('range'), st.size);
      const bytes = r && r !== 'unsatisfiable' ? r.end - r.start + 1 : st.size;
      try {
        await box.chargeSend(p.accountId, bytes);
      } catch (e) {
        if (e instanceof BoxError) return c.text(e.message, e.status as 402);
        throw e;
      }
    }
    return serveFile(c, a, st);
  });

  return app;
}

export function pageShell(title: string, body: string, head = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,400..800&display=swap" rel="stylesheet">
${head}
<style>
:root{color-scheme:dark;--bg:#0c0d10;--panel:#15171c;--line:#262a31;--ink:#eceef2;--mute:#9aa1ae;--red:#ff3d5a}
*{box-sizing:border-box;min-width:0}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 Archivo,system-ui,sans-serif;overflow-x:clip;padding-bottom:120px}
a{color:inherit}
h1{font-stretch:112%;font-weight:800;letter-spacing:-.02em;line-height:1.05;margin:0;font-size:clamp(30px,5vw,52px);text-wrap:balance}
.wrap{max-width:1000px;margin:0 auto;padding:clamp(20px,5vw,56px) max(4vw,16px)}
.top{display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);gap:clamp(20px,4vw,40px);align-items:end}
.art{aspect-ratio:1;border-radius:14px;overflow:hidden;background:linear-gradient(135deg,#2a1118,#15171c 60%);box-shadow:0 24px 60px -20px #000;display:grid;place-items:center}
.art img{width:100%;height:100%;object-fit:cover;display:block}
.art svg{width:38%;opacity:.5}
.kicker{font-size:14px;color:var(--mute);margin-bottom:8px}
.desc{color:var(--mute);margin:12px 0 0;max-width:60ch;white-space:pre-line}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:10px 20px;border-radius:999px;font:700 16px Archivo,sans-serif;text-decoration:none;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
.btn.go{background:var(--red);border-color:var(--red);color:#fff}
.btn:focus-visible,.trk:focus-visible{outline:2px solid var(--red);outline-offset:2px}
ol{list-style:none;padding:0;margin:32px 0 0}
.trk{width:100%;display:grid;grid-template-columns:2.2em minmax(0,1fr) auto;gap:12px;align-items:center;text-align:left;padding:12px 10px;border:0;border-bottom:1px solid var(--line);background:none;color:inherit;font:inherit;cursor:pointer;border-radius:8px}
.trk:hover{background:var(--panel)}
.trk .n{color:var(--mute);font-variant-numeric:tabular-nums;text-align:right}
.trk .tt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trk .k{font-size:12px;color:var(--mute);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.trk[aria-current=true]{background:var(--panel)}
.trk[aria-current=true] .n,.trk[aria-current=true] .tt{color:var(--red);font-weight:700}
.stage{margin-top:24px;border-radius:12px;overflow:hidden;background:#000}
.stage[hidden]{display:none}
.stage video{display:block;width:100%;max-height:70vh}
.bar{position:fixed;left:0;right:0;bottom:0;background:color-mix(in oklab,var(--bg) 92%,transparent);backdrop-filter:blur(10px);border-top:1px solid var(--line);padding:10px max(4vw,16px) calc(10px + env(safe-area-inset-bottom))}
.bar .in{max-width:1000px;margin:0 auto;display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 14px;align-items:center}
.ctl{display:flex;gap:6px}
.ctl button{width:44px;height:44px;border-radius:50%;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;font-size:16px}
.ctl button.play{background:var(--red);border-color:var(--red);color:#fff}
.now{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
audio{width:100%;height:36px;grid-column:1/-1}
.foot{margin-top:40px;font-size:14px;color:var(--mute)}
.empty{text-align:center;padding:80px 16px}
.empty h1{font-size:28px;margin-bottom:10px}
@media(max-width:640px){.top{grid-template-columns:minmax(0,1fr)}.art{max-width:260px}}
</style>
</head>
<body>${body}</body>
</html>`;
}

const NOTE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="#ff3d5a" stroke-width="1.5" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;

function playerHtml(p: { title: string; description: string; items: string; cover: string | null }, token: string, origin: string) {
  const items = parseItems(p.items);
  const base = `/p/${token}`;
  const tracks = items
    .map((path, i) => {
      const kind = playableKind(path) ?? 'audio';
      const name = path.split('/').pop() ?? path;
      const src = `${base}/t/${i}/${encodeURIComponent(name)}`;
      return `<li><button class="trk" type="button" data-i="${i}" data-src="${esc(src)}" data-kind="${kind}"><span class="n">${i + 1}</span><span class="tt">${esc(trackTitle(path))}</span>${kind === 'video' ? '<span class="k">Video</span>' : ''}</button></li>`;
    })
    .join('');
  const count = `${items.length} ${items.length === 1 ? 'track' : 'tracks'}`;
  const og = [
    `<meta property="og:type" content="music.playlist">`,
    `<meta property="og:title" content="${esc(p.title)}">`,
    `<meta property="og:description" content="${esc(p.description || `${count} · a BazzyBox playlist`)}">`,
    `<meta property="og:url" content="${esc(`${origin}${base}`)}">`,
    p.cover ? `<meta property="og:image" content="${esc(`${origin}${base}/cover`)}">` : '',
    `<meta name="twitter:card" content="${p.cover ? 'summary_large_image' : 'summary'}">`,
    `<meta name="robots" content="noindex">`,
  ].join('\n');
  const body = `
<div class="wrap">
  <header class="top">
    <div class="art">${p.cover ? `<img src="${base}/cover" alt="">` : NOTE_SVG}</div>
    <div>
      <div class="kicker">Playlist · ${count}</div>
      <h1>${esc(p.title)}</h1>
      ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
      <div class="actions">${items.length ? '<button class="btn go" type="button" id="playall">▶ Play</button><button class="btn" type="button" id="shuffle">Shuffle</button>' : ''}</div>
    </div>
  </header>
  <div class="stage" id="stage" hidden><video id="video" playsinline controls></video></div>
  ${items.length ? `<ol id="list">${tracks}</ol>` : '<p class="desc" style="margin-top:32px">This playlist is empty.</p>'}
  <p class="foot">Made with <a href="/">BazzyBox Playlist Maker</a></p>
</div>
<div class="bar" id="bar" hidden>
  <div class="in">
    <div class="ctl"><button type="button" id="prev" aria-label="Previous">⏮</button><button type="button" class="play" id="toggle" aria-label="Play or pause">▶</button><button type="button" id="next" aria-label="Next">⏭</button></div>
    <div class="now" id="now" aria-live="polite"></div>
    <audio id="audio" controls preload="none"></audio>
  </div>
</div>
<script src="/p.js"></script>`;
  return pageShell(`${p.title} · Playlist`, body, og);
}

/** Player: one queue, audio in the bottom bar, video in the stage. */
export const playerJs = String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  const buttons = [...document.querySelectorAll('.trk')];
  if (!buttons.length) return;
  const audio = $('audio'), video = $('video'), stage = $('stage'), bar = $('bar'), now = $('now'), toggle = $('toggle');
  const pageTitle = document.title;
  let order = buttons.map((_, i) => i), pos = -1;
  const media = () => (buttons[order[pos]] && buttons[order[pos]].dataset.kind === 'video' ? video : audio);
  const icon = () => { toggle.textContent = media().paused ? '▶' : '⏸'; };
  function play(p) {
    if (p < 0 || p >= order.length) return;
    pos = p;
    const b = buttons[order[pos]];
    buttons.forEach((x) => x.setAttribute('aria-current', String(x === b)));
    const isVideo = b.dataset.kind === 'video';
    const el = isVideo ? video : audio, other = isVideo ? audio : video;
    other.pause();
    stage.hidden = !isVideo;
    audio.hidden = isVideo;
    bar.hidden = false;
    el.src = b.dataset.src;
    el.play().catch(() => {});
    now.textContent = b.querySelector('.tt').textContent;
    document.title = now.textContent + ' · ' + pageTitle;
    if (isVideo) stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  buttons.forEach((b) => b.addEventListener('click', () => { order = buttons.map((_, i) => i); play(Number(b.dataset.i)); }));
  [audio, video].forEach((el) => {
    el.addEventListener('ended', () => play(pos + 1));
    el.addEventListener('play', icon);
    el.addEventListener('pause', icon);
  });
  $('next').addEventListener('click', () => play(Math.min(pos + 1, order.length - 1)));
  $('prev').addEventListener('click', () => play(Math.max(pos - 1, 0)));
  toggle.addEventListener('click', () => { const m = media(); if (pos < 0) play(0); else if (m.paused) m.play(); else m.pause(); });
  const all = $('playall'); if (all) all.addEventListener('click', () => { order = buttons.map((_, i) => i); play(0); });
  const sh = $('shuffle'); if (sh) sh.addEventListener('click', () => {
    order = buttons.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    play(0);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input,textarea,button,video,audio')) return;
    if (e.code === 'Space') { e.preventDefault(); toggle.click(); }
  });
})();
`;
