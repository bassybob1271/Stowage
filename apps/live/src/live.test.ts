import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bazzyHttp, mtxAllows, sign } from './auth.js';
import { loadConfig, type Config } from './config.js';
import { Recorder, startedAtFromName, type RecordingSink } from './recorder.js';
import { createServer } from './server.js';
import { handleFrom, Store } from './store.js';
import { mediamtxConfig, type Supervisor } from './supervisor.js';

const SECRET = 'x'.repeat(40);
let dir: string;
let cfg: Config;
let store: Store;

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    LIVE_PUBLISH_PASS: 'station-pass-123',
    LIVE_DATA_DIR: dir,
    LIVE_PUBLIC_URL: 'https://live.bazzy.io',
    LIVE_BAZZY_AUTH_URL: 'https://bazzyvideo.com',
    LIVE_BAZZY_CLIENT_SECRET: 'client-secret',
    LIVE_SESSION_SECRET: SECRET,
    LIVE_RECORD: 'true',
    ...extra,
  } as NodeJS.ProcessEnv);
}

const fakeSup = { encoder: 'x264', streams: () => [], get: () => undefined, livePaths: () => new Set<string>() } as unknown as Supervisor;
const cookieFor = (sub: string) => `bl_session=${sign(SECRET, { sub, e: Date.now() + 60_000 })}`;
const ORIGIN = { origin: 'https://live.bazzy.io' };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'live-'));
  cfg = config();
  store = await new Store(join(dir, 'state.json'), SECRET, ['publisher']).load();
});
afterEach(async () => {
  await store.flush();
  await rm(dir, { recursive: true, force: true });
});

describe('store', () => {
  it('makes unique, safe channel handles', async () => {
    expect(handleFrom('Bassy Bob!')).toBe('bassy-bob');
    expect(handleFrom('', 'jo@x.com', 'Zoë Ané')).toBe('zoe-ane');
    expect(handleFrom('A', 'admin@x.com')).toBe('admin');
    const a = await store.upsertCreator({ sub: '1', name: 'Bassy Bob' });
    const b = await store.upsertCreator({ sub: '2', name: 'Bassy Bob' });
    const c = await store.upsertCreator({ sub: '3', name: 'Studio' });
    const d = await store.upsertCreator({ sub: '4', name: 'Publisher' });
    expect([a.handle, b.handle, c.handle, d.handle]).toEqual(['bassy-bob', 'bassy-bob-2', 'studio-2', 'publisher-2']);
    expect((await store.upsertCreator({ sub: '1', name: 'Bob B', role: 'filmmaker' })).handle).toBe('bassy-bob');
  });

  it('keeps stream keys encrypted on disk and checks them', async () => {
    const c = await store.upsertCreator({ sub: '1', name: 'Bob' });
    const key = store.streamKey(c)!;
    await store.flush();
    expect(await readFile(join(dir, 'state.json'), 'utf8')).not.toContain(key);
    expect(store.checkKey(c, key)).toBe(true);
    expect(store.checkKey(c, key + 'x')).toBe(false);
    await store.rotateKey('1');
    expect(store.checkKey(c, key)).toBe(false);
    const reloaded = await new Store(join(dir, 'state.json'), SECRET).load();
    expect(reloaded.checkKey(reloaded.creatorBySub('1')!, store.streamKey(c)!)).toBe(true);
  });
});

describe('MediaMTX auth', () => {
  it('lets creators publish only to their own channel with their own key', async () => {
    const bob = await store.upsertCreator({ sub: '1', name: 'Bob', role: 'filmmaker' });
    const fan = await store.upsertCreator({ sub: '2', name: 'Fan', role: 'viewer' });
    const key = store.streamKey(bob)!;
    const pub = (user: string, password: string, path: string) => mtxAllows(cfg, store, { action: 'publish', user, password, path, ip: '203.0.113.9' }).ok;
    expect(pub('bob', key, 'live/bob')).toBe(true);
    expect(pub('bob', key, 'live/someone')).toBe(false);
    expect(pub('bob', 'wrong', 'live/bob')).toBe(false);
    expect(pub('fan', store.streamKey(fan)!, 'live/fan')).toBe(false); // viewers can't go live
    expect(pub('publisher', 'station-pass-123', 'live/anything')).toBe(true);
    expect(pub('publisher', 'nope', 'live/anything')).toBe(false);
    expect(mtxAllows(cfg, store, { action: 'publish', token: `bob:${key}`, path: 'live/bob' }).ok).toBe(true);
  });

  it('allows reads from this machine only', () => {
    expect(mtxAllows(cfg, store, { action: 'read', ip: '127.0.0.1', path: 'live/bob' }).ok).toBe(true);
    expect(mtxAllows(cfg, store, { action: 'read', ip: '198.51.100.4', path: 'live/bob' }).ok).toBe(false);
  });

  it('points MediaMTX at the hook and records when asked', () => {
    const y = mediamtxConfig(cfg, { authUrl: 'http://127.0.0.1:8790/internal/mtx-auth/s3cret', record: true });
    expect(y).toContain('authMethod: http');
    expect(y).toContain('"http://127.0.0.1:8790/internal/mtx-auth/s3cret"');
    expect(y).toContain('record: yes');
    expect(y).toContain('recordFormat: fmp4');
    expect(y).not.toContain('station-pass-123');
  });
});

