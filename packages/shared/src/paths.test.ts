import { describe, expect, it } from 'vitest';
import { normalizePath, PathError, basename, dirname, extname } from './paths.js';
import { mimeFor } from './mime.js';

describe('normalizePath', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['a/b', 'a/b'],
    ['/a//b/./c/', 'a/b/c'],
    ['a\\b', 'a/b'],
    ['héllo wörld/日本.txt', 'héllo wörld/日本.txt'],
  ])('%s -> %s', (i, o) => expect(normalizePath(i)).toBe(o));

  it.each(['..', '../x', 'a/../../b', 'a/..', '..\\x', 'a/\0b'])('rejects %s', (p) => {
    expect(() => normalizePath(p)).toThrow(PathError);
  });

  it('allows names that merely contain dots', () => {
    expect(normalizePath('a/..b/c..')).toBe('a/..b/c..');
  });
});

describe('path helpers', () => {
  it('basename/dirname/extname', () => {
    expect(basename('a/b/c.TXT')).toBe('c.TXT');
    expect(dirname('a/b/c.txt')).toBe('a/b');
    expect(dirname('c.txt')).toBe('');
    expect(extname('a/b/c.TXT')).toBe('txt');
    expect(extname('.bashrc')).toBe('');
  });
  it('mimeFor', () => {
    expect(mimeFor('x.mp4')).toBe('video/mp4');
    expect(mimeFor('x.unknownext')).toBe('application/octet-stream');
  });
});
