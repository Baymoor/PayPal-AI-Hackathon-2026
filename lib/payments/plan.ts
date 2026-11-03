/**
 * Planning a payment operation = writing a durable outbox row (and marking
 * the attempt *_PENDING) inside the caller's transaction. Nothing is sent to
 * the provider here; the worker executes planned operations later with the
 * stable `requestId` as PayPal-Request-Id, so retries never double-charge.
 */
import { and, eq } from "drizzle-orm";
import { paymentAttempts, paymentOperations, type PaymentOperation } from "../db/schema";
import type { Tx } from "../db/client";
import { assertPaymentTransition } from "../domain/state-machine";
import type { OperationKind, PaymentStatus } from "../domain/types";
import { enqueueJob, operationsJobKey } from "../jobs/queue";
import { assertMinor } from "../domain/money";

const PENDING_STATUS: Record<OperationKind, PaymentStatus> = {
  CAPTURE: "CAPTURE_PENDING",
  VOID: "VOID_PENDING",
  REFUND: "REFUND_PENDING",
};

/** Stable idempotency key: one logical operation per (attempt, kind). */
export function operationRequestId(kind: OperationKind, paymentAttemptId: string): string {
  return `outings-${kind.toLowerCase()}-${paymentAttemptId}`;
}

export interface PlanOperationInput {
  outingId: string;
  paymentAttemptId: string;
  kind: OperationKind;
  amountMinor: number;
  currency: string;
  /** Execution order within the outing (captures run sequentially). */
  sequence?: number;
  /** Run no earlier than this. Defaults to now. */
  runAt?: Date;
}

/**
 * Idempotently plan an operation. Returns the existing row if this logical
 * operation was already planned (same attempt + kind).
 */
export async function planPaymentOperation(tx: Tx, input: PlanOperationInput): Promise<PaymentOperation> {
  assertMinor(input.amountMinor, "operation amount");
  const attempt = await tx.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, input.paymentAttemptId) });
  if (!attempt) throw new Error(`payment attempt ${input.paymentAttemptId} not found`);
  if (attempt.outingId !== input.outingId) throw new Error("payment attempt does not belong to outing");
  if (input.kind === "CAPTURE" && input.amountMinor > attempt.authorizedMinor) {
    throw new Error(`refusing to plan capture of ${input.amountMinor} above authorized ${attempt.authorizedMinor}`);
  }
  if (input.kind === "REFUND" && input.amountMinor > attempt.capturedMinor - attempt.refundedMinor) {
    throw new Error("refusing to plan refund above captured amount");
  }

  const inserted = await tx
    .insert(paymentOperations)
    .values({
      outingId: input.outingId,
      paymentAttemptId: input.paymentAttemptId,
      kind: input.kind,
      amountMinor: input.amountMinor,
      currency: input.currency,
      requestId: operationRequestId(input.kind, input.paymentAttemptId),
      sequence: input.sequence ?? 0,
      nextAttemptAt: input.runAt ?? new Date(),
    })
    .onConflictDoNothing({ target: [paymentOperations.paymentAttemptId, paymentOperations.kind] })
    .returning();

  const op =
    inserted[0] ??
    (await tx.query.paymentOperations.findFirst({
      where: and(eq(paymentOperations.paymentAttemptId, input.paymentAttemptId), eq(paymentOperations.kind, input.kind)),
    }));
  if (!op) throw new Error("failed to plan payment operation");

  if (inserted[0]) {
    const next = PENDING_STATUS[input.kind];
    if (attempt.status !== next) {
      assertPaymentTransition(attempt.status, next);
      await tx
        .update(paymentAttempts)
        .set({ status: next, updatedAt: new Date() })
        .where(eq(paymentAttempts.id, attempt.id));
    }
    await enqueueJob(tx, {
      kind: "PROCESS_OPERATIONS",
      outingId: input.outingId,
      runAt: input.runAt ?? new Date(),
      dedupeKey: operationsJobKey(input.outingId),
      onConflict: "requeue",
    });
  }
  return op;
}
