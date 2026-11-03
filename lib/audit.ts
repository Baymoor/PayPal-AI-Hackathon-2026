import { auditEvents } from "./db/schema";
import type { DbOrTx } from "./db/client";

export type AuditActor = "SYSTEM" | "MERCHANT" | "WEBHOOK" | `PARTICIPANT:${string}` | `WORKER:${string}`;

/**
 * Append-only audit trail. Never put secrets, tokens, buyer emails or private
 * budget votes in `data`.
 */
export async function recordAudit(
  db: DbOrTx,
  event: { outingId: string | null; actor: AuditActor; type: string; data?: Record<string, unknown> },
): Promise<void> {
  await db.insert(auditEvents).values({
    outingId: event.outingId,
    actor: event.actor,
    type: event.type,
    data: event.data ?? {},
  });
}
