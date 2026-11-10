import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // The database layer is process-global, so keep suites in one process.
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
