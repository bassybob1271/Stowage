import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { MountRegistry } from '../src/mounts.js';
import { createApp, createContext } from '../src/app.js';
import { LoginLimiter } from '../src/auth.js';
import { parseRange } from '../src/serve.js';

const dir = mkdtempSync(join(tmpdir(), 'stowage-api-'));
const root = join(dir, 'files');
writeFileSync(
  join(dir, 'mounts.yaml'),
  `mounts:\n  - id: local\n    label: Local\n    kind: local\n    config: { root: "${root}" }\n  - id: ro\n    kind: local\n    readOnly: true\n    config: { root: "${root}" }\n`,
);

const cfg = loadConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'x'.repeat(48),
  MASTER_KEY: 'a'.repeat(64),
  DATABASE_URL: 'file::memory:',
  MOUNTS_FILE: join(dir, 'mounts.yaml'),
  DATA_DIR: join(dir, 'data'),
  RECONCILE_INTERVAL_SEC: '0',
  WEB_DIST: join(dir, 'no-web'),
} as NodeJS.ProcessEnv);

let app: ReturnType<typeof createApp>;
let cookie = '';
let ipN = 0;
/** Each test can use its own fake client IP (TRUST_PROXY is off, so we vary the limiter key directly). */
const req = (path: string, init: RequestInit = {}, withCookie = true) =>
  app.request(path, { ...init, headers: { ...(withCookie && cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) } });

beforeAll(async () => {
  const db = await openDb(cfg.DATABASE_URL);
  const mounts = new MountRegistry(db, cfg.MASTER_KEY);
  await mounts.load(cfg.MOUNTS_FILE);
  const ctx = await createContext(cfg, db, mounts);
  app = createApp(ctx);
  const r = await app.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ code: '42' }), headers: { 'content-type': 'application/json' } });
  expect(r.status).toBe(200);
  const set = r.headers.get('set-cookie')!;
  expect(set).toMatch(/HttpOnly/i);
  expect(set).toMatch(/Secure/i);
  expect(set).toMatch(/SameSite=Lax/i);
  expect(set).toMatch(/Max-Age=604800/);
  cookie = set.split(';')[0]!;
  ipN++;
});

describe('access gate', () => {
  it('rejects API calls without a session cookie', async () => {
    for (const p of ['/api/mounts', '/api/fs/local/list', '/api/fs/local/raw?path=x', '/api/search?q=ab'])
      expect((await req(p, {}, false)).status).toBe(401);
    expect((await req('/api/tus', { method: 'POST' }, false)).status).toBe(401);
  });

  it('leaves health and auth endpoints public', async () => {
    expect((await req('/api/health', {}, false)).status).toBe(200);
    expect(await (await req('/api/auth/session', {}, false)).json()).toMatchObject({ authenticated: false });
  });

  it('rejects a tampered cookie', async () => {
    expect((await app.request('/api/mounts', { headers: { cookie: cookie.slice(0, -3) + 'abc' } })).status).toBe(401);
  });

  it('wrong code → 401, then rate limit with backoff → 429', async () => {
    const login = (code: string) =>
      app.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ code }), headers: { 'content-type': 'application/json' } });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await login('nope')).status);
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
    // Even the right code is refused while locked out.
    const locked = await login('42');
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('blocks cross-origin mutations', async () => {
    const r = await req('/api/fs/local/mkdir', { method: 'POST', body: JSON.stringify({ path: 'x' }), headers: { origin: 'https://evil.example', host: 'localhost' } });
    expect(r.status).toBe(403);
  });
});

