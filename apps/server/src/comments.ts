import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { normalizePath } from '@stowage/shared';
import { resolveMount, type AppContext } from './app.js';
import type { Db } from './db/index.js';
import { escapeLike } from './db/index.js';
import { clientIp } from './auth.js';
import { accountIdOf, BoxError, type BoxService } from './box/service.js';
import { pageShell, playableKind } from './box/playlists.js';
import { SITE_CSP } from './box/site.js';
import { parseRange, serveFile } from './serve.js';
import { reviewJs } from './review-js.js';

/**
 * Timed comments on audio and video ("raise the vocal at 1:36"). A comment belongs to one file
 * (mount + path) and may carry a position or a range in the media. Replies are one level deep.
 * They follow the file on rename/move and go away when it's deleted.
 */

const MAX_T = 7 * 24 * 3600; // seconds
const commentInput = z
  .object({
    body: z.string().trim().min(1).max(4000),
    t: z.number().min(0).max(MAX_T).nullish(),
    tEnd: z.number().min(0).max(MAX_T).nullish(),
    parentId: z.string().min(1).max(40).nullish(),
  })
  .strict();
const guestInput = commentInput.extend({ name: z.string().trim().min(1).max(60) }).strict();
const patchInput = z.object({ body: z.string().trim().min(1).max(4000).optional(), resolved: z.boolean().optional() }).strict();
type CommentInput = z.infer<typeof commentInput>;

