/** POST /api/outings/:id/respond {response: ACCEPT|DECLINE} (participant). */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { requireParticipant } from "@/lib/services/access";
import { RespondInput, respond } from "@/lib/services/outings";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  rateLimit(req, "outings:mutation", RATE_LIMITS.mutation);
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireParticipant(db, req, id);
  const body = await readJson(req, RespondInput);
  const result = await respond(db, { outingId: id, participantId: participant.id }, body);
  return json({ ok: true, ...result });
});
