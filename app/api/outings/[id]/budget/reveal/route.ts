/** POST /api/outings/:id/budget/reveal (organizer): needs >= 3 votes; stores the aggregate only + AI summary. */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json } from "@/lib/http";
import { requireOrganizer } from "@/lib/services/access";
import { reveal } from "@/lib/services/outings";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  rateLimit(req, "outings:mutation", RATE_LIMITS.mutation);
  rateLimit(req, "ai", RATE_LIMITS.ai);
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireOrganizer(db, req, id);
  const stored = await reveal(db, { outingId: id, participantId: participant.id });
  return json({ ok: true, round: stored.round, voteCount: stored.aggregate.voteCount });
});
