/**
 * POST /api/merchant/ai/query {question} -> validated, READ-ONLY dashboard filter (never a money operation).
 * With the judge gate on, only judges reach the real model; everyone else gets the labelled sample parser.
 */
import { z } from "zod";
import { isJudgeRequest } from "@/lib/auth/judge";
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { requireMerchant } from "@/lib/services/access";
import { dashboardQuery } from "@/lib/services/merchant";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

const Body = z.object({ question: z.string().min(1).max(1000) });

export const POST = handle(async (req: Request) => {
  assertSameOrigin(req);
  requireMerchant(req);
  rateLimit(req, "ai", RATE_LIMITS.ai);
  const { question } = await readJson(req, Body);
  return json(await dashboardQuery(getDb(), question, new Date(), { sampleOnly: !isJudgeRequest(req) }));
});