describe('limiter backoff', () => {
  it('grows exponentially after 5 failures/min', () => {
    let now = 0;
    const l = new LoginLimiter(5, () => now);
    const locks = Array.from({ length: 8 }, () => l.fail('1.2.3.4'));
    expect(locks.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(locks.slice(4)).toEqual([2, 4, 8, 16]);
    now += 17_000;
    expect(l.check('1.2.3.4').allowed).toBe(true);
    l.succeed('1.2.3.4');
    expect(l.fail('1.2.3.4')).toBe(0);
  });
});

describe('files API', () => {
  const body = Buffer.from('0123456789'.repeat(1000));

  it('uploads (raw body), lists, stats', async () => {
    const up = await req('/api/fs/local/upload?path=docs/n%C3%BCm.txt', { method: 'POST', body });
    expect(up.status).toBe(201);
    const l = (await (await req('/api/fs/local/list?path=docs')).json()) as { entries: { name: string; size: number }[] };
    expect(l.entries).toEqual([expect.objectContaining({ name: 'nüm.txt', size: 10_000 })]);
    const st = (await (await req('/api/fs/local/stat?path=docs/n%C3%BCm.txt')).json()) as { mime: string };
    expect(st.mime).toBe('text/plain');
  });

  it('uploads multipart/form-data with folder-relative names', async () => {
    const fd = new FormData();
    fd.append('dir', 'mp');
    fd.append('file', new Blob(['hello']), 'sub/a.txt');
    fd.append('file', new Blob(['world!']), 'b.txt');
    const r = await req('/api/fs/local/upload', { method: 'POST', body: fd });
    expect(r.status).toBe(201);
    expect((await (await req('/api/fs/local/stat?path=mp/sub/a.txt')).json()) as object).toMatchObject({ size: 5 });
    expect((await (await req('/api/fs/local/stat?path=mp/b.txt')).json()) as object).toMatchObject({ size: 6 });
  });

  it('serves Range requests with 206 and headers', async () => {
    const r = await req('/api/fs/local/raw?path=docs/n%C3%BCm.txt', { headers: { range: 'bytes=10-19' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 10-19/10000');
    expect(r.headers.get('content-length')).toBe('10');
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('etag')).toBeTruthy();
    expect(await r.text()).toBe('0123456789');
    const suffix = await req('/api/fs/local/raw?path=docs/n%C3%BCm.txt', { headers: { range: 'bytes=-3' } });
    expect(await suffix.text()).toBe('789');
    const bad = await req('/api/fs/local/raw?path=docs/n%C3%BCm.txt', { headers: { range: 'bytes=99999-' } });
    expect(bad.status).toBe(416);
  });

  it('honors If-None-Match', async () => {
    const r = await req('/api/fs/local/raw?path=docs/n%C3%BCm.txt');
    const etag = r.headers.get('etag')!;
    expect((await req('/api/fs/local/raw?path=docs/n%C3%BCm.txt', { headers: { 'if-none-match': etag } })).status).toBe(304);
  });

  it('download sets attachment disposition', async () => {
    const r = await req('/api/fs/local/download?path=docs/n%C3%BCm.txt');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; .*filename\*=UTF-8''n%C3%BCm\.txt/);
  });

  it('sandboxes user HTML/SVG so it cannot script the app origin', async () => {
    await req('/api/fs/local/upload?path=evil.html', { method: 'POST', body: '<script>fetch("/api/mounts")</script>' });
    await req('/api/fs/local/upload?path=evil.svg', { method: 'POST', body: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>' });
    for (const p of ['evil.html', 'evil.svg']) {
      const r = await req(`/api/fs/local/raw?path=${p}`);
      expect(r.headers.get('content-security-policy')).toMatch(/^sandbox;/);
      expect(r.headers.get('content-security-policy')).not.toMatch(/allow-scripts|allow-same-origin/);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('rejects path traversal everywhere', async () => {
    for (const p of [
      '/api/fs/local/stat?path=../../etc/passwd',
      '/api/fs/local/raw?path=a/../../x',
      '/api/fs/local/list?path=..',
    ])
      expect((await req(p)).status).toBe(400);
    const mv = await req('/api/fs/local/move', { method: 'POST', body: JSON.stringify({ from: 'docs', to: '../escape' }), headers: { 'content-type': 'application/json' } });
    expect(mv.status).toBe(400);
  });

  it('mkdir, move, delete', async () => {
    const j = { 'content-type': 'application/json' };
    expect((await req('/api/fs/local/mkdir', { method: 'POST', body: JSON.stringify({ path: 'new/folder' }), headers: j })).status).toBe(201);
    expect((await req('/api/fs/local/move', { method: 'POST', body: JSON.stringify({ from: 'mp/b.txt', to: 'new/folder/b2.txt' }), headers: j })).status).toBe(200);
    expect((await req('/api/fs/local/stat?path=mp/b.txt')).status).toBe(404);
    expect((await req('/api/fs/local?path=new', { method: 'DELETE' })).status).toBe(200);
    expect((await req('/api/fs/local/stat?path=new/folder/b2.txt')).status).toBe(404);
  });

  it('refuses writes on read-only mounts', async () => {
    expect((await req('/api/fs/ro/upload?path=x.txt', { method: 'POST', body: 'x' })).status).toBe(403);
    expect((await req('/api/fs/ro?path=docs', { method: 'DELETE' })).status).toBe(403);
  });

  it('streams a zip of a folder', async () => {
    const r = await req('/api/fs/local/zip?paths[]=docs&paths[]=mp');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/zip');
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    expect(buf.includes(Buffer.from('docs/nüm.txt'))).toBe(true);
    expect(buf.includes(Buffer.from('mp/sub/a.txt'))).toBe(true);
  });

  it('searches the index', async () => {
    await req('/api/fs/local/list?path=docs');
    await new Promise((r) => setTimeout(r, 50));
    const r = (await (await req('/api/search?q=n%C3%BCm')).json()) as { results: { path: string }[] };
    expect(r.results.map((x) => x.path)).toContain('docs/nüm.txt');
  });

  it('resumable tus upload lands in the mount', async () => {
    const meta = (o: Record<string, string>) =>
      Object.entries(o)
        .map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`)
        .join(',');
    const create = await req('/api/tus', {
      method: 'POST',
      headers: { 'tus-resumable': '1.0.0', 'upload-length': '11', 'upload-metadata': meta({ mount: 'local', dir: 'tus', filename: 'hi.txt' }) },
    });
    expect(create.status).toBe(201);
    const loc = create.headers.get('location')!;
    const url = loc.startsWith('http') ? new URL(loc).pathname : loc;
    const p1 = await req(url, { method: 'PATCH', body: 'hello ', headers: { 'tus-resumable': '1.0.0', 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' } });
    expect(p1.status).toBe(204);
    // "Refresh": ask the server where we left off.
    const head = await req(url, { method: 'HEAD', headers: { 'tus-resumable': '1.0.0' } });
    expect(head.headers.get('upload-offset')).toBe('6');
    const p2 = await req(url, { method: 'PATCH', body: 'world', headers: { 'tus-resumable': '1.0.0', 'upload-offset': '6', 'content-type': 'application/offset+octet-stream' } });
    expect(p2.status).toBe(204);
    expect(await (await req('/api/fs/local/raw?path=tus/hi.txt')).text()).toBe('hello world');
  });
});

describe('parseRange', () => {
  it.each([
    ['bytes=0-0', 10, { start: 0, end: 0 }],
    ['bytes=5-', 10, { start: 5, end: 9 }],
    ['bytes=-4', 10, { start: 6, end: 9 }],
    ['bytes=2-100', 10, { start: 2, end: 9 }],
    ['bytes=10-', 10, 'unsatisfiable'],
    ['bytes=0-1,4-5', 10, null],
    ['items=0-1', 10, null],
  ])('%s of %i', (h, size, out) => expect(parseRange(h, size)).toEqual(out));
});
