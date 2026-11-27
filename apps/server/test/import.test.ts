import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { MountRegistry } from '../src/mounts.js';
import { createApp, createContext, type AppContext } from '../src/app.js';
import { dropboxHttp } from '../src/box/dropbox.js';

const dir = mkdtempSync(join(tmpdir(), 'bazzybox-import-'));
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
  BOX_FREE_GB: '0.00002', // 20 KB free space
  BOX_METER_INTERVAL_SEC: '0',
  IMPORT_INTERVAL_SEC: '0', // the test drives the worker
  APP_ORIGIN: 'https://box.test',
  DROPBOX_APP_KEY: 'dbx-key',
  DROPBOX_APP_SECRET: 'dbx-secret',
} as NodeJS.ProcessEnv);

// ---------- a fake Dropbox ----------
type F = { id: string; path: string; data: string };
const files: F[] = [
  { id: 'id:1', path: '/Album/01 Intro.wav', data: 'intro-audio' },
  { id: 'id:2', path: '/Album/Stems/Vocal Lead.wav', data: 'vocal-stem-bytes' },
  { id: 'id:3', path: '/Album/Stems/Bass.wav', data: 'bass' },
  { id: 'id:4', path: '/Album/Ça va — mix.mp3', data: 'unicode name' },
  { id: 'id:5', path: '/Notes.txt', data: 'fix the bridge' },
  { id: 'id:6', path: '/Huge/movie.mov', data: 'x'.repeat(30_000) },
];
const folders = ['/Album', '/Album/Stems', '/Huge'];
let flaky = 0; // fail this many downloads of id:3 first
const calls: string[] = [];
let accessTokens = 0;
const PAGE = 2;

const entry = (p: string) => {
  const f = files.find((x) => x.path.toLowerCase() === p.toLowerCase());
  if (f) return { '.tag': 'file', id: f.id, name: f.path.split('/').pop(), path_display: f.path, size: Buffer.byteLength(f.data) };
  if (folders.some((d) => d.toLowerCase() === p.toLowerCase())) return { '.tag': 'folder', id: `id:${p}`, name: p.split('/').pop(), path_display: folders.find((d) => d.toLowerCase() === p.toLowerCase()) };
  return null;
};
const under = (root: string, recursive: boolean) => {
  const all = [...folders, ...files.map((f) => f.path)];
  return all
    .filter((p) => {
      const parent = p.slice(0, p.lastIndexOf('/')) || '';
      return recursive ? p.startsWith(`${root}/`) : parent === root;
    })
    .map(entry);
};
const pages = new Map<string, unknown[]>();

dropboxHttp.fetch = async (url: string, init?: RequestInit) => {
  calls.push(url);
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  if (url === 'https://api.dropboxapi.com/oauth2/token') {
    const f = new URLSearchParams(init!.body as string);
    if (f.get('client_id') !== 'dbx-key' || f.get('client_secret') !== 'dbx-secret') return Response.json({}, { status: 400 });
    if (f.get('grant_type') === 'authorization_code') {
      if (f.get('code') !== 'good-code' || f.get('redirect_uri') !== 'https://box.test/api/box/import/dropbox/callback' || !f.get('code_verifier')) return Response.json({}, { status: 400 });
      return Response.json({ access_token: 'at-0', refresh_token: 'rt-alice', expires_in: 14400, account_id: 'dbid:alice' });
    }
    if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'rt-alice') return Response.json({ access_token: `at-${++accessTokens}`, expires_in: 14400 });
    return Response.json({}, { status: 400 });
  }
  if (!auth.startsWith('Bearer at-')) return new Response('unauthorized', { status: 401 });
  if (url === 'https://api.dropboxapi.com/2/files/list_folder' || url === 'https://api.dropboxapi.com/2/files/list_folder/continue') {
    const b = JSON.parse(init!.body as string) as { path?: string; recursive?: boolean; cursor?: string };
    const all = b.cursor ? pages.get(b.cursor)! : under(b.path ?? '', !!b.recursive);
    const cursor = `c${pages.size}`;
    pages.set(cursor, all.slice(PAGE));
    return Response.json({ entries: all.slice(0, PAGE), cursor, has_more: all.length > PAGE });
  }
  if (url === 'https://api.dropboxapi.com/2/files/get_metadata') {
    const e = entry((JSON.parse(init!.body as string) as { path: string }).path);
    return e ? Response.json(e) : Response.json({ error_summary: 'path/not_found' }, { status: 409 });
  }
  if (url === 'https://content.dropboxapi.com/2/files/download') {
    const arg = new Headers(init?.headers).get('dropbox-api-arg')!;
    expect(arg).toMatch(/^[\x20-\x7e]+$/); // header-safe
    const f = files.find((x) => x.id === (JSON.parse(arg) as { path: string }).path)!;
    if (f.id === 'id:3' && flaky-- > 0) return new Response('busy', { status: 503 });
    return new Response(f.data);
  }
  throw new Error(`unexpected ${url}`);
};

