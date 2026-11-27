import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { MountRegistry } from '../src/mounts.js';
import { createApp, createContext, type AppContext } from '../src/app.js';
import type { CommentOut } from '../src/comments.js';

const dir = mkdtempSync(join(tmpdir(), 'comments-'));
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

async function account(email: string) {
  const r = await app.request('/api/auth/box/signup', { method: 'POST', headers: json, body: JSON.stringify({ email, password: 'correct horse battery' }) });
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  const mount = ((await (await app.request('/api/mounts', { headers: { cookie } })).json()) as { mounts: { id: string }[] }).mounts[0]!.id;
  const call = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { cookie, ...json, ...(init.headers as Record<string, string>) } });
  return { call, id: mount.slice(4), mount };
}
let alice: Awaited<ReturnType<typeof account>>;
let bob: Awaited<ReturnType<typeof account>>;
const list = async (who = alice, path = 'Mixes/Night Drive.wav') =>
  ((await (await who.call(`/api/comments/${who.mount}?path=${encodeURIComponent(path)}`)).json()) as { comments: CommentOut[] }).comments;

beforeAll(async () => {
  const db = await openDb(cfg.DATABASE_URL);
  const mounts = new MountRegistry(db, cfg.MASTER_KEY);
  await mounts.load(cfg.MOUNTS_FILE);
  await mounts.checkHealth(0);
  ctx = await createContext(cfg, db, mounts);
  app = createApp(ctx);
  alice = await account('alice@example.com');
  bob = await account('bob@example.com');
  await ctx.box!.mountFor(alice.id).adapter.write('Mixes/Night Drive.wav', new Blob([new Uint8Array(4000).fill(3)]).stream(), {});
  await ctx.box!.mountFor(alice.id).adapter.write('Notes.txt', new Blob(['hi']).stream(), {});
});

