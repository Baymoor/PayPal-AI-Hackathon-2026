/** POST /api/outings/:id/invitees {names[], required?} (organizer). Invite links are returned exactly once. */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { requireOrganizer } from "@/lib/services/access";
import { AddInviteesInput, addInvitees } from "@/lib/services/outings";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  rateLimit(req, "outings:mutation", RATE_LIMITS.mutation);
  rateLimit(req, "outings:invite", RATE_LIMITS.invite);
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireOrganizer(db, req, id);
  const body = await readJson(req, AddInviteesInput);
  const result = await addInvitees(db, { outingId: id, participantId: participant.id }, body);
  return json(result, { status: 201 });
});
