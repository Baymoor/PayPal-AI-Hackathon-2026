/** POST /api/outings/:id/open {activityAt, deadlineAt, minPayers} (organizer): availability -> quote -> COLLECTING -> deadline job. */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { requireOrganizer } from "@/lib/services/access";
import { OpenCollectionInput, openCollection } from "@/lib/services/outings";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  rateLimit(req, "outings:mutation", RATE_LIMITS.mutation);
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireOrganizer(db, req, id);
  const body = await readJson(req, OpenCollectionInput);
  const result = await openCollection(db, { outingId: id, participantId: participant.id }, {
    activityAt: new Date(body.activityAt),
    deadlineAt: new Date(body.deadlineAt),
    minPayers: body.minPayers,
  });
  return json({ ok: true, ...result });
});
