import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { MountRegistry } from '../src/mounts.js';
import { createApp, createContext, type AppContext } from '../src/app.js';
import { BoxService } from '../src/box/service.js';
import { signWebhook, verifyWebhook } from '../src/box/stripe.js';
import { DAY_MS, GB, TB, allowedBytes, dailyOverageMc, plans, proratedRefundMc, sendChargeMc } from '../src/box/pricing.js';

const dir = mkdtempSync(join(tmpdir(), 'bazzybox-'));
writeFileSync(join(dir, 'mounts.yaml'), `mounts:\n  - id: box\n    label: b2\n    kind: local\n    config: { root: "${join(dir, 'files')}" }\n`);

const env = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'x'.repeat(48),
  MASTER_KEY: 'a'.repeat(64),
  DATABASE_URL: 'file::memory:',
  MOUNTS_FILE: join(dir, 'mounts.yaml'),
  DATA_DIR: join(dir, 'data'),
  RECONCILE_INTERVAL_SEC: '0',
  WEB_DIST: join(dir, 'no-web'),
  BAZZYBOX: 'true',
  BOX_FREE_GB: '0.000005', // 5 KB free space keeps quota tests small
  BOX_DEV_CREDITS: 'true',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  BOX_METER_INTERVAL_SEC: '0',
} as NodeJS.ProcessEnv;
const cfg = loadConfig(env);

let app: ReturnType<typeof createApp>;
let ctx: AppContext;
let db: Db;
const json = { 'content-type': 'application/json' };

async function signup(email: string) {
  const r = await app.request('/api/auth/box/signup', { method: 'POST', headers: json, body: JSON.stringify({ email, password: 'correct horse battery' }) });
  expect(r.status).toBe(201);
  return r.headers.get('set-cookie')!.split(';')[0]!;
}
const as = (cookie: string) => (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { cookie, ...(init.headers as Record<string, string>) } });

let alice: ReturnType<typeof as>;
let bob: ReturnType<typeof as>;
let aliceMount = '';

beforeAll(async () => {
  db = await openDb(cfg.DATABASE_URL);
  const mounts = new MountRegistry(db, cfg.MASTER_KEY);
  await mounts.load(cfg.MOUNTS_FILE);
  await mounts.checkHealth(0);
  ctx = await createContext(cfg, db, mounts);
  app = createApp(ctx);
  alice = as(await signup('alice@example.com'));
  bob = as(await signup('bob@example.com'));
  aliceMount = ((await (await alice('/api/mounts')).json()) as { mounts: { id: string }[] }).mounts[0]!.id;
});

describe('pricing', () => {
  const p = plans(10);
  it('charges extra storage by the day', () => {
    expect(dailyOverageMc(p.flex, 0)).toBe(0);
    // 1 TB extra = 950 credits / 30 days = 31.67 credits/day
    expect(dailyOverageMc(p.flex, TB)).toBe(31667);
    expect(dailyOverageMc(p.free, TB)).toBe(0);
  });
  it('lets the wallet extend space by a week of runway', () => {
    expect(allowedBytes(p.free, 1e9)).toBe(10 * GB);
    expect(allowedBytes(p.flex, 0)).toBe(3 * TB);
    // 950 credits covers 1 TB for 30 days, so ~4.29 TB for a week
    expect(allowedBytes(p.flex, 950_000) / TB).toBeCloseTo(3 + 30 / 7, 2);
  });
  it('refunds unused days on downgrade', () => {
    const start = 0;
    const end = 30 * DAY_MS;
    expect(proratedRefundMc(p.flex, start, end, 15 * DAY_MS)).toBe(499_500);
    expect(proratedRefundMc(p.flex, start, end, end)).toBe(0);
  });
  it('bills sends past the free allowance', () => {
    expect(sendChargeMc(p.flex, 0, 50 * GB)).toBe(0);
    expect(sendChargeMc(p.flex, 50 * GB, GB)).toBe(4000);
    expect(sendChargeMc(p.flex, 49 * GB, 2 * GB)).toBe(4000);
  });
});

