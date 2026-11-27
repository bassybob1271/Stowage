/**
 * Import from Dropbox into a member's BazzyBox.
 *
 * A job goes: scanning (list everything picked, add up the size, check it fits the member's plan)
 * → running (copy file by file, Dropbox → Backblaze B2, streamed, never held in memory) → done.
 * Everything is in the database, so a restart picks up where it left off: files already copied are
 * done, a file that's already in Box with the same size is skipped, a failed file is retried 3 times.
 *
 * It reads from Dropbox and never changes anything there.
 *
 * Bandwidth: each file comes down from Dropbox and goes up to B2 through the machine running this.
 * On a venue's connection that competes with live shows; IMPORT_INTERVAL_SEC=0 turns the worker off
 * here so a separate server (same code, same database) can do the copying.
 */
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { basename, mimeFor, normalizePath } from '@stowage/shared';
import type { Config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import type { Db } from '../db/index.js';
import { log } from '../log.js';
import { allowedBytes } from './pricing.js';
import { BoxError, fmtBytes, type BoxService } from './service.js';
import { DropboxClient, type DropboxApp, type DropboxEntry } from './dropbox.js';

export const IMPORT_DEST = 'From Dropbox';
const MAX_TRIES = 3;

export type JobState = 'scanning' | 'running' | 'paused' | 'done' | 'failed' | 'canceled';

export class Importer {
  private busy = false;
  private readonly clients = new Map<string, DropboxClient>();

  constructor(private readonly cfg: Config, private readonly db: Db, private readonly box: BoxService, private readonly now = () => Date.now()) {}

  get dropboxApp(): DropboxApp | null {
    return this.cfg.DROPBOX_APP_KEY && this.cfg.DROPBOX_APP_SECRET ? { key: this.cfg.DROPBOX_APP_KEY, secret: this.cfg.DROPBOX_APP_SECRET } : null;
  }

  private iso() {
    return new Date(this.now()).toISOString();
  }

  // ---------- connections ----------

  async connect(accountId: string, refreshToken: string, label?: string) {
    const t = this.db.t.importSources;
    const id = `${accountId}:dropbox`;
    await this.db.orm.delete(t).where(eq(t.id, id));
    await this.db.orm.insert(t).values({ id, accountId, provider: 'dropbox', tokenEnc: encrypt(this.cfg.MASTER_KEY, refreshToken), label: label ?? null, createdAt: this.iso() });
    this.clients.delete(accountId);
  }

  async disconnect(accountId: string) {
    const t = this.db.t.importSources;
    await this.db.orm.delete(t).where(eq(t.id, `${accountId}:dropbox`));
    this.clients.delete(accountId);
  }

  async connected(accountId: string) {
    const t = this.db.t.importSources;
    const [row] = await this.db.orm.select({ label: t.label }).from(t).where(eq(t.id, `${accountId}:dropbox`));
    return row ? { connected: true, label: row.label } : { connected: false, label: null };
  }

  async client(accountId: string): Promise<DropboxClient> {
    const hit = this.clients.get(accountId);
    if (hit) return hit;
    const app = this.dropboxApp;
    if (!app) throw new BoxError(503, 'Dropbox import is not set up on this server.');
    const t = this.db.t.importSources;
    const [row] = await this.db.orm.select().from(t).where(eq(t.id, `${accountId}:dropbox`));
    if (!row) throw new BoxError(409, 'Connect your Dropbox first.', 'not_connected');
    const c = new DropboxClient(app, decrypt(this.cfg.MASTER_KEY, row.tokenEnc));
    this.clients.set(accountId, c);
    return c;
  }

  // ---------- jobs ----------

  /** Start an import of the picked Dropbox files and folders. Scanning happens in the background. */
  async start(accountId: string, paths: string[]) {
    await this.client(accountId); // connected?
    const picked = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
    if (!picked.length) throw new BoxError(400, 'Pick at least one folder or file.');
    if (picked.length > 200) throw new BoxError(400, 'Pick up to 200 folders or files per import.');
    const j = this.db.t.importJobs;
    const active = await this.db.orm.select({ id: j.id }).from(j).where(and(eq(j.accountId, accountId), inArray(j.state, ['scanning', 'running', 'paused'])));
    if (active.length) throw new BoxError(409, 'An import is already going. Wait for it to finish, or cancel it.', 'busy');
    const row = {
      id: randomBytes(8).toString('hex'),
      accountId,
      provider: 'dropbox',
      sources: JSON.stringify(picked),
      dest: IMPORT_DEST,
      state: 'scanning' as JobState,
      createdAt: this.iso(),
      updatedAt: this.iso(),
    };
    await this.db.orm.insert(j).values(row);
    log.info('box.import_start', { account: accountId, job: row.id, picked: picked.length });
    return this.get(accountId, row.id);
  }

  async get(accountId: string, jobId: string) {
    const j = this.db.t.importJobs;
    const [row] = await this.db.orm.select().from(j).where(and(eq(j.id, jobId), eq(j.accountId, accountId)));
    if (!row) throw new BoxError(404, 'No such import');
    return this.out(row);
  }

  async list(accountId: string, limit = 10) {
    const j = this.db.t.importJobs;
    const rows = await this.db.orm.select().from(j).where(eq(j.accountId, accountId)).orderBy(desc(j.createdAt)).limit(limit);
    return rows.map((r) => this.out(r));
  }

  private out(r: typeof this.db.t.importJobs.$inferSelect) {
    return {
      id: r.id,
      provider: r.provider,
      sources: JSON.parse(r.sources) as string[],
      dest: r.dest,
      state: r.state as JobState,
      totalFiles: r.totalFiles,
      totalBytes: r.totalBytes,
      doneFiles: r.doneFiles,
      doneBytes: r.doneBytes,
      failedFiles: r.failedFiles,
      error: r.error,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async setState(accountId: string, jobId: string, action: 'pause' | 'resume' | 'cancel') {
    const job = await this.get(accountId, jobId);
    const next: Record<string, JobState | undefined> = {
      pause: job.state === 'running' ? 'paused' : undefined,
      resume: job.state === 'paused' || job.state === 'failed' ? (job.totalFiles ? 'running' : 'scanning') : undefined,
      cancel: ['scanning', 'running', 'paused', 'failed'].includes(job.state) ? 'canceled' : undefined,
    };
    const to = next[action];
    if (!to) throw new BoxError(409, `This import is ${job.state}; it can't ${action}.`);
    const j = this.db.t.importJobs;
    await this.db.orm.update(j).set({ state: to, error: action === 'resume' ? null : job.error, updatedAt: this.iso() }).where(eq(j.id, jobId));
    if (action === 'resume') {
      // Give files that ran out of tries another go.
      const it = this.db.t.importItems;
      await this.db.orm.update(it).set({ state: 'pending', tries: 0, error: null }).where(and(eq(it.jobId, jobId), eq(it.state, 'failed')));
      await this.db.orm.update(j).set({ failedFiles: 0 }).where(eq(j.id, jobId));
    }
    return this.get(accountId, jobId);
  }

  // ---------- the worker ----------

  /** One round of work: scan one job, or copy up to IMPORT_CONCURRENCY files. Safe to call often. */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const j = this.db.t.importJobs;
      const [scan] = await this.db.orm.select().from(j).where(eq(j.state, 'scanning')).orderBy(asc(j.createdAt)).limit(1);
      if (scan) {
        await this.scan(scan).catch((e) => this.fail(scan.id, e));
        return;
      }
      const it = this.db.t.importItems;
      const running = await this.db.orm.select({ id: j.id, accountId: j.accountId }).from(j).where(eq(j.state, 'running'));
      if (!running.length) return;
      const owner = new Map(running.map((r) => [r.id, r.accountId]));
      const batch = await this.db.orm
        .select()
        .from(it)
        .where(and(inArray(it.jobId, [...owner.keys()]), eq(it.state, 'pending'), lt(it.tries, MAX_TRIES)))
        .limit(this.cfg.IMPORT_CONCURRENCY);
      await Promise.all(batch.map((item) => this.copy(owner.get(item.jobId)!, item)));
      for (const id of owner.keys()) await this.finishIfDone(id);
    } finally {
      this.busy = false;
    }
  }

  private async scan(job: typeof this.db.t.importJobs.$inferSelect) {
    const c = await this.client(job.accountId);
    const picked = JSON.parse(job.sources) as string[];
    const files: { e: DropboxEntry; dest: string }[] = [];
    for (const p of picked) {
      const meta = await c.metadata(p);
      if (!meta) continue;
      if (meta.tag === 'file') {
        files.push({ e: meta, dest: `${job.dest}/${meta.name}` });
        continue;
      }
      // A folder keeps its own name and everything below it: /Projects/Album → From Dropbox/Album/…
      const parentLen = meta.path.length - meta.name.length;
      for (const e of await c.listRecursive(meta.path)) {
        if (e.tag === 'file') files.push({ e, dest: `${job.dest}/${e.path.slice(parentLen)}` });
      }
    }
    // Same file picked twice (a folder and something inside it): copy it once.
    const seen = new Set<string>();
    const items = files.filter((f) => !seen.has(f.e.id) && seen.add(f.e.id));
    const total = items.reduce((n, f) => n + f.e.size, 0);

    const a = await this.box.get(job.accountId);
    const plan = this.box.plan(a);
    const room = allowedBytes(plan, await this.box.walletMcOf(a)) - a.usedBytes;
    const j = this.db.t.importJobs;
    if (total > room) {
      await this.db.orm
        .update(j)
        .set({
          state: 'failed',
          totalFiles: items.length,
          totalBytes: total,
          error: `This import is ${fmtBytes(total)} and your plan has ${fmtBytes(Math.max(0, room))} free. Upgrade your plan, or pick fewer folders.`,
          updatedAt: this.iso(),
        })
        .where(eq(j.id, job.id));
      log.info('box.import_too_big', { job: job.id, total, room });
      return;
    }
    const it = this.db.t.importItems;
    for (let i = 0; i < items.length; i += 500) {
      await this.db.orm.insert(it).values(
        items.slice(i, i + 500).map((f) => ({
          id: randomBytes(8).toString('hex'),
          jobId: job.id,
          src: f.e.id,
          dest: normalizePath(f.dest),
          size: f.e.size,
          state: 'pending',
        })),
      );
    }
    await this.db.orm.update(j).set({ state: items.length ? 'running' : 'done', totalFiles: items.length, totalBytes: total, updatedAt: this.iso() }).where(eq(j.id, job.id));
    log.info('box.import_scanned', { job: job.id, files: items.length, bytes: total });
  }

  private async copy(accountId: string, item: typeof this.db.t.importItems.$inferSelect) {
    const it = this.db.t.importItems;
    const j = this.db.t.importJobs;
    try {
      const adapter = this.box.mountFor(accountId).adapter;
      const existing = await adapter.stat(item.dest).catch(() => null);
      if (existing && !existing.isDir && existing.size === item.size) {
        await this.db.orm.update(it).set({ state: 'skipped' }).where(eq(it.id, item.id));
      } else {
        await this.box.checkUpload(accountId, item.size); // storage filled up meanwhile → stops the job
        const body = await (await this.client(accountId)).download(item.src);
        await adapter.write(item.dest, body, { size: item.size, mime: mimeFor(basename(item.dest)) });
        await this.db.orm.update(it).set({ state: 'done' }).where(eq(it.id, item.id));
      }
      await this.db.orm
        .update(j)
        .set({ doneFiles: sql`${j.doneFiles} + 1`, doneBytes: sql`${j.doneBytes} + ${item.size}`, updatedAt: this.iso() })
        .where(eq(j.id, item.jobId));
      this.box.scheduleUsage(accountId);
    } catch (e) {
      if (e instanceof BoxError && (e.status === 402 || e.status === 507)) {
        await this.fail(item.jobId, e);
        return;
      }
      const tries = item.tries + 1;
      const gaveUp = tries >= MAX_TRIES;
      await this.db.orm
        .update(it)
        .set({ tries, state: gaveUp ? 'failed' : 'pending', error: (e as Error).message.slice(0, 300) })
        .where(eq(it.id, item.id));
      if (gaveUp)
        await this.db.orm
          .update(j)
          .set({ failedFiles: sql`${j.failedFiles} + 1`, error: `Latest problem: ${(e as Error).message}`.slice(0, 500), updatedAt: this.iso() })
          .where(eq(j.id, item.jobId));
      log.warn('box.import_file_failed', { job: item.jobId, tries, error: (e as Error).message });
    }
  }

  private async finishIfDone(jobId: string) {
    const it = this.db.t.importItems;
    const [left] = await this.db.orm.select({ n: sql<number>`count(*)` }).from(it).where(and(eq(it.jobId, jobId), eq(it.state, 'pending')));
    if (Number(left?.n ?? 0) > 0) return;
    const j = this.db.t.importJobs;
    const [job] = await this.db.orm.select().from(j).where(eq(j.id, jobId));
    if (!job || job.state !== 'running') return;
    const failed = job.failedFiles > 0;
    let why = '';
    if (failed) {
      const [one] = await this.db.orm.select({ error: it.error }).from(it).where(and(eq(it.jobId, jobId), eq(it.state, 'failed'))).limit(1);
      if (one?.error) why = ` ${one.error}`;
    }
    await this.db.orm
      .update(j)
      .set({
        state: failed ? 'failed' : 'done',
        error: failed ? `${job.failedFiles} file${job.failedFiles > 1 ? 's' : ''} couldn't be copied.${why}`.slice(0, 500) : null,
        updatedAt: this.iso(),
      })
      .where(eq(j.id, jobId));
    log.info('box.import_done', { job: jobId, failed: job.failedFiles });
  }

  private async fail(jobId: string, e: unknown) {
    const j = this.db.t.importJobs;
    await this.db.orm.update(j).set({ state: 'failed', error: (e as Error).message.slice(0, 300), updatedAt: this.iso() }).where(eq(j.id, jobId));
    log.warn('box.import_failed', { job: jobId, error: (e as Error).message });
  }
}
