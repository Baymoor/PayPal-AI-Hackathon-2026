/**
 * Shared view DTOs between the service layer (lib/services/views.ts) and the
 * UI (app/**, components/**). Server-authorized and sanitized: no private
 * budget votes linked to names, no tokens, no raw provider payloads.
 *
 * All money is integer minor units + currency. All instants are ISO-8601 UTC
 * strings; format them for display with `displayTimezone`.
 */
import type { AiSource, BriefExtraction, RevealAggregate } from "../ai/types";
import type {
  AttendanceState,
  CleanupState,
  OperationKind,
  OperationStatus,
  OutingStatus,
  ParticipantRole,
  PayerType,
  PaymentProviderName,
  PaymentStatus,
  PricingModel,
} from "../domain/types";

export type PaymentModeLabel = "PAYPAL_SANDBOX" | "FIXTURE" | "DISABLED";
export type AiModeLabel = "ANTHROPIC" | "FIXTURE" | "DISABLED";

/** Stepper position: Brief -> Budget -> Invite -> Commit, then Result. */
export type OutingStage = "BRIEF" | "BUDGET" | "INVITE" | "COMMIT" | "RESULT";

export interface PersonView {
  participantId: string;
  displayName: string;
  role: ParticipantRole;
  payerType: PayerType;
  required: boolean;
  attendance: AttendanceState;
  /** Payer: has a verified, timely authorization for current terms. Sponsored: accepted. */
  committed: boolean;
  /** Has voted in the current budget round (never the amount). */
  hasVoted: boolean;
}

export interface CatalogueCandidateView {
  offeringId: string;
  name: string;
  merchantName: string;
  category: string;
  description: string;
  location: string;
  pricingModel: PricingModel;
  priceMinor: number;
  currency: string;
  capacity: number;
  minAttendees: number;
  /** AI fit label + reasons (validated against catalogue). */
  fit: "GREAT" | "GOOD" | "STRETCH" | null;
  reasons: string[];
  concerns: string[];
}

export interface QuoteView {
  id: string;
  version: number;
  merchantName: string;
  offeringName: string;
  /** Catalogue category, e.g. "karaoke"; decorative use only (picks the invitation picture). */
  category: string;
  location: string;
  pricingModel: PricingModel;
  totalMinor: number;
  currency: string;
  capMinor: number;
  minPayers: number;
  capacity: number;
  activityAt: string;
  deadlineAt: string;
  expiresAt: string;
  termsHash: string;
  merchantConfirmedAt: string;
  /** "FIXTURE" = demo catalogue availability model (must be labelled in UI). */
  availabilitySource: "FIXTURE" | "MERCHANT_API";
  sponsoredNames: string[];
  requiredCount: number;
}

export interface MyPaymentView {
  paymentAttemptId: string;
  status: PaymentStatus;
  provider: PaymentProviderName;
  /** "PayPal sandbox" | "Fixture · not real PayPal" */
  providerLabel: string;
  authorizedMinor: number;
  capturedMinor: number;
  refundedMinor: number;
  late: boolean;
  verified: boolean;
  /** Redacted, e.g. "…4F2A" */
  authorizationRef: string | null;
}

