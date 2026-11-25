import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { Supervisor } from './supervisor.js';
import { createServer } from './server.js';
import { b2Sink, Recorder } from './recorder.js';
import { Store } from './store.js';
import { log } from './log.js';

const cfg = loadConfig();
for (const b of ['mediamtx', 'ffmpeg', 'ffprobe']) {
  if (!existsSync(join(cfg.binDir, b))) {
    console.error(`Missing ${join(cfg.binDir, b)} — run: pnpm --filter @stowage/live fetch-bins`);
    process.exit(1);
  }
}

const store = await new Store(join(cfg.LIVE_DATA_DIR, 'state.json'), cfg.LIVE_SESSION_SECRET, [cfg.LIVE_PUBLISH_USER.toLowerCase()]).load();
// MediaMTX checks every publish/read with us; the secret keeps that endpoint private even behind the tunnel.
const hookSecret = randomBytes(24).toString('base64url');
const hookHost = ['0.0.0.0', '::', ''].includes(cfg.LIVE_HOST) ? '127.0.0.1' : cfg.LIVE_HOST;
const sup = new Supervisor(cfg, { authUrl: `http://${hookHost}:${cfg.LIVE_PORT}/internal/mtx-auth/${hookSecret}`, record: cfg.LIVE_RECORD });
const recorder = cfg.LIVE_RECORD ? new Recorder(cfg, store, () => sup.livePaths(), cfg.b2 ? b2Sink(cfg) : undefined) : undefined;

const app = createServer(cfg, sup, { store, recorder, hookSecret });
// Listen before MediaMTX starts, so its first auth request finds us.
const server = serve({ fetch: app.fetch, port: cfg.LIVE_PORT, hostname: cfg.LIVE_HOST }, (i) =>
  log.info('live.listening', {
    url: `http://${i.address}:${i.port}`,
    public: cfg.LIVE_PUBLIC_URL,
    ladder: cfg.ladder,
    encoder: sup.encoder,
    signIn: cfg.bazzy,
    recording: cfg.LIVE_RECORD ? (cfg.b2 ? `b2://${cfg.LIVE_B2_BUCKET}/${cfg.LIVE_B2_PREFIX}` : cfg.recordDir) : false,
  }),
);
await sup.start();
recorder?.start();

const shutdown = async () => {
  recorder?.stop();
  await sup.stop();
  await store.flush();
  server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
