/** POST /api/outings/:id/start-budget (organizer): DRAFT -> BUDGETING. */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json } from "@/lib/http";
import { requireOrganizer } from "@/lib/services/access";
import { startBudget } from "@/lib/services/outings";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  rateLimit(req, "outings:mutation", RATE_LIMITS.mutation);
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireOrganizer(db, req, id);
  await startBudget(db, { outingId: id, participantId: participant.id });
  return json({ ok: true });
});
