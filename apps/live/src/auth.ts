/**
 * Sign in with Bazzy TV for Bazzy Live, and the publish check MediaMTX calls for every stream.
 *
 *   GET  /auth/bazzy/start     → Bazzy TV /oauth/authorize (state + PKCE kept in a signed cookie)
 *   GET  /auth/bazzy/callback  → swap the code server-to-server, read userinfo, start a session, go to /studio
 *   POST /auth/logout
 *
 * Creators publish to live/<handle> with their own stream key; the shared LIVE_PUBLISH_USER/PASS
 * still works for any path (the station's own feeds).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config } from './config.js';
import { log } from './log.js';
import type { Creator, Store } from './store.js';

const SESSION = 'bl_session';
const PENDING = 'bl_bazzy';
const SESSION_TTL = 30 * 24 * 3600;
const PENDING_TTL = 600;

/** Swappable for tests. */
export const bazzyHttp = { fetch: (input: string, init?: RequestInit) => fetch(input, init) };

const same = (a: string, b: string) => {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
};
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

export function sign(secret: string, payload: object) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function verify<T extends { e: number }>(secret: string, token: string): T | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  if (!same(mac, createHmac('sha256', secret).update(body).digest('base64url'))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    return typeof p.e === 'number' && p.e > Date.now() ? p : null;
  } catch {
    return null;
  }
}

export function publicOrigin(c: Context, cfg: Config) {
  if (cfg.LIVE_PUBLIC_URL) return cfg.LIVE_PUBLIC_URL.replace(/\/$/, '');
  const u = new URL(c.req.url);
  const proto = cfg.LIVE_TRUST_PROXY ? c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() : undefined;
  const host = (cfg.LIVE_TRUST_PROXY && c.req.header('x-forwarded-host')) || c.req.header('host') || u.host;
  return `${proto ?? u.protocol.replace(':', '')}://${host}`;
}

export function canGoLive(cfg: Config, c: Creator) {
  const roles = cfg.LIVE_CREATOR_ROLES.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
  return roles.includes('*') || roles.includes((c.role ?? '').toLowerCase());
}

/** The signed-in creator, if any. */
export function currentCreator(c: Context, cfg: Config, store: Store): Creator | null {
  if (!cfg.bazzy) return null;
  const s = verify<{ sub: string; e: number }>(cfg.LIVE_SESSION_SECRET!, getCookie(c, SESSION) ?? '');
  return s ? (store.creatorBySub(s.sub) ?? null) : null;
}

/** State-changing requests must come from our own pages. */
export function sameOrigin(c: Context, cfg: Config) {
  const o = c.req.header('origin');
  return Boolean(o) && o === publicOrigin(c, cfg);
}

