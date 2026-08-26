import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@better-agent/auth': fileURLToPath(
        new URL('../../packages/auth/src/index.ts', import.meta.url),
      ),
      '@better-agent/domain-contracts': fileURLToPath(
        new URL('../../packages/domain-contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'api',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    maxWorkers: 1,
    pool: 'threads',
  },
});