describe('recorder', () => {
  async function file(rel: string, bytes = 2048, ageMs = 120_000) {
    const f = join(cfg.recordDir, rel);
    await mkdir(join(f, '..'), { recursive: true });
    await writeFile(f, Buffer.alloc(bytes, 1));
    const t = new Date(Date.now() - ageMs);
    await utimes(f, t, t);
    return f;
  }

  it('uploads finished shows to B2, skips live and short ones', async () => {
    await store.upsertCreator({ sub: '1', name: 'Bob', role: 'filmmaker' });
    const done = await file('live/bob/2026-11-25_20-00-00-000001.mp4');
    const fresh = await file('live/bob/2026-11-25_21-00-00-000001.mp4', 10, 1000);
    const short = await file('live/x/2026-11-25_19-00-00-000001.mp4');
    const puts: string[] = [];
    const sink: RecordingSink = { put: async (k) => void puts.push(k), url: async (k) => `https://s3.us-west-004.backblazeb2.com/b/${k}?sig`, remove: async () => {}, origin: 'https://s3.us-west-004.backblazeb2.com' };
    const rec = new Recorder(cfg, store, () => new Set(['live/bob']), sink, async (f) => (f === short ? 3 : 3725));
    await rec.scan();
    expect(puts).toEqual(['recordings/live-bob/2026-11-25_20-00-00-000001.mp4']);
    const [r] = store.recordings();
    expect(r).toMatchObject({ handle: 'bob', title: 'Bob', durationSec: 3725, storage: 'b2', slug: 'live-bob' });
    expect(existsSync(done)).toBe(false); // uploaded copy removed
    expect(existsSync(fresh)).toBe(true); // still being written
    expect(existsSync(short)).toBe(false); // dropped
    await rec.scan();
    expect(puts).toHaveLength(1); // nothing twice
  });

  it('parses start times from MediaMTX file names', () => {
    expect(startedAtFromName('2026-11-25_20-04-05-1.mp4', new Date(0))).toBe(new Date(2026, 10, 25, 20, 4, 5).toISOString());
    expect(startedAtFromName('junk.mp4', new Date(0))).toBe(new Date(0).toISOString());
  });
});

