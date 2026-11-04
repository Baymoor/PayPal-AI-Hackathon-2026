/**
 * Merchant availability check at settlement time.
 *
 * MVP: the FIXTURE availability model stored on the offering (active flag +
 * capacity). A real merchant API would be consulted here later; the result
 * records its `source` so the snapshot stays honest about where it came from.
 */
import { eq } from "drizzle-orm";
import { offerings, type QuoteVersion } from "../db/schema";
import type { DbOrTx } from "../db/client";

export interface MerchantAvailability {
  available: boolean;
  source: "FIXTURE" | "MERCHANT_API";
  reason?: "OFFERING_NOT_FOUND" | "OFFERING_INACTIVE" | "CAPACITY_REDUCED" | "MERCHANT_MISMATCH";
}

export async function checkMerchantAvailability(
  db: DbOrTx,
  quote: Pick<QuoteVersion, "offeringId" | "merchantId" | "capacity">,
): Promise<MerchantAvailability> {
  const offering = await db.query.offerings.findFirst({ where: eq(offerings.id, quote.offeringId) });
  if (!offering) return { available: false, source: "FIXTURE", reason: "OFFERING_NOT_FOUND" };
  const source = offering.availability?.source === "MERCHANT_API" ? "MERCHANT_API" : "FIXTURE";
  if (offering.merchantId !== quote.merchantId) return { available: false, source, reason: "MERCHANT_MISMATCH" };
  if (!offering.active) return { available: false, source, reason: "OFFERING_INACTIVE" };
  if (offering.capacity < quote.capacity) return { available: false, source, reason: "CAPACITY_REDUCED" };
  return { available: true, source };
}
