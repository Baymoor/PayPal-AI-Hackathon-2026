/**
 * Who may switch the browser's session to which participant (demo mode only).
 *
 * Threat model (judge mode): with DEMO_FIXTURES_ENABLED any participant of an
 * outing can act as ANY other participant of the SAME outing, organizer
 * included, without that person's invitation link. That is the intended
 * testing mode for hackathon judges and must never be enabled in a real
 * deployment. What it does NOT allow, even in demo mode:
 *  - entering an outing the browser holds no session for (unless it is a
 *    seeded fixture outing, as before);
 *  - learning whether a participant id exists: every refusal is the same null,
 *    which the route turns into one uniform 404.
 * A PayPal attempt is still bound to its own participant: the return route
 * authorizes only when the session participant owns the attempt, so switching
 * mid-approval cannot let one person's return authorize another's hold.
 */
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { outings, participants } from "../db/schema";
import type { ParticipantSession } from "../auth/session";

export interface PersonaSwitch {
  outingId: string;
  /** Participant the session held for this outing before the switch, if any. */
  fromParticipantId: string | null;
  toParticipantId: string;
}

interface TargetParticipant {
  outingId: string;
  isFixtureOuting: boolean;
}

async function loadTarget(db: DbOrTx, participantId: string): Promise<TargetParticipant | null> {
  const rows = await db
    .select({ outingId: participants.outingId, isFixtureOuting: outings.isFixture })
    .from(participants)
    .innerJoin(outings, eq(outings.id, participants.outingId))
    .where(eq(participants.id, participantId))
    .limit(1);
  return rows[0] ?? null;
}

/** The session's participant for an outing only counts if that row really is in the outing (signed cookie or not). */
async function sessionHoldsParticipantOf(db: DbOrTx, outingId: string, participantId: string): Promise<boolean> {
  const row = await db.query.participants.findFirst({
    columns: { id: true },
    where: and(eq(participants.id, participantId), eq(participants.outingId, outingId)),
  });
  return row !== undefined;
}

/**
 * Allowed when the target belongs to a fixture outing, or when the session
 * already holds a participant of the target's outing. Null for every refusal.
 */
export async function authorizePersonaSwitch(db: DbOrTx, session: ParticipantSession, toParticipantId: string): Promise<PersonaSwitch | null> {
  const target = await loadTarget(db, toParticipantId);
  if (!target) return null;
  const fromParticipantId = session.outings[target.outingId] ?? null;
  const result: PersonaSwitch = { outingId: target.outingId, fromParticipantId, toParticipantId };
  if (target.isFixtureOuting) return result;
  if (!fromParticipantId) return null;
  if (!(await sessionHoldsParticipantOf(db, target.outingId, fromParticipantId))) return null;
  return result;
}
