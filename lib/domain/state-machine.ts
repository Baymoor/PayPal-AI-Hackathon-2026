import type { OperationStatus, OutingStatus, PaymentStatus } from "./types";

/**
 * Legal transitions for the booking lifecycle:
 *
 *   DRAFT -> BUDGETING -> PROPOSED -> COLLECTING -> SETTLING -> CONFIRMED
 *                                       |              |
 *                          deadline not met         capture failure
 *                                       v              v
 *                                  CANCELLING      COMPENSATING
 *                                       |              |
 *                                       +--> CANCELLED <-+
 *
 * Payment clean-up (void / refund) is tracked separately from booking status:
 * a CANCELLED booking may still show VOID_PENDING / REFUND_PENDING money state.
 */
const OUTING_TRANSITIONS: Record<OutingStatus, readonly OutingStatus[]> = {
  DRAFT: ["BUDGETING", "CANCELLED"],
  BUDGETING: ["PROPOSED", "CANCELLED"],
  // PROPOSED -> BUDGETING lets the organizer run another budget round before any consent exists.
  PROPOSED: ["COLLECTING", "BUDGETING", "CANCELLED"],
  COLLECTING: ["SETTLING", "CANCELLING"],
  SETTLING: ["CONFIRMED", "COMPENSATING"],
  CONFIRMED: [],
  CANCELLING: ["CANCELLED"],
  COMPENSATING: ["CANCELLED"],
  CANCELLED: [],
};

export function canTransitionOuting(from: OutingStatus, to: OutingStatus): boolean {
  return OUTING_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly entity: "outing" | "payment" | "operation",
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${entity} transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertOutingTransition(from: OutingStatus, to: OutingStatus): void {
  if (!canTransitionOuting(from, to)) throw new IllegalTransitionError("outing", from, to);
}

/** Outing states in which no new commitments (consent / authorization) are accepted. */
export function acceptsCommitments(status: OutingStatus): boolean {
  return status === "COLLECTING";
}

export function isTerminalOuting(status: OutingStatus): boolean {
  return status === "CONFIRMED" || status === "CANCELLED";
}

/**
 * Per-payment lifecycle. UNKNOWN means "we sent something and do not know the
 * outcome" (e.g. HTTP timeout) — it is NOT evidence the provider did nothing,
 * so reconciliation may resolve it to any provider-observed state.
 */
const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: ["APPROVAL_PENDING", "FAILED", "UNKNOWN"],
  APPROVAL_PENDING: ["AUTHORIZED", "FAILED", "UNKNOWN"],
  AUTHORIZED: ["CAPTURE_PENDING", "VOID_PENDING", "VOIDED", "FAILED", "UNKNOWN"],
  // A definitive capture failure on a still-valid hold must lead to a void.
  CAPTURE_PENDING: ["CAPTURED", "VOID_PENDING", "FAILED", "UNKNOWN"],
  CAPTURED: ["REFUND_PENDING"],
  VOID_PENDING: ["VOIDED", "FAILED", "UNKNOWN"],
  VOIDED: [],
  REFUND_PENDING: ["REFUNDED", "FAILED", "UNKNOWN"],
  REFUNDED: [],
  // FAILED may still hold money that needs releasing (e.g. capture declined, hold still valid).
  FAILED: ["VOID_PENDING", "REFUND_PENDING"],
  UNKNOWN: [
    "APPROVAL_PENDING",
    "AUTHORIZED",
    "CAPTURE_PENDING",
    "CAPTURED",
    "VOID_PENDING",
    "VOIDED",
    "REFUND_PENDING",
    "REFUNDED",
    "FAILED",
  ],
};

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return from === to || PAYMENT_TRANSITIONS[from].includes(to);
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransitionPayment(from, to)) throw new IllegalTransitionError("payment", from, to);
}

/** Statuses in which an uncaptured authorization hold may exist at the provider. */
export function mayHoldFunds(status: PaymentStatus): boolean {
  return status === "AUTHORIZED" || status === "CAPTURE_PENDING" || status === "VOID_PENDING" || status === "UNKNOWN";
}

export function isTerminalPayment(status: PaymentStatus): boolean {
  return status === "VOIDED" || status === "REFUNDED";
}

const OPERATION_TRANSITIONS: Record<OperationStatus, readonly OperationStatus[]> = {
  PENDING: ["IN_FLIGHT", "SKIPPED"],
  IN_FLIGHT: ["SUCCEEDED", "FAILED", "UNKNOWN"],
  // UNKNOWN is resolved by reconciliation, or retried with the SAME request id.
  UNKNOWN: ["IN_FLIGHT", "SUCCEEDED", "FAILED"],
  // A retryable failure can be re-sent with the same idempotency key.
  FAILED: ["IN_FLIGHT"],
  SUCCEEDED: [],
  SKIPPED: [],
};

export function canTransitionOperation(from: OperationStatus, to: OperationStatus): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}

export function assertOperationTransition(from: OperationStatus, to: OperationStatus): void {
  if (!canTransitionOperation(from, to)) throw new IllegalTransitionError("operation", from, to);
}
