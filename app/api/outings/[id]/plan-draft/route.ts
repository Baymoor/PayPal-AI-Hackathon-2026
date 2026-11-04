/**
 * POST /api/outings/:id/plan-draft (organizer, PROPOSED): the AI drafts the "open commitments" form.
 * Returns validated suggestions + dropped-field notes; persists nothing as terms. The organizer reviews
 * every field and opens commitments explicitly; each payer still approves their own terms.
 */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json } from "@/lib/http";
import { requireOrganizer } from "@/lib/services/access";
import { draftPlan } from "@/lib/services/outings";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  rateLimit(req, "ai", RATE_LIMITS.ai);
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireOrganizer(db, req, id);
  const result = await draftPlan(db, { outingId: id, organizerId: participant.id });
  return json(result);
});