describe('accounts and isolation', () => {
  it('reports a BazzyBox session', async () => {
    const s = await (await alice('/api/auth/session')).json();
    expect(s).toMatchObject({ authenticated: true, provider: 'box', account: true, admin: false });
  });

  it('rejects duplicate emails, short passwords and wrong passwords', async () => {
    const dup = await app.request('/api/auth/box/signup', { method: 'POST', headers: json, body: JSON.stringify({ email: 'ALICE@example.com', password: 'correct horse battery' }) });
    expect(dup.status).toBe(409);
    const short = await app.request('/api/auth/box/signup', { method: 'POST', headers: json, body: JSON.stringify({ email: 'c@example.com', password: 'short' }) });
    expect(short.status).toBe(400);
    const bad = await app.request('/api/auth/box/login', { method: 'POST', headers: json, body: JSON.stringify({ email: 'alice@example.com', password: 'wrong password!!' }) });
    expect(bad.status).toBe(401);
    const ok = await app.request('/api/auth/box/login', { method: 'POST', headers: json, body: JSON.stringify({ email: 'alice@example.com', password: 'correct horse battery' }) });
    expect(ok.status).toBe(200);
  });

  it('shows each user only their own mount', async () => {
    const a = (await (await alice('/api/mounts')).json()) as { mounts: { id: string; label: string }[] };
    expect(a.mounts).toHaveLength(1);
    expect(a.mounts[0]!.label).toBe('BazzyBox');
    expect(a.mounts[0]!.id).toMatch(/^box-[0-9a-f]{16}$/);
    // Bob can't touch Alice's mount, and nobody can reach the shared backing mount.
    expect((await bob(`/api/fs/${aliceMount}/list?path=`)).status).toBe(404);
    expect((await alice('/api/fs/box/list?path=')).status).toBe(404);
    expect((await alice('/api/mounts', { method: 'POST', headers: json, body: '{}' })).status).toBe(403);
  });

  it('uploads into the user folder and keeps it private', async () => {
    const up = await alice(`/api/fs/${aliceMount}/upload?path=song.wav`, { method: 'POST', body: 'RIFF1234', headers: { 'content-length': '8' } });
    expect(up.status).toBe(201);
    const list = (await (await alice(`/api/fs/${aliceMount}/list?path=`)).json()) as { entries: { name: string }[] };
    expect(list.entries.map((e) => e.name)).toEqual(['song.wav']);
    const raw = await alice(`/api/fs/${aliceMount}/raw?path=song.wav`);
    expect(await raw.text()).toBe('RIFF1234');
    const search = (await (await bob('/api/search?q=song')).json()) as { results: unknown[] };
    expect(search.results).toHaveLength(0);
  });

  it('ignores a forged tus subject header', async () => {
    const meta = `mount ${btoa('box')},filename ${btoa('x.bin')}`;
    const r = await bob('/api/tus', { method: 'POST', headers: { 'tus-resumable': '1.0.0', 'upload-length': '4', 'upload-metadata': meta, 'x-stowage-sub': 'owner' } });
    expect(r.status).toBe(404);
  });
});

describe('quota, plans and credits', () => {
  it('enforces the free space limit', async () => {
    await ctx.box!.refreshUsage(aliceMount.slice(4));
    const big = 'x'.repeat(6000);
    const r = await alice(`/api/fs/${aliceMount}/upload?path=too-big.bin`, { method: 'POST', body: big, headers: { 'content-length': String(big.length) } });
    expect(r.status).toBe(507);
  });

  it('upgrades from the wallet and refunds unused days on downgrade', async () => {
    expect((await alice('/api/box/plan', { method: 'POST', headers: json, body: JSON.stringify({ plan: 'flex' }) })).status).toBe(402);
    const top = (await (await alice('/api/box/credits', { method: 'POST', headers: json, body: JSON.stringify({ pack: 'p10' }) })).json()) as { wallet: { credits: number } };
    expect(top.wallet.credits).toBe(1000);
    const up = (await (await alice('/api/box/plan', { method: 'POST', headers: json, body: JSON.stringify({ plan: 'flex' }) })).json()) as {
      plan: { id: string; includedBytes: number };
      wallet: { credits: number };
    };
    expect(up.plan.id).toBe('flex');
    expect(up.plan.includedBytes).toBe(3 * TB);
    expect(up.wallet.credits).toBe(1);
    const down = (await (await alice('/api/box/plan', { method: 'POST', headers: json, body: JSON.stringify({ plan: 'free' }) })).json()) as {
      plan: { id: string };
      wallet: { credits: number };
      history: { kind: string }[];
    };
    expect(down.plan.id).toBe('free');
    expect(down.wallet.credits).toBeGreaterThan(999);
    expect(down.history[0]!.kind).toBe('refund');
  });

  it('credits a Stripe checkout once, even if the webhook repeats', async () => {
    const id = aliceMount.slice(4);
    const before = (await ctx.box!.get(id)).walletMc;
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', metadata: { account_id: id, pack: 'p25' } } } });
    const send = () => app.request('/api/box/webhook/stripe', { method: 'POST', body, headers: { 'stripe-signature': signWebhook(body, 'whsec_test') } });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await ctx.box!.get(id)).walletMc - before).toBe(2_600_000);
    const forged = await app.request('/api/box/webhook/stripe', { method: 'POST', body, headers: { 'stripe-signature': signWebhook(body, 'wrong') } });
    expect(forged.status).toBe(400);
  });

  it('rejects stale webhook signatures', () => {
    const body = '{}';
    expect(verifyWebhook(body, signWebhook(body, 's', 1000), 's', 1000)).toEqual({});
    expect(verifyWebhook(body, signWebhook(body, 's', 1000), 's', 2000)).toBeNull();
  });
});

