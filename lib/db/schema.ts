/**
 * Outings persistence schema (Postgres, Drizzle ORM).
 *
 * Conventions
 * - All money columns are integer minor units (`*_minor`) + an explicit currency.
 * - All timestamps are `timestamptz` (stored UTC); display timezone is separate.
 * - Primary keys are random UUIDs (never sequential, never used as access control).
 * - Enums mirror lib/domain/types.ts.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  ATTENDANCE_STATES,
  BUDGET_UNITS,
  CLEANUP_STATES,
  DEADLINE_POLICIES,
  JOB_KINDS,
  JOB_STATUSES,
  OPERATION_KINDS,
  OPERATION_STATUSES,
  OUTING_STATUSES,
  PARTICIPANT_ROLES,
  PAYER_TYPES,
  PAYMENT_PROVIDERS,
  PAYMENT_STATUSES,
  PRICING_MODELS,
  QUOTE_STATUSES,
  SETTLEMENT_DECISIONS,
} from "../domain/types";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();

export const outingStatus = pgEnum("outing_status", OUTING_STATUSES);
export const deadlinePolicy = pgEnum("deadline_policy", DEADLINE_POLICIES);
export const pricingModel = pgEnum("pricing_model", PRICING_MODELS);
export const budgetUnit = pgEnum("budget_unit", BUDGET_UNITS);
export const participantRole = pgEnum("participant_role", PARTICIPANT_ROLES);
export const payerType = pgEnum("payer_type", PAYER_TYPES);
export const attendanceState = pgEnum("attendance_state", ATTENDANCE_STATES);
export const quoteStatus = pgEnum("quote_status", QUOTE_STATUSES);
export const paymentProvider = pgEnum("payment_provider", PAYMENT_PROVIDERS);
export const paymentStatus = pgEnum("payment_status", PAYMENT_STATUSES);
export const operationKind = pgEnum("operation_kind", OPERATION_KINDS);
export const operationStatus = pgEnum("operation_status", OPERATION_STATUSES);
export const jobKind = pgEnum("job_kind", JOB_KINDS);
export const jobStatus = pgEnum("job_status", JOB_STATUSES);
export const settlementDecision = pgEnum("settlement_decision", SETTLEMENT_DECISIONS);
export const cleanupState = pgEnum("cleanup_state", CLEANUP_STATES);

/* ----------------------------- Merchant catalogue ---------------------------- */

export const merchants = pgTable("merchants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** Sandbox PayPal merchant id of the experience merchant (payee), if known. */
  paypalMerchantId: text("paypal_merchant_id"),
  timezone: text("timezone").notNull().default("Europe/Copenhagen"),
  createdAt: createdAt(),
});

export const offerings = pgTable(
  "offerings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    description: text("description").notNull(),
    location: text("location").notNull(),
    pricingModel: pricingModel("pricing_model").notNull(),
    /** FIXED_TOTAL: the all-in total. PER_ATTENDEE: price per attendee. */
    priceMinor: integer("price_minor").notNull(),
    currency: text("currency").notNull().default("USD"),
    minAttendees: integer("min_attendees").notNull().default(1),
    capacity: integer("capacity").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    /** Demo availability model (labelled FIXTURE capacity in the UI). */
    availability: jsonb("availability")
      .$type<{ weekdays: number[]; startHours: number[]; source: "FIXTURE" | "MERCHANT_API" }>()
      .notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("offerings_merchant_slug_idx").on(t.merchantId, t.slug),
    check("offerings_price_positive", sql`${t.priceMinor} > 0`),
    check("offerings_capacity_positive", sql`${t.capacity} > 0`),
  ],
);

/* ---------------------------------- Outings --------------------------------- */

