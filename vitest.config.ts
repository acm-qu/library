import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['scripts/test/global-setup.ts'],
    // Integration tests share one database; run files one at a time.
    fileParallelism: false,
  },
});
