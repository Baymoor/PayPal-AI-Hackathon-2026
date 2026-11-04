/** GET /api/merchant/bookings -> MerchantBookingRow[] (own outings only). */
import { getDb } from "@/lib/db/client";
import { handle, json } from "@/lib/http";
import { requireMerchant } from "@/lib/services/access";
import { listBookingRows } from "@/lib/services/merchant";

export const GET = handle(async (req: Request) => {
  const { merchantId } = requireMerchant(req);
  return json(await listBookingRows(getDb(), merchantId, new Date()));
});
