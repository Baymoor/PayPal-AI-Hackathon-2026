/**
 * Deterministic outing policy: commitment terms, deadline validation,
 * eligibility at roster freeze and the settle/cancel decision.
 *
 * Everything in this module is a pure function of its inputs (time is passed
 * in explicitly). No AI output, browser timer or provider callback can change
 * these rules; they only provide verified facts that are fed in.
 */
import { createHash } from "node:crypto";
import { equalSplit, perPayerCap, assertPositiveMinor, type Currency } from "./money";
import {
  MAX_COMMITMENT_WINDOW_MS,
  MIN_COMMITMENT_WINDOW_MS,
  QUOTE_SETTLEMENT_GRACE_MS,
  SPLIT_RULE,
  type AttendanceState,
  type CancelReason,
  type DeadlinePolicy,
  type PayerType,
  type PaymentStatus,
  type PricingModel,
} from "./types";

export class PolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

/* -------------------------------------------------------------------------- */
/* Commitment terms                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The exact material terms a payer consents to. Any change to any field is a
 * material revision and produces a different hash, so stale consent can never
 * be silently reused.
 */
export interface CommitmentTerms {
  termsVersion: 1;
  outingId: string;
  quoteId: string;
  quoteVersion: number;
  merchantId: string;
  merchantName: string;
  offeringId: string;
  offeringName: string;
  pricingModel: PricingModel;
  totalMinor: number;
  currency: Currency;
  capacity: number;
  minPayers: number;
  capMinor: number;
  activityAt: string; // ISO-8601 UTC
  deadlineAt: string; // ISO-8601 UTC
  policy: DeadlinePolicy;
  splitRule: typeof SPLIT_RULE;
  sponsoredParticipantIds: string[]; // sorted
  requiredParticipantIds: string[]; // sorted
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonicalize((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Stable canonical JSON (sorted keys) used for hashing terms. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function buildCommitmentTerms(input: Omit<CommitmentTerms, "termsVersion" | "splitRule" | "capMinor">): CommitmentTerms {
  if (input.pricingModel !== "FIXED_TOTAL") {
    throw new PolicyError("PRICING_MODEL_UNSUPPORTED", "MVP only supports FIXED_TOTAL quotes for shared bookings");
  }
  assertPositiveMinor(input.totalMinor, "totalMinor");
  if (!Number.isSafeInteger(input.capacity) || input.capacity < 1) {
    throw new PolicyError("INVALID_CAPACITY", "capacity must be a positive integer");
  }
  if (!Number.isSafeInteger(input.minPayers) || input.minPayers < 1) {
    throw new PolicyError("INVALID_MIN_PAYERS", "minPayers must be a positive integer");
  }
  if (input.minPayers > input.capacity) {
    throw new PolicyError("INVALID_MIN_PAYERS", "minPayers cannot exceed capacity");
  }
  const sponsored = [...input.sponsoredParticipantIds].sort();
  const required = [...input.requiredParticipantIds].sort();
  if (new Set(sponsored).size !== sponsored.length || new Set(required).size !== required.length) {
    throw new PolicyError("DUPLICATE_PARTICIPANTS", "participant id lists must not contain duplicates");
  }
  return {
    ...input,
    termsVersion: 1,
    splitRule: SPLIT_RULE,
    capMinor: perPayerCap(input.totalMinor, input.minPayers),
    sponsoredParticipantIds: sponsored,
    requiredParticipantIds: required,
  };
}

export function hashTerms(terms: CommitmentTerms): string {
  return createHash("sha256").update(canonicalJson(terms)).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Deadlines                                                                  */
/* -------------------------------------------------------------------------- */

export interface DeadlineCheckInput {
  now: Date;
  deadlineAt: Date;
  activityAt: Date;
  quoteExpiresAt: Date;
}

/**
 * Validate a commitment deadline when collection opens. The window must stay
 * inside PayPal's authorization honor period with margin (<= 48h), precede
 * the activity, and the quote must stay valid through settlement.
 */
export function validateCommitmentDeadline({ now, deadlineAt, activityAt, quoteExpiresAt }: DeadlineCheckInput): void {
  const window = deadlineAt.getTime() - now.getTime();
  if (window < MIN_COMMITMENT_WINDOW_MS) {
    throw new PolicyError("DEADLINE_TOO_SOON", "The commitment deadline must be at least one minute from now");
  }
  if (window > MAX_COMMITMENT_WINDOW_MS) {
    throw new PolicyError(
      "DEADLINE_TOO_LATE",
      "The commitment deadline must be within 48 hours so payment holds stay inside the safe authorization window",
    );
  }
  if (deadlineAt.getTime() >= activityAt.getTime()) {
    throw new PolicyError("DEADLINE_AFTER_ACTIVITY", "The commitment deadline must be before the activity starts");
  }
  if (quoteExpiresAt.getTime() < deadlineAt.getTime() + QUOTE_SETTLEMENT_GRACE_MS) {
    throw new PolicyError("QUOTE_EXPIRES_TOO_SOON", "The merchant quote must remain valid for at least an hour after the deadline");
  }
}

/** Server-side commitment gate. `now` must be server time, never client time. */
export function isBeforeDeadline(now: Date, deadlineAt: Date): boolean {
  return now.getTime() < deadlineAt.getTime();
}

/* -------------------------------------------------------------------------- */
/* Settlement decision                                                        */
/* -------------------------------------------------------------------------- */

export interface RosterParticipant {
  id: string;
  /** Immutable stable ordering key assigned when the invitation was created. */
  sortKey: number;
  payerType: PayerType;
  required: boolean;
  attendance: AttendanceState;
  attendanceAt: Date | null;
}

export interface RosterConsent {
  id: string;
  participantId: string;
  quoteId: string;
  termsHash: string;
  capMinor: number;
  currency: Currency;
  acceptedAt: Date;
  withdrawnAt: Date | null;
}

/**
 * Provider-verified view of a payment attempt. `verified` must only be true
 * when the authorization state was read back from the provider (or from a
 * signature-verified webhook) — never from a browser redirect.
 */
export interface RosterAuthorization {
  paymentAttemptId: string;
  participantId: string;
  consentId: string | null;
  status: PaymentStatus;
  verified: boolean;
  authorizedMinor: number;
  currency: Currency;
  /** Provider authorization create_time (verified completion timestamp). */
  authorizedAt: Date | null;
  /** Provider authorization expiration_time. */
  expiresAt: Date | null;
}

export interface SettlementInput {
  now: Date;
  outingId: string;
  policy: DeadlinePolicy;
  deadlineAt: Date;
  quote: {
    id: string;
    termsHash: string;
    totalMinor: number;
    currency: Currency;
    capMinor: number;
    minPayers: number;
    capacity: number;
    expiresAt: Date;
  };
  participants: RosterParticipant[];
  consents: RosterConsent[];
  authorizations: RosterAuthorization[];
  /** Result of the merchant availability / quote validity check. */
  merchantAvailable: boolean;
  /** Early evaluation (before the deadline) is only allowed to CANCEL an infeasible outing. */
  early?: boolean;
}

export interface PayerAllocation {
  participantId: string;
  paymentAttemptId: string;
  consentId: string;
  sortKey: number;
  allocationMinor: number;
  capMinor: number;
  authorizedMinor: number;
}

export interface IneligibleEntry {
  participantId: string;
  required: boolean;
  reason:
    | "NOT_ACCEPTED"
    | "DECLINED"
    | "WITHDRAWN"
    | "LATE_ACCEPTANCE"
    | "NO_CONSENT"
    | "STALE_CONSENT"
    | "LATE_CONSENT"
    | "NO_AUTHORIZATION"
    | "LATE_AUTHORIZATION"
    | "UNVERIFIED_AUTHORIZATION"
    | "AUTHORIZATION_EXPIRED"
    | "AUTHORIZATION_MISMATCH";
}

export type SettlementDecision =
  | {
      kind: "SETTLE";
      totalMinor: number;
      currency: Currency;
      payerCount: number;
      allocations: PayerAllocation[];
      sponsoredParticipantIds: string[];
      ineligible: IneligibleEntry[];
      /** Holds that exist but will not be captured (late, duplicate, optional ineligible). */
      voidPaymentAttemptIds: string[];
    }
  | {
      kind: "CANCEL";
      reasons: CancelReason[];
      ineligible: IneligibleEntry[];
      /** Every attempt that may hold funds and must be voided. */
      voidPaymentAttemptIds: string[];
    };

const HOLD_STATUSES: ReadonlySet<PaymentStatus> = new Set(["AUTHORIZED", "UNKNOWN"]);

/** Immutable stable payer order: sortKey, then id as tiebreaker. */
export function stablePayerOrder<T extends { sortKey: number; participantId: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.sortKey - b.sortKey || (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0));
}

/**
 * Decide, from verified facts at roster freeze, whether to SETTLE (capture
 * exact allocated shares) or CANCEL (void every hold). Fails closed: any
 * unverifiable fact that matters leads to cancellation, never to a guess.
 */
export function decideSettlement(input: SettlementInput): SettlementDecision {
  const { now, deadlineAt, quote } = input;
  if (input.policy !== "ALL_REQUIRED") {
    throw new PolicyError("POLICY_UNSUPPORTED", `Unsupported deadline policy ${input.policy}`);
  }
  const deadlineMs = deadlineAt.getTime();
  if (!input.early && now.getTime() < deadlineMs) {
    throw new PolicyError("NOT_DUE", "Settlement cannot be evaluated before the deadline");
  }

  const ineligible: IneligibleEntry[] = [];
  const eligiblePayers: PayerAllocation[] = [];
  const eligibleSponsored: string[] = [];
  const usedAttemptIds = new Set<string>();
  const reasons = new Set<CancelReason>();

  for (const p of input.participants) {
    const markIneligible = (reason: IneligibleEntry["reason"]) => ineligible.push({ participantId: p.id, required: p.required, reason });

    if (p.attendance === "DECLINED") {
      markIneligible("DECLINED");
      if (p.required) reasons.add("REQUIRED_DECLINED");
      continue;
    }
    if (p.attendance === "WITHDRAWN") {
      markIneligible("WITHDRAWN");
      if (p.required) reasons.add("REQUIRED_DECLINED");
      continue;
    }
    if (p.attendance !== "ACCEPTED" || !p.attendanceAt) {
      markIneligible("NOT_ACCEPTED");
      continue;
    }
    if (p.attendanceAt.getTime() > deadlineMs) {
      markIneligible("LATE_ACCEPTANCE");
      continue;
    }

    if (p.payerType === "SPONSORED") {
      eligibleSponsored.push(p.id);
      continue;
    }

    // Payer: needs a timely consent to the CURRENT terms.
    const consents = input.consents.filter((c) => c.participantId === p.id && c.withdrawnAt === null);
    if (consents.length === 0) {
      markIneligible("NO_CONSENT");
      continue;
    }
    const current = consents.filter((c) => c.quoteId === quote.id && c.termsHash === quote.termsHash);
    if (current.length === 0) {
      markIneligible("STALE_CONSENT");
      continue;
    }
    const timelyConsent = current
      .filter((c) => c.acceptedAt.getTime() <= deadlineMs)
      .sort((a, b) => a.acceptedAt.getTime() - b.acceptedAt.getTime())[0];
    if (!timelyConsent) {
      markIneligible("LATE_CONSENT");
      continue;
    }

    // Payer: needs a verified, timely, unexpired authorization for exactly the consented cap.
    const auths = input.authorizations.filter((a) => a.participantId === p.id && HOLD_STATUSES.has(a.status));
    if (auths.length === 0) {
      markIneligible("NO_AUTHORIZATION");
      continue;
    }
    const verifiedAuths = auths.filter((a) => a.status === "AUTHORIZED" && a.verified);
    if (verifiedAuths.length === 0) {
      markIneligible("UNVERIFIED_AUTHORIZATION");
      continue;
    }
    const timely = verifiedAuths
      .filter((a) => a.authorizedAt !== null && a.authorizedAt.getTime() <= deadlineMs)
      .sort((a, b) => a.authorizedAt!.getTime() - b.authorizedAt!.getTime());
    if (timely.length === 0) {
      markIneligible("LATE_AUTHORIZATION");
      continue;
    }
    const usable = timely.filter((a) => a.expiresAt !== null && a.expiresAt.getTime() > now.getTime());
    if (usable.length === 0) {
      markIneligible("AUTHORIZATION_EXPIRED");
      continue;
    }
    const matching = usable.filter(
      (a) => a.currency === quote.currency && a.authorizedMinor === timelyConsent.capMinor && timelyConsent.capMinor === quote.capMinor,
    );
    if (matching.length === 0) {
      markIneligible("AUTHORIZATION_MISMATCH");
      continue;
    }
    const chosen = matching[0];
    usedAttemptIds.add(chosen.paymentAttemptId);
    eligiblePayers.push({
      participantId: p.id,
      paymentAttemptId: chosen.paymentAttemptId,
      consentId: timelyConsent.id,
      sortKey: p.sortKey,
      allocationMinor: 0,
      capMinor: timelyConsent.capMinor,
      authorizedMinor: chosen.authorizedMinor,
    });
  }

  // ALL_REQUIRED: any required participant who is not fully eligible cancels the outing.
  const requiredMissing = ineligible.filter((i) => i.required);
  if (requiredMissing.length > 0) {
    if (requiredMissing.some((i) => i.reason === "UNVERIFIED_AUTHORIZATION")) reasons.add("UNVERIFIABLE");
    if (requiredMissing.some((i) => i.reason !== "DECLINED" && i.reason !== "WITHDRAWN")) reasons.add("REQUIRED_MISSING");
  }

  if (!input.merchantAvailable) reasons.add("MERCHANT_UNAVAILABLE");
  if (quote.expiresAt.getTime() <= now.getTime()) reasons.add("QUOTE_EXPIRED");

  const attendeeCount = eligiblePayers.length + eligibleSponsored.length;
  if (attendeeCount > quote.capacity) reasons.add("CAPACITY_EXCEEDED");

  if (eligiblePayers.length === 0) reasons.add("NO_PAYERS");
  else if (eligiblePayers.length < quote.minPayers) reasons.add("BELOW_MIN_PAYERS");

  const allHolds = input.authorizations.filter((a) => HOLD_STATUSES.has(a.status)).map((a) => a.paymentAttemptId);

  if (input.early) {
    // Early evaluation may only cancel, and only for reasons that can no longer change.
    const terminal = new Set<CancelReason>(["REQUIRED_DECLINED", "QUOTE_EXPIRED", "MERCHANT_UNAVAILABLE"]);
    const early = [...reasons].filter((r) => terminal.has(r));
    if (early.length === 0) {
      throw new PolicyError("NOT_INFEASIBLE", "Outing is still feasible; early evaluation cannot settle");
    }
    return { kind: "CANCEL", reasons: early, ineligible, voidPaymentAttemptIds: allHolds };
  }

  if (reasons.size > 0) {
    return { kind: "CANCEL", reasons: [...reasons], ineligible, voidPaymentAttemptIds: allHolds };
  }

  const ordered = stablePayerOrder(eligiblePayers);
  const split = equalSplit(
    quote.totalMinor,
    ordered.map((p) => p.participantId),
  );
  const allocations = ordered.map((p, i) => ({ ...p, allocationMinor: split[i].amountMinor }));

  // Defensive: never capture above a consented cap or an authorized amount.
  if (allocations.some((a) => a.allocationMinor > a.capMinor || a.allocationMinor > a.authorizedMinor)) {
    return { kind: "CANCEL", reasons: ["CAP_EXCEEDED"], ineligible, voidPaymentAttemptIds: allHolds };
  }

  return {
    kind: "SETTLE",
    totalMinor: quote.totalMinor,
    currency: quote.currency,
    payerCount: allocations.length,
    allocations,
    sponsoredParticipantIds: eligibleSponsored,
    ineligible,
    voidPaymentAttemptIds: allHolds.filter((id) => !usedAttemptIds.has(id)),
  };
}

/**
 * True when the outing can no longer succeed regardless of what happens
 * before the deadline (used to cancel early and release holds sooner).
 */
export function isInfeasible(participants: readonly RosterParticipant[]): boolean {
  return participants.some((p) => p.required && (p.attendance === "DECLINED" || p.attendance === "WITHDRAWN"));
}
