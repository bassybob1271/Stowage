import { extname } from './paths.js';

/** Shared extension → MIME map used by server responses and client previewer selection. */
export const MIME_MAP: Readonly<Record<string, string>> = {
  // images
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  // video
  mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', mov: 'video/quicktime',
  ogv: 'video/ogg', mkv: 'video/x-matroska', m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  // audio
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', weba: 'audio/webm',
  // docs
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // text / code
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  json: 'application/json', yaml: 'text/yaml', yml: 'text/yaml', toml: 'text/plain',
  xml: 'application/xml', ini: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', jsx: 'text/javascript',
  tsx: 'text/plain', py: 'text/x-python', go: 'text/x-go', rs: 'text/x-rust',
  java: 'text/x-java', c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c++', hpp: 'text/x-c++',
  cs: 'text/plain', rb: 'text/plain', php: 'text/plain', kt: 'text/plain', swift: 'text/plain',
  sh: 'text/x-shellscript', bash: 'text/x-shellscript', zsh: 'text/x-shellscript',
  sql: 'text/x-sql', html: 'text/html', htm: 'text/html', css: 'text/css', scss: 'text/plain',
  vtt: 'text/vtt', srt: 'text/plain', env: 'text/plain', conf: 'text/plain', dockerfile: 'text/plain',
  // archives
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed',
  // fonts
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  // 3d
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', stl: 'model/stl', obj: 'model/obj',
};

export const DEFAULT_MIME = 'application/octet-stream';

/**
 * Note: '.ts' is ambiguous (MPEG-TS vs TypeScript). We serve it as video/mp2t
 * because HLS needs that; the client previewer registry matches TypeScript by
 * extension, so it still opens in the code viewer.
 */
export function mimeFor(path: string): string {
  return MIME_MAP[extname(path)] ?? DEFAULT_MIME;
}

export function isTextLike(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'image/svg+xml'
  );
}
