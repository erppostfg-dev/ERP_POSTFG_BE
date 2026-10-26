import { defineConfig } from 'vitest/config';

// Unit tests (user, 2026-10-22: automatic tests for the in-transit file store). `npm test`.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    // the store tests change env.intransit.dir; files run one at a time so they never share it
    fileParallelism: false,
  },
});
