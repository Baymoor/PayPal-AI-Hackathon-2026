/**
 * POST /api/merchant/setup/paypal  (dashboard-password session, same-origin, rate-limited)
 * Owner diagnostics: does a fresh PayPal sandbox OAuth exchange succeed with the configured credentials?
 * Returns status / latency only. The access token, client id and secret are never returned.
 */
import { assertSameOrigin, handle, json } from "@/lib/http";
import { config } from "@/lib/env";
import { PaypalProvider } from "@/lib/payments/paypal";
import { rateLimit } from "@/lib/rate-limit";
import { requirePasswordMerchant } from "@/lib/services/access";

export const dynamic = "force-dynamic";

const RULE = { capacity: 5, refillPerMinute: 5 };

export const POST = handle(async (req: Request) => {
  assertSameOrigin(req);
  requirePasswordMerchant(req);
  rateLimit(req, "merchant-setup-paypal", RULE);

  const c = config();
  if (c.paymentMode !== "PAYPAL_SANDBOX" || !c.paypal) {
    return json({
      ok: false,
      mode: c.paymentMode,
      status: "NOT_CONFIGURED",
      label: c.paymentMode === "FIXTURE" ? "FIXTURE mode: simulated payments, not real PayPal" : "Payments are disabled",
      message: "No PayPal sandbox credentials configured (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET). Nothing was sent to PayPal.",
    });
  }

  const started = Date.now();
  const r = await PaypalProvider.fromConfig().checkCredentials();
  const latencyMs = Date.now() - started;
  if (r.ok) {
    return json({ ok: true, mode: c.paymentMode, status: "CREDENTIALS_VALID", httpStatus: 200, latencyMs, debugId: null, message: "PayPal sandbox accepted the credentials (OAuth token obtained; not shown)." });
  }
  const unreachable = r.code === "OAUTH_NETWORK_ERROR" || r.code === "OAUTH_TIMEOUT";
  const invalid = r.httpStatus === 401 || r.code === "OAUTH_INVALID_CLIENT";
  return json({
    ok: false,
    mode: c.paymentMode,
    status: unreachable ? "UNREACHABLE" : invalid ? "INVALID_CREDENTIALS" : "ERROR",
    httpStatus: r.httpStatus ?? null,
    code: r.code,
    latencyMs,
    debugId: r.debugId ?? null,
    message: unreachable
      ? "PayPal unreachable from this server (network error or timeout)."
      : invalid
        ? "PayPal rejected the client id / secret (401). Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are from the same SANDBOX app."
        : "PayPal OAuth failed unexpectedly.",
  });
});
