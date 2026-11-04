/** PATCH /api/outings/:id/participants/:pid {payerType?, required?} (organizer, before collection only). */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { assertUuid, requireOrganizer } from "@/lib/services/access";
import { PatchParticipantInput, patchParticipant } from "@/lib/services/outings";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string; pid: string }> }) => {
  assertSameOrigin(req);
  rateLimit(req, "outings:mutation", RATE_LIMITS.mutation);
  const { id, pid } = await ctx.params;
  const db = getDb();
  const { participant } = await requireOrganizer(db, req, id);
  assertUuid(pid, "participant");
  const body = await readJson(req, PatchParticipantInput);
  await patchParticipant(db, { outingId: id, participantId: participant.id }, pid, body);
  return json({ ok: true });
});