describe('share links', () => {
  it('serves a public link and counts the bytes against the owner', async () => {
    const r = (await (await alice('/api/box/shares', { method: 'POST', headers: json, body: JSON.stringify({ path: 'song.wav', days: 3 }) })).json()) as { url: string };
    const pub = await app.request(r.url);
    expect(pub.status).toBe(200);
    expect(await pub.text()).toBe('RIFF1234');
    const me = (await (await alice('/api/box/me')).json()) as { usage: { sendBytes: number } };
    expect(me.usage.sendBytes).toBe(8);
    expect((await app.request('/s/not-a-token')).status).toBe(404);
  });
});

describe('meter and renewals', () => {
  it('renews Flex from the wallet, then drops to Free without deleting files', async () => {
    let clock = Date.now();
    const box = new BoxService(cfg, db, ctx.mounts, () => clock);
    const a = await box.signup('carol@example.com', 'correct horse battery');
    await box.ledger(a.id, 1_500_000, 'topup', 'test');
    await box.changePlan(a.id, 'flex'); // wallet 1500 - 999 = 501 credits
    await box.mountFor(a.id).adapter.write('keep.txt', new Blob(['hi']).stream(), {});
    clock += 31 * DAY_MS;
    await box.meter(a.id);
    let s = await box.summary(a.id);
    expect(s.plan.id).toBe('free'); // 501 credits can't pay 999
    expect(s.history.some((h) => h.note.includes('moved to Free'))).toBe(true);
    expect(await box.mountFor(a.id).adapter.stat('keep.txt')).not.toBeNull();
    await box.ledger(a.id, 2_000_000, 'topup', 'test');
    await box.changePlan(a.id, 'flex');
    clock += 30 * DAY_MS;
    await box.meter(a.id);
    s = await box.summary(a.id);
    expect(s.plan.id).toBe('flex');
    expect(s.wallet.credits).toBeCloseTo(2501 - 999 * 2, 0);
  });
});

describe('Studio plan', () => {
  it('prices Studio at $79.99 for 15 TB, then $6 per TB-month', () => {
    const s = plans().studio;
    expect(s.priceCredits).toBe(7999);
    expect(s.includedBytes).toBe(15 * TB);
    expect(dailyOverageMc(s, 5 * TB) * 30).toBeCloseTo(5 * 600 * 1000, -2);
  });

  it('refuses a switch the wallet cannot cover and leaves plan and wallet untouched', async () => {
    let clock = Date.now();
    const box = new BoxService(cfg, db, ctx.mounts, () => clock);
    const a = await box.signup('dana@example.com', 'correct horse battery');
    await box.ledger(a.id, 7_999_000, 'topup', 'test');
    await box.changePlan(a.id, 'flex'); // wallet 7,000
    clock += 15 * DAY_MS; // ~499 unused Flex credits: 7,499 < 7,999
    await expect(box.changePlan(a.id, 'studio')).rejects.toMatchObject({ status: 402 });
    const s = await box.summary(a.id);
    expect(s.plan.id).toBe('flex');
    expect(s.wallet.credits).toBe(7000);
    expect(s.history.some((h) => h.kind === 'refund')).toBe(false);
  });

  it('switches Flex to Studio mid-period, crediting unused Flex days first', async () => {
    let clock = Date.now();
    const box = new BoxService(cfg, db, ctx.mounts, () => clock);
    const a = await box.signup('erin@example.com', 'correct horse battery');
    await box.ledger(a.id, 8_600_000, 'topup', 'test');
    await box.changePlan(a.id, 'flex'); // wallet 7,601
    clock += 15 * DAY_MS;
    await box.changePlan(a.id, 'studio');
    const s = await box.summary(a.id);
    expect(s.plan.id).toBe('studio');
    expect(s.plan.includedBytes).toBe(15 * TB);
    // 7,601 + 499.5 unused Flex days - 7,999 Studio
    expect(s.wallet.credits).toBeCloseTo(7601 + 999 / 2 - 7999, 0);
    expect(s.history.map((h) => h.kind).slice(0, 2)).toEqual(['plan', 'refund']);
  });
});

describe('public website', () => {
  it('serves the BazzyBox site at / to visitors without a session', async () => {
    const r = await app.request('/');
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<title>BazzyBox</title>');
    expect(html).toContain('$9.99'); // Flex price comes from pricing.ts
    expect(html).toContain('href="/signup"');
    expect(html).toContain('https://video.bazzy.tv'); // link back to Bazzy TV
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(html).not.toMatch(/<script>(?!<\/script>)/); // no inline script
  });

  it('serves the calculator script', async () => {
    const r = await app.request('/site.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    expect(await r.text()).toContain('Dropbox Plus');
  });

  it('sends signed-in users past the site to the app', async () => {
    const r = await alice('/');
    expect(await r.text()).not.toContain('<title>BazzyBox</title>');
  });
});
