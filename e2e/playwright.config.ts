import { defineConfig, devices } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 8799);
const root = resolve(import.meta.dirname, '..');
const data = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'stowage-e2e-'));

/**
 * Runs against the built web app served by the real server, with S3 (RustFS)
 * and IPFS (Kubo) from deploy/docker-compose.test.yml. Set E2E_BASE_URL to
 * test an already-running instance (e.g. `docker compose up`).
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    acceptDownloads: true,
  },
  // Real Chrome (H.264/AAC) when available; Playwright's Chromium lacks proprietary codecs.
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: process.env.E2E_CHANNEL ?? (existsSync('/Applications/Google Chrome.app') || existsSync('/opt/google/chrome/chrome') ? 'chrome' : undefined) } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `node --conditions=development --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/src/main.ts`,
        cwd: root,
        url: `http://localhost:${PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          PORT: String(PORT),
          HOST: '127.0.0.1',
          ACCESS_CODE: '42',
          SESSION_SECRET: 'e2e-session-secret-0123456789abcdef0123456789',
          MASTER_KEY: '0'.repeat(64),
          DATABASE_URL: `file:${join(data, 'e2e.db')}`,
          DATA_DIR: data,
          MOUNTS_FILE: join(root, 'e2e/mounts.e2e.yaml'),
          WEB_DIST: join(root, 'apps/web/dist'),
          RECONCILE_INTERVAL_SEC: '0',
          LOG_LEVEL: 'warn',
        },
      },
});
