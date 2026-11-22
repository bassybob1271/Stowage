import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { Supervisor } from './supervisor.js';
import { createServer } from './server.js';
import { log } from './log.js';

const cfg = loadConfig();
for (const b of ['mediamtx', 'ffmpeg', 'ffprobe']) {
  if (!existsSync(join(cfg.binDir, b))) {
    console.error(`Missing ${join(cfg.binDir, b)} — run: pnpm --filter @stowage/live fetch-bins`);
    process.exit(1);
  }
}

const sup = new Supervisor(cfg);
await sup.start();
const app = createServer(cfg, sup);
const server = serve({ fetch: app.fetch, port: cfg.LIVE_PORT, hostname: cfg.LIVE_HOST }, (i) =>
  log.info('live.listening', { url: `http://${i.address}:${i.port}`, public: cfg.LIVE_PUBLIC_URL, ladder: cfg.ladder, encoder: sup.encoder }),
);

const shutdown = async () => {
  await sup.stop();
  server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
