/**
 * Dropbox, as a source to import from. OAuth 2 code flow with PKCE and offline access (a refresh
 * token, so long imports keep working), folder listing, and streamed downloads.
 *
 * Only reads. The app asks for files.metadata.read + files.content.read and nothing else: BazzyBox
 * copies what the member picks and never changes or deletes anything in their Dropbox.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Swappable for tests. */
export const dropboxHttp = { fetch: (input: string, init?: RequestInit) => fetch(input, init) };

const AUTH = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

export interface DropboxApp {
  key: string;
  secret: string;
}

export interface DropboxEntry {
  tag: 'file' | 'folder';
  id: string;
  name: string;
  path: string; // path_display, e.g. "/Projects/Mix 3.wav"
  size: number;
  modified?: string;
}

export class DropboxError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
export const newVerifier = () => randomBytes(48).toString('base64url');

export function authorizeUrl(app: DropboxApp, redirectUri: string, state: string, verifier: string) {
  const q = new URLSearchParams({
    client_id: app.key,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    token_access_type: 'offline',
    code_challenge: s256(verifier),
    code_challenge_method: 'S256',
  });
  return `${AUTH}?${q}`;
}

async function tokenCall(app: DropboxApp, body: Record<string, string>) {
  const r = await dropboxHttp.fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...body, client_id: app.key, client_secret: app.secret }).toString(),
  });
  if (!r.ok) throw new DropboxError(r.status, `Dropbox sign-in failed (${r.status})`);
  return (await r.json()) as { access_token: string; refresh_token?: string; expires_in?: number; account_id?: string };
}

export function exchangeCode(app: DropboxApp, code: string, redirectUri: string, verifier: string) {
  return tokenCall(app, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
}

/** Dropbox-API-Arg is an HTTP header, so anything outside ASCII must be \u-escaped. */
const headerJson = (v: unknown) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** A member's Dropbox, given their refresh token. Access tokens are fetched and refreshed as needed. */
export class DropboxClient {
  private access?: { token: string; until: number };

  constructor(private readonly app: DropboxApp, private readonly refreshToken: string) {}

  private async token(): Promise<string> {
    if (this.access && this.access.until > Date.now() + 60_000) return this.access.token;
    const t = await tokenCall(this.app, { grant_type: 'refresh_token', refresh_token: this.refreshToken });
    this.access = { token: t.access_token, until: Date.now() + (t.expires_in ?? 14_400) * 1000 };
    return t.access_token;
  }

  private async rpc<T>(endpoint: string, args: unknown): Promise<T> {
    const r = await dropboxHttp.fetch(`${API}${endpoint}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (r.status === 401) this.access = undefined;
    if (!r.ok) throw new DropboxError(r.status, `Dropbox ${endpoint} failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  }

  private static entry(e: Record<string, unknown>): DropboxEntry | null {
    const tag = e['.tag'];
    if (tag !== 'file' && tag !== 'folder') return null; // skip "deleted"
    return {
      tag,
      id: String(e.id),
      name: String(e.name),
      path: String(e.path_display ?? e.path_lower ?? ''),
      size: Number(e.size ?? 0),
      modified: e.client_modified ? String(e.client_modified) : undefined,
    };
  }

  /** One folder level ("" = the Dropbox root), for the picker. */
  async listFolder(path: string): Promise<DropboxEntry[]> {
    return this.walk(path, false);
  }

  /** Everything under a folder, for an import. */
  async listRecursive(path: string): Promise<DropboxEntry[]> {
    return this.walk(path, true);
  }

  private async walk(path: string, recursive: boolean): Promise<DropboxEntry[]> {
    type Page = { entries: Record<string, unknown>[]; cursor: string; has_more: boolean };
    const out: DropboxEntry[] = [];
    let page = await this.rpc<Page>('/files/list_folder', { path: path === '/' ? '' : path, recursive, limit: 2000 });
    for (;;) {
      for (const e of page.entries) {
        const x = DropboxClient.entry(e);
        if (x) out.push(x);
      }
      if (!page.has_more) return out;
      page = await this.rpc<Page>('/files/list_folder/continue', { cursor: page.cursor });
    }
  }

  async metadata(path: string): Promise<DropboxEntry | null> {
    const e = await this.rpc<Record<string, unknown>>('/files/get_metadata', { path });
    return DropboxClient.entry(e);
  }

  /** The file's bytes, streamed. */
  async download(idOrPath: string): Promise<ReadableStream<Uint8Array>> {
    const r = await dropboxHttp.fetch(`${CONTENT}/files/download`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.token()}`, 'dropbox-api-arg': headerJson({ path: idOrPath }) },
    });
    if (r.status === 401) this.access = undefined;
    if (!r.ok || !r.body) {
      const why = (await r.text().catch(() => '')).slice(0, 200);
      if (/missing_scope|files\.content\.read|not permitted to access this end/.test(why))
        throw new DropboxError(r.status, 'Dropbox won’t let BazzyBox download files yet: tick files.content.read in the Dropbox app’s Permissions, then disconnect and connect Dropbox again.');
      throw new DropboxError(r.status, `Dropbox download failed (${r.status})${why ? `: ${why}` : ''}`);
    }
    return r.body;
  }
}
