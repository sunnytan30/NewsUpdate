import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    /*
     * One test file at a time.
     *
     * The database connection is a process-global singleton, and several
     * suites call migrate(), truncate tables, and change shared `settings`
     * rows. Running files sequentially keeps those from interleaving.
     *
     * This replaces the pre-Vitest-4 `pool: 'threads'` +
     * `poolOptions.threads.singleThread`, which that version removed — it was
     * being silently ignored after the upgrade.
     */
    fileParallelism: false,
  },
});
