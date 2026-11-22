import { WebdavAdapter } from './webdav.js';

export interface RcloneConfig {
  /**
   * URL of `rclone serve webdav <remote>:` — e.g. http://rclone:8080.
   * This one adapter unlocks every backend rclone supports (Google Drive,
   * OneDrive, Dropbox, Box, Mega, pCloud, Proton Drive, Sia, Storj, ...).
   */
  url: string;
  username?: string;
  password?: string;
  root?: string;
  /** Optional rclone remote-control API (rclone rcd / --rc) for health checks. */
  rcUrl?: string;
  rcUser?: string;
  rcPass?: string;
}

/**
 * Catch-all adapter: talks WebDAV to `rclone serve webdav`. We chose WebDAV
 * over `rclone serve s3` because it preserves empty folders and works for
 * every rclone backend (see docs/DECISIONS.md).
 */
export class RcloneAdapter extends WebdavAdapter {
  override readonly kind = 'rclone' as const;
  constructor(id: string, private readonly rc: RcloneConfig) {
    super(id, { url: rc.url, username: rc.username, password: rc.password, root: rc.root, rangeRead: true });
  }

  override async healthCheck() {
    const dav = await super.healthCheck();
    if (!this.rc.rcUrl || !dav.ok) return dav;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.rc.rcUser) headers.authorization = 'Basic ' + Buffer.from(`${this.rc.rcUser}:${this.rc.rcPass ?? ''}`).toString('base64');
      const res = await fetch(this.rc.rcUrl.replace(/\/$/, '') + '/core/version', { method: 'POST', headers, body: '{}' });
      const v = (await res.json()) as { version?: string };
      return { ok: true, detail: `rclone ${v.version ?? '?'}` };
    } catch (e) {
      return { ok: true, detail: `webdav ok; rc unreachable: ${(e as Error).message}` };
    }
  }
}
