import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    name: 'domain-contracts',
    pool: 'threads',
    maxWorkers: 1,
  },
});
