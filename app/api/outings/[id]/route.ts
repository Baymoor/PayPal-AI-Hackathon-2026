/** GET /api/outings/:id -> OutingView for the signed-in participant (server-authorized, sanitized). */
import { getDb } from "@/lib/db/client";
import { handle, json } from "@/lib/http";
import { requireParticipant } from "@/lib/services/access";
import { buildOutingView } from "@/lib/services/views";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireParticipant(db, req, id);
  const view = await buildOutingView(db, { outingId: id, participantId: participant.id, now: new Date() });
  return json(view);
});
