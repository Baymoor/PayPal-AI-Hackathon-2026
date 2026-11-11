import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MERCHANT_COOKIE, isPasswordSession, merchantSessionFromCookieValue } from "@/lib/auth/session";
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
  { name: "JUDGE_USERNAME", secret: true, note: "Judge sign-in (default: judge)" },
  { name: "JUDGE_PASSWORD", secret: true, note: "Judge sign-in; set = only judges create outings or reach Claude" },
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

/** Shown to a demo sign-in: a plain explanation and two ways on, instead of an error page. */
function OwnerOnlyNotice() {
  return (
    <div className="m-login">
      <div className="m-card">
        <h1 className="m-h1" style={{ fontSize: 32, lineHeight: "38px" }}>Setup is for the site owner</h1>
        <p className="m-sub">
          You opened the dashboard with the demo sign-in, which shows a venue&apos;s bookings. Setup shows how this site
          itself is configured, so it asks for the dashboard password.
        </p>
        <p style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
          {/* Inline colours: the merchant stylesheet's link colour would otherwise win over the button's. */}
          <Link href="/merchant" className="m-btn m-btn-primary" style={{ color: "#fff" }}>Back to bookings</Link>
          <Link href="/merchant/login" className="m-btn" style={{ color: "var(--m-ink)" }}>Sign in with the password</Link>
        </p>
      </div>
    </div>
  );
}

export default async function SetupPage() {
  const jar = await cookies();
  const session = merchantSessionFromCookieValue(jar.get(MERCHANT_COOKIE)?.value);
  if (!session) redirect("/merchant/login");
  // The demo sign-in needs no credentials, so it never sees the deployment's settings or the live-API test buttons.
  if (!isPasswordSession(session)) return <OwnerOnlyNotice />;

  const c = config();
  const summary = { ...publicModeSummary(c), trustedProxyHops: c.trustedProxyHops };
  const vars = ENV_VARS.map((v) => ({ name: v.name, note: v.note, state: process.env[v.name]?.trim() ? "set" : "not set" }));
  const base = c.appBaseUrl.replace(/\/+$/, "");
  return <SetupClient summary={summary} vars={vars} cronUrl={`${base}/api/cron/tick`} webhookUrl={`${base}/api/webhooks/paypal`} />;
}