describe('timed comments', () => {
  it('adds comments at a time, a range, and for the whole file, in timeline order', async () => {
    const add = (b: object) => alice.call(`/api/comments/${alice.mount}`, { method: 'POST', body: JSON.stringify({ path: 'Mixes/Night Drive.wav', ...b }) });
    expect((await add({ body: 'raise the vocal', t: 96 })).status).toBe(201);
    expect((await add({ body: 'bass too loud here', t: 30.5, tEnd: 45 })).status).toBe(201);
    expect((await add({ body: 'love the mix overall' })).status).toBe(201);
    expect((await add({ body: 'end before start is dropped', t: 50, tEnd: 10 })).status).toBe(201);
    const cs = await list();
    expect(cs.map((c) => c.body)).toEqual(['love the mix overall', 'bass too loud here', 'end before start is dropped', 'raise the vocal']);
    expect(cs[1]).toMatchObject({ t: 30.5, tEnd: 45, author: 'alice', mine: true, guest: false, resolved: false });
    expect(cs[2]!.tEnd).toBeNull();
    expect(cs[0]!.t).toBeNull();
  });

  it('replies sit under their comment, one level deep, with no time of their own', async () => {
    const top = (await list()).find((c) => c.body === 'raise the vocal')!;
    const r1 = (await (await alice.call(`/api/comments/${alice.mount}`, { method: 'POST', body: JSON.stringify({ path: 'Mixes/Night Drive.wav', body: 'done in v2', parentId: top.id, t: 5 }) })).json()) as CommentOut;
    expect(r1).toMatchObject({ parentId: top.id, t: null });
    const r2 = (await (await alice.call(`/api/comments/${alice.mount}`, { method: 'POST', body: JSON.stringify({ path: 'Mixes/Night Drive.wav', body: 'thanks', parentId: r1.id }) })).json()) as CommentOut;
    expect(r2.parentId).toBe(top.id);
    const cs = await list();
    const i = cs.findIndex((c) => c.id === top.id);
    expect(cs.slice(i, i + 3).map((c) => c.body)).toEqual(['raise the vocal', 'done in v2', 'thanks']);
  });

  it('resolves, edits own text, and deletes a thread', async () => {
    const top = (await list()).find((c) => c.body === 'raise the vocal')!;
    const res = await alice.call(`/api/comments/${alice.mount}/${top.id}`, { method: 'PATCH', body: JSON.stringify({ resolved: true, body: 'raise the vocal 2 dB' }) });
    expect(await res.json()).toMatchObject({ resolved: true, body: 'raise the vocal 2 dB' });
    await alice.call(`/api/comments/${alice.mount}/${top.id}`, { method: 'DELETE' });
    const cs = await list();
    expect(cs.some((c) => c.body.startsWith('raise the vocal') || c.body === 'done in v2' || c.body === 'thanks')).toBe(false);
  });

  it("can't be read or written through someone else's mount", async () => {
    expect((await bob.call(`/api/comments/${alice.mount}?path=Mixes%2FNight%20Drive.wav`)).status).toBe(404);
    expect((await bob.call(`/api/comments/${alice.mount}`, { method: 'POST', body: JSON.stringify({ path: 'Mixes/Night Drive.wav', body: 'x' }) })).status).toBe(404);
    expect(await list(bob)).toEqual([]);
    const id = (await list())[0]!.id;
    expect((await bob.call(`/api/comments/${bob.mount}/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await app.request(`/api/comments/${alice.mount}?path=x`)).status).toBe(401);
  });

  it('rejects empty or oversized notes and traversal paths', async () => {
    const post = (b: object) => alice.call(`/api/comments/${alice.mount}`, { method: 'POST', body: JSON.stringify(b) });
    expect((await post({ path: 'Mixes/Night Drive.wav', body: '   ' })).status).toBe(400);
    expect((await post({ path: 'Mixes/Night Drive.wav', body: 'x'.repeat(4001) })).status).toBe(400);
    expect((await post({ path: '../etc/passwd', body: 'x' })).status).toBeGreaterThanOrEqual(400);
  });

  it('follow the file when its folder is renamed, and go when it is deleted', async () => {
    const before = (await list()).length;
    expect((await alice.call(`/api/fs/${alice.mount}/move`, { method: 'POST', body: JSON.stringify({ from: 'Mixes', to: 'Final Mixes' }) })).status).toBe(200);
    expect(await list()).toEqual([]);
    expect((await list(alice, 'Final Mixes/Night Drive.wav')).length).toBe(before);
    await alice.call(`/api/fs/${alice.mount}?path=${encodeURIComponent('Final Mixes/Night Drive.wav')}`, { method: 'DELETE' });
    expect(await list(alice, 'Final Mixes/Night Drive.wav')).toEqual([]);
  });
});

describe('review links', () => {
  let url = '';
  beforeAll(async () => {
    await ctx.box!.mountFor(alice.id).adapter.write('Review/Song.mp3', new Blob([new Uint8Array(3000).fill(9)]).stream(), {});
    const r = await alice.call('/api/box/reviews', { method: 'POST', body: JSON.stringify({ path: 'Review/Song.mp3' }) });
    expect(r.status).toBe(201);
    url = ((await r.json()) as { url: string }).url;
  });

  it('only for playable files', async () => {
    expect((await alice.call('/api/box/reviews', { method: 'POST', body: JSON.stringify({ path: 'Notes.txt' }) })).status).toBe(400);
  });

  it('serves the page, the media with Range, and the comments without a session', async () => {
    const page = await app.request(url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await page.text()).toContain('/r.js');
    const m = await app.request(`${url}/media`, { headers: { range: 'bytes=0-99' } });
    expect(m.status).toBe(206);
    expect((await m.arrayBuffer()).byteLength).toBe(100);
    expect(await (await app.request(`${url}/info`)).json()).toMatchObject({ name: 'Song.mp3', kind: 'audio', comments: [] });
  });

  it('guests comment with a name; the owner sees it in the file', async () => {
    const r = await app.request(`${url}/comments`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Producer Pat', body: 'raise the vocal at 1:36', t: 96 }) });
    expect(r.status).toBe(201);
    const cs = await list(alice, 'Review/Song.mp3');
    expect(cs[0]).toMatchObject({ author: 'Producer Pat', guest: true, mine: false, t: 96 });
    // the owner can resolve a guest's note
    expect((await alice.call(`/api/comments/${alice.mount}/${cs[0]!.id}`, { method: 'PATCH', body: JSON.stringify({ resolved: true }) })).status).toBe(200);
    // but can't rewrite it
    expect((await alice.call(`/api/comments/${alice.mount}/${cs[0]!.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'nope' }) })).status).toBe(403);
  });

  it('guards guest posts: JSON only, same site only, rate limited, expired links refused', async () => {
    expect((await app.request(`${url}/comments`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await app.request(`${url}/comments`, { method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body: JSON.stringify({ name: 'x', body: 'y' }) })).status).toBe(403);
    expect((await app.request(`${url}/comments`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'x', body: 'y', extra: 1 }) })).status).toBe(400);
    let last = 0;
    for (let i = 0; i < 14; i++) last = (await app.request(`${url}/comments`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Spam', body: `n${i}` }) })).status;
    expect(last).toBe(429);
    const token = url.split('/').pop()!;
    await ctx.db.orm.update(ctx.db.t.reviewLinks).set({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await app.request(`/r/${token}`)).status).toBe(404);
    expect((await app.request(`/r/${token}/media`)).status).toBe(404);
  });
});
