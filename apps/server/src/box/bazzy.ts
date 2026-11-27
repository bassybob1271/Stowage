/**
 * "Sign in with Bazzy TV": OAuth 2.0 authorization code + PKCE against the Bazzy TV website
 * (bazzy-video), which handles email/password, Google and Apple sign-in itself.
 *
 *   GET /api/auth/bazzy/start      → Bazzy TV /oauth/authorize (state + PKCE kept in a signed cookie)
 *   GET /api/auth/bazzy/callback   → swap the code (server to server), read /oauth/userinfo,
 *                                    link or create the BazzyBox account, start a session, go to "/"
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppContext } from '../app.js';
import type { Config } from '../config.js';
import { signToken, verifyToken } from '../crypto.js';
import { log } from '../log.js';
import { BoxError, userSub, type BoxService } from './service.js';

const COOKIE = 'bz_bazzy';
const MEMBER = 'bazzy_member';

/**
 * bazzy.tv sends returning members straight to their app. That marker lives on .bazzy.tv,
 * so Box only sets it when it's served from a bazzy.tv address (box.bazzy.tv). No account data in it.
 */
export function setMemberMarker(c: Context, cfg: Config, on: boolean) {
  const host = new URL(origin(c, cfg)).hostname;
  if (host !== 'bazzy.tv' && !host.endsWith('.bazzy.tv')) return;
  if (on) setCookie(c, MEMBER, 'box', { domain: '.bazzy.tv', path: '/', maxAge: 31536000, sameSite: 'Lax', secure: true });
  else deleteCookie(c, MEMBER, { domain: '.bazzy.tv', path: '/', secure: true });
}
const TTL_SEC = 600;

/** Swappable for tests. */
export const bazzyHttp = { fetch: (input: string, init?: RequestInit) => fetch(input, init) };

export const bazzyEnabled = (cfg: Config) => Boolean(cfg.BAZZYBOX && cfg.BAZZY_AUTH_URL && cfg.BAZZY_CLIENT_SECRET);

function origin(c: Context, cfg: Config) {
  return (cfg.APP_ORIGIN ?? new URL(c.req.url).origin).replace(/\/$/, '');
}
const callbackUrl = (c: Context, cfg: Config) => `${origin(c, cfg)}/api/auth/bazzy/callback`;
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

interface Pending {
  s: string; // state
  v: string; // PKCE verifier
  e: number; // expiry (ms)
}

export function bazzyRoutes(ctx: AppContext, box: BoxService) {
  const { cfg } = ctx;
  const app = new Hono();
  const base = () => cfg.BAZZY_AUTH_URL!.replace(/\/$/, '');
  const back = (c: Context, error: string) => {
    deleteCookie(c, COOKIE, { path: '/api/auth/bazzy' });
    return c.redirect(`/login?error=${encodeURIComponent(error)}`, 303);
  };

  app.get('/auth/bazzy/start', (c) => {
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    setCookie(c, COOKIE, signToken(cfg.SESSION_SECRET, { s: state, v: verifier, e: Date.now() + TTL_SEC * 1000 } satisfies Pending), {
      httpOnly: true,
      secure: origin(c, cfg).startsWith('https://'),
      sameSite: 'Lax', // the return trip is a top-level GET redirect from Bazzy TV
      path: '/api/auth/bazzy',
      maxAge: TTL_SEC,
    });
    const q = new URLSearchParams({
      ...(c.req.query('signup') ? { screen: 'signup' } : {}),
      response_type: 'code',
      client_id: cfg.BAZZY_CLIENT_ID,
      redirect_uri: callbackUrl(c, cfg),
      scope: 'openid profile email',
      state,
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
    });
    return c.redirect(`${base()}/oauth/authorize?${q}`, 302);
  });

  app.get('/auth/bazzy/callback', async (c) => {
    const error = c.req.query('error');
    if (error) return back(c, error === 'access_denied' ? 'Bazzy TV sign-in was cancelled.' : 'Bazzy TV sign-in failed. Try again.');
    const pending = verifyToken<Pending>(cfg.SESSION_SECRET, getCookie(c, COOKIE) ?? '');
    const state = c.req.query('state') ?? '';
    const code = c.req.query('code') ?? '';
    if (!pending || pending.e < Date.now()) return back(c, 'Your sign-in session expired. Try again.');
    if (!state || !same(pending.s, state) || !code) return back(c, 'Sign-in could not be verified. Try again.');

    try {
      const tok = await bazzyHttp.fetch(`${base()}/api/v1/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${cfg.BAZZY_CLIENT_ID}:${cfg.BAZZY_CLIENT_SECRET}`).toString('base64')}`,
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl(c, cfg), code_verifier: pending.v }),
      });
      if (!tok.ok) {
        log.warn('box.bazzy_token_failed', { status: tok.status, body: (await tok.text()).slice(0, 200) });
        return back(c, 'Bazzy TV sign-in failed. Try again.');
      }
      const { access_token } = (await tok.json()) as { access_token?: string };
      const me = await bazzyHttp.fetch(`${base()}/api/v1/oauth/userinfo`, { headers: { authorization: `Bearer ${access_token}` } });
      if (!me.ok) return back(c, 'Bazzy TV sign-in failed. Try again.');
      const info = (await me.json()) as { sub?: string; email?: string; email_verified?: boolean };
      if (!info.sub) return back(c, 'Bazzy TV sign-in failed. Try again.');

      const account = await box.signInWithBazzy({ sub: String(info.sub), email: info.email, emailVerified: info.email_verified === true });
      deleteCookie(c, COOKIE, { path: '/api/auth/bazzy' });
      await ctx.sessions.issue(c, userSub(account.id));
      setMemberMarker(c, cfg, true);
      log.info('box.bazzy_login', { account: account.id });
      return c.redirect('/', 303);
    } catch (e) {
      if (e instanceof BoxError) return back(c, e.message);
      log.warn('box.bazzy_error', { error: (e as Error).message });
      return back(c, 'Bazzy TV sign-in failed. Try again.');
    }
  });

  return app;
}
