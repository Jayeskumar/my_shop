import { defineConfig } from 'vitest/config'

// Integration tests run against a real PostgreSQL database (TEST_DATABASE_URL), migrated once by
// the global setup. Every test file creates its own tenants, so files run in parallel without
// truncating anything.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    globalSetup: ['src/test/global-setup.ts'],
    pool: 'forks',
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { NODE_ENV: 'test' },
  },
})
