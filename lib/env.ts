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

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  APP_BASE_URL: z.string().url().optional(),
  SESSION_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  DEMO_FIXTURES_ENABLED: boolish,
  MERCHANT_DASHBOARD_PASSWORD: z.string().optional(),
  PAYPAL_ENV: z.enum(["sandbox"]).optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_MERCHANT_ID: z.string().optional(),
  AG_STUDIO_LICENSE_KEY: z.string().optional(),
  OUTINGS_ANTHROPIC_API_KEY: z.string().optional(),
  OUTINGS_AI_MODEL: z.string().optional(),
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
  paymentMode: PaymentMode;
  paypal: { clientId: string; clientSecret: string; webhookId: string | undefined; merchantId: string | undefined; apiBase: string } | null;
  agStudioLicenseKey: string | undefined;
  aiMode: AiMode;
  anthropic: { apiKey: string; model: string } | null;
}

let cached: AppConfig | null = null;

const nonEmpty = (v: string | undefined) => (v && v.trim().length > 0 ? v.trim() : undefined);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
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
    paymentMode: paypal ? "PAYPAL_SANDBOX" : demo ? "FIXTURE" : "DISABLED",
    paypal,
    agStudioLicenseKey: nonEmpty(parsed.AG_STUDIO_LICENSE_KEY),
    aiMode: anthropic ? "ANTHROPIC" : demo ? "FIXTURE" : "DISABLED",
    anthropic,
  };
}

let ephemeral: string | null = null;
function devSecret(): string {
  if (!ephemeral) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    ephemeral = Buffer.from(bytes).toString("hex");
  }
  return ephemeral;
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
