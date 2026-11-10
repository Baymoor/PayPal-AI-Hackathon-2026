/**
 * POST /api/merchant/demo-login {venue?} — one-click sign-in, only when demo fixtures are enabled.
 * `venue` is a demo venue slug (default The Sound Room); any other value is 404, so this can
 * never open a session for a merchant outside the demo set. The session is scoped to that one
 * merchant, which then sees only its own bookings. It is marked as a demo sign-in, so it never
 * opens the owner's /setup diagnostics.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { merchants } from "@/lib/db/schema";
import { config } from "@/lib/env";
import { ServiceError, assertSameOrigin, handle, json, notFound, readJson } from "@/lib/http";
import { merchantCookie } from "@/lib/auth/session";
import { DEMO_MERCHANT_SLUG, isDemoVenueSlug } from "@/lib/demo/constants";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

const Body = z.object({ venue: z.string().max(80).optional() });

export const POST = handle(async (req: Request) => {
  if (!config().demoFixturesEnabled) throw notFound();
  assertSameOrigin(req);
  rateLimit(req, "merchant:login", RATE_LIMITS.merchantLogin);
  const { venue = DEMO_MERCHANT_SLUG } = await readJson(req, Body);
  if (!isDemoVenueSlug(venue)) throw notFound("That demo venue does not exist");
  const merchant = await getDb().query.merchants.findFirst({ where: eq(merchants.slug, venue) });
  if (!merchant) throw new ServiceError("MERCHANT_NOT_SEEDED", 503, "The demo merchant has not been seeded yet (run npm run db:seed)");
  return json({ ok: true, merchant: { id: merchant.id, name: merchant.name } }, { headers: { "set-cookie": merchantCookie(merchant.id, "demo") } });
});
