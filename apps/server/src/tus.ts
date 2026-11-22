import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Server, EVENTS } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { eq } from 'drizzle-orm';
import { joinPath, mimeFor, normalizePath } from '@stowage/shared';
import { toWeb } from '@stowage/storage';
import type { AppContext } from './app.js';
import { indexListing } from './db/index.js';
import { log } from './log.js';

/**
 * Resumable uploads (tus 1.0). Chunks land in DATA_DIR/tus; the FileStore's
 * sidecar JSON keeps offsets, so a browser refresh resumes where it stopped.
 * When the last chunk arrives the assembled file is streamed into the mount.
 *
 * Upload-Metadata: mount, dir, filename (relativePath for folder uploads).
 */
export function createTus(ctx: AppContext) {
  const directory = join(ctx.cfg.DATA_DIR, 'tus');
  const uploads = ctx.db.t.uploads;
  const now = () => new Date().toISOString();

  const target = (meta: Record<string, string | null> | undefined) => {
    const mount = meta?.mount ?? '';
    const path = joinPath(normalizePath(meta?.dir ?? ''), normalizePath(meta?.relativePath || meta?.filename || ''));
    return { mount, path };
  };

  const server = new Server({
    path: '/api/tus',
    datastore: new FileStore({ directory }),
    maxSize: ctx.cfg.MAX_UPLOAD_BYTES || undefined,
    respectForwardedHeaders: ctx.cfg.TRUST_PROXY,
    relativeLocation: true,
    async onUploadCreate(_req, upload) {
      const { mount, path } = target(upload.metadata);
      const m = ctx.mounts.get(mount);
      if (!m) throw { status_code: 404, body: 'unknown mount\n' };
      if (m.def.readOnly) throw { status_code: 403, body: 'mount is read-only\n' };
      if (!path) throw { status_code: 400, body: 'filename required\n' };
      await ctx.db.orm.insert(uploads).values({
        id: upload.id,
        mountId: mount,
        path,
        size: upload.size ?? null,
        offset: 0,
        status: 'uploading',
        createdAt: now(),
        updatedAt: now(),
      });
      return { metadata: upload.metadata };
    },
    async onUploadFinish(_req, upload) {
      const { mount, path } = target(upload.metadata);
      const m = ctx.mounts.get(mount)!;
      const file = join(directory, upload.id);
      try {
        await ctx.db.orm.update(uploads).set({ status: 'storing', offset: upload.offset, updatedAt: now() }).where(eq(uploads.id, upload.id));
        const st = await m.adapter.write(path, toWeb(createReadStream(file)), { size: upload.size, mime: mimeFor(path) });
        await indexListing(ctx.db, mount, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', [st], false);
        await ctx.db.orm.update(uploads).set({ status: 'done', updatedAt: now() }).where(eq(uploads.id, upload.id));
        await rm(file, { force: true });
        await rm(file + '.json', { force: true });
        return { status_code: 204, headers: { 'Stowage-Path': encodeURIComponent(path) } };
      } catch (e) {
        log.error('tus.store_failed', { id: upload.id, mount, path, error: (e as Error).message });
        await ctx.db.orm.update(uploads).set({ status: 'failed', error: (e as Error).message, updatedAt: now() }).where(eq(uploads.id, upload.id));
        throw { status_code: 502, body: `storing to mount failed: ${(e as Error).message}\n` };
      }
    },
  });

  server.on(EVENTS.POST_RECEIVE, (_req, upload) => {
    ctx.db.orm
      .update(uploads)
      .set({ offset: upload.offset, updatedAt: now() })
      .where(eq(uploads.id, upload.id))
      .catch(() => {});
  });

  return server;
}
