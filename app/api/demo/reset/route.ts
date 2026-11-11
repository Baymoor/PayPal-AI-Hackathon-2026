/**
 * POST /api/demo/reset (demo only): re-seed the FIXTURE outings. Real outings are never touched, and
 * neither is a /demo story started in the last 15 minutes (another visitor may be mid-run).
 */
import { getDb } from "@/lib/db/client";
import { config } from "@/lib/env";
import { assertSameOrigin, handle, json, notFound } from "@/lib/http";
import { seedDemo } from "@/lib/demo/seed";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request) => {
  if (!config().demoFixturesEnabled) throw notFound();
  assertSameOrigin(req);
  rateLimit(req, "demo", RATE_LIMITS.demo);
  return json(await seedDemo(getDb(), { now: new Date() }));
});