export const outings = pgTable(
  "outings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    brief: text("brief").notNull().default(""),
    /** Structured AI extraction of the brief (validated) + provenance. */
    briefExtraction: jsonb("brief_extraction"),
    status: outingStatus("status").notNull().default("DRAFT"),
    policy: deadlinePolicy("policy").notNull().default("ALL_REQUIRED"),
    currency: text("currency").notNull().default("USD"),
    budgetUnit: budgetUnit("budget_unit").notNull().default("TOTAL"),
    budgetRound: integer("budget_round").notNull().default(1),
    budgetRevealedAt: ts("budget_revealed_at"),
    /** Stored aggregate-only reveal (RevealAggregate) + AI summary with provenance. No names. */
    budgetReveal: jsonb("budget_reveal"),
    /** Organizer-chosen proposal budget in `budgetUnit` (per person for new outings), minor units. Not a payment authorization. */
    proposedBudgetMinor: integer("proposed_budget_minor"),
    /** AI-ranked catalogue proposal (validated against the catalogue) + provenance. */
    proposal: jsonb("proposal"),
    /** Offering the organizer selected (preview only; terms are fixed when collection opens). */
    selectedOfferingId: uuid("selected_offering_id"),
    merchantId: uuid("merchant_id").references(() => merchants.id),
    currentQuoteId: uuid("current_quote_id"),
    minPayers: integer("min_payers"),
    maxAttendees: integer("max_attendees"),
    activityAt: ts("activity_at"),
    deadlineAt: ts("deadline_at"),
    displayTimezone: text("display_timezone").notNull().default("Europe/Copenhagen"),
    collectionOpenedAt: ts("collection_opened_at"),
    /** Set exactly once when the roster is frozen for settlement. */
    frozenAt: ts("frozen_at"),
    settledAt: ts("settled_at"),
    cancelledAt: ts("cancelled_at"),
    cancelReasons: jsonb("cancel_reasons").$type<string[]>().notNull().default([]),
    cleanup: cleanupState("cleanup").notNull().default("NONE"),
    /** Optimistic concurrency version, bumped on every status change. */
    version: integer("version").notNull().default(1),
    /** Demo/fixture outings are visibly separated from real sandbox ones. */
    isFixture: boolean("is_fixture").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("outings_status_deadline_idx").on(t.status, t.deadlineAt), index("outings_merchant_idx").on(t.merchantId)],
);

export const quoteVersions = pgTable(
  "quote_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outingId: uuid("outing_id")
      .notNull()
      .references(() => outings.id),
    version: integer("version").notNull(),
    status: quoteStatus("status").notNull().default("ACTIVE"),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    offeringId: uuid("offering_id")
      .notNull()
      .references(() => offerings.id),
    pricingModel: pricingModel("pricing_model").notNull(),
    totalMinor: integer("total_minor").notNull(),
    currency: text("currency").notNull(),
    capacity: integer("capacity").notNull(),
    minPayers: integer("min_payers").notNull(),
    capMinor: integer("cap_minor").notNull(),
    activityAt: ts("activity_at").notNull(),
    deadlineAt: ts("deadline_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    /** Full canonical CommitmentTerms object and its SHA-256 hash. */
    terms: jsonb("terms").notNull(),
    termsHash: text("terms_hash").notNull(),
    merchantConfirmedAt: ts("merchant_confirmed_at").notNull(),
    /** FIXTURE when availability came from the demo catalogue model. */
    availabilitySource: text("availability_source").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("quote_versions_outing_version_idx").on(t.outingId, t.version),
    check("quote_total_positive", sql`${t.totalMinor} > 0`),
    check("quote_cap_positive", sql`${t.capMinor} > 0`),
  ],
);

export const participants = pgTable(
  "participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outingId: uuid("outing_id")
      .notNull()
      .references(() => outings.id),
    displayName: text("display_name").notNull(),
    role: participantRole("role").notNull().default("INVITEE"),
    payerType: payerType("payer_type").notNull().default("PAYER"),
    required: boolean("required").notNull().default(true),
    /** Immutable stable ordering key for penny allocation (assigned once). */
    sortKey: integer("sort_key").notNull(),
    attendance: attendanceState("attendance").notNull().default("PENDING"),
    attendanceAt: ts("attendance_at"),
    /** SHA-256 of the high-entropy invitation token. The token itself is never stored. */
    inviteTokenHash: text("invite_token_hash").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("participants_outing_sort_idx").on(t.outingId, t.sortKey), index("participants_outing_idx").on(t.outingId)],
);

