/** POST /api/outings {organizerName, brief} -> creates a DRAFT outing + organizer session. */
import { getDb } from "@/lib/db/client";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { participantCookie, readParticipantSession, withOuting } from "@/lib/auth/session";
import { CreateOutingInput, createOuting } from "@/lib/services/outings";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

export const POST = handle(async (req: Request) => {
  assertSameOrigin(req);
  rateLimit(req, "outings:create", RATE_LIMITS.createOuting);
  rateLimit(req, "ai", RATE_LIMITS.ai);
  const body = await readJson(req, CreateOutingInput);
  const { outingId, participantId } = await createOuting(getDb(), body);
  const session = withOuting(readParticipantSession(req), outingId, participantId);
  return json({ outingId }, { status: 201, headers: { "set-cookie": participantCookie(session) } });
});
