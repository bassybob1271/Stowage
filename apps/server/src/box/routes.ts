import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { normalizePath } from '@stowage/shared';
import type { AppContext } from '../app.js';
import { clientIp, logFailedLogin } from '../auth.js';
import { parseRange, serveFile } from '../serve.js';
import { log } from '../log.js';
import { BoxError, accountIdOf, accountIdOfMount, userSub, type BoxService } from './service.js';
import { PACKS, type PackId } from './pricing.js';
import { createCheckout, verifyWebhook } from './stripe.js';
import { setMemberMarker } from './bazzy.js';
import { authorizeUrl, DropboxError, exchangeCode, newVerifier } from './dropbox.js';
import { signToken, verifyToken } from '../crypto.js';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

const credsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(10, 'password must be at least 10 characters').max(256),
});
const planSchema = z.object({ plan: z.enum(['free', 'flex', 'studio']) });
const packSchema = z.object({ pack: z.enum(Object.keys(PACKS) as [PackId, ...PackId[]]) });
const shareSchema = z.object({ path: z.string().min(1), days: z.number().int().min(1).max(90).default(7) });

const fail = (c: Context, e: unknown) => {
  if (e instanceof BoxError) return c.json({ error: e.message, code: e.code }, e.status as 400);
  throw e;
};

/** Public routes: sign-up, login, Stripe webhook. Mounted before the session middleware. */
export function boxPublicRoutes(ctx: AppContext, box: BoxService) {
  const app = new Hono();

  const gated = (fn: (c: Context, body: z.infer<typeof credsSchema>) => Promise<Response>) => async (c: Context) => {
    const ip = clientIp(c, ctx.cfg.TRUST_PROXY);
    const gate = ctx.limiter.check(ip);
    if (!gate.allowed) {
      c.header('Retry-After', String(gate.retryAfterSec));
      return c.json({ error: 'too many attempts', retryAfterSec: gate.retryAfterSec }, 429);
    }
    const parsed = credsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid request' }, 400);
    try {
      return await fn(c, parsed.data);
    } catch (e) {
      return fail(c, e);
    }
  };

  app.post(
    '/auth/box/signup',
    gated(async (c, b) => {
      const a = await box.signup(b.email, b.password);
      await ctx.sessions.issue(c, userSub(a.id));
      return c.json({ ok: true }, 201);
    }),
  );

  app.post(
    '/auth/box/login',
    gated(async (c, b) => {
      const ip = clientIp(c, ctx.cfg.TRUST_PROXY);
      const a = await box.login(b.email, b.password);
      if (!a) {
        const lock = ctx.limiter.fail(ip);
        logFailedLogin(ip, lock);
        return c.json({ error: 'wrong email or password', retryAfterSec: lock || undefined }, 401);
      }
      ctx.limiter.succeed(ip);
      await ctx.sessions.issue(c, userSub(a.id));
      setMemberMarker(c, ctx.cfg, true);
      return c.json({ ok: true });
    }),
  );

  /** Stripe calls this after a successful Checkout. Signature-verified; credits are idempotent per session id. */
  app.post('/box/webhook/stripe', async (c) => {
    const secret = ctx.cfg.STRIPE_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: 'webhook not configured' }, 404);
    const raw = await c.req.text();
    const evt = verifyWebhook<{ type: string; data: { object: { id: string; payment_status?: string; metadata?: Record<string, string> } } }>(
      raw,
      c.req.header('stripe-signature'),
      secret,
    );
    if (!evt) return c.json({ error: 'bad signature' }, 400);
    if (evt.type === 'checkout.session.completed' || evt.type === 'checkout.session.async_payment_succeeded') {
      const s = evt.data.object;
      const pack = s.metadata?.pack as PackId | undefined;
      const account = s.metadata?.account_id;
      if (s.payment_status === 'paid' && account && pack && pack in PACKS) {
        const applied = await box.grantPack(account, pack, `stripe:${s.id}`).catch((e) => {
          log.error('box.webhook_credit_failed', { session: s.id, error: (e as Error).message });
          throw e;
        });
        log.info('box.topup', { account, pack, applied });
      }
    }
    return c.json({ received: true });
  });

  return app;
}

