/**
 * POST /api/merchant/login {password}: timing-safe check, session scoped to the demo merchant.
 * The session is marked as a password sign-in, the only kind that may open /setup.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { merchants } from "@/lib/db/schema";
import { config } from "@/lib/env";
import { ServiceError, assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { merchantCookie } from "@/lib/auth/session";
import { DEMO_MERCHANT_SLUG } from "@/lib/demo/constants";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

const Body = z.object({ password: z.string().max(200) });

function passwordMatches(given: string, expected: string): boolean {
  // Compare fixed-length digests so neither content nor length leaks through timing.
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export const POST = handle(async (req: Request) => {
  assertSameOrigin(req);
  rateLimit(req, "merchant:login", RATE_LIMITS.merchantLogin);
  const { password } = await readJson(req, Body);
  const expected = config().merchantDashboardPassword;
  if (!expected) throw new ServiceError("LOGIN_DISABLED", 503, "Password sign-in is not configured for this deployment");
  if (!passwordMatches(password, expected)) throw new ServiceError("INVALID_PASSWORD", 401, "That password is not correct");
  const merchant = await getDb().query.merchants.findFirst({ where: eq(merchants.slug, DEMO_MERCHANT_SLUG) });
  if (!merchant) throw new ServiceError("MERCHANT_NOT_SEEDED", 503, "The merchant has not been set up yet (run npm run db:seed)");
  return json({ ok: true, merchant: { id: merchant.id, name: merchant.name } }, { headers: { "set-cookie": merchantCookie(merchant.id, "password") } });
});
