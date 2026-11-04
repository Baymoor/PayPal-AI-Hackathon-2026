/** GET /api/merchant/outings/:id -> MerchantOutingDetail (404 for other merchants' outings). */
import { getDb } from "@/lib/db/client";
import { handle, json } from "@/lib/http";
import { requireMerchant } from "@/lib/services/access";
import { getOutingDetail } from "@/lib/services/merchant";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { merchantId } = requireMerchant(req);
  const { id } = await ctx.params;
  return json(await getOutingDetail(getDb(), merchantId, id, new Date()));
});
