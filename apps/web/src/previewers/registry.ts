import type { ComponentType } from 'react';
import type { FileStat, MountInfo } from '@stowage/shared';
import { ext as extOf } from '../lib/format';

export interface PreviewProps {
  mount: MountInfo;
  file: FileStat;
  /** Streaming URL (path-style, Range-capable, same origin). */
  url: string;
  /** Files in the same folder (for playlists, subtitles, etc.). */
  siblings: FileStat[];
  onSaved: () => void;
}

export interface PreviewerDef {
  id: string;
  match(mime: string, ext: string): boolean;
  /** Lazy-loaded so the initial bundle stays small. */
  load: () => Promise<{ default: ComponentType<PreviewProps> }>;
  /** Above this size show "Too large to preview — download." Omit for streamed media. */
  maxSize?: number;
}

const registry: PreviewerDef[] = [];

export function registerPreviewer(def: PreviewerDef) {
  registry.push(def);
}

export function pickPreviewer(file: Pick<FileStat, 'name' | 'mime'>): PreviewerDef {
  const e = extOf(file.name);
  return registry.find((d) => d.match(file.mime, e)) ?? registry.find((d) => d.id === 'unknown')!;
}

const MB = 1024 * 1024;
const set = (...xs: string[]) => new Set(xs);

const IMAGE = set('jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'heic', 'heif');
const VIDEO = set('mp4', 'webm', 'mov', 'ogv', 'm4v', 'm3u8', 'mkv');
const AUDIO = set('mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba');
const CODE = set(
  'txt', 'log', 'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'csv', 'tsv', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs',
  'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'sh', 'bash', 'zsh', 'sql', 'html', 'htm', 'css', 'scss', 'vtt',
  'srt', 'env', 'conf', 'cfg', 'gitignore', 'dockerfile', 'makefile', 'lua', 'r', 'pl', 'dart', 'vue', 'svelte', 'graphql', 'proto',
);

// Order matters: first match wins.
registerPreviewer({ id: 'image', match: (m, e) => IMAGE.has(e) || (m.startsWith('image/') && e !== 'tif' && e !== 'tiff'), load: () => import('./ImageView'), maxSize: 200 * MB });
registerPreviewer({ id: 'video', match: (m, e) => VIDEO.has(e) || (m.startsWith('video/') && e !== 'ts'), load: () => import('./VideoView') });
registerPreviewer({ id: 'audio', match: (m, e) => AUDIO.has(e) || m.startsWith('audio/'), load: () => import('./AudioView') });
registerPreviewer({ id: 'pdf', match: (m, e) => e === 'pdf' || m === 'application/pdf', load: () => import('./PdfView') });
registerPreviewer({ id: 'markdown', match: (_m, e) => e === 'md' || e === 'markdown', load: () => import('./MarkdownView'), maxSize: 5 * MB });
registerPreviewer({ id: 'table', match: (_m, e) => e === 'csv' || e === 'tsv', load: () => import('./CsvView'), maxSize: 50 * MB });
registerPreviewer({ id: 'json', match: (_m, e) => e === 'json', load: () => import('./JsonView'), maxSize: 5 * MB });
registerPreviewer({ id: 'zip', match: (_m, e) => e === 'zip', load: () => import('./ZipView') });
registerPreviewer({ id: 'font', match: (_m, e) => ['ttf', 'otf', 'woff', 'woff2'].includes(e), load: () => import('./FontView'), maxSize: 30 * MB });
registerPreviewer({ id: 'docx', match: (_m, e) => e === 'docx', load: () => import('./DocxView'), maxSize: 30 * MB });
registerPreviewer({ id: 'xlsx', match: (_m, e) => e === 'xlsx' || e === 'xls' || e === 'ods', load: () => import('./XlsxView'), maxSize: 30 * MB });
registerPreviewer({
  id: 'code',
  match: (m, e) => CODE.has(e) || (m.startsWith('text/') && !m.startsWith('text/vtt')) || m === 'application/json' || m === 'application/xml',
  load: () => import('./CodeView'),
  maxSize: 5 * MB,
});
registerPreviewer({ id: 'unknown', match: () => true, load: () => import('./UnknownView') });
