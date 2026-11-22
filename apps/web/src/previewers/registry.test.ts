import { describe, expect, it } from 'vitest';
import { mimeFor } from '@stowage/shared';
import { pickPreviewer } from './registry';
import { formatBytes, formatDuration, typeLabel } from '../lib/format';

const pick = (name: string) => pickPreviewer({ name, mime: mimeFor(name) }).id;

describe('previewer registry', () => {
  it.each([
    ['a.jpg', 'image'], ['a.HEIC', 'image'], ['a.svg', 'image'], ['a.avif', 'image'],
    ['a.mp4', 'video'], ['a.mov', 'video'], ['live.m3u8', 'video'], ['a.webm', 'video'],
    ['a.mp3', 'audio'], ['a.flac', 'audio'], ['a.opus', 'audio'],
    ['a.pdf', 'pdf'],
    ['README.md', 'markdown'],
    ['a.csv', 'table'], ['a.tsv', 'table'],
    ['a.json', 'json'],
    ['a.zip', 'zip'],
    ['a.woff2', 'font'],
    ['a.docx', 'docx'], ['a.xlsx', 'xlsx'],
    ['a.ts', 'code'], // TypeScript, even though .ts is served as video/mp2t for HLS
    ['a.py', 'code'], ['a.yaml', 'code'], ['a.log', 'code'], ['a.html', 'code'],
    ['a.bin', 'unknown'], ['noext', 'unknown'],
  ])('%s → %s', (name, id) => expect(pick(name)).toBe(id));

  it('caps text previews at 5 MB but not streamed media', () => {
    expect(pickPreviewer({ name: 'a.txt', mime: 'text/plain' }).maxSize).toBe(5 * 1024 * 1024);
    expect(pickPreviewer({ name: 'a.mp4', mime: 'video/mp4' }).maxSize).toBeUndefined();
    expect(pickPreviewer({ name: 'a.mp3', mime: 'audio/mpeg' }).maxSize).toBeUndefined();
  });
});

describe('format', () => {
  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
  });
  it('formatDuration', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
  it('typeLabel', () => {
    expect(typeLabel('x.tar.gz', false, 'application/gzip')).toBe('GZ');
    expect(typeLabel('dir', true, 'inode/directory')).toBe('Folder');
  });
});
