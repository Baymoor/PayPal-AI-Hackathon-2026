/** POST /api/outings/:id/budget/vote {amountMinor} — the caller's OWN vote (participant id comes from the session only). */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { requireParticipant } from "@/lib/services/access";
import { VoteInput, vote } from "@/lib/services/outings";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  rateLimit(req, "outings:mutation", RATE_LIMITS.mutation);
  rateLimit(req, "outings:vote", RATE_LIMITS.vote);
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireParticipant(db, req, id);
  const body = await readJson(req, VoteInput);
  await vote(db, { outingId: id, participantId: participant.id }, body);
  return json({ ok: true });
});