let ctx: AppContext;
let app: ReturnType<typeof createApp>;
let cookie = '';
let otherCookie = '';
const json = { 'content-type': 'application/json', origin: 'https://box.test' };
const as = (ck: string) => (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { cookie: ck, ...json, ...(init.headers as Record<string, string>) } });
let alice: ReturnType<typeof as>;
let bob: ReturnType<typeof as>;

async function signup(email: string) {
  const r = await app.request('/api/auth/box/signup', { method: 'POST', headers: json, body: JSON.stringify({ email, password: 'correct horse battery' }) });
  return r.headers.get('set-cookie')!.split(';')[0]!;
}
async function work(rounds = 30) {
  for (let i = 0; i < rounds; i++) await ctx.importer!.tick();
}
const boxFile = (id: string, p: string) => join(dir, 'files', 'u', id, p);

beforeAll(async () => {
  const db = await openDb(cfg.DATABASE_URL);
  const mounts = new MountRegistry(db, cfg.MASTER_KEY);
  await mounts.load(cfg.MOUNTS_FILE);
  await mounts.checkHealth(0);
  ctx = await createContext(cfg, db, mounts);
  app = createApp(ctx);
  cookie = await signup('alice@example.com');
  otherCookie = await signup('bob@example.com');
  alice = as(cookie);
  bob = as(otherCookie);
});

async function connectDropbox() {
  const start = await alice('/api/box/import/dropbox/start');
  expect(start.status).toBe(302);
  const to = new URL(start.headers.get('location')!);
  expect(`${to.origin}${to.pathname}`).toBe('https://www.dropbox.com/oauth2/authorize');
  expect(to.searchParams.get('token_access_type')).toBe('offline');
  expect(to.searchParams.get('code_challenge_method')).toBe('S256');
  const dbx = start.headers.get('set-cookie')!.split(';')[0]!;
  return app.request(`/api/box/import/dropbox/callback?code=good-code&state=${to.searchParams.get('state')}`, { headers: { cookie: `${cookie}; ${dbx}` } });
}

