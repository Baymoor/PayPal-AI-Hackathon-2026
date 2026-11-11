/**
 * Environment validation and honest mode detection.
 *
 * The app boots without any payment/AI keys. In that case it runs in clearly
 * labelled FIXTURE modes (only if DEMO_FIXTURES_ENABLED=true). Fixture mode
 * is never presented as real PayPal sandbox or real model output.
 */
import { z } from "zod";

const boolish = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

export const MIN_JUDGE_PASSWORD_LENGTH = 16;
export const DEFAULT_JUDGE_USERNAME = "judge";

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  APP_BASE_URL: z.string().url().optional(),
  SESSION_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  DEMO_FIXTURES_ENABLED: boolish,
  MERCHANT_DASHBOARD_PASSWORD: z.string().optional(),
  JUDGE_USERNAME: z.string().max(100).optional(),
  // Empty = unset (judge gate off). When set it guards real PayPal sandbox and Claude use, so no short passwords.
  JUDGE_PASSWORD: z
    .string()
    .max(200)
    .optional()
    .refine((v) => !v || v.trim().length === 0 || v.trim().length >= MIN_JUDGE_PASSWORD_LENGTH, {
      message: `JUDGE_PASSWORD must be at least ${MIN_JUDGE_PASSWORD_LENGTH} characters`,
    }),
  PAYPAL_ENV: z.enum(["sandbox"]).optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_MERCHANT_ID: z.string().optional(),
  AG_STUDIO_LICENSE_KEY: z.string().optional(),
  OUTINGS_ANTHROPIC_API_KEY: z.string().optional(),
  OUTINGS_AI_MODEL: z.string().optional(),
  TRUSTED_PROXY_HOPS: z.string().optional(),
});

export type PaymentMode = "PAYPAL_SANDBOX" | "FIXTURE" | "DISABLED";
export type AiMode = "ANTHROPIC" | "FIXTURE" | "DISABLED";

export interface AppConfig {
  isProduction: boolean;
  appBaseUrl: string;
  databaseUrl: string | undefined;
  sessionSecret: string;
  sessionSecretIsEphemeral: boolean;
  cronSecret: string | undefined;
  demoFixturesEnabled: boolean;
  merchantDashboardPassword: string | undefined;
  /**
   * Judge sign-in (lib/auth/judge.ts). null = gate off: everyone may create real outings and use real AI,
   * as in local development and tests. Set JUDGE_PASSWORD to switch the gate on.
   */
  judge: { username: string; password: string } | null;
  paymentMode: PaymentMode;
  paypal: { clientId: string; clientSecret: string; webhookId: string | undefined; merchantId: string | undefined; apiBase: string } | null;
  agStudioLicenseKey: string | undefined;
  aiMode: AiMode;
  anthropic: { apiKey: string; model: string } | null;
  /**
   * Number of reverse proxies in front of the app that append to
   * X-Forwarded-For (0 = none: forwarding headers are not trusted). Used only
   * to key rate limits (`clientIp` in lib/rate-limit.ts).
   */
  trustedProxyHops: number;
}

let cached: AppConfig | null = null;

const nonEmpty = (v: string | undefined) => (v && v.trim().length > 0 ? v.trim() : undefined);

export const MAX_TRUSTED_PROXY_HOPS = 10;

/** TRUSTED_PROXY_HOPS: unset/empty = 0; otherwise a whole number 0..10 (anything else is a configuration error). */
function parseTrustedProxyHops(v: string | undefined): number {
  const s = nonEmpty(v);
  if (s === undefined) return 0;
  if (!/^\d{1,2}$/.test(s) || Number(s) > MAX_TRUSTED_PROXY_HOPS) {
    throw new Error(`TRUSTED_PROXY_HOPS must be a whole number from 0 to ${MAX_TRUSTED_PROXY_HOPS}`);
  }
  return Number(s);
}

