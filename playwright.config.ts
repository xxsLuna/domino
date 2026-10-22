import { defineConfig } from '@playwright/test'

/**
 * E2E runs against the built web app + the mock server. Locally an already
 * running dev server (port 5173) and mock (8787) are reused; in CI both are
 * started fresh (build:web + vite preview).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // The mock keeps process-global counters; tests assert deltas, so stay serial.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'node samples/mock-server.mjs',
      url: 'http://127.0.0.1:8787/stats',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000
    },
    {
      command: 'npm run build:web && npx vite preview --config vite.web.config.ts --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000
    }
  ]
})
