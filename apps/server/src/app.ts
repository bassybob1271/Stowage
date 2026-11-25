import { Hono, type Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { and, eq, like, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { loginSchema, mountDefSchema, normalizePath } from '@stowage/shared';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { escapeLike } from './db/index.js';
import type { MountRegistry } from './mounts.js';
import { CodeGateProvider, LoginLimiter, Sessions, clientIp, logFailedLogin, type AuthProvider } from './auth.js';
import { fsRoutes } from './routes/fs.js';
import { createTus } from './tus.js';
import { serveFile } from './serve.js';
import { verifyToken } from './crypto.js';
import { log } from './log.js';
import type { Mount } from './mounts.js';
import { BoxService, accountIdOf, accountIdOfMount, userMountId } from './box/service.js';
import { boxPublicRoutes, boxRoutes, shareRoute } from './box/routes.js';
import { SITE_CSP, siteHtml, siteJs } from './box/site.js';
import { bazzyEnabled, bazzyRoutes } from './box/bazzy.js';
import { playlistRoutes, publicPlaylistRoutes } from './box/playlists.js';

export interface AppContext {
  cfg: Config;
  db: Db;
  mounts: MountRegistry;
  auth: AuthProvider;
  sessions: Sessions;
  limiter: LoginLimiter;
  /** Present when BAZZYBOX=true: accounts, per-user storage, plans and credits. */
  box?: BoxService;
}

/** Header the server sets on tus requests to carry the session subject. Client copies are stripped. */
export const SUB_HEADER = 'x-stowage-sub';

/**
 * Find a mount for a session subject. The owner (code gate) sees every mount;
 * a BazzyBox account sees only its own private mount, box-<id>.
 */
export function resolveMount(ctx: AppContext, sub: string | undefined, id: string): Mount | undefined {
  const acct = accountIdOf(sub);
  if (ctx.box && acct) return id === userMountId(acct) ? ctx.box.mountFor(acct) : undefined;
  if (ctx.box && !sub) return undefined;
  return ctx.mounts.get(id);
}

export async function createContext(cfg: Config, db: Db, mounts: MountRegistry): Promise<AppContext> {
  let box: BoxService | undefined;
  if (cfg.BAZZYBOX) {
    box = new BoxService(cfg, db, mounts);
    box.validate();
  }
  return {
    cfg,
    db,
    mounts,
    auth: await CodeGateProvider.create(cfg.ACCESS_CODE),
    sessions: new Sessions(cfg),
    limiter: new LoginLimiter(5),
    box,
  };
}

function appCsp(cfg: Config) {
  const ext = [cfg.CONTENT_ORIGIN, cfg.DIRECT_TRANSFER ? 'https: http:' : ''].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: ${ext}`,
    `media-src 'self' blob: ${ext}`,
    `connect-src 'self' ${ext}`,
    "worker-src 'self' blob:",
    "font-src 'self' blob: data:",
    `frame-src 'self' blob: ${cfg.CONTENT_ORIGIN ?? ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function createApp(ctx: AppContext) {
  const { cfg } = ctx;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: 'invalid request', issues: err.issues }, 400);
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 600) return c.json({ error: err.message }, status as 400);
    log.error('request.error', { path: c.req.path, error: err.message, stack: err.stack });
    return c.json({ error: 'internal error' }, 500);
  });

  // Baseline security headers.
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    if (!c.res.headers.has('Content-Security-Policy')) c.header('Content-Security-Policy', appCsp(cfg));
    c.header('X-Frame-Options', 'DENY');
  });

  // CSRF: reject cross-origin state-changing requests (SameSite=Lax already blocks most).
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin) {
        // Same-host requests, plus the public origin when served via a tunnel/proxy.
        const allowed = new Set([c.req.header('host'), cfg.APP_ORIGIN && new URL(cfg.APP_ORIGIN).host].filter(Boolean));
        let host: string | undefined;
        try {
          host = new URL(origin).host;
        } catch {
          /* malformed */
        }
        if (!host || !allowed.has(host)) return c.json({ error: 'cross-origin request blocked' }, 403);
      }
    }
    await next();
  });

  // ---------- public ----------
  app.get('/api/health', (c) => c.json({ ok: true }));

  app.post('/api/auth/login', async (c) => {
    const ip = clientIp(c, cfg.TRUST_PROXY);
    const gate = ctx.limiter.check(ip);
    if (!gate.allowed) {
      c.header('Retry-After', String(gate.retryAfterSec));
      return c.json({ error: 'too many attempts', retryAfterSec: gate.retryAfterSec }, 429);
    }
    const body = loginSchema.safeParse(await c.req.json().catch(() => ({})));
    const sub = body.success ? await ctx.auth.authenticate(body.data) : null;
    if (!sub) {
      const lock = ctx.limiter.fail(ip);
      logFailedLogin(ip, lock);
      if (lock) c.header('Retry-After', String(lock));
      return c.json({ error: 'wrong code', retryAfterSec: lock || undefined }, 401);
    }
    ctx.limiter.succeed(ip);
    await ctx.sessions.issue(c, sub);
    log.info('auth.login', { ip });
    return c.json({ ok: true });
  });

  app.post('/api/auth/logout', (c) => {
    ctx.sessions.clear(c);
    return c.json({ ok: true });
  });

  app.get('/api/auth/session', async (c) => {
    const s = await ctx.sessions.read(c);
    return c.json({
      authenticated: Boolean(s),
      provider: ctx.box ? 'box' : ctx.auth.name,
      account: Boolean(accountIdOf(s?.sub)),
      admin: s?.sub === 'owner',
      bazzy: Boolean(ctx.box) && bazzyEnabled(cfg),
    });
  });

  if (ctx.box) {
    app.route('/api', boxPublicRoutes(ctx, ctx.box));
    if (bazzyEnabled(cfg)) app.route('/api', bazzyRoutes(ctx, ctx.box));
    app.route('/', publicPlaylistRoutes(ctx, ctx.box));
    app.on(['GET', 'HEAD'], '/s/:token/:name?', shareRoute(ctx, ctx.box));
  }

  /** Token-authenticated, cookie-less content route (served from CONTENT_ORIGIN when configured). */
  app.on(['GET', 'HEAD'], '/c/:token/:name?', async (c) => {
    const t = verifyToken<{ m: string; p: string; e: number }>(cfg.SESSION_SECRET, c.req.param('token'));
    if (!t || t.e < Date.now()) return c.text('link expired', 403);
    const owner = accountIdOfMount(t.m);
    const m = owner && ctx.box ? ctx.box.mountFor(owner) : ctx.mounts.get(t.m);
    const st = m && (await m.adapter.stat(t.p));
    if (!m || !st || st.isDir) return c.text('not found', 404);
    return serveFile(c, m.adapter, st);
  });

  // ---------- authenticated ----------
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/auth/') || c.req.path === '/api/health' || c.req.path.startsWith('/api/box/webhook/')) return next();
    return ctx.sessions.middleware()(c, next);
  });

  /** Mount management is for the owner only; BazzyBox accounts get one private mount. */
  const sub = (c: Context) => c.get('user' as never) as string | undefined;
  const ownerOnly = (c: Context) => (accountIdOf(sub(c)) ? c.json({ error: 'forbidden' }, 403) : null);

  app.get('/api/mounts', async (c) => {
    await ctx.mounts.checkHealth(c.req.query('fresh') ? 0 : 30_000);
    const acct = accountIdOf(sub(c));
    if (ctx.box && acct) return c.json({ mounts: [ctx.box.mountInfo(acct)], directTransfer: cfg.DIRECT_TRANSFER });
    return c.json({ mounts: ctx.mounts.all().map((m) => ctx.mounts.info(m)), directTransfer: cfg.DIRECT_TRANSFER });
  });

  app.post('/api/mounts', async (c) => {
    const no = ownerOnly(c);
    if (no) return no;
    const def = mountDefSchema.parse(await c.req.json());
    if (ctx.mounts.get(def.id)) return c.json({ error: 'mount id already exists' }, 409);
    await ctx.mounts.create(def);
    return c.json(ctx.mounts.info(ctx.mounts.get(def.id)!), 201);
  });

  app.delete('/api/mounts/:id', async (c) => {
    const no = ownerOnly(c);
    if (no) return no;
    const ok = await ctx.mounts.remove(c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  /** Search the metadata index by name (all mounts or one). */
  app.get('/api/search', async (c) => {
    const term = (c.req.query('q') ?? '').trim();
    if (term.length < 2) return c.json({ results: [] });
    const f = ctx.db.t.files;
    const acct = accountIdOf(sub(c));
    const mount = ctx.box && acct ? userMountId(acct) : c.req.query('mount');
    const pattern = `%${escapeLike(term.toLowerCase())}%`;
    const where = and(
      sql`lower(${f.name}) LIKE ${pattern} ESCAPE '\\'`,
      mount ? eq(f.mountId, mount) : undefined,
      c.req.query('path') ? like(f.path, escapeLike(normalizePath(c.req.query('path'))) + '/%') : undefined,
    );
    const rows = await ctx.db.orm.select().from(f).where(where).limit(200);
    return c.json({
      results: rows.map((r) => ({
        mount: r.mountId,
        path: r.path,
        name: r.name,
        size: r.size,
        mime: r.mime,
        isDir: r.isDir,
        etag: r.etag ?? undefined,
        cid: r.cid ?? undefined,
        modifiedAt: r.modifiedAt,
      })),
    });
  });

  app.route('/api/fs', fsRoutes(ctx));
  if (ctx.box) {
    app.route('/api/box/playlists', playlistRoutes(ctx, ctx.box));
    app.route('/api/box', boxRoutes(ctx, ctx.box));
  }

  // tus hooks only see the Request, so carry the session subject on a header we set ourselves.
  const tus = createTus(ctx);
  const withSub = (c: Context) => {
    const r = c.req.raw;
    const headers = new Headers(r.headers);
    headers.delete(SUB_HEADER);
    const s = sub(c);
    if (s) headers.set(SUB_HEADER, s);
    return new Request(r.url, { method: r.method, headers, body: r.body, duplex: 'half' } as RequestInit);
  };
  app.all('/api/tus', (c) => tus.handleWeb(withSub(c)));
  app.all('/api/tus/*', (c) => tus.handleWeb(withSub(c)));

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // ---------- BazzyBox public website ----------
  // Visitors without a session get the marketing site at "/"; signed-in users fall through to the app.
  if (ctx.box) {
    const site = siteHtml({ freeGb: cfg.BOX_FREE_GB, tvUrl: cfg.BAZZY_TV_URL, signupOpen: cfg.BOX_SIGNUP === 'open' });
    app.get('/', async (c, next) => {
      if (await ctx.sessions.read(c)) return next();
      c.header('Content-Security-Policy', SITE_CSP);
      c.header('Cache-Control', 'no-cache');
      return c.html(site);
    });
    app.get('/site.js', (c) => {
      c.header('Content-Type', 'text/javascript; charset=utf-8');
      c.header('Cache-Control', 'public, max-age=3600');
      return c.body(siteJs);
    });
  }

  // ---------- static web app ----------
  const dist = resolve(cfg.WEB_DIST);
  if (existsSync(join(dist, 'index.html'))) {
    const index = readFileSync(join(dist, 'index.html'), 'utf8');
    app.use(
      '/assets/*',
      serveStatic({
        root: relative(process.cwd(), dist),
        onFound: (_p, c) => {
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.use('*', serveStatic({ root: relative(process.cwd(), dist) }));
    app.get('*', (c: Context) => c.html(index));
  } else {
    app.get('/', (c) => c.text(`Web app not built (looked in ${dist}). Run: pnpm --filter @stowage/web build`, 503));
  }

  return app;
}
