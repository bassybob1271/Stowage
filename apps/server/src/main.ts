import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { openDb, indexListing } from './db/index.js';
import { MountRegistry } from './mounts.js';
import { createApp, createContext } from './app.js';
import { log } from './log.js';
import type { FileStat } from '@stowage/shared';

const cfg = loadConfig();
log.setLevel(cfg.LOG_LEVEL);

if (cfg.ACCESS_CODE === '42' && cfg.NODE_ENV === 'production')
  log.warn('security.default_access_code', { hint: 'ACCESS_CODE is the demo value "42". Change it before exposing this server.' });

const db = await openDb(cfg.DATABASE_URL);
const mounts = new MountRegistry(db, cfg.MASTER_KEY);
await mounts.load(cfg.MOUNTS_FILE);
const ctx = await createContext(cfg, db, mounts);
const app = createApp(ctx);

const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: cfg.HOST }, (i) =>
  log.info('server.listening', { url: `http://${i.address}:${i.port}`, mounts: mounts.all().length }),
);
// Long uploads/downloads: don't let Node kill slow requests.
(server as unknown as { requestTimeout: number }).requestTimeout = 0;

mounts.checkHealth(0).catch(() => {});
const sweep = setInterval(() => ctx.limiter.sweep(), 60_000);

/** Background reconcile: walk each mount (bounded) to refresh the metadata index. */
async function reconcile() {
  for (const m of mounts.all()) {
    if (!m.health.ok) continue;
    const byParent = new Map<string, FileStat[]>();
    let n = 0;
    try {
      for await (const e of m.adapter.walk('')) {
        const parent = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
        (byParent.get(parent) ?? byParent.set(parent, []).get(parent)!).push(e);
        if (++n >= 50_000) break;
      }
      for (const [parent, entries] of byParent) await indexListing(db, m.def.id, parent, entries, n < 50_000);
      log.info('reconcile.done', { mount: m.def.id, entries: n });
    } catch (e) {
      log.warn('reconcile.failed', { mount: m.def.id, error: (e as Error).message });
    }
  }
}
const reconcileTimer =
  cfg.RECONCILE_INTERVAL_SEC > 0 ? setInterval(() => void reconcile(), cfg.RECONCILE_INTERVAL_SEC * 1000) : undefined;

async function shutdown(sig: string) {
  log.info('server.shutdown', { sig });
  clearInterval(sweep);
  if (reconcileTimer) clearInterval(reconcileTimer);
  server.close();
  await mounts.closeAll();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
