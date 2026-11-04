/** POST /api/outings/:id/budget/round (organizer): start a new budget round (clears the reveal). */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json } from "@/lib/http";
import { requireOrganizer } from "@/lib/services/access";
import { newRound } from "@/lib/services/outings";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  rateLimit(req, "outings:mutation", RATE_LIMITS.mutation);
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireOrganizer(db, req, id);
  const result = await newRound(db, { outingId: id, participantId: participant.id });
  return json({ ok: true, round: result.round });
});
