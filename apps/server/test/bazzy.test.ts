import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { MountRegistry } from '../src/mounts.js';
import { createApp, createContext } from '../src/app.js';
import { bazzyHttp } from '../src/box/bazzy.js';

const dir = mkdtempSync(join(tmpdir(), 'bazzy-signin-'));
writeFileSync(join(dir, 'mounts.yaml'), `mounts:\n  - id: box\n    label: b2\n    kind: local\n    config: { root: "${join(dir, 'files')}" }\n`);

const cfg = loadConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'x'.repeat(48),
  MASTER_KEY: 'a'.repeat(64),
  DATABASE_URL: 'file::memory:',
  MOUNTS_FILE: join(dir, 'mounts.yaml'),
  DATA_DIR: join(dir, 'data'),
  RECONCILE_INTERVAL_SEC: '0',
  WEB_DIST: join(dir, 'no-web'),
  BAZZYBOX: 'true',
  BOX_METER_INTERVAL_SEC: '0',
  APP_ORIGIN: 'https://box.test',
  BAZZY_AUTH_URL: 'https://video.test',
  BAZZY_CLIENT_ID: 'bazzybox',
  BAZZY_CLIENT_SECRET: 'box-secret',
} as NodeJS.ProcessEnv);

let app: ReturnType<typeof createApp>;
const json = { 'content-type': 'application/json' };

/** A fake Bazzy TV: issues a code for whoever `nextUser` is, and checks client auth + PKCE like the real one. */
let nextUser: { sub: string; email: string; email_verified: boolean } = { sub: 'u1', email: 'a@example.com', email_verified: true };
const codes = new Map<string, { challenge: string; user: typeof nextUser }>();
const calls: string[] = [];

bazzyHttp.fetch = async (url: string, init?: RequestInit) => {
  calls.push(url);
  if (url === 'https://video.test/api/v1/oauth/token') {
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Basic ${Buffer.from('bazzybox:box-secret').toString('base64')}`) return Response.json({ error: 'invalid_client' }, { status: 401 });
    const form = new URLSearchParams(init!.body as string);
    const grant = codes.get(form.get('code')!);
    codes.delete(form.get('code')!);
    if (!grant || form.get('redirect_uri') !== 'https://box.test/api/auth/bazzy/callback') return Response.json({ error: 'invalid_grant' }, { status: 400 });
    if (createHash('sha256').update(form.get('code_verifier')!).digest('base64url') !== grant.challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    return Response.json({ access_token: `at-${grant.user.sub}`, token_type: 'Bearer', expires_in: 900 });
  }
  if (url === 'https://video.test/api/v1/oauth/userinfo') {
    const sub = new Headers(init?.headers).get('authorization')?.replace('Bearer at-', '');
    return sub === nextUser.sub ? Response.json(nextUser) : Response.json({ error: 'invalid_token' }, { status: 401 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

/** Runs the browser side: start → (Bazzy TV approves) → callback. Returns the callback response. */
async function signIn(opts: { tamperState?: boolean } = {}) {
  const start = await app.request('/api/auth/bazzy/start');
  expect(start.status).toBe(302);
  const to = new URL(start.headers.get('location')!);
  expect(`${to.origin}${to.pathname}`).toBe('https://video.test/oauth/authorize');
  const q = to.searchParams;
  expect(q.get('client_id')).toBe('bazzybox');
  expect(q.get('redirect_uri')).toBe('https://box.test/api/auth/bazzy/callback');
  expect(q.get('code_challenge_method')).toBe('S256');
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const code = randomBytes(16).toString('hex');
  codes.set(code, { challenge: q.get('code_challenge')!, user: { ...nextUser } });
  const state = opts.tamperState ? 'forged' : q.get('state')!;
  return app.request(`/api/auth/bazzy/callback?code=${code}&state=${encodeURIComponent(state)}`, { headers: { cookie } });
}
const sessionOf = (r: Response) => r.headers.getSetCookie().find((c) => !c.startsWith('bz_bazzy'))!.split(';')[0]!;

beforeAll(async () => {
  const db = await openDb(cfg.DATABASE_URL);
  const mounts = new MountRegistry(db, cfg.MASTER_KEY);
  await mounts.load(cfg.MOUNTS_FILE);
  await mounts.checkHealth(0);
  app = createApp(await createContext(cfg, db, mounts));
});

describe('Sign in with Bazzy TV', () => {
  it('advertises the button to the web app', async () => {
    expect(((await (await app.request('/api/auth/session')).json()) as { bazzy: boolean }).bazzy).toBe(true);
  });

  it('creates a BazzyBox account on first sign-in and signs the user in', async () => {
    nextUser = { sub: 'bz-1', email: 'Maker@Example.com', email_verified: true };
    const r = await signIn();
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/');
    const me = await app.request('/api/box/me', { headers: { cookie: sessionOf(r) } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { account: { email: string } }).account.email).toBe('maker@example.com');
  });

  it('returns the same account next time, even if the Bazzy email changed', async () => {
    const first = await (await app.request('/api/box/me', { headers: { cookie: sessionOf(await signIn()) } })).json();
    nextUser = { sub: 'bz-1', email: 'renamed@example.com', email_verified: true };
    const again = await (await app.request('/api/box/me', { headers: { cookie: sessionOf(await signIn()) } })).json();
    expect((again as { account: { id: string } }).account.id).toBe((first as { account: { id: string } }).account.id);
  });

  it('links a verified Bazzy email to an existing password account', async () => {
    const su = await app.request('/api/auth/box/signup', { method: 'POST', headers: json, body: JSON.stringify({ email: 'pw@example.com', password: 'correct horse battery' }) });
    expect(su.status).toBe(201);
    const pwMe = (await (await app.request('/api/box/me', { headers: { cookie: su.headers.get('set-cookie')!.split(';')[0]! } })).json()) as { account: { id: string } };
    nextUser = { sub: 'bz-2', email: 'pw@example.com', email_verified: true };
    const viaBazzy = (await (await app.request('/api/box/me', { headers: { cookie: sessionOf(await signIn()) } })).json()) as { account: { id: string } };
    expect(viaBazzy.account.id).toBe(pwMe.account.id);
  });

  it('refuses an unverified Bazzy email that matches someone else’s account', async () => {
    await app.request('/api/auth/box/signup', { method: 'POST', headers: json, body: JSON.stringify({ email: 'victim@example.com', password: 'correct horse battery' }) });
    nextUser = { sub: 'bz-attacker', email: 'victim@example.com', email_verified: false };
    const r = await signIn();
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toMatch(/^\/login\?error=/);
    expect(r.headers.getSetCookie().some((c) => c.startsWith('stowage'))).toBe(false);
  });

  it('rejects a forged state without calling Bazzy TV', async () => {
    calls.length = 0;
    const r = await signIn({ tamperState: true });
    expect(r.headers.get('location')).toMatch(/^\/login\?error=/);
    expect(calls).toEqual([]);
  });

  it('passes a cancelled consent back as a friendly error', async () => {
    const r = await app.request('/api/auth/bazzy/callback?error=access_denied&state=x');
    expect(decodeURIComponent(r.headers.get('location')!)).toContain('cancelled');
  });
});
