import { defineConfig } from "@playwright/test";
import { E2E_BASE_URL, E2E_ENV } from "./tests/e2e/env";

/**
 * End-to-end tests in a real Chromium against the PRODUCTION build (FIXTURE payment + AI modes).
 *
 *   npm run test:e2e                      build into .next-e2e, start on :3400, migrate + reset the DB, run
 *   E2E_SKIP_BUILD=1 npm run test:e2e     reuse an existing .next-e2e build
 *   E2E_SCREENSHOTS=1 npm run test:e2e    also refresh docs/screenshots/*.png
 *
 * A server already listening on :3400 is reused (it must use the same CRON_SECRET, see tests/e2e/env.ts).
 * Time-based settlement is driven through POST /api/cron/tick (bearer CRON_SECRET), exactly like a scheduler;
 * a separately running `npm run worker` is harmless. The global setup TRUNCATES the e2e database.
 */
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./tests/e2e/global-setup.ts",
  // One shared database and in-memory rate limits: run serially.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: E2E_BASE_URL,
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    reducedMotion: "reduce",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "node tests/e2e/serve.mjs",
    url: `${E2E_BASE_URL}/api/health`,
    reuseExistingServer: true,
    timeout: 5 * 60_000,
    env: E2E_ENV,
    stdout: "ignore",
    stderr: "pipe",
  },
});
