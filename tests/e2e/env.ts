/**
 * Environment of the app under end-to-end test. Shared by playwright.config.ts (web server + global setup)
 * and the specs (cron bearer secret). FIXTURE modes only: real PayPal / Anthropic keys are blanked so a
 * developer's .env can never make the e2e suite touch a real service.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3400);
export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`;

/**
 * A second server from the same build with the judge gate ON, used only by judge-login.spec.ts.
 * Every other spec runs against the main server, where JUDGE_PASSWORD is blank (gate off).
 */
export const E2E_JUDGE_PORT = Number(process.env.E2E_JUDGE_PORT ?? E2E_PORT + 100);
export const E2E_JUDGE_BASE_URL = process.env.E2E_JUDGE_BASE_URL ?? `http://localhost:${E2E_JUDGE_PORT}`;
/** Test-only credentials (not secrets, never used on a real deployment). */
export const E2E_JUDGE = { username: "e2e-judge", password: "e2e-judge-password-not-a-secret" } as const;

export const E2E_ENV: Record<string, string> = {
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://outings:outings@localhost:5432/outings",
  DEMO_FIXTURES_ENABLED: "true",
  // The e2e server is a production build (`next start`): allow the /demo "Process due work now" button
  // (POST /api/demo/tick, demo mode only). It only ever processes work that is already due.
  DEMO_ALLOW_PUBLIC_TICK: "true",
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
  JUDGE_PASSWORD: "",
};

export const E2E_JUDGE_ENV: Record<string, string> = {
  ...E2E_ENV,
  APP_BASE_URL: E2E_JUDGE_BASE_URL,
  E2E_PORT: String(E2E_JUDGE_PORT),
  // The main server (started first) has already built NEXT_DIST_DIR.
  E2E_SKIP_BUILD: "1",
  JUDGE_USERNAME: E2E_JUDGE.username,
  JUDGE_PASSWORD: E2E_JUDGE.password,
};
