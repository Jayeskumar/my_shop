/**
 * Browser smoke tests against the production build (`vite build` + `vite preview`).
 * API calls are mocked per test with page.route (see e2e/fixtures.ts), so the suite runs
 * without the Kadai server. Full-stack e2e (signup → POS sale → return → GST report) belongs
 * in a suite that also starts apps/server.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers pnpm --filter @kadai/web e2e
 */
import { defineConfig, devices } from '@playwright/test'

const PORT = 4173

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `pnpm exec vite build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