export const budgetVotes = pgTable(
  "budget_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outingId: uuid("outing_id")
      .notNull()
      .references(() => outings.id),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id),
    round: integer("round").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    unit: budgetUnit("unit").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("budget_votes_unique_idx").on(t.outingId, t.participantId, t.round),
    check("budget_vote_positive", sql`${t.amountMinor} > 0`),
  ],
);

export const consents = pgTable(
  "consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outingId: uuid("outing_id")
      .notNull()
      .references(() => outings.id),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quoteVersions.id),
    termsHash: text("terms_hash").notNull(),
    capMinor: integer("cap_minor").notNull(),
    currency: text("currency").notNull(),
    /** Exact consent statement shown to the payer. */
    statement: text("statement").notNull(),
    acceptedAt: ts("accepted_at").notNull(),
    withdrawnAt: ts("withdrawn_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("consents_participant_idx").on(t.participantId),
    // One active consent per participant per quote version.
    uniqueIndex("consents_active_unique_idx").on(t.participantId, t.quoteId).where(sql`${t.withdrawnAt} is null`),
  ],
);

export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outingId: uuid("outing_id")
      .notNull()
      .references(() => outings.id),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id),
    consentId: uuid("consent_id")
      .notNull()
      .references(() => consents.id),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quoteVersions.id),
    provider: paymentProvider("provider").notNull(),
    status: paymentStatus("status").notNull().default("CREATED"),
    currency: text("currency").notNull(),
    /** Amount the order was created for == consented cap. */
    requestedMinor: integer("requested_minor").notNull(),
    authorizedMinor: integer("authorized_minor").notNull().default(0),
    capturedMinor: integer("captured_minor").notNull().default(0),
    refundedMinor: integer("refunded_minor").notNull().default(0),
    providerOrderId: text("provider_order_id"),
    authorizationId: text("authorization_id"),
    captureId: text("capture_id"),
    refundId: text("refund_id"),
    /** Provider authorization create_time — the verified completion timestamp. */
    authorizedAt: ts("authorized_at"),
    authorizationExpiresAt: ts("authorization_expires_at"),
    /** True only after state was read back from the provider / verified webhook. */
    verified: boolean("verified").notNull().default(false),
    verifiedAt: ts("verified_at"),
    /** Authorization arrived after the deadline — must be voided, never admitted. */
    late: boolean("late").notNull().default(false),
    /** Last raw provider status string (e.g. "CREATED", "COMPLETED"), redacted context only. */
    providerStatus: text("provider_status"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("payment_attempts_outing_idx").on(t.outingId),
    index("payment_attempts_participant_idx").on(t.participantId),
    uniqueIndex("payment_attempts_order_idx").on(t.providerOrderId),
    uniqueIndex("payment_attempts_authorization_idx").on(t.authorizationId),
    check("payment_requested_positive", sql`${t.requestedMinor} > 0`),
    // Application invariant mirrored in the DB: never capture above the authorized amount.
    check("payment_capture_le_authorized", sql`${t.capturedMinor} <= ${t.authorizedMinor}`),
    check("payment_refund_le_captured", sql`${t.refundedMinor} <= ${t.capturedMinor}`),
  ],
);

/** Immutable record of the frozen roster and every allocated cent. One per outing. */
export const settlementSnapshots = pgTable("settlement_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  outingId: uuid("outing_id")
    .notNull()
    .unique()
    .references(() => outings.id),
  quoteId: uuid("quote_id")
    .notNull()
    .references(() => quoteVersions.id),
  termsHash: text("terms_hash").notNull(),
  decision: settlementDecision("decision").notNull(),
  reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
  frozenAt: ts("frozen_at").notNull(),
  totalMinor: integer("total_minor").notNull(),
  currency: text("currency").notNull(),
  payerCount: integer("payer_count").notNull(),
  /** Full decision payload: allocations, sponsored ids, ineligible list, voids. */
  roster: jsonb("roster").notNull(),
  createdAt: createdAt(),
});

