/**
 * PayPal webhook receiver. Reads the raw body (signature verification needs
 * it unmodified), verifies, dedupes and enqueues reconciliation. Always
 * answers quickly; the worker does the provider reads.
 */
import { getDb } from "@/lib/db/client";
import { json } from "@/lib/http";
import { getPaymentProvider } from "@/lib/payments";
import { handlePaypalWebhook } from "@/lib/webhooks/paypal";

export async function POST(req: Request): Promise<Response> {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return json({ ok: false, code: "INVALID_BODY" }, { status: 400 });
  }
  if (rawBody.length > 256_000) return json({ ok: false, code: "INVALID_BODY" }, { status: 413 });
  try {
    const outcome = await handlePaypalWebhook(getDb(), getPaymentProvider, { headers: req.headers, rawBody });
    return json(outcome.body, { status: outcome.status });
  } catch (err) {
    console.error("[outings] webhook handling failed", err instanceof Error ? err.message : err);
    // 500 makes PayPal retry the delivery; dedupe makes the retry safe.
    return json({ ok: false, code: "INTERNAL" }, { status: 500 });
  }
}