export interface CommentOut {
  id: string;
  parentId: string | null;
  author: string;
  guest: boolean;
  mine: boolean;
  body: string;
  /** Seconds into the media, or null for a note about the whole file. */
  t: number | null;
  tEnd: number | null;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

type Row = Db['t']['comments']['$inferSelect'];

function out(r: Row, viewer: string | null): CommentOut {
  return {
    id: r.id,
    parentId: r.parentId,
    author: r.authorName,
    guest: r.authorId === null,
    mine: viewer !== null && r.authorId === viewer,
    body: r.body,
    t: r.tMs === null ? null : r.tMs / 1000,
    tEnd: r.tEndMs === null ? null : r.tEndMs / 1000,
    resolved: r.resolvedAt !== null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Top-level comments in timeline order (whole-file notes first), each followed by its replies. */
export async function listComments(db: Db, mountId: string, path: string, viewer: string | null) {
  const t = db.t.comments;
  const rows = await db.orm.select().from(t).where(and(eq(t.mountId, mountId), eq(t.path, path))).orderBy(asc(t.createdAt));
  const top = rows.filter((r) => !r.parentId).sort((a, b) => (a.tMs ?? -1) - (b.tMs ?? -1) || a.createdAt.localeCompare(b.createdAt));
  const replies = new Map<string, Row[]>();
  for (const r of rows) if (r.parentId) replies.set(r.parentId, [...(replies.get(r.parentId) ?? []), r]);
  return top.flatMap((r) => [r, ...(replies.get(r.id) ?? [])]).map((r) => out(r, viewer));
}

export async function addComment(db: Db, mountId: string, path: string, author: { id: string | null; name: string }, input: CommentInput) {
  const t = db.t.comments;
  let parentId: string | null = null;
  if (input.parentId) {
    const [p] = await db.orm.select().from(t).where(and(eq(t.id, input.parentId), eq(t.mountId, mountId), eq(t.path, path)));
    if (!p) throw new BoxError(404, 'That comment was removed.');
    parentId = p.parentId ?? p.id; // keep threads one level deep
  }
  const tMs = parentId || input.t == null ? null : Math.round(input.t * 1000);
  const tEndMs = tMs !== null && input.tEnd != null && input.tEnd * 1000 > tMs ? Math.round(input.tEnd * 1000) : null;
  const now = new Date().toISOString();
  const row = { id: randomBytes(9).toString('base64url'), mountId, path, parentId, authorId: author.id, authorName: author.name, body: input.body, tMs, tEndMs, resolvedAt: null, createdAt: now, updatedAt: now };
  await db.orm.insert(t).values(row);
  return out(row, author.id);
}

/** Keep comments with their file when it (or a folder above it) is renamed or moved. */
export async function moveComments(db: Db, mountId: string, from: string, to: string) {
  const t = db.t.comments;
  await db.orm.update(t).set({ path: to }).where(and(eq(t.mountId, mountId), eq(t.path, from)));
  await db.orm
    .update(t)
    .set({ path: sql`${to} || substr(${t.path}, ${from.length + 1})` })
    .where(and(eq(t.mountId, mountId), sql`${t.path} LIKE ${escapeLike(from) + '/%'} ESCAPE '\\'`));
}

export async function dropComments(db: Db, mountId: string, path: string) {
  const t = db.t.comments;
  await db.orm.delete(t).where(and(eq(t.mountId, mountId), sql`(${t.path} = ${path} OR ${t.path} LIKE ${escapeLike(path) + '/%'} ESCAPE '\\')`));
}

const httpErr = (c: Context, e: unknown) => {
  if (e instanceof BoxError) return c.json({ error: e.message }, e.status as 400);
  if (e instanceof z.ZodError) return c.json({ error: e.issues[0]?.message ?? 'invalid input' }, 400);
  throw e;
};

/** Signed-in routes: /api/comments/:mount?path=… Anyone who can open the mount can comment, resolve and tidy up. */
export function commentRoutes(ctx: AppContext) {
  const app = new Hono();
  const sub = (c: Context) => c.get('user' as never) as string | undefined;
  const mountId = (c: Context) => {
    const m = resolveMount(ctx, sub(c), c.req.param('mount') ?? '');
    if (!m) throw new BoxError(404, 'unknown mount');
    return m.adapter.id;
  };
  const authorName = async (s: string | undefined) => {
    const acct = accountIdOf(s);
    if (acct && ctx.box) {
      const a = ctx.db.t.accounts;
      const [row] = await ctx.db.orm.select({ email: a.email }).from(a).where(eq(a.id, acct));
      return row?.email.split('@')[0] || 'Member';
    }
    return 'Owner';
  };
  const one = async (c: Context) => {
    const t = ctx.db.t.comments;
    const [r] = await ctx.db.orm.select().from(t).where(and(eq(t.id, c.req.param('id') ?? ''), eq(t.mountId, mountId(c))));
    if (!r) throw new BoxError(404, 'That comment was removed.');
    return r;
  };

  app.get('/:mount', async (c) => {
    try {
      return c.json({ comments: await listComments(ctx.db, mountId(c), normalizePath(c.req.query('path') ?? ''), sub(c) ?? null) });
    } catch (e) {
      return httpErr(c, e);
    }
  });

  app.post('/:mount', async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const path = normalizePath(String(body.path ?? ''));
      if (!path) throw new BoxError(400, 'path required');
      delete body.path;
      const input = commentInput.parse(body);
      const m = mountId(c);
      const added = await addComment(ctx.db, m, path, { id: sub(c) ?? null, name: await authorName(sub(c)) }, input);
      return c.json(added, 201);
    } catch (e) {
      return httpErr(c, e);
    }
  });

  app.patch('/:mount/:id', async (c) => {
    try {
      const r = await one(c);
      const p = patchInput.parse(await c.req.json());
      if (p.body !== undefined && r.authorId !== (sub(c) ?? null)) throw new BoxError(403, 'You can only edit your own comments.');
      const t = ctx.db.t.comments;
      const set: Partial<Row> = { updatedAt: new Date().toISOString() };
      if (p.body !== undefined) set.body = p.body;
      if (p.resolved !== undefined) set.resolvedAt = p.resolved ? new Date().toISOString() : null;
      await ctx.db.orm.update(t).set(set).where(eq(t.id, r.id));
      return c.json(out({ ...r, ...set }, sub(c) ?? null));
    } catch (e) {
      return httpErr(c, e);
    }
  });

  app.delete('/:mount/:id', async (c) => {
    try {
      const r = await one(c);
      const t = ctx.db.t.comments;
      await ctx.db.orm.delete(t).where(or(eq(t.id, r.id), eq(t.parentId, r.id)));
      return c.json({ ok: true });
    } catch (e) {
      return httpErr(c, e);
    }
  });

  return app;
}

// ---------- review links (BazzyBox) ----------

const reviewSchema = z.object({ path: z.string().min(1).max(1024), days: z.number().int().min(1).max(90).default(14) });

/** Owner side, under /api/box/reviews. */
export function reviewOwnerRoutes(ctx: AppContext, box: BoxService) {
  const app = new Hono();
  const r = ctx.db.t.reviewLinks;
  const me = (c: Context) => {
    const id = accountIdOf(c.get('user' as never) as string | undefined);
    if (!id) throw new BoxError(403, 'sign in with a BazzyBox account');
    return id;
  };

  app.post('/', async (c) => {
    try {
      const id = me(c);
      const { path, days } = reviewSchema.parse(await c.req.json());
      const p = normalizePath(path);
      const st = await box.mountFor(id).adapter.stat(p);
      if (!st || st.isDir) throw new BoxError(404, 'file not found');
      if (!playableKind(p)) throw new BoxError(400, `“${st.name}” isn’t an audio or video file a browser can play`);
      const token = randomBytes(18).toString('base64url');
      const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      await ctx.db.orm.insert(r).values({ token, accountId: id, path: p, expiresAt, createdAt: new Date().toISOString() });
      return c.json({ token, url: `/r/${token}`, expiresAt }, 201);
    } catch (e) {
      return httpErr(c, e);
    }
  });

  app.get('/', async (c) => {
    try {
      const rows = await ctx.db.orm.select().from(r).where(eq(r.accountId, me(c)));
      return c.json({ reviews: rows.map((x) => ({ token: x.token, path: x.path, expiresAt: x.expiresAt, url: `/r/${x.token}` })) });
    } catch (e) {
      return httpErr(c, e);
    }
  });

  app.delete('/:token', async (c) => {
    try {
      await ctx.db.orm.delete(r).where(and(eq(r.token, c.req.param('token')), eq(r.accountId, me(c))));
      return c.json({ ok: true });
    } catch (e) {
      return httpErr(c, e);
    }
  });

  return app;
}

/** Simple per-IP limit on guest comments. */
class GuestLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = 12, private windowMs = 60_000) {}
  ok(ip: string) {
    const now = Date.now();
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) return false;
    recent.push(now);
    this.hits.set(ip, recent);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }
}

