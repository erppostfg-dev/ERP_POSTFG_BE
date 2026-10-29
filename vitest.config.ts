import { defineConfig } from 'vitest/config';

// Tests (2026-10-28, PROJECT_STATUS "Tests + lint"): unit tests next to the code (src/**/__tests__) and API / flow
// tests in test/ against the throwaway test database mcaff_postfg_test (test/setup/global.ts builds it from all
// migrations; test/setup/env.ts loads the test settings and blocks every outside network call). `npm test`.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/setup/global.ts'],
    setupFiles: ['test/setup/env.ts'],
    // one database for the whole run: test files run one at a time (the in-transit store tests need this too)
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
