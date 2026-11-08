/**
 * POST /api/demo/persona {participantId} (demo only): switch the browser's
 * participant session to another participant without their invitation link.
 *
 * Allowed for seeded FIXTURE outings (the /demo hub) and, in judge mode, for
 * any participant of an outing this browser already holds a session for (see
 * lib/demo/judge-persona.ts for the threat model). Every refusal is the same
 * 404 so the endpoint is not an existence oracle for participant ids.
 */
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { config } from "@/lib/env";
import { assertSameOrigin, handle, json, notFound, readJson } from "@/lib/http";
import { participantCookie, readParticipantSession, withOuting } from "@/lib/auth/session";
import { recordAudit } from "@/lib/audit";
import { authorizePersonaSwitch } from "@/lib/demo/judge-persona";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

const Body = z.object({ participantId: z.string().uuid() });

const refused = () => notFound("Unknown demo persona");

export const POST = handle(async (req: Request) => {
  if (!config().demoFixturesEnabled) throw refused();
  assertSameOrigin(req);
  rateLimit(req, "demo:persona", RATE_LIMITS.mutation);
  const { participantId } = await readJson(req, Body);
  const db = getDb();
  const session = readParticipantSession(req);
  const sw = await authorizePersonaSwitch(db, session, participantId);
  if (!sw) throw refused();

  // Ids only, never names: the audit trail must show who acted as whom in judge mode.
  await recordAudit(db, {
    outingId: sw.outingId,
    actor: sw.fromParticipantId ? `PARTICIPANT:${sw.fromParticipantId}` : "SYSTEM",
    type: "DEMO_PERSONA_SWITCHED",
    data: { fromParticipantId: sw.fromParticipantId, toParticipantId: sw.toParticipantId },
  });

  const next = withOuting(session, sw.outingId, sw.toParticipantId);
  return json(
    { ok: true, outingId: sw.outingId, participantId: sw.toParticipantId, redirect: `/o/${sw.outingId}` },
    { headers: { "set-cookie": participantCookie(next) } },
  );
});
