/**
 * POST /api/demo/persona {participantId} (demo only, FIXTURE outings only):
 * switch the browser's participant session to a seeded persona without a token.
 */
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { config } from "@/lib/env";
import { assertSameOrigin, handle, json, notFound, readJson } from "@/lib/http";
import { participantCookie, readParticipantSession, withOuting } from "@/lib/auth/session";
import { fixtureOutingOf } from "@/lib/demo/seed";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

const Body = z.object({ participantId: z.string().uuid() });

export const POST = handle(async (req: Request) => {
  if (!config().demoFixturesEnabled) throw notFound();
  assertSameOrigin(req);
  rateLimit(req, "demo:persona", RATE_LIMITS.mutation);
  const { participantId } = await readJson(req, Body);
  const outingId = await fixtureOutingOf(getDb(), participantId);
  // Real (non-fixture) outings can only be joined with their invitation link.
  if (!outingId) throw notFound("Unknown demo persona");
  const session = withOuting(readParticipantSession(req), outingId, participantId);
  return json({ ok: true, outingId, participantId, redirect: `/o/${outingId}` }, { headers: { "set-cookie": participantCookie(session) } });
});
