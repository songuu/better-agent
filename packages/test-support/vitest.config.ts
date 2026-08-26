import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,mjs}'],
    maxWorkers: 1,
    name: 'test-support',
    pool: 'threads',
  },
});
