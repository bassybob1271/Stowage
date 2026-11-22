import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['development'] },
  ssr: { resolve: { conditions: ['development'], externalConditions: ['development'] } },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
