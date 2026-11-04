/**
 * POST /api/outings/:id/payments — start (or resume) the caller's payment
 * authorization for the CURRENT terms. The hold amount is always the consented
 * cap computed by the server; any amount in the body is ignored.
 * Optional body: { termsHash } = the terms the payer just reviewed (409 if stale).
 */
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { requireParticipant } from "@/lib/services/access";
import { startPayment } from "@/lib/services/payments";

const Body = z.object({ termsHash: z.string().min(1).max(128).optional() });

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireParticipant(db, req, id);
  const body = await readJson(req, Body);
  const result = await startPayment(db, {
    outingId: id,
    participantId: participant.id,
    now: new Date(),
    reviewedTermsHash: body.termsHash,
  });
  return json(result, { status: result.reused ? 200 : 201 });
});