/** Public side: /r/:token (page), /r/:token/media, /r/:token/comments. No session needed; the token is the key. */
export function reviewPublicRoutes(ctx: AppContext, box: BoxService) {
  const app = new Hono();
  const r = ctx.db.t.reviewLinks;
  const limiter = new GuestLimiter();
  const link = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(token)) return null;
    const [x] = await ctx.db.orm.select().from(r).where(eq(r.token, token));
    if (!x || Date.parse(x.expiresAt) < Date.now()) return null;
    return x;
  };
  const gone = (c: Context) => {
    c.header('Content-Security-Policy', SITE_CSP);
    return c.html(pageShell('Review link expired', `<main class="empty"><h1>This review link has expired.</h1><p>Ask whoever sent it for a new one.</p></main>`), 404);
  };

  app.get('/r.js', (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=300');
    return c.body(reviewJs);
  });

  app.get('/r/:token', async (c) => {
    const x = await link(c.req.param('token'));
    if (!x) return gone(c);
    const st = await box.mountFor(x.accountId).adapter.stat(x.path).catch(() => null);
    if (!st || st.isDir) return gone(c);
    c.header('Content-Security-Policy', SITE_CSP);
    c.header('Cache-Control', 'no-cache');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Robots-Tag', 'noindex');
    return c.html(pageShell(`Review: ${st.name}`, `<main class="wrap" id="review" data-token="${c.req.param('token')}"><p class="kicker">Loading…</p></main><script src="/r.js" defer></script>`, REVIEW_CSS));
  });

  app.get('/r/:token/info', async (c) => {
    const x = await link(c.req.param('token'));
    if (!x) return c.json({ error: 'This review link has expired.' }, 404);
    const st = await box.mountFor(x.accountId).adapter.stat(x.path).catch(() => null);
    if (!st || st.isDir) return c.json({ error: 'The file was removed.' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json({
      name: st.name,
      kind: playableKind(x.path),
      size: st.size,
      expiresAt: x.expiresAt,
      comments: await listComments(ctx.db, box.mountFor(x.accountId).adapter.id, x.path, null),
    });
  });

  app.on(['GET', 'HEAD'], '/r/:token/media', async (c) => {
    const x = await link(c.req.param('token'));
    if (!x) return c.text('expired', 404);
    const a = box.mountFor(x.accountId).adapter;
    const st = await a.stat(x.path).catch(() => null);
    if (!st || st.isDir) return c.text('removed', 404);
    if (c.req.method === 'GET') {
      const rg = parseRange(c.req.header('range'), st.size);
      try {
        await box.chargeSend(x.accountId, rg && rg !== 'unsatisfiable' ? rg.end - rg.start + 1 : st.size);
      } catch (e) {
        if (e instanceof BoxError) return c.text(e.message, e.status as 402);
        throw e;
      }
    }
    return serveFile(c, a, st);
  });

  app.post('/r/:token/comments', async (c) => {
    try {
      // JSON only (a plain form post can't set this), from this site only.
      if (!(c.req.header('content-type') ?? '').includes('application/json')) throw new BoxError(415, 'send JSON');
      const origin = c.req.header('origin');
      if (origin) {
        const ok = new Set([c.req.header('host'), ctx.cfg.APP_ORIGIN && new URL(ctx.cfg.APP_ORIGIN).host].filter(Boolean));
        let h = '';
        try {
          h = new URL(origin).host;
        } catch {
          /* malformed */
        }
        if (!ok.has(h)) throw new BoxError(403, 'cross-origin request blocked');
      }
      const x = await link(c.req.param('token'));
      if (!x) throw new BoxError(404, 'This review link has expired.');
      if (!limiter.ok(clientIp(c, ctx.cfg.TRUST_PROXY))) throw new BoxError(429, 'Slow down a little, then try again.');
      const { name, ...input } = guestInput.parse(await c.req.json());
      const added = await addComment(ctx.db, box.mountFor(x.accountId).adapter.id, x.path, { id: null, name }, input);
      return c.json(added, 201);
    } catch (e) {
      return httpErr(c, e);
    }
  });

  return app;
}

const REVIEW_CSS = `<style>
.rv{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:24px;align-items:start}
.rv .media{background:#000;border-radius:12px;overflow:hidden}
.rv video{display:block;width:100%;max-height:70vh}
.rv audio{width:100%;display:block;padding:12px;background:var(--panel)}
.track{position:relative;height:18px;margin:10px 0 0;background:var(--panel);border-radius:9px;cursor:pointer}
.track .pos{position:absolute;top:0;bottom:0;left:0;background:color-mix(in oklab,var(--red) 35%,transparent);border-radius:9px;pointer-events:none}
.mk{position:absolute;top:2px;width:14px;height:14px;margin-left:-7px;border-radius:50%;background:var(--red);border:2px solid var(--bg);cursor:pointer;padding:0}
.mk.range{border-radius:7px;margin-left:0;background:color-mix(in oklab,var(--red) 70%,transparent)}
.mk.done{background:var(--mute)}
.side{background:var(--panel);border:1px solid var(--line);border-radius:12px;display:flex;flex-direction:column;max-height:80vh}
.side h2{font-size:16px;margin:0;padding:12px 14px;border-bottom:1px solid var(--line)}
.list{overflow-y:auto;flex:1;padding:6px 0}
.cm{padding:8px 14px}
.cm.reply{padding-left:34px}
.cm .who{font-size:13px;color:var(--mute)}
.cm .who b{color:var(--ink)}
.cm.done .txt{opacity:.55;text-decoration:line-through}
.ts{font:700 12px Archivo,sans-serif;color:var(--red);background:none;border:1px solid color-mix(in oklab,var(--red) 50%,transparent);border-radius:6px;padding:1px 6px;cursor:pointer;margin-right:6px}
.txt{white-space:pre-wrap;word-break:break-word;margin:2px 0}
.lnk{background:none;border:0;padding:0;color:var(--mute);font:inherit;font-size:13px;cursor:pointer}
form.add{border-top:1px solid var(--line);padding:10px 14px;display:flex;flex-direction:column;gap:8px}
form.add input,form.add textarea{width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit}
form.add textarea{min-height:64px;resize:vertical}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--mute)}
.chip{border:1px solid var(--line);border-radius:999px;padding:3px 10px;background:none;color:var(--ink);font:inherit;font-size:13px;cursor:pointer}
.chip[aria-pressed=true]{border-color:var(--red);color:var(--red)}
.none{color:var(--mute);padding:14px;font-size:14px}
@media(max-width:860px){.rv{grid-template-columns:minmax(0,1fr)}.side{max-height:none}}
</style>`;