describe('Import from Dropbox', () => {
  it('connects with read-only offline access and keeps the token encrypted', async () => {
    const before = (await (await alice('/api/box/import')).json()) as { dropbox: { available: boolean; connected: boolean } };
    expect(before.dropbox).toMatchObject({ available: true, connected: false });
    const cb = await connectDropbox();
    expect(cb.status).toBe(303);
    expect(cb.headers.get('location')).toBe('/?import=connected');
    const after = (await (await alice('/api/box/import')).json()) as { dropbox: { connected: boolean } };
    expect(after.dropbox.connected).toBe(true);
    const [row] = await ctx.db.orm.select().from(ctx.db.t.importSources);
    expect(row!.tokenEnc).not.toContain('rt-alice');
  });

  it('refuses a callback whose state does not match', async () => {
    const r = await app.request('/api/box/import/dropbox/callback?code=good-code&state=forged', { headers: { cookie } });
    expect(r.headers.get('location')).toBe('/?import=expired');
  });

  it('lists one folder for the picker, folders first, across Dropbox pages', async () => {
    const root = (await (await alice('/api/box/import/dropbox/list?path=')).json()) as { entries: { name: string; folder: boolean }[] };
    expect(root.entries.map((e) => [e.name, e.folder])).toEqual([['Album', true], ['Huge', true], ['Notes.txt', false]]);
  });

  it('copies picked folders and files into "From Dropbox", keeping structure, and resumes after errors', async () => {
    flaky = 2;
    const r = await alice('/api/box/import/jobs', { method: 'POST', body: JSON.stringify({ paths: ['/Album', '/Notes.txt', '/Album/Stems/Bass.wav'] }) });
    expect(r.status).toBe(201);
    const job = (await r.json()) as { id: string; state: string };
    expect(job.state).toBe('scanning');
    // A second import while one is going is refused.
    expect((await alice('/api/box/import/jobs', { method: 'POST', body: JSON.stringify({ paths: ['/Notes.txt'] }) })).status).toBe(409);
    await work();
    const done = (await (await alice('/api/box/import')).json()) as { jobs: { id: string; state: string; totalFiles: number; doneFiles: number; doneBytes: number; totalBytes: number }[] };
    const j = done.jobs.find((x) => x.id === job.id)!;
    expect(j).toMatchObject({ state: 'done', totalFiles: 5, doneFiles: 5 }); // Bass picked twice, copied once
    expect(j.doneBytes).toBe(j.totalBytes);
    const id = ((await (await alice('/api/box/me')).json()) as { account: { id: string } }).account.id;
    expect(readFileSync(boxFile(id, 'From Dropbox/Album/Stems/Vocal Lead.wav'), 'utf8')).toBe('vocal-stem-bytes');
    expect(readFileSync(boxFile(id, 'From Dropbox/Album/Ça va — mix.mp3'), 'utf8')).toBe('unicode name');
    expect(readFileSync(boxFile(id, 'From Dropbox/Notes.txt'), 'utf8')).toBe('fix the bridge');
    expect(readFileSync(boxFile(id, 'From Dropbox/Album/Stems/Bass.wav'), 'utf8')).toBe('bass'); // retried past 2 failures
  });

  it('skips files already in Box with the same size on a second import', async () => {
    const before = calls.filter((u) => u.includes('/files/download')).length;
    const job = (await (await alice('/api/box/import/jobs', { method: 'POST', body: JSON.stringify({ paths: ['/Notes.txt'] }) })).json()) as { id: string };
    await work();
    const j = (await (await alice(`/api/box/import`)).json()) as { jobs: { id: string; state: string }[] };
    expect(j.jobs.find((x) => x.id === job.id)!.state).toBe('done');
    expect(calls.filter((u) => u.includes('/files/download')).length).toBe(before);
  });

  it('checks the plan before copying anything', async () => {
    const job = (await (await alice('/api/box/import/jobs', { method: 'POST', body: JSON.stringify({ paths: ['/Huge'] }) })).json()) as { id: string };
    await work(3);
    const j = ((await (await alice('/api/box/import')).json()) as { jobs: { id: string; state: string; error: string; doneFiles: number }[] }).jobs.find((x) => x.id === job.id)!;
    expect(j.state).toBe('failed');
    expect(j.error).toMatch(/your plan has .* free/);
    expect(j.doneFiles).toBe(0);
    const id = ((await (await alice('/api/box/me')).json()) as { account: { id: string } }).account.id;
    expect(existsSync(boxFile(id, 'From Dropbox/Huge/movie.mov'))).toBe(false);
    // Cancel clears it so a new import can start.
    expect((await alice(`/api/box/import/jobs/${job.id}/cancel`, { method: 'POST' })).status).toBe(200);
  });

  it('is private to each member', async () => {
    const list = (await (await bob('/api/box/import')).json()) as { dropbox: { connected: boolean }; jobs: unknown[] };
    expect(list).toMatchObject({ dropbox: { connected: false }, jobs: [] });
    expect((await bob('/api/box/import/dropbox/list?path=')).status).toBe(409);
    const aliceJob = ((await (await alice('/api/box/import')).json()) as { jobs: { id: string }[] }).jobs[0]!.id;
    expect((await bob(`/api/box/import/jobs/${aliceJob}/pause`, { method: 'POST' })).status).toBe(404);
  });

  it('disconnects', async () => {
    expect((await alice('/api/box/import/dropbox', { method: 'DELETE' })).status).toBe(200);
    expect(((await (await alice('/api/box/import')).json()) as { dropbox: { connected: boolean } }).dropbox.connected).toBe(false);
  });
});