export function authRoutes(cfg: Config, store: Store) {
  const app = new Hono();
  const base = () => cfg.LIVE_BAZZY_AUTH_URL!.replace(/\/$/, '');
  const secure = (c: Context) => publicOrigin(c, cfg).startsWith('https://');
  const callback = (c: Context) => `${publicOrigin(c, cfg)}/auth/bazzy/callback`;
  const fail = (c: Context, msg: string) => {
    deleteCookie(c, PENDING, { path: '/auth/bazzy' });
    return c.redirect(`/studio?error=${encodeURIComponent(msg)}`, 303);
  };

  app.get('/auth/bazzy/start', (c) => {
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    setCookie(c, PENDING, sign(cfg.LIVE_SESSION_SECRET!, { s: state, v: verifier, e: Date.now() + PENDING_TTL * 1000 }), {
      httpOnly: true,
      secure: secure(c),
      sameSite: 'Lax', // the return trip is a top-level GET from Bazzy TV
      path: '/auth/bazzy',
      maxAge: PENDING_TTL,
    });
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.LIVE_BAZZY_CLIENT_ID,
      redirect_uri: callback(c),
      scope: 'openid profile email',
      state,
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
    });
    return c.redirect(`${base()}/oauth/authorize?${q}`, 302);
  });

  app.get('/auth/bazzy/callback', async (c) => {
    const error = c.req.query('error');
    if (error) return fail(c, error === 'access_denied' ? 'Bazzy TV sign-in was cancelled.' : 'Bazzy TV sign-in failed. Try again.');
    const pending = verify<{ s: string; v: string; e: number }>(cfg.LIVE_SESSION_SECRET!, getCookie(c, PENDING) ?? '');
    const state = c.req.query('state') ?? '';
    const code = c.req.query('code') ?? '';
    if (!pending) return fail(c, 'Your sign-in session expired. Try again.');
    if (!state || !same(pending.s, state) || !code) return fail(c, 'Sign-in could not be verified. Try again.');
    try {
      const tok = await bazzyHttp.fetch(`${base()}/api/v1/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${cfg.LIVE_BAZZY_CLIENT_ID}:${cfg.LIVE_BAZZY_CLIENT_SECRET}`).toString('base64')}`,
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callback(c), code_verifier: pending.v }),
      });
      if (!tok.ok) {
        log.warn('auth.token_failed', { status: tok.status, body: (await tok.text()).slice(0, 200) });
        return fail(c, 'Bazzy TV sign-in failed. Try again.');
      }
      const { access_token } = (await tok.json()) as { access_token?: string };
      const me = await bazzyHttp.fetch(`${base()}/api/v1/oauth/userinfo`, { headers: { authorization: `Bearer ${access_token}` } });
      if (!me.ok) return fail(c, 'Bazzy TV sign-in failed. Try again.');
      const info = (await me.json()) as { sub?: string | number; email?: string; name?: string; role?: string };
      if (!info.sub) return fail(c, 'Bazzy TV sign-in failed. Try again.');
      const creator = await store.upsertCreator({ sub: String(info.sub), name: info.name ?? undefined, email: info.email ?? undefined, role: info.role ?? undefined });
      deleteCookie(c, PENDING, { path: '/auth/bazzy' });
      setCookie(c, SESSION, sign(cfg.LIVE_SESSION_SECRET!, { sub: creator.sub, e: Date.now() + SESSION_TTL * 1000 }), {
        httpOnly: true,
        secure: secure(c),
        sameSite: 'Lax',
        path: '/',
        maxAge: SESSION_TTL,
      });
      log.info('auth.login', { handle: creator.handle, role: creator.role });
      return c.redirect('/studio', 303);
    } catch (e) {
      log.warn('auth.error', { error: (e as Error).message });
      return fail(c, 'Bazzy TV sign-in failed. Try again.');
    }
  });

  app.post('/auth/logout', (c) => {
    if (!sameOrigin(c, cfg)) return c.text('forbidden', 403);
    deleteCookie(c, SESSION, { path: '/' });
    return c.redirect('/', 303);
  });

  return app;
}

/* ── MediaMTX HTTP auth ── */

export interface MtxAuthRequest {
  user?: string;
  password?: string;
  token?: string;
  ip?: string;
  action?: string;
  path?: string;
  protocol?: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Decide one MediaMTX auth request. Reads (FFmpeg, ffprobe, recorder) are only allowed from this machine. */
export function mtxAllows(cfg: Config, store: Store, r: MtxAuthRequest): { ok: boolean; who?: string } {
  const action = r.action ?? '';
  if (action !== 'publish') return { ok: LOOPBACK.has(r.ip ?? '') };
  let user = r.user ?? '';
  let pass = r.password ?? '';
  if (!user && r.token?.includes(':')) [user, pass] = [r.token.slice(0, r.token.indexOf(':')), r.token.slice(r.token.indexOf(':') + 1)];
  if (!user || !pass) return { ok: false };
  if (same(user, cfg.LIVE_PUBLISH_USER) && same(pass, cfg.LIVE_PUBLISH_PASS)) return { ok: true, who: 'station' };
  if (!cfg.bazzy) return { ok: false };
  const creator = store.creatorByHandle(user);
  if (!creator || !canGoLive(cfg, creator)) return { ok: false };
  if ((r.path ?? '') !== `live/${creator.handle}`) return { ok: false };
  return store.checkKey(creator, pass) ? { ok: true, who: creator.handle } : { ok: false };
}
