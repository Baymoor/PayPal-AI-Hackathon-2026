/** POST /api/outings/:id/select {offeringId} (organizer): choose a catalogue offering (preview only). */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { requireOrganizer } from "@/lib/services/access";
import { SelectOfferingInput, selectOffering } from "@/lib/services/outings";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  rateLimit(req, "outings:mutation", RATE_LIMITS.mutation);
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireOrganizer(db, req, id);
  const body = await readJson(req, SelectOfferingInput);
  await selectOffering(db, { outingId: id, participantId: participant.id }, body);
  return json({ ok: true });
});
