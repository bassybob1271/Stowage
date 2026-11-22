import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// `pnpm test:infra` loads endpoints for deploy/docker-compose.test.yml.
if (process.env.STOWAGE_TEST_INFRA) process.loadEnvFile(fileURLToPath(new URL('../../deploy/test.env', import.meta.url)));

export default defineConfig({
  resolve: { conditions: ['development'] },
  ssr: { resolve: { conditions: ['development'], externalConditions: ['development'] } },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