/** Signed-in account routes under /api/box. */
export function boxRoutes(ctx: AppContext, box: BoxService) {
  const app = new Hono();

  const me = (c: Context) => {
    const id = accountIdOf(c.get('user' as never) as string | undefined);
    if (!id) throw new BoxError(403, 'sign in with a BazzyBox account');
    return id;
  };
  const wrap = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      return fail(c, e);
    }
  };

  app.get('/me', wrap(async (c) => c.json(await box.summary(me(c)))));

  // ---------- Import from Dropbox ----------
  const importer = ctx.importer!;
  const DBX_COOKIE = 'bz_dbx';
  const origin = (c: Context) => (ctx.cfg.APP_ORIGIN ?? new URL(c.req.url).origin).replace(/\/$/, '');
  const dbxCallback = (c: Context) => `${origin(c)}/api/box/import/dropbox/callback`;

  app.get(
    '/import',
    wrap(async (c) => c.json({ dropbox: { available: Boolean(importer.dropboxApp), ...(await importer.connected(me(c))) }, jobs: await importer.list(me(c)) })),
  );

  /** Sends the member to Dropbox to approve read-only access, then back to the callback. */
  app.get(
    '/import/dropbox/start',
    wrap(async (c) => {
      const id = me(c);
      const dbx = importer.dropboxApp;
      if (!dbx) throw new BoxError(503, 'Dropbox import is not set up on this server.');
      const state = randomBytes(24).toString('base64url');
      const verifier = newVerifier();
      setCookie(c, DBX_COOKIE, signToken(ctx.cfg.SESSION_SECRET, { s: state, v: verifier, a: id, e: Date.now() + 600_000 }), {
        httpOnly: true,
        secure: origin(c).startsWith('https://'),
        sameSite: 'Lax',
        path: '/api/box/import/dropbox',
        maxAge: 600,
      });
      return c.redirect(authorizeUrl(dbx, dbxCallback(c), state, verifier), 302);
    }),
  );

  app.get('/import/dropbox/callback', async (c) => {
    const back = (q: string) => {
      deleteCookie(c, DBX_COOKIE, { path: '/api/box/import/dropbox' });
      return c.redirect(`/?import=${q}`, 303);
    };
    try {
      const id = me(c);
      const dbx = importer.dropboxApp;
      const p = verifyToken<{ s: string; v: string; a: string; e: number }>(ctx.cfg.SESSION_SECRET, getCookie(c, DBX_COOKIE) ?? '');
      if (!dbx || !p || p.e < Date.now() || p.a !== id || p.s !== c.req.query('state')) return back('expired');
      if (c.req.query('error') || !c.req.query('code')) return back('cancelled');
      const t = await exchangeCode(dbx, c.req.query('code')!, dbxCallback(c), p.v);
      if (!t.refresh_token) return back('failed');
      await importer.connect(id, t.refresh_token, 'Dropbox');
      log.info('box.dropbox_connected', { account: id });
      return back('connected');
    } catch (e) {
      if (e instanceof BoxError) return fail(c, e);
      log.warn('box.dropbox_connect_failed', { error: (e as Error).message });
      return back('failed');
    }
  });

  app.delete(
    '/import/dropbox',
    wrap(async (c) => {
      await importer.disconnect(me(c));
      return c.json({ ok: true });
    }),
  );

  /** One folder of the member's Dropbox, for the picker. */
  app.get(
    '/import/dropbox/list',
    wrap(async (c) => {
      try {
        const entries = await (await importer.client(me(c))).listFolder(c.req.query('path') ?? '');
        entries.sort((a, b) => (a.tag === b.tag ? a.name.localeCompare(b.name) : a.tag === 'folder' ? -1 : 1));
        return c.json({ entries: entries.map((e) => ({ name: e.name, path: e.path, folder: e.tag === 'folder', size: e.size })) });
      } catch (e) {
        if (e instanceof DropboxError && (e.status === 400 || e.status === 401)) throw new BoxError(409, 'Reconnect your Dropbox.', 'not_connected');
        throw e;
      }
    }),
  );

  app.post(
    '/import/jobs',
    wrap(async (c) => {
      const { paths } = z.object({ paths: z.array(z.string().min(1).max(1024)).min(1).max(200) }).parse(await c.req.json());
      return c.json(await importer.start(me(c), paths), 201);
    }),
  );

  app.post(
    '/import/jobs/:id/:action{pause|resume|cancel}',
    wrap(async (c) => c.json(await importer.setState(me(c), c.req.param('id')!, c.req.param('action') as 'pause' | 'resume' | 'cancel'))),
  );

  app.post(
    '/usage/refresh',
    wrap(async (c) => {
      await box.refreshUsage(me(c));
      return c.json(await box.summary(me(c)));
    }),
  );

  app.post(
    '/plan',
    wrap(async (c) => {
      const { plan } = planSchema.parse(await c.req.json());
      await box.changePlan(me(c), plan);
      return c.json(await box.summary(me(c)));
    }),
  );

  /** Start a credit top-up: a Stripe Checkout URL, or an instant grant when BOX_DEV_CREDITS=true. */
  app.post(
    '/credits',
    wrap(async (c) => {
      const id = me(c);
      const { pack } = packSchema.parse(await c.req.json());
      if (ctx.cfg.STRIPE_SECRET_KEY) {
        const a = await box.get(id);
        const origin = ctx.cfg.APP_ORIGIN ?? new URL(c.req.url).origin;
        const s = await createCheckout(ctx.cfg.STRIPE_SECRET_KEY, { pack, accountId: id, email: a.email, origin });
        return c.json({ checkoutUrl: s.url });
      }
      if (ctx.cfg.BOX_DEV_CREDITS) {
        await box.grantPack(id, pack, `dev:${randomBytes(8).toString('hex')}`);
        return c.json(await box.summary(id));
      }
      throw new BoxError(503, 'payments are not configured (set STRIPE_SECRET_KEY)');
    }),
  );

  // ---------- share links ("sends") ----------
  const shares = ctx.db.t.shares;

  app.get(
    '/shares',
    wrap(async (c) => {
      const rows = await ctx.db.orm.select().from(shares).where(eq(shares.mountId, `box-${me(c)}`));
      return c.json({ shares: rows.map((r) => ({ token: r.token, path: r.path, expiresAt: r.expiresAt, downloads: r.downloads, url: `/s/${r.token}` })) });
    }),
  );

  app.post(
    '/shares',
    wrap(async (c) => {
      const id = me(c);
      const { path, days } = shareSchema.parse(await c.req.json());
      const p = normalizePath(path);
      const st = await box.mountFor(id).adapter.stat(p);
      if (!st || st.isDir) throw new BoxError(404, 'file not found');
      const token = randomBytes(18).toString('base64url');
      const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      await ctx.db.orm.insert(shares).values({ token, mountId: `box-${id}`, path: p, expiresAt, downloads: 0, createdAt: new Date().toISOString() });
      return c.json({ token, url: `/s/${token}/${encodeURIComponent(st.name)}`, expiresAt }, 201);
    }),
  );

  app.delete(
    '/shares/:token',
    wrap(async (c) => {
      await ctx.db.orm.delete(shares).where(and(eq(shares.token, c.req.param('token') ?? ''), eq(shares.mountId, `box-${me(c)}`)));
      return c.json({ ok: true });
    }),
  );

  return app;
}