/** Durable payment operation outbox. One logical operation per (attempt, kind). */
export const paymentOperations = pgTable(
  "payment_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outingId: uuid("outing_id")
      .notNull()
      .references(() => outings.id),
    paymentAttemptId: uuid("payment_attempt_id")
      .notNull()
      .references(() => paymentAttempts.id),
    kind: operationKind("kind").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    /** Stable PayPal-Request-Id reused for every retry of this logical operation. */
    requestId: text("request_id").notNull().unique(),
    status: operationStatus("status").notNull().default("PENDING"),
    /** Execution order within an outing (captures run sequentially). */
    sequence: integer("sequence").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    providerRef: text("provider_ref"),
    providerStatus: text("provider_status"),
    lastError: text("last_error"),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payment_operations_attempt_kind_idx").on(t.paymentAttemptId, t.kind),
    index("payment_operations_status_idx").on(t.status, t.nextAttemptAt),
    check("payment_operation_amount_non_negative", sql`${t.amountMinor} >= 0`),
  ],
);

export const webhookEvents = pgTable("webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: paymentProvider("provider").notNull(),
  providerEventId: text("provider_event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  resourceId: text("resource_id"),
  verified: boolean("verified").notNull(),
  /** Redacted payload (no buyer PII). */
  payload: jsonb("payload").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
  processedAt: ts("processed_at"),
  processingError: text("processing_error"),
});

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: jobKind("kind").notNull(),
    outingId: uuid("outing_id").references(() => outings.id),
    payload: jsonb("payload").notNull().default({}),
    runAt: ts("run_at").notNull(),
    status: jobStatus("status").notNull().default("QUEUED"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(10),
    lockedBy: text("locked_by"),
    lockedUntil: ts("locked_until"),
    lastError: text("last_error"),
    /** Prevents duplicate scheduling of the same logical job. */
    dedupeKey: text("dedupe_key").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("jobs_due_idx").on(t.status, t.runAt)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outingId: uuid("outing_id").references(() => outings.id),
    /** "SYSTEM", "MERCHANT", "PARTICIPANT:<id>", "WORKER:<id>", "WEBHOOK" */
    actor: text("actor").notNull(),
    type: text("type").notNull(),
    data: jsonb("data").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_outing_idx").on(t.outingId, t.createdAt)],
);

/** Records AI calls (real or fixture) for honest provenance; no private votes or PII. */
export const aiRuns = pgTable("ai_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  outingId: uuid("outing_id").references(() => outings.id),
  purpose: text("purpose").notNull(),
  /** "ANTHROPIC" (real model call) or "FIXTURE" (deterministic, labelled). */
  source: text("source").notNull(),
  model: text("model"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  ok: boolean("ok").notNull(),
  error: text("error"),
  output: jsonb("output"),
  createdAt: createdAt(),
});

/**
 * Persistent state of the FIXTURE payment simulator (orders, authorizations,
 * captures, refunds). Only used when paymentMode === "FIXTURE"; never mixed
 * with real PayPal data. Kept in Postgres so the web app and the worker share it.
 */
export const fixtureProviderObjects = pgTable(
  "fixture_provider_objects",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // ORDER | AUTHORIZATION | CAPTURE | REFUND | REQUEST
    data: jsonb("data").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("fixture_provider_objects_kind_idx").on(t.kind)],
);

export type Merchant = typeof merchants.$inferSelect;
export type Offering = typeof offerings.$inferSelect;
export type Outing = typeof outings.$inferSelect;
export type QuoteVersion = typeof quoteVersions.$inferSelect;
export type Participant = typeof participants.$inferSelect;
export type BudgetVote = typeof budgetVotes.$inferSelect;
export type Consent = typeof consents.$inferSelect;
export type PaymentAttempt = typeof paymentAttempts.$inferSelect;
export type SettlementSnapshot = typeof settlementSnapshots.$inferSelect;
export type PaymentOperation = typeof paymentOperations.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type AiRun = typeof aiRuns.$inferSelect;
