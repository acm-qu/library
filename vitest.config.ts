import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['scripts/test/global-setup.ts'],
    // Integration tests share one database; run files one at a time.
    fileParallelism: false,
    // ffmpeg encodes and per-test truncates on the docker database often pass 5 s / 10 s on a laptop.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
