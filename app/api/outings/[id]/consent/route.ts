/** POST /api/outings/:id/consent {termsHash} (payer): consent to the CURRENT terms before the server deadline. */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { requireParticipant } from "@/lib/services/access";
import { ConsentInput, consent } from "@/lib/services/outings";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  rateLimit(req, "outings:mutation", RATE_LIMITS.mutation);
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireParticipant(db, req, id);
  const body = await readJson(req, ConsentInput);
  const result = await consent(db, { outingId: id, participantId: participant.id }, body);
  return json({ ok: true, ...result }, { status: 201 });
});
