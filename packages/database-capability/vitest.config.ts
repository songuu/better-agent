import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@better-agent/domain-contracts': fileURLToPath(
        new URL('../domain-contracts/src/index.ts', import.meta.url),
      ),
      '@better-agent/release-core': fileURLToPath(
        new URL('../release-core/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    maxWorkers: 1,
    name: 'database-capability',
    pool: 'threads',
  },
});
