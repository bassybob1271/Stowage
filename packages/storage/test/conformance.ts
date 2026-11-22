/**
 * Shared conformance suite. Every adapter must pass this.
 *
 *   runConformance('s3/minio', () => new S3Adapter('t', cfg));
 *
 * Set CONFORMANCE_LARGE=1 to run the >5 GB multipart test (slow; skipped in CI).
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withEmulation, type EmulatedAdapter, type StorageAdapter } from '../src/index.js';

const enc = new TextEncoder();

function bytesStream(data: Uint8Array, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream({
    pull(c) {
      if (off >= data.byteLength) return c.close();
      c.enqueue(data.subarray(off, off + chunk));
      off += chunk;
    },
  });
}

async function readAll(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of s as unknown as AsyncIterable<Uint8Array>) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
}

/** Deterministic pseudo-random stream of `size` bytes, generated on the fly. */
function generated(size: number, seed = 1): ReadableStream<Uint8Array> {
  let sent = 0;
  const block = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < block.length; i++) block[i] = (i * 31 + seed * 7) & 0xff;
  return new ReadableStream({
    pull(c) {
      if (sent >= size) return c.close();
      const n = Math.min(block.length, size - sent);
      c.enqueue(new Uint8Array(block.subarray(0, n)));
      sent += n;
    },
  });
}

