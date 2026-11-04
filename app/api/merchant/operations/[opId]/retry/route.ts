/**
 * POST /api/merchant/operations/:opId/retry — re-queue an EXISTING FAILED/UNKNOWN
 * operation of the merchant's own outing (same request id; never a new money movement).
 */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json } from "@/lib/http";
import { requireMerchant } from "@/lib/services/access";
import { retryOperation } from "@/lib/services/merchant";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ opId: string }> }) => {
  assertSameOrigin(req);
  const { merchantId } = requireMerchant(req);
  rateLimit(req, "merchant:mutation", RATE_LIMITS.mutation);
  const { opId } = await ctx.params;
  return json({ ok: true, ...(await retryOperation(getDb(), merchantId, opId, new Date())) });
});