/** Public share-link downloads: GET /s/:token[/name]. Bytes count against the owner's send allowance. */
export function shareRoute(ctx: AppContext, box: BoxService) {
  return async (c: Context) => {
    const shares = ctx.db.t.shares;
    const [s] = await ctx.db.orm.select().from(shares).where(eq(shares.token, c.req.param('token') ?? ''));
    if (!s || (s.expiresAt && Date.parse(s.expiresAt) < Date.now())) return c.text('This link has expired or does not exist.', 404);
    const owner = accountIdOfMount(s.mountId);
    if (!owner) return c.text('not found', 404);
    const a = box.mountFor(owner).adapter;
    const st = await a.stat(s.path);
    if (!st || st.isDir) return c.text('The shared file was removed.', 404);
    if (c.req.method === 'GET') {
      const r = parseRange(c.req.header('range'), st.size);
      const bytes = r && r !== 'unsatisfiable' ? r.end - r.start + 1 : st.size;
      try {
        await box.chargeSend(owner, bytes);
      } catch (e) {
        if (e instanceof BoxError) return c.text(e.message, e.status as 402);
        throw e;
      }
      if (!r) await ctx.db.orm.update(shares).set({ downloads: s.downloads + 1 }).where(eq(shares.token, s.token));
    }
    return serveFile(c, a, st, { download: c.req.query('dl') === '1' });
  };
}
