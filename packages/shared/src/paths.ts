export class PathError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

/**
 * Normalize a user-supplied, mount-relative path to canonical form:
 * POSIX separators, no leading/trailing slash, no empty or '.' segments.
 * Any '..' segment is rejected outright (never resolved), as are NUL bytes.
 * The mount root is ''.
 */
export function normalizePath(input: string | undefined | null): string {
  if (input == null) return '';
  if (typeof input !== 'string') throw new PathError('path must be a string');
  if (input.includes('\0')) throw new PathError('path contains NUL byte');
  const parts = input.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') throw new PathError('path traversal is not allowed');
    out.push(p);
  }
  return out.join('/');
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'));
}

export function basename(path: string): string {
  const p = normalizePath(path);
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function dirname(path: string): string {
  const p = normalizePath(path);
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function extname(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}
