/** POST /api/merchant/demo-login — one-click sign-in, only when demo fixtures are enabled. */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { merchants } from "@/lib/db/schema";
import { config } from "@/lib/env";
import { ServiceError, assertSameOrigin, handle, json, notFound } from "@/lib/http";
import { merchantCookie } from "@/lib/auth/session";
import { DEMO_MERCHANT_SLUG } from "@/lib/demo/constants";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request) => {
  if (!config().demoFixturesEnabled) throw notFound();
  assertSameOrigin(req);
  rateLimit(req, "merchant:login", RATE_LIMITS.merchantLogin);
  const merchant = await getDb().query.merchants.findFirst({ where: eq(merchants.slug, DEMO_MERCHANT_SLUG) });
  if (!merchant) throw new ServiceError("MERCHANT_NOT_SEEDED", 503, "The demo merchant has not been seeded yet (run npm run db:seed)");
  return json({ ok: true, merchant: { id: merchant.id, name: merchant.name } }, { headers: { "set-cookie": merchantCookie(merchant.id) } });
});
