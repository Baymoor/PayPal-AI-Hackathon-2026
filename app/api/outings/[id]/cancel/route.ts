/** POST /api/outings/:id/cancel (organizer): cancel directly before collection, or queue the engine's cancellation (voids holds). */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json } from "@/lib/http";
import { requireOrganizer } from "@/lib/services/access";
import { cancel } from "@/lib/services/outings";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  rateLimit(req, "outings:mutation", RATE_LIMITS.mutation);
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireOrganizer(db, req, id);
  const result = await cancel(db, { outingId: id, participantId: participant.id });
  return json({ ok: true, ...result });
});
