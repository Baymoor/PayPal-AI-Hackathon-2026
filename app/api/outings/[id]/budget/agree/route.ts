/** POST /api/outings/:id/budget/agree {amountMinor} (organizer): proposed budget in the outing's unit, per person for new outings (not a payment) -> PROPOSED; AI ranks the catalogue. */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { requireOrganizer } from "@/lib/services/access";
import { AgreeBudgetInput, agreeBudget } from "@/lib/services/outings";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  rateLimit(req, "outings:mutation", RATE_LIMITS.mutation);
  rateLimit(req, "ai", RATE_LIMITS.ai);
  const { id } = await ctx.params;
  const db = getDb();
  const { participant } = await requireOrganizer(db, req, id);
  const body = await readJson(req, AgreeBudgetInput);
  const stored = await agreeBudget(db, { outingId: id, participantId: participant.id }, body);
  return json({ ok: true, candidates: stored.ranked.length, source: stored.source });
});
