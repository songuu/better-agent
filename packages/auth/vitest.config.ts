import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@better-agent/domain-contracts': fileURLToPath(
        new URL('../domain-contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'auth',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    maxWorkers: 1,
    pool: 'threads',
  },
});