describe('server', () => {
  const app = (rec?: Recorder) => createServer(cfg, fakeSup, { store, recorder: rec, hookSecret: 'hook-secret-value' });

  it('answers MediaMTX only on the secret URL and never through the tunnel', async () => {
    const a = app();
    const body = JSON.stringify({ action: 'publish', user: 'publisher', password: 'station-pass-123', path: 'live/a' });
    const h = { 'content-type': 'application/json' };
    expect((await a.request('/internal/mtx-auth/hook-secret-value', { method: 'POST', body, headers: h })).status).toBe(200);
    expect((await a.request('/internal/mtx-auth/wrong-secret-value', { method: 'POST', body, headers: h })).status).toBe(404);
    expect((await a.request('/internal/mtx-auth/hook-secret-value', { method: 'POST', body, headers: { ...h, 'cf-connecting-ip': '1.2.3.4' } })).status).toBe(404);
  });

  it('signs in with Bazzy TV and shows the creator their OBS settings', async () => {
    const a = app();
    const start = await a.request('/auth/bazzy/start');
    const loc = new URL(start.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://bazzyvideo.com/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('bazzylive');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://live.bazzy.io/auth/bazzy/callback');
    const pending = start.headers.get('set-cookie')!.split(';')[0]!;

    const calls: string[] = [];
    bazzyHttp.fetch = async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/token')) {
        expect(String(init?.body)).toContain('code_verifier=');
        return Response.json({ access_token: 'at' });
      }
      return Response.json({ sub: 42, name: 'Bassy Bob', email: 'bob@bazzy.tv', role: 'filmmaker' });
    };
    const cb = await a.request(`/auth/bazzy/callback?code=c1&state=${loc.searchParams.get('state')}`, { headers: { cookie: pending } });
    expect(cb.status).toBe(303);
    expect(cb.headers.get('location')).toBe('/studio');
    expect(calls).toEqual(['https://bazzyvideo.com/api/v1/oauth/token', 'https://bazzyvideo.com/api/v1/oauth/userinfo']);
    const session = cb.headers.getSetCookie().find((c) => c.startsWith('bl_session='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/Secure/i);

    const me = await (await a.request('/api/me', { headers: { cookie: session.split(';')[0]! } })).json();
    expect(me).toMatchObject({ signedIn: true, handle: 'bassy-bob', canGoLive: true, watch: 'https://live.bazzy.io/watch/live-bassy-bob' });
    expect(me.obs.server).toBe('rtmp://127.0.0.1:1935/live');
    const key = store.streamKey(store.creatorBySub('42')!)!;
    expect(me.obs.streamKey).toBe(`bassy-bob?user=bassy-bob&pass=${key}`);
  });

  it('rejects a callback with the wrong state', async () => {
    const a = app();
    const start = await a.request('/auth/bazzy/start');
    const r = await a.request('/auth/bazzy/callback?code=c&state=forged', { headers: { cookie: start.headers.get('set-cookie')!.split(';')[0]! } });
    expect(r.headers.get('location')).toMatch(/^\/studio\?error=/);
  });

  it('resets keys only from our own pages', async () => {
    const c = await store.upsertCreator({ sub: '7', name: 'Bob', role: 'filmmaker' });
    const before = store.streamKey(c);
    const a = app();
    expect((await a.request('/api/me/key', { method: 'POST', headers: { cookie: cookieFor('7'), origin: 'https://evil.example' } })).status).toBe(403);
    expect((await a.request('/api/me/key', { method: 'POST', headers: { cookie: cookieFor('7'), ...ORIGIN } })).status).toBe(200);
    expect(store.streamKey(c)).not.toBe(before);
  });

  it('serves local replays with Range, lists them and lets only the creator delete', async () => {
    await store.upsertCreator({ sub: '1', name: 'Bob', role: 'filmmaker' });
    await store.upsertCreator({ sub: '2', name: 'Other', role: 'filmmaker' });
    const rel = 'live/bob/2026-11-25_20-00-00-000001.mp4';
    await mkdir(join(cfg.recordDir, 'live/bob'), { recursive: true });
    await writeFile(join(cfg.recordDir, rel), Buffer.from('0123456789'));
    const old = new Date(Date.now() - 120_000);
    await utimes(join(cfg.recordDir, rel), old, old);
    const rec = new Recorder(cfg, store, () => new Set(), undefined, async () => 60);
    await rec.scan();
    const a = app(rec);
    const { recordings } = await (await a.request('/api/recordings')).json();
    expect(recordings).toHaveLength(1);
    const r = recordings[0];
    expect((await a.request(r.page)).status).toBe(200);
    const part = await a.request(r.url, { headers: { range: 'bytes=2-5' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await part.text()).toBe('2345');
    expect((await a.request(`/api/recordings/${r.id}`, { method: 'DELETE', headers: { cookie: cookieFor('2'), ...ORIGIN } })).status).toBe(403);
    expect((await a.request(`/api/recordings/${r.id}`, { method: 'DELETE', headers: { cookie: cookieFor('1'), ...ORIGIN } })).status).toBe(200);
    expect(store.recordings()).toHaveLength(0);
    expect(existsSync(join(cfg.recordDir, rel))).toBe(false);
  });

  it('redirects B2 replays to a signed URL and allows that origin in the CSP', async () => {
    const sink: RecordingSink = { put: async () => {}, url: async (k) => `https://s3.us-west-004.backblazeb2.com/bucket/${k}?X-Amz-Signature=abc`, remove: async () => {}, origin: 'https://s3.us-west-004.backblazeb2.com' };
    await store.addRecording({ id: 'rec123456', path: 'live/bob', slug: 'live-bob', title: 'Bob', startedAt: new Date().toISOString(), durationSec: 60, bytes: 1, mime: 'video/mp4', storage: 'b2', key: 'recordings/live-bob/a.mp4', src: 'live/bob/a.mp4', createdAt: new Date().toISOString() });
    const a = app(new Recorder(cfg, store, () => new Set(), sink));
    const r = await a.request('/rec/rec123456.mp4');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('recordings/live-bob/a.mp4');
    const page = await a.request('/replay/rec123456');
    expect(page.headers.get('content-security-policy')).toContain('media-src \'self\' blob: https://s3.us-west-004.backblazeb2.com');
  });

  it('links Bazzy TV and BazzyBox in the header', async () => {
    const html = await (await app().request('/')).text();
    expect(html).toContain('href="https://bazzyvideo.com"');
    expect(html).toContain('href="https://box.bazzy.io"');
    expect(html).toContain('href="/studio"');
  });
});