export function runConformance(name: string, factory: () => StorageAdapter | Promise<StorageAdapter>, opts: { skip?: boolean } = {}) {
  describe.skipIf(opts.skip)(`conformance: ${name}`, () => {
    let a: EmulatedAdapter;
    const base = `conf-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const p = (s: string) => `${base}/${s}`;

    beforeAll(async () => {
      a = withEmulation(await factory());
      const h = await a.healthCheck();
      expect(h.ok, `health: ${h.detail}`).toBe(true);
    }, 60_000);

    afterAll(async () => {
      if (!a) return;
      await a.delete(base).catch(() => {});
      await a.close?.();
    }, 120_000);

    it('write + stat + read round-trip', async () => {
      const data = enc.encode('hello stowage\n'.repeat(100));
      const st = await a.write(p('hello.txt'), bytesStream(data), { size: data.byteLength, mime: 'text/plain' });
      expect(st.size).toBe(data.byteLength);
      expect(st.isDir).toBe(false);
      expect(st.name).toBe('hello.txt');
      const s2 = await a.stat(p('hello.txt'));
      expect(s2?.size).toBe(data.byteLength);
      expect(s2?.mime).toMatch(/^text\/plain/);
      expect(await readAll(await a.read(p('hello.txt')))).toEqual(data);
    });

    it('stat returns null for missing files', async () => {
      expect(await a.stat(p('nope/missing.bin'))).toBeNull();
    });

    it('range reads', async () => {
      const data = randomBytes(300_000);
      await a.write(p('range.bin'), bytesStream(data), { size: data.byteLength });
      const mid = await readAll(await a.read(p('range.bin'), { start: 1000, end: 1999 }));
      expect(Buffer.from(mid)).toEqual(data.subarray(1000, 2000));
      const tail = await readAll(await a.read(p('range.bin'), { start: 299_990 }));
      expect(Buffer.from(tail)).toEqual(data.subarray(299_990));
      const first = await readAll(await a.read(p('range.bin'), { start: 0, end: 0 }));
      expect(Buffer.from(first)).toEqual(data.subarray(0, 1));
    });

    it('lists files and folders', async () => {
      await a.mkdir(p('dir/sub'));
      await a.write(p('dir/a.txt'), bytesStream(enc.encode('a')), { size: 1 });
      await a.write(p('dir/sub/b.txt'), bytesStream(enc.encode('bb')), { size: 2 });
      const l = await a.list(p('dir'));
      const names = l.entries.map((e) => `${e.name}${e.isDir ? '/' : ''}`).sort();
      expect(names).toEqual(['a.txt', 'sub/']);
      const file = l.entries.find((e) => e.name === 'a.txt')!;
      expect(file.path).toBe(p('dir/a.txt'));
      expect(file.size).toBe(1);
      expect((await a.stat(p('dir/sub')))?.isDir).toBe(true);
    });

    it('lists an empty folder created with mkdir', async () => {
      await a.mkdir(p('empty'));
      const parent = await a.list(base);
      expect(parent.entries.some((e) => e.name === 'empty' && e.isDir)).toBe(true);
      expect((await a.list(p('empty'))).entries).toEqual([]);
    });

    it('overwrites existing files', async () => {
      await a.write(p('ow.txt'), bytesStream(enc.encode('one')), { size: 3 });
      await a.write(p('ow.txt'), bytesStream(enc.encode('second')), { size: 6 });
      expect(new TextDecoder().decode(await readAll(await a.read(p('ow.txt'))))).toBe('second');
    });

    it('handles unicode names', async () => {
      const name = p('ünïcødé 日本語 🎉/файл (1) #&+.txt');
      const data = enc.encode('unicode ok');
      await a.write(name, bytesStream(data), { size: data.byteLength });
      expect((await a.stat(name))?.name).toBe('файл (1) #&+.txt');
      expect(await readAll(await a.read(name))).toEqual(data);
      const l = await a.list(p('ünïcødé 日本語 🎉'));
      expect(l.entries.map((e) => e.name)).toEqual(['файл (1) #&+.txt']);
    });

    it('handles 0-byte files', async () => {
      const st = await a.write(p('zero.bin'), bytesStream(new Uint8Array(0)), { size: 0 });
      expect(st.size).toBe(0);
      expect((await a.stat(p('zero.bin')))?.size).toBe(0);
      expect((await readAll(await a.read(p('zero.bin')))).byteLength).toBe(0);
    });

    it('moves files', async () => {
      await a.write(p('mv/src.txt'), bytesStream(enc.encode('move me')), { size: 7 });
      await a.move(p('mv/src.txt'), p('mv/dst/renamed.txt'));
      expect(await a.stat(p('mv/src.txt'))).toBeNull();
      expect(new TextDecoder().decode(await readAll(await a.read(p('mv/dst/renamed.txt'))))).toBe('move me');
    });

    it('moves folders recursively', async () => {
      await a.write(p('mvd/x/1.txt'), bytesStream(enc.encode('1')), { size: 1 });
      await a.write(p('mvd/x/deep/2.txt'), bytesStream(enc.encode('22')), { size: 2 });
      await a.move(p('mvd/x'), p('mvd/y'));
      expect(await a.stat(p('mvd/x/1.txt'))).toBeNull();
      expect((await a.stat(p('mvd/y/1.txt')))?.size).toBe(1);
      expect((await a.stat(p('mvd/y/deep/2.txt')))?.size).toBe(2);
    });

    it('deletes files and folders recursively', async () => {
      await a.write(p('del/f.txt'), bytesStream(enc.encode('x')), { size: 1 });
      await a.write(p('del/sub/g.txt'), bytesStream(enc.encode('y')), { size: 1 });
      await a.delete(p('del/f.txt'));
      expect(await a.stat(p('del/f.txt'))).toBeNull();
      await a.delete(p('del'));
      expect(await a.stat(p('del/sub/g.txt'))).toBeNull();
      expect(await a.stat(p('del'))).toBeNull();
    });

    it('rejects path traversal', async () => {
      await expect(a.stat('../etc/passwd')).rejects.toThrow(/traversal/);
      await expect(a.write('a/../../x', bytesStream(new Uint8Array(1)), { size: 1 })).rejects.toThrow(/traversal/);
    });

    it('survives concurrent writes', async () => {
      const n = 8;
      const blobs = Array.from({ length: n }, () => randomBytes(50_000));
      await Promise.all(blobs.map((b, i) => a.write(p(`conc/f${i}.bin`), bytesStream(b), { size: b.byteLength })));
      const l = await a.list(p('conc'));
      expect(l.entries.length).toBe(n);
      for (let i = 0; i < n; i++) expect(Buffer.from(await readAll(await a.read(p(`conc/f${i}.bin`))))).toEqual(blobs[i]);
      // Same-path races: last writer wins, the file is never corrupt.
      const racers = Array.from({ length: 4 }, (_, i) => Buffer.alloc(20_000, 65 + i));
      await Promise.all(racers.map((b) => a.write(p('conc/race.bin'), bytesStream(b), { size: b.byteLength })));
      const got = Buffer.from(await readAll(await a.read(p('conc/race.bin'))));
      expect(racers.some((r) => r.equals(got))).toBe(true);
    }, 60_000);

    it.skipIf(!process.env.CONFORMANCE_LARGE)(
      'streams a file over 5 GB (multipart)',
      async () => {
        const size = 5 * 1024 ** 3 + 1234;
        const wHash = createHash('sha256');
        const src = generated(size).pipeThrough(
          new TransformStream({ transform: (c, ctl) => (wHash.update(c), ctl.enqueue(c)) }),
        );
        const st = await a.write(p('large.bin'), src, { size });
        expect(st.size).toBe(size);
        const rHash = createHash('sha256');
        for await (const c of (await a.read(p('large.bin'))) as unknown as AsyncIterable<Uint8Array>) rHash.update(c);
        expect(rHash.digest('hex')).toBe(wHash.digest('hex'));
        await a.delete(p('large.bin'));
      },
      3 * 60 * 60_000,
    );
  });
}
