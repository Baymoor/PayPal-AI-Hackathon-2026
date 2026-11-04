import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MERCHANT_COOKIE, merchantSessionFromCookieValue } from "@/lib/auth/session";
import { config, publicModeSummary } from "@/lib/env";
import { SetupClient } from "@/components/merchant/SetupClient";

export const dynamic = "force-dynamic";

/** Env var names only; values are never read into the page (secrets show just set / not set). */
const ENV_VARS: { name: string; secret: boolean; note: string }[] = [
  { name: "DATABASE_URL", secret: true, note: "Postgres connection" },
  { name: "APP_BASE_URL", secret: false, note: "Public https URL (PayPal return URLs, webhook)" },
  { name: "SESSION_SECRET", secret: true, note: "Cookie signing; required in production" },
  { name: "CRON_SECRET", secret: true, note: "Bearer token for /api/cron/tick" },
  { name: "MERCHANT_DASHBOARD_PASSWORD", secret: true, note: "Merchant sign-in" },
  { name: "DEMO_FIXTURES_ENABLED", secret: false, note: "Labelled fixture modes" },
  { name: "PAYPAL_CLIENT_ID", secret: true, note: "Sandbox REST app" },
  { name: "PAYPAL_CLIENT_SECRET", secret: true, note: "Sandbox REST app" },
  { name: "PAYPAL_WEBHOOK_ID", secret: true, note: "Webhook signature verification" },
  { name: "PAYPAL_MERCHANT_ID", secret: false, note: "Payee fallback" },
  { name: "OUTINGS_ANTHROPIC_API_KEY", secret: true, note: "Real Claude" },
  { name: "OUTINGS_AI_MODEL", secret: false, note: "Optional model override" },
  { name: "AG_STUDIO_LICENSE_KEY", secret: true, note: "Studio licence (trial works without)" },
  { name: "TRUSTED_PROXY_HOPS", secret: false, note: "Reverse proxies in front of the app" },
];

export default async function SetupPage() {
  const jar = await cookies();
  if (!merchantSessionFromCookieValue(jar.get(MERCHANT_COOKIE)?.value)) redirect("/merchant/login");

  const c = config();
  const summary = { ...publicModeSummary(c), trustedProxyHops: c.trustedProxyHops };
  const vars = ENV_VARS.map((v) => ({ name: v.name, note: v.note, state: process.env[v.name]?.trim() ? "set" : "not set" }));
  const base = c.appBaseUrl.replace(/\/+$/, "");
  return <SetupClient summary={summary} vars={vars} cronUrl={`${base}/api/cron/tick`} webhookUrl={`${base}/api/webhooks/paypal`} />;
}
