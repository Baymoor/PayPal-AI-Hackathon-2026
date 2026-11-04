/**
 * POST /api/outings/:id/withdraw — the caller withdraws before the deadline:
 * consent withdrawn, attendance WITHDRAWN, any hold planned for VOID. A
 * required participant's withdrawal schedules an early cancellation check.
 */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json } from "@/lib/http";
import { requireParticipant } from "@/lib/services/access";
import { withdraw } from "@/lib/services/payments";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireParticipant(db, req, id);
  const result = await withdraw(db, { outingId: id, participantId: participant.id, now: new Date() });
  return json(result);
});
