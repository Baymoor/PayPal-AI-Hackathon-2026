/**
 * Shared domain vocabulary. These string unions are mirrored 1:1 by Postgres
 * enums in lib/db/schema.ts — change both together.
 */

export const OUTING_STATUSES = [
  "DRAFT",
  "BUDGETING",
  "PROPOSED",
  "COLLECTING",
  "SETTLING",
  "CONFIRMED",
  "CANCELLING",
  "COMPENSATING",
  "CANCELLED",
] as const;
export type OutingStatus = (typeof OUTING_STATUSES)[number];

/** Deadline policy. Only ALL_REQUIRED is implemented for the MVP. */
export const DEADLINE_POLICIES = ["ALL_REQUIRED"] as const;
export type DeadlinePolicy = (typeof DEADLINE_POLICIES)[number];

export const PRICING_MODELS = ["FIXED_TOTAL", "PER_ATTENDEE"] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

export const BUDGET_UNITS = ["TOTAL", "PER_PERSON"] as const;
export type BudgetUnit = (typeof BUDGET_UNITS)[number];

export const PARTICIPANT_ROLES = ["ORGANIZER", "INVITEE"] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

/** A sponsored guest attends at $0; everyone else on the roster is a payer. */
export const PAYER_TYPES = ["PAYER", "SPONSORED"] as const;
export type PayerType = (typeof PAYER_TYPES)[number];

export const ATTENDANCE_STATES = ["PENDING", "ACCEPTED", "DECLINED", "WITHDRAWN"] as const;
export type AttendanceState = (typeof ATTENDANCE_STATES)[number];

export const QUOTE_STATUSES = ["ACTIVE", "SUPERSEDED", "EXPIRED"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const PAYMENT_PROVIDERS = ["PAYPAL", "FIXTURE"] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

/** Per-payment lifecycle (one PaymentAttempt == one PayPal order/authorization). */
export const PAYMENT_STATUSES = [
  "CREATED",
  "APPROVAL_PENDING",
  "AUTHORIZED",
  "CAPTURE_PENDING",
  "CAPTURED",
  "VOID_PENDING",
  "VOIDED",
  "REFUND_PENDING",
  "REFUNDED",
  "FAILED",
  "UNKNOWN",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const OPERATION_KINDS = ["CAPTURE", "VOID", "REFUND"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * Durable payment operation (outbox row) status.
 * - PENDING: planned, not yet sent
 * - IN_FLIGHT: request sent, outcome not yet recorded
 * - SUCCEEDED / FAILED: provider-confirmed terminal outcomes
 * - UNKNOWN: timeout / 5xx / network error — must be reconciled before any retry decision
 * - SKIPPED: deliberately not executed (e.g. remaining captures after a failure)
 */
export const OPERATION_STATUSES = ["PENDING", "IN_FLIGHT", "SUCCEEDED", "FAILED", "UNKNOWN", "SKIPPED"] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const JOB_KINDS = ["SETTLE_DEADLINE", "PROCESS_OPERATIONS", "RECONCILE_PAYMENT"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ["QUEUED", "RUNNING", "DONE", "FAILED", "DEAD"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const SETTLEMENT_DECISIONS = ["SETTLE", "CANCEL"] as const;
export type SettlementDecisionKind = (typeof SETTLEMENT_DECISIONS)[number];

/** Why an outing was cancelled. Several can apply at once. */
export const CANCEL_REASONS = [
  "REQUIRED_MISSING", // ALL_REQUIRED: a required invitee did not accept / authorize in time
  "REQUIRED_DECLINED", // a required invitee declined or withdrew before the deadline
  "BELOW_MIN_PAYERS", // fewer eligible payers than minPayers -> shares would exceed caps
  "NO_PAYERS",
  "CAP_EXCEEDED", // defensive: an allocation would exceed a consented cap
  "CAPACITY_EXCEEDED",
  "QUOTE_EXPIRED",
  "MERCHANT_UNAVAILABLE",
  "UNVERIFIABLE", // provider state could not be verified -> fail closed
  "ORGANIZER_CANCELLED",
  "CAPTURE_FAILED", // partial group capture failure -> compensation
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

/**
 * Money clean-up state shown next to a cancelled/confirmed booking. Derived
 * from payment attempts/operations; never set "COMPLETE" merely because a
 * cancellation was requested.
 */
export const CLEANUP_STATES = ["NONE", "VOID_PENDING", "REFUND_PENDING", "NEEDS_ATTENTION", "COMPLETE"] as const;
export type CleanupState = (typeof CLEANUP_STATES)[number];

/** Identifies the equal-split algorithm version recorded in consents and snapshots. */
export const SPLIT_RULE = "EQUAL_STABLE_PENNY_V1" as const;

/** Safety window: commitment deadline at most 48h after collection opens. */
export const MAX_COMMITMENT_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Minimum lead time for a deadline when opening collection. */
export const MIN_COMMITMENT_WINDOW_MS = 60 * 1000;
/** A quote must stay valid at least this long after the deadline (settlement grace). */
export const QUOTE_SETTLEMENT_GRACE_MS = 60 * 60 * 1000;
/** Budget reveal needs at least this many votes so no single vote is exposed. */
export const MIN_VOTES_FOR_REVEAL = 3;
