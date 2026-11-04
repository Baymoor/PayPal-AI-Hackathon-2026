/**
 * Environment of the app under end-to-end test. Shared by playwright.config.ts (web server + global setup)
 * and the specs (cron bearer secret). FIXTURE modes only: real PayPal / Anthropic keys are blanked so a
 * developer's .env can never make the e2e suite touch a real service.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3400);
export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`;

export const E2E_ENV: Record<string, string> = {
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://outings:outings@localhost:5432/outings",
  DEMO_FIXTURES_ENABLED: "true",
  // Test-only values (not secrets). A reused server must have been started with the same CRON_SECRET.
  SESSION_SECRET: process.env.SESSION_SECRET ?? "4f1c2b7e9a0d3c5e8f6a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6",
  CRON_SECRET: process.env.CRON_SECRET ?? "e2e-cron-secret",
  MERCHANT_DASHBOARD_PASSWORD: process.env.MERCHANT_DASHBOARD_PASSWORD ?? "e2e-merchant-pass",
  APP_BASE_URL: E2E_BASE_URL,
  NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? ".next-e2e",
  NEXT_TELEMETRY_DISABLED: "1",
  PAYPAL_CLIENT_ID: "",
  PAYPAL_CLIENT_SECRET: "",
  PAYPAL_WEBHOOK_ID: "",
  OUTINGS_ANTHROPIC_API_KEY: "",
};
