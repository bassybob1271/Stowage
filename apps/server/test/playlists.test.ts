import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { MountRegistry } from '../src/mounts.js';
import { createApp, createContext, type AppContext } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'playlists-'));
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
} as NodeJS.ProcessEnv);

let app: ReturnType<typeof createApp>;
let ctx: AppContext;
const json = { 'content-type': 'application/json' };
type Pl = { id: string; title: string; tracks: { path: string; title: string; kind: string }[]; coverUrl: string | null; shareUrl: string | null };

async function account(email: string) {
  const r = await app.request('/api/auth/box/signup', { method: 'POST', headers: json, body: JSON.stringify({ email, password: 'correct horse battery' }) });
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  const mount = ((await (await app.request('/api/mounts', { headers: { cookie } })).json()) as { mounts: { id: string }[] }).mounts[0]!.id;
  const id = mount.slice(4);
  const call = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { cookie, ...(init.headers as Record<string, string>) } });
  return { call, id };
}
const put = async (id: string, path: string, bytes: number) =>
  ctx.box!.mountFor(id).adapter.write(path, new Blob([new Uint8Array(bytes).fill(7)]).stream(), {});

// A real 1×1 PNG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a0b10000000049454e44ae426082', 'hex');

let alice: Awaited<ReturnType<typeof account>>;
let bob: Awaited<ReturnType<typeof account>>;

beforeAll(async () => {
  const db = await openDb(cfg.DATABASE_URL);
  const mounts = new MountRegistry(db, cfg.MASTER_KEY);
  await mounts.load(cfg.MOUNTS_FILE);
  await mounts.checkHealth(0);
  ctx = await createContext(cfg, db, mounts);
  app = createApp(ctx);
  alice = await account('alice@example.com');
  bob = await account('bob@example.com');
  await ctx.box!.mountFor(alice.id).adapter.mkdir?.('Mixes');
  await put(alice.id, 'Mixes/01 Night Drive.wav', 2000);
  await put(alice.id, 'Mixes/02 Bayou Dub.mp3', 1000);
  await put(alice.id, 'Video/Teaser.mp4', 3000);
  await put(alice.id, 'notes.pdf', 10);
  await put(bob.id, 'secret.mp3', 10);
});

describe('Playlist Maker', () => {
  let pl: Pl;

  it('creates a playlist from the owner’s audio and video, in order, without duplicates', async () => {
    const r = await alice.call('/api/box/playlists', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'Late Set', description: 'Mixes for the boat', items: ['Mixes/02 Bayou Dub.mp3', 'Video/Teaser.mp4', '/Mixes/02 Bayou Dub.mp3', 'Mixes/01 Night Drive.wav'] }),
    });
    expect(r.status).toBe(201);
    pl = (await r.json()) as Pl;
    expect(pl.tracks.map((t) => t.title)).toEqual(['02 Bayou Dub', 'Teaser', '01 Night Drive']);
    expect(pl.tracks.map((t) => t.kind)).toEqual(['audio', 'video', 'audio']);
  });

  it('refuses files that are missing, not playable, or someone else’s', async () => {
    const bad = (items: string[]) => alice.call(`/api/box/playlists/${pl.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ items }) });
    expect((await bad(['notes.pdf'])).status).toBe(400);
    expect((await bad(['secret.mp3'])).status).toBe(400); // Bob's file isn't in Alice's folder
    expect((await bad(['../../secret.mp3'])).status).toBe(400);
  });

  it('keeps playlists private to their owner', async () => {
    expect((await bob.call(`/api/box/playlists/${pl.id}`)).status).toBe(404);
    expect(((await (await bob.call('/api/box/playlists')).json()) as { playlists: Pl[] }).playlists).toEqual([]);
  });

  it('accepts a cover picture and rejects anything that isn’t an image', async () => {
    const ok = await alice.call(`/api/box/playlists/${pl.id}/cover`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Pl).coverUrl).toMatch(/\/cover\?v=/);
    const html = await alice.call(`/api/box/playlists/${pl.id}/cover`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: '<svg onload=alert(1)>' });
    expect(html.status).toBe(415);
  });

  it('shares a public player page with the cover, tracks and link previews', async () => {
    const s = (await (await alice.call(`/api/box/playlists/${pl.id}/share`, { method: 'POST' })).json()) as { url: string };
    expect(s.url).toMatch(/^https:\/\/box\.test\/p\/[A-Za-z0-9_-]+$/);
    const path = new URL(s.url).pathname;
    const page = await app.request(path);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<h1>Late Set</h1>');
    expect(html).toContain('3 tracks');
    expect(html).toContain('og:image');
    expect(html).toContain(`src="${path}/cover"`);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(html).not.toContain('alice@example.com'); // no owner details on the public page
    const cover = await app.request(`${path}/cover`);
    expect(cover.headers.get('content-type')).toBe('image/png');
    expect((await app.request('/p.js')).status).toBe(200);
  });

  it('streams tracks with Range support and meters the bytes to the owner', async () => {
    const s = (await (await alice.call(`/api/box/playlists/${pl.id}/share`, { method: 'POST' })).json()) as { url: string };
    const base = new URL(s.url).pathname;
    const sent = async () => ((await (await alice.call('/api/box/me')).json()) as { usage: { sendBytes: number } }).usage.sendBytes;
    const before = await sent();
    const full = await app.request(`${base}/t/0/02%20Bayou%20Dub.mp3`);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('audio/mpeg');
    expect((await full.arrayBuffer()).byteLength).toBe(1000);
    const part = await app.request(`${base}/t/1/Teaser.mp4`, { headers: { range: 'bytes=0-99' } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    expect((await app.request(`${base}/t/9/x.mp3`)).status).toBe(404);
    expect((await sent()) - before).toBe(1100);
  });

  it('stops the old link when sharing is turned off, and deleting removes the playlist', async () => {
    const s = (await (await alice.call(`/api/box/playlists/${pl.id}/share`, { method: 'POST' })).json()) as { url: string };
    await alice.call(`/api/box/playlists/${pl.id}/share`, { method: 'DELETE' });
    expect((await app.request(new URL(s.url).pathname)).status).toBe(404);
    expect((await alice.call(`/api/box/playlists/${pl.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await alice.call(`/api/box/playlists/${pl.id}`)).status).toBe(404);
  });

  it('escapes titles on the public page', async () => {
    const r = (await (await alice.call('/api/box/playlists', { method: 'POST', headers: json, body: JSON.stringify({ title: '<img src=x onerror=alert(1)>', items: ['Mixes/01 Night Drive.wav'] }) })).json()) as Pl;
    const s = (await (await alice.call(`/api/box/playlists/${r.id}/share`, { method: 'POST' })).json()) as { url: string };
    const html = await (await app.request(new URL(s.url).pathname)).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&#60;img src=x');
  });
});