export interface OutingView {
  outing: {
    id: string;
    title: string;
    brief: string;
    status: OutingStatus;
    stage: OutingStage;
    isFixture: boolean;
    currency: string;
    displayTimezone: string;
    activityAt: string | null;
    deadlineAt: string | null;
    /** Server time when the view was built (countdowns must not trust the client clock). */
    serverNow: string;
    cancelReasons: string[];
    cleanup: CleanupState;
    paymentMode: PaymentModeLabel;
    aiMode: AiModeLabel;
    /**
     * Server runs with DEMO_FIXTURES_ENABLED: the judge bar (act as any participant of this outing
     * without an invitation link) is shown. Never true in a real deployment.
     */
    demoMode: boolean;
  };
  viewer: {
    participantId: string;
    displayName: string;
    role: ParticipantRole;
    payerType: PayerType;
    required: boolean;
    attendance: AttendanceState;
    isOrganizer: boolean;
  };
  brief: {
    extraction: BriefExtraction | null;
    source: AiSource | null;
    model: string | null;
  };
  budget: {
    round: number;
    unit: "TOTAL";
    /** Suggested totals in minor units, e.g. [5000, 7500, 10000, 15000, 20000]. */
    options: number[];
    myVoteMinor: number | null;
    votedCount: number;
    invitedCount: number;
    revealed: boolean;
    /** Organizer-only flag: enough votes (>= 3) to reveal without exposing anyone. */
    canReveal: boolean;
    /** Aggregate only; null until revealed. */
    aggregate: RevealAggregate | null;
    aiSummary: { headline: string; summary: string; suggestedTotalMinor: number; source: AiSource; model: string | null } | null;
    proposedBudgetMinor: number | null;
  };
  /** Organizer sees candidates while choosing; everyone sees the selected offering. */
  proposal: {
    candidates: CatalogueCandidateView[];
    note: string | null;
    source: AiSource | null;
    selectedOfferingId: string | null;
  } | null;
  quote: QuoteView | null;
  roster: {
    people: PersonView[];
    capacity: number | null;
    minPayers: number | null;
    invitedPayers: number;
    sponsoredCount: number;
    attendeeCount: number;
    requiredInvited: number;
    requiredAccepted: number;
    payersAuthorized: number;
  };
  estimates: {
    capMinor: number | null;
    /** Payers who would be on the roster if it froze now, incl. the viewer if they commit. */
    projectedPayers: number;
    estimatedShareMinor: number | null;
  };
  me: {
    consent: { acceptedAt: string; capMinor: number; termsHash: string; current: boolean } | null;
    payment: MyPaymentView | null;
    /** From the immutable settlement snapshot, once frozen. */
    finalShareMinor: number | null;
    /** What the viewer may do right now (server-computed). */
    can: {
      vote: boolean;
      accept: boolean;
      decline: boolean;
      consent: boolean;
      authorize: boolean;
      withdraw: boolean;
    };
  };
  organizer: {
    can: {
      startBudget: boolean;
      addInvitees: boolean;
      reveal: boolean;
      newRound: boolean;
      agreeBudget: boolean;
      propose: boolean;
      selectOffering: boolean;
      editRoster: boolean; // sponsor / required toggles (before collection)
      openCollection: boolean;
      cancel: boolean;
      /** Ask the AI to pre-fill the open-commitments form (PROPOSED, AI configured). Absent in older views = false. */
      draftPlan?: boolean;
    };
  } | null;
  settlement: {
    decision: "SETTLE" | "CANCEL";
    frozenAt: string;
    payerCount: number;
    totalMinor: number;
    reasons: string[];
  } | null;
}

/* ------------------------------ Merchant ------------------------------------ */

export type RecoveryStatus = CleanupState;

export interface MerchantBookingRow {
  outingId: string;
  title: string;
  offeringName: string | null;
  status: OutingStatus;
  recoveryStatus: RecoveryStatus;
  isFixture: boolean;
  /** Provider of the outing's payment attempts; null if none yet. */
  provider: PaymentProviderName | "MIXED" | null;
  currency: string;
  activityAt: string | null;
  deadlineAt: string | null;
  /** Minutes until deadline (negative once passed); null without deadline. */
  closesInMinutes: number | null;
  /** Deadline falls later today in `merchantTimezone`. */
  closesToday: boolean;
  /** The merchant's IANA time zone (merchants.timezone); format instants in it. */
  merchantTimezone: string;
  requiredInvited: number;
  requiredAccepted: number;
  missingRequired: number;
  payersAuthorized: number;
  minPayers: number | null;
  capacity: number | null;
  attendees: number;
  totalMinor: number | null;
  capMinor: number | null;
  /** Uncaptured holds. NOT revenue. */
  authorizedTotalMinor: number;
  /** Sum of allocations in the frozen settlement snapshot. */
  allocatedTotalMinor: number;
  capturedTotalMinor: number;
  refundedTotalMinor: number;
  voidPendingCount: number;
  refundPendingCount: number;
  updatedAt: string;
}

export interface MerchantParticipantRow {
  participantId: string;
  displayName: string;
  role: ParticipantRole;
  payerType: PayerType;
  required: boolean;
  attendance: AttendanceState;
  consentQuoteVersion: number | null;
  consentAcceptedAt: string | null;
  consentCurrent: boolean;
  paymentStatus: PaymentStatus | null;
  provider: PaymentProviderName | null;
  late: boolean;
  orderRef: string | null;
  authorizationRef: string | null;
  captureRef: string | null;
  refundRef: string | null;
  authorizedMinor: number;
  allocationMinor: number | null;
  capturedMinor: number;
  refundedMinor: number;
}

export interface MerchantOperationRow {
  operationId: string;
  participantName: string;
  kind: OperationKind;
  status: OperationStatus;
  amountMinor: number;
  attempts: number;
  lastError: string | null;
  providerStatus: string | null;
  updatedAt: string;
  /** Safe manual recovery: re-queue this existing operation (never creates new money movement). */
  canRetry: boolean;
}

export interface MerchantOutingDetail {
  booking: MerchantBookingRow;
  quote: QuoteView | null;
  participants: MerchantParticipantRow[];
  operations: MerchantOperationRow[];
  timeline: { at: string; actor: string; type: string }[];
}