/** A readable configuration error (variable names and rules only, never values). */
function parseEnv(env: NodeJS.ProcessEnv): z.infer<typeof EnvSchema> {
  const result = EnvSchema.safeParse(env);
  if (result.success) return result.data;
  throw new Error(`Invalid environment: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = parseEnv(env);
  const isProduction = parsed.NODE_ENV === "production";
  const demo = parsed.DEMO_FIXTURES_ENABLED;

  const clientId = nonEmpty(parsed.PAYPAL_CLIENT_ID);
  const clientSecret = nonEmpty(parsed.PAYPAL_CLIENT_SECRET);
  const paypal =
    clientId && clientSecret
      ? {
          clientId,
          clientSecret,
          webhookId: nonEmpty(parsed.PAYPAL_WEBHOOK_ID),
          merchantId: nonEmpty(parsed.PAYPAL_MERCHANT_ID),
          // Sandbox only. Live endpoints are deliberately not configurable.
          apiBase: "https://api-m.sandbox.paypal.com",
        }
      : null;

  const apiKey = nonEmpty(parsed.OUTINGS_ANTHROPIC_API_KEY);
  const anthropic = apiKey ? { apiKey, model: nonEmpty(parsed.OUTINGS_AI_MODEL) ?? "claude-sonnet-5-5" } : null;

  const judgePassword = nonEmpty(parsed.JUDGE_PASSWORD);
  const judge = judgePassword ? { username: nonEmpty(parsed.JUDGE_USERNAME) ?? DEFAULT_JUDGE_USERNAME, password: judgePassword } : null;

  const secret = nonEmpty(parsed.SESSION_SECRET);
  if (!secret && isProduction) {
    throw new Error("SESSION_SECRET is required in production");
  }

  return {
    isProduction,
    appBaseUrl: parsed.APP_BASE_URL ?? "http://localhost:3000",
    databaseUrl: nonEmpty(parsed.DATABASE_URL),
    // Development fallback is random per process: sessions simply reset on restart.
    sessionSecret: secret ?? devSecret(),
    sessionSecretIsEphemeral: !secret,
    cronSecret: nonEmpty(parsed.CRON_SECRET),
    demoFixturesEnabled: demo,
    merchantDashboardPassword: nonEmpty(parsed.MERCHANT_DASHBOARD_PASSWORD),
    judge,
    paymentMode: paypal ? "PAYPAL_SANDBOX" : demo ? "FIXTURE" : "DISABLED",
    paypal,
    agStudioLicenseKey: nonEmpty(parsed.AG_STUDIO_LICENSE_KEY),
    aiMode: anthropic ? "ANTHROPIC" : demo ? "FIXTURE" : "DISABLED",
    anthropic,
    trustedProxyHops: parseTrustedProxyHops(parsed.TRUSTED_PROXY_HOPS),
  };
}

declare global {
  var __outingsEphemeralSessionSecret: string | undefined;
}

/**
 * One random secret per process. Kept on globalThis because Next.js dev loads this module once per
 * bundle layer (route handlers vs server components): a module-level variable would give each layer its
 * own secret, so a cookie signed by an API route would not verify on a server-rendered page.
 */
function devSecret(): string {
  if (!globalThis.__outingsEphemeralSessionSecret) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    globalThis.__outingsEphemeralSessionSecret = Buffer.from(bytes).toString("hex");
  }
  return globalThis.__outingsEphemeralSessionSecret;
}

export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper. */
export function resetConfigForTests(next?: AppConfig): void {
  cached = next ?? null;
}

/** Safe, secret-free summary for UI badges and /api/health. */
export function publicModeSummary(c: AppConfig = config()) {
  return {
    paymentMode: c.paymentMode,
    aiMode: c.aiMode,
    aiModel: c.anthropic?.model ?? null,
    demoFixturesEnabled: c.demoFixturesEnabled,
    agStudioLicensed: Boolean(c.agStudioLicenseKey),
    webhookVerification: Boolean(c.paypal?.webhookId),
    sessionSecretIsEphemeral: c.sessionSecretIsEphemeral,
  };
}
