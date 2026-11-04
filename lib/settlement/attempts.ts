/**
 * Small helpers for moving a payment attempt through its state machine from
 * provider-observed facts. All writes go through `assertPaymentPath` so an
 * illegal jump is a thrown error, never a silent overwrite.
 */
import { eq } from "drizzle-orm";
import { paymentAttempts, type PaymentAttempt } from "../db/schema";
import type { DbOrTx } from "../db/client";
import { assertPaymentTransition, canTransitionPayment } from "../domain/state-machine";
import type { PaymentStatus } from "../domain/types";

/**
 * Some provider observations legitimately skip one intermediate state that we
 * never had the chance to record (an approval that completed while we were
 * offline, a capture completed while an attempt was still AUTHORIZED in our
 * books). Only these documented two-hop paths are allowed.
 */
const TWO_HOP: Partial<Record<PaymentStatus, PaymentStatus>> = {
  CREATED: "APPROVAL_PENDING",
  AUTHORIZED: "CAPTURE_PENDING",
  CAPTURE_PENDING: "VOID_PENDING",
};

export function assertPaymentPath(from: PaymentStatus, to: PaymentStatus): void {
  if (canTransitionPayment(from, to)) return;
  const via = TWO_HOP[from];
  if (via && canTransitionPayment(from, via) && canTransitionPayment(via, to)) return;
  assertPaymentTransition(from, to);
}

export type AttemptPatch = Partial<
  Pick<
    PaymentAttempt,
    | "authorizedMinor"
    | "capturedMinor"
    | "refundedMinor"
    | "providerOrderId"
    | "authorizationId"
    | "captureId"
    | "refundId"
    | "authorizedAt"
    | "authorizationExpiresAt"
    | "verified"
    | "verifiedAt"
    | "late"
    | "providerStatus"
    | "lastError"
  >
>;

/** Transition + patch in one UPDATE. Returns the updated row. */
export async function moveAttempt(
  db: DbOrTx,
  attempt: PaymentAttempt,
  to: PaymentStatus,
  patch: AttemptPatch,
  now: Date,
): Promise<PaymentAttempt> {
  assertPaymentPath(attempt.status, to);
  const [row] = await db
    .update(paymentAttempts)
    .set({ ...patch, status: to, updatedAt: now })
    .where(eq(paymentAttempts.id, attempt.id))
    .returning();
  if (!row) throw new Error(`payment attempt ${attempt.id} vanished`);
  return row;
}

/** Patch facts without changing status. */
export async function patchAttempt(db: DbOrTx, attemptId: string, patch: AttemptPatch, now: Date): Promise<PaymentAttempt> {
  const [row] = await db
    .update(paymentAttempts)
    .set({ ...patch, updatedAt: now })
    .where(eq(paymentAttempts.id, attemptId))
    .returning();
  if (!row) throw new Error(`payment attempt ${attemptId} vanished`);
  return row;
}

/** Lock an attempt row for update inside a transaction. */
export async function lockAttempt(tx: DbOrTx, attemptId: string): Promise<PaymentAttempt | null> {
  const [row] = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, attemptId)).for("update");
  return row ?? null;
}

export function truncateError(message: string, max = 500): string {
  return message.length > max ? `${message.slice(0, max - 1)}…` : message;
}
