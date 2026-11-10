/**
 * Server-side authorization. Every route calls one of these; hidden buttons
 * are never access control. Sessions are read from the Request cookie header.
 */
import { and, eq } from "drizzle-orm";
import { participants, outings, type Participant, type Outing } from "../db/schema";
import type { DbOrTx } from "../db/client";
import { isPasswordSession, readMerchantSession, readParticipantSession } from "../auth/session";
import { forbidden, notFound, unauthorized } from "../http";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(id: string, what = "id"): string {
  if (!UUID_RE.test(id)) throw notFound(`Unknown ${what}`);
  return id;
}

export interface ParticipantContext {
  outing: Outing;
  participant: Participant;
}

/** The caller must hold a session for this outing; returns their participant row. */
export async function requireParticipant(db: DbOrTx, req: Request, outingId: string): Promise<ParticipantContext> {
  assertUuid(outingId, "outing");
  const session = readParticipantSession(req);
  const participantId = session.outings[outingId];
  if (!participantId) throw unauthorized();
  const participant = await db.query.participants.findFirst({
    where: and(eq(participants.id, participantId), eq(participants.outingId, outingId)),
  });
  if (!participant) throw unauthorized();
  const outing = await db.query.outings.findFirst({ where: eq(outings.id, outingId) });
  if (!outing) throw notFound("Outing not found");
  return { outing, participant };
}

export async function requireOrganizer(db: DbOrTx, req: Request, outingId: string): Promise<ParticipantContext> {
  const ctx = await requireParticipant(db, req, outingId);
  if (ctx.participant.role !== "ORGANIZER") throw forbidden("Only the organizer can do this");
  return ctx;
}

/** Merchant dashboard session; returns the merchant id the caller is scoped to. */
export function requireMerchant(req: Request): { merchantId: string } {
  const s = readMerchantSession(req);
  if (!s) throw unauthorized("Merchant sign-in required");
  return { merchantId: s.merchantId };
}

/**
 * Owner diagnostics (/setup and its API routes) call real PayPal and Anthropic endpoints and list the
 * deployment's settings. The one-click demo sign-in needs no credentials, so it must not reach them:
 * only a session opened with the dashboard password does.
 */
export function requirePasswordMerchant(req: Request): { merchantId: string } {
  const s = readMerchantSession(req);
  if (!s) throw unauthorized("Merchant sign-in required");
  if (!isPasswordSession(s)) throw forbidden("Setup is for the site owner. Sign in with the dashboard password to use it.");
  return { merchantId: s.merchantId };
}

/** Merchants may only access outings booked with them. */
export async function requireMerchantOuting(db: DbOrTx, req: Request, outingId: string): Promise<{ merchantId: string; outing: Outing }> {
  const { merchantId } = requireMerchant(req);
  assertUuid(outingId, "outing");
  const outing = await db.query.outings.findFirst({ where: eq(outings.id, outingId) });
  if (!outing || outing.merchantId !== merchantId) throw notFound("Outing not found");
  return { merchantId, outing };
}
