import type { Context } from 'hono';
import { mimeFor, type FileStat } from '@stowage/shared';
import type { EmulatedAdapter } from '@stowage/storage';

export type ParsedRange = { start: number; end: number } | 'unsatisfiable' | null;

/** Parse a single `bytes=` range against a known size. Multi-range requests fall back to full content. */
export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** RFC 6266 filename for Content-Disposition. */
export function contentDisposition(kind: 'inline' | 'attachment', name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Types that could execute script if rendered on our origin. */
export function isActiveContent(mime: string) {
  return /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/xml|text\/xml)/.test(mime);
}

/**
 * Stream a file with Range (206), ETag/If-None-Match (304), HEAD, and safe headers.
 * Every response carries `Content-Security-Policy: sandbox` and nosniff so
 * uploaded HTML/SVG can never run script against the app origin.
 */
export async function serveFile(
  c: Context,
  adapter: EmulatedAdapter,
  st: FileStat,
  opts: { download?: boolean } = {},
): Promise<Response> {
  const mime = st.mime && st.mime !== 'application/octet-stream' ? st.mime : mimeFor(st.path);
  const headers = new Headers({
    'Content-Type': mime.startsWith('text/') && !mime.includes('charset') ? `${mime}; charset=utf-8` : mime,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src data: blob:; media-src 'self'; style-src 'unsafe-inline'",
    'Cross-Origin-Resource-Policy': 'same-site',
    'Cache-Control': 'private, no-cache',
    'Last-Modified': new Date(st.modifiedAt).toUTCString(),
    'Content-Disposition': contentDisposition(opts.download ? 'attachment' : 'inline', st.name),
  });
  const etag = st.etag ? `"${st.etag}"` : undefined;
  if (etag) headers.set('ETag', etag);

  if (etag && c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });

  const range = c.req.header('if-range') && c.req.header('if-range') !== etag ? null : parseRange(c.req.header('range'), st.size);
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${st.size}`);
    return new Response(null, { status: 416, headers });
  }
  const isHead = c.req.method === 'HEAD';
  if (range) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    if (isHead) return new Response(null, { status: 206, headers });
    const body = await adapter.read(st.path, range);
    return new Response(body, { status: 206, headers });
  }
  headers.set('Content-Length', String(st.size));
  if (isHead) return new Response(null, { status: 200, headers });
  const body = st.size === 0 ? null : await adapter.read(st.path);
  return new Response(body, { status: 200, headers });
}
