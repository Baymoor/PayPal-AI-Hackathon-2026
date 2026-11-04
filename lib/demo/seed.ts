/**
 * Demo seed: one experience merchant ("The Sound Room"), a small catalogue,
 * and clearly synthetic FIXTURE outings (isFixture = true) for the demo and
 * the merchant dashboard.
 *
 * Honesty rules
 * - Every seeded outing is `isFixture`; every seeded payment uses the FIXTURE
 *   provider ("Fixture — not real PayPal"). Fixture authorizations/captures
 *   are created through the real FixtureProvider so the worker can later
 *   void/capture/refund them exactly like live fixture payments.
 * - Seeded brief extractions come from the deterministic FIXTURE parser and
 *   are labelled FIXTURE; nothing is presented as model output.
 * - Settlement snapshots are produced by the real `decideSettlement` policy.
 *
 * Re-seeding deletes FIXTURE outings only; the merchant/catalogue are upserted
 * by slug so ids referenced by real (non-fixture) outings stay stable.
 */
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  aiRuns,
  auditEvents,
  budgetVotes,
  consents,
  fixtureProviderObjects,
  jobs,
  merchants,
  offerings,
  outings,
  participants,
  paymentAttempts,
  paymentOperations,
  quoteVersions,
  settlementSnapshots,
  type Consent,
  type Merchant,
  type Offering,
  type Outing,
  type Participant,
  type PaymentAttempt,
  type QuoteVersion,
} from "../db/schema";
import { config } from "../env";
import { demoInviteToken, hashToken } from "../auth/tokens";
import { buildCommitmentTerms, decideSettlement, hashTerms, type SettlementDecision } from "../domain/policy";
import type { AttendanceState, CleanupState, OperationKind, OperationStatus, OutingStatus, PaymentStatus } from "../domain/types";
import { FixtureProvider } from "../payments/fixture";
import type { ProviderResult } from "../payments/provider";
import { operationRequestId } from "../payments/plan";
import { settleJobKey } from "../jobs/queue";
import { FixtureOutingsAi } from "../ai/fixture";
import type { SettlementRoster } from "../settlement/snapshot";
import { aggregateVotes, commitStatement, type StoredBriefExtraction, type StoredProposal, type StoredReveal } from "../services/outings";
import { checkAvailability, zonedParts, zonedTimeToUtc } from "../services/catalogue";

import { DEMO_BUDGET_TITLE, DEMO_MAIN_TITLE, DEMO_MERCHANT_NAME, DEMO_MERCHANT_SLUG, DEMO_TIMEZONE } from "./constants";

export { DEMO_BUDGET_TITLE, DEMO_MAIN_TITLE, DEMO_MERCHANT_NAME, DEMO_MERCHANT_SLUG, DEMO_TIMEZONE };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                  */
/* -------------------------------------------------------------------------- */

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const CATALOGUE = [
  {
    slug: "private-karaoke-room",
    name: "Private karaoke room",
    category: "karaoke",
    description:
      "A private room for up to 10 with pro sound, two wireless mics and a 9,000-song library. One fixed price for the room, so every extra singer lowers each share.",
    location: "The Sound Room, Vesterbro, Copenhagen",
    pricingModel: "FIXED_TOTAL" as const,
    priceMinor: 10_000,
    minAttendees: 2,
    capacity: 10,
    durationMinutes: 120,
    tags: ["private room", "birthday", "music", "fixed total"],
    availability: { weekdays: ALL_DAYS, startHours: [16, 17, 18, 19, 20, 21], source: "FIXTURE" as const },
  },
  {
    slug: "karaoke-party-suite",
    name: "Karaoke party suite",
    category: "karaoke",
    description: "Our largest suite for up to 16, with a stage, light show and a host to get things started. Fixed total for the suite.",
    location: "The Sound Room, Vesterbro, Copenhagen",
    pricingModel: "FIXED_TOTAL" as const,
    priceMinor: 18_000,
    minAttendees: 6,
    capacity: 16,
    durationMinutes: 150,
    tags: ["private room", "party", "large group", "fixed total"],
    availability: { weekdays: ALL_DAYS, startHours: [18, 19, 20, 21], source: "FIXTURE" as const },
  },
  {
    slug: "pottery-wheel-evening",
    name: "Pottery wheel evening",
    category: "pottery",
    description: "A guided two-hour session on the wheel, clay and glazing included. Priced per attendee, so the total grows with each person.",
    location: "The Sound Room studio loft, Vesterbro, Copenhagen",
    pricingModel: "PER_ATTENDEE" as const,
    priceMinor: 2_500,
    minAttendees: 2,
    capacity: 8,
    durationMinutes: 120,
    tags: ["workshop", "creative", "per attendee"],
    availability: { weekdays: [2, 4, 6], startHours: [18, 19], source: "FIXTURE" as const },
  },
  {
    slug: "escape-room",
    name: "Escape room: The Lost Tape",
    category: "escape-room",
    description: "Find the missing master tape before the hour runs out. A private game for up to 6 at one fixed price.",
    location: "The Sound Room basement, Vesterbro, Copenhagen",
    pricingModel: "FIXED_TOTAL" as const,
    priceMinor: 12_000,
    minAttendees: 2,
    capacity: 6,
    durationMinutes: 60,
    tags: ["games", "puzzle", "team", "fixed total"],
    availability: { weekdays: ALL_DAYS, startHours: [12, 14, 16, 18, 19, 20, 21], source: "FIXTURE" as const },
  },
];

export type CatalogueSlug = (typeof CATALOGUE)[number]["slug"];

export async function seedCatalogue(db: Db): Promise<{ merchant: Merchant; offerings: Record<string, Offering> }> {
  const [merchant] = await db
    .insert(merchants)
    .values({
      slug: DEMO_MERCHANT_SLUG,
      name: DEMO_MERCHANT_NAME,
      timezone: DEMO_TIMEZONE,
      paypalMerchantId: config().paypal?.merchantId ?? null,
    })
    .onConflictDoUpdate({
      target: merchants.slug,
      set: { name: DEMO_MERCHANT_NAME, timezone: DEMO_TIMEZONE, paypalMerchantId: config().paypal?.merchantId ?? null },
    })
    .returning();
  const result: Record<string, Offering> = {};
  for (const item of CATALOGUE) {
    const [row] = await db
      .insert(offerings)
      .values({ merchantId: merchant.id, ...item, currency: "USD", active: true })
      .onConflictDoUpdate({
        target: [offerings.merchantId, offerings.slug],
        set: {
          name: item.name,
          category: item.category,
          description: item.description,
          location: item.location,
          pricingModel: item.pricingModel,
          priceMinor: item.priceMinor,
          currency: "USD",
          minAttendees: item.minAttendees,
          capacity: item.capacity,
          durationMinutes: item.durationMinutes,
          tags: item.tags,
          availability: item.availability,
          active: true,
        },
      })
      .returning();
    result[item.slug] = row;
  }
  return { merchant, offerings: result };
}

/* -------------------------------------------------------------------------- */
/* Clean-up                                                                   */
/* -------------------------------------------------------------------------- */

const APP_TABLES = [
  "fixture_provider_objects",
  "ai_runs",
  "audit_events",
  "jobs",
  "webhook_events",
  "payment_operations",
  "settlement_snapshots",
  "payment_attempts",
  "consents",
  "budget_votes",
  "participants",
  "quote_versions",
  "outings",
  "offerings",
  "merchants",
];

/** DESTRUCTIVE: empties every app table (CLI `--reset` only). */
export async function truncateAppTables(db: Db): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${APP_TABLES.join(", ")} RESTART IDENTITY CASCADE`));
}

/** Deletes FIXTURE outings and everything hanging off them. Real outings are untouched. */
export async function deleteFixtureOutings(db: Db): Promise<number> {
  const rows = await db.select({ id: outings.id }).from(outings).where(eq(outings.isFixture, true));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return 0;
  await db.transaction(async (tx) => {
    const attemptRows = await tx
      .select({ id: paymentAttempts.id, authorizationId: paymentAttempts.authorizationId, captureId: paymentAttempts.captureId })
      .from(paymentAttempts)
      .where(inArray(paymentAttempts.outingId, ids));
    const attemptIds = attemptRows.map((r) => r.id);
    const authIds = attemptRows.map((r) => r.authorizationId).filter((x): x is string => !!x);
    const captureIds = attemptRows.map((r) => r.captureId).filter((x): x is string => !!x);
    await tx.delete(paymentOperations).where(inArray(paymentOperations.outingId, ids));
    await tx.delete(settlementSnapshots).where(inArray(settlementSnapshots.outingId, ids));
    await tx.delete(paymentAttempts).where(inArray(paymentAttempts.outingId, ids));
    await tx.delete(consents).where(inArray(consents.outingId, ids));
    await tx.delete(budgetVotes).where(inArray(budgetVotes.outingId, ids));
    await tx.delete(jobs).where(inArray(jobs.outingId, ids));
    await tx.delete(auditEvents).where(inArray(auditEvents.outingId, ids));
    await tx.delete(aiRuns).where(inArray(aiRuns.outingId, ids));
    await tx.delete(quoteVersions).where(inArray(quoteVersions.outingId, ids));
    await tx.delete(participants).where(inArray(participants.outingId, ids));
    await tx.delete(outings).where(inArray(outings.id, ids));
    // Simulator objects of those outings: orders, authorizations, captures, refunds and request replays.
    const data = fixtureProviderObjects.data;
    const conditions = [inArray(sql`${data}->>'outingId'`, ids)];
    if (attemptIds.length) {
      conditions.push(inArray(sql`${data}->>'customId'`, attemptIds));
      const requestIds = attemptIds.flatMap((id) =>
        [`seed-order-${id}`, `seed-authorize-${id}`, ...(["CAPTURE", "VOID", "REFUND"] as const).map((k) => operationRequestId(k, id))].map((r) => `REQ:${r}`),
      );
      conditions.push(and(eq(fixtureProviderObjects.kind, "REQUEST"), inArray(fixtureProviderObjects.id, requestIds))!);
    }
    if (authIds.length) conditions.push(and(eq(fixtureProviderObjects.kind, "CAPTURE"), inArray(sql`${data}->>'authorizationId'`, authIds))!);
    if (captureIds.length) conditions.push(and(eq(fixtureProviderObjects.kind, "REFUND"), inArray(sql`${data}->>'captureId'`, captureIds))!);
    await tx.delete(fixtureProviderObjects).where(or(...conditions));
  });
  return ids.length;
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

interface PersonSpec {
  key: string;
  name: string;
  organizer?: boolean;
  sponsored?: boolean;
  required?: boolean;
  attendance?: AttendanceState;
  attendanceAt?: Date;
  /** Payer consent time (sets attendance ACCEPTED). */
  consentAt?: Date;
  /** FIXTURE authorization time (requires consentAt). */
  authorizeAt?: Date;
  /** Budget vote (current round), minor units. */
  voteMinor?: number;
}

interface OutingSpec {
  key: string;
  title: string;
  brief: string;
  status: OutingStatus;
  createdAt: Date;
  people: PersonSpec[];
  /** Collection (omit for pre-collection demo outings). */
  collection?: {
    merchant: Merchant;
    offering: Offering;
    minPayers: number;
    activityAt: Date;
    deadlineAt: Date;
    openedAt: Date;
    proposedBudgetMinor: number;
  };
}

interface SeededOuting {
  outing: Outing;
  quote: QuoteVersion | null;
  people: Map<string, Participant>;
  consents: Map<string, Consent>;
  attempts: Map<string, PaymentAttempt>;
}

function fixtureAt(db: Db, at: Date): FixtureProvider {
  return new FixtureProvider({ db, now: () => at });
}

async function audit(db: Db, outingId: string, actor: string, type: string, at: Date, data: Record<string, unknown> = {}) {
  await db.insert(auditEvents).values({ outingId, actor, type, data, createdAt: at });
}

async function fixtureExtraction(brief: string, now: Date, categories: string[]): Promise<StoredBriefExtraction> {
  const result = await new FixtureOutingsAi().extractBrief({ brief, now, timezone: DEMO_TIMEZONE, categories });
  return {
    extraction: result.output,
    source: result.source,
    model: result.model,
    warnings: result.warnings.slice(0, 10),
    error: null,
    createdAt: now.toISOString(),
  };
}

async function seedOuting(db: Db, spec: OutingSpec, secret: string): Promise<SeededOuting> {
  const categories = [...new Set(CATALOGUE.map((c) => c.category))];
  const extraction = await fixtureExtraction(spec.brief, spec.createdAt, categories);
  const c = spec.collection;
  const quoteId = c ? crypto.randomUUID() : null;

  const [outing] = await db
    .insert(outings)
    .values({
      title: spec.title,
      brief: spec.brief,
      briefExtraction: extraction,
      status: spec.status,
      currency: "USD",
      budgetUnit: "TOTAL",
      displayTimezone: DEMO_TIMEZONE,
      isFixture: true,
      createdAt: spec.createdAt,
      updatedAt: spec.createdAt,
      ...(c
        ? {
            merchantId: c.merchant.id,
            selectedOfferingId: c.offering.id,
            proposedBudgetMinor: c.proposedBudgetMinor,
            currentQuoteId: quoteId,
            minPayers: c.minPayers,
            maxAttendees: c.offering.capacity,
            activityAt: c.activityAt,
            deadlineAt: c.deadlineAt,
            collectionOpenedAt: c.openedAt,
          }
        : {}),
    })
    .returning();
  await db.insert(aiRuns).values({
    outingId: outing.id,
    purpose: "BRIEF_EXTRACTION",
    source: extraction.source ?? "FIXTURE",
    model: null,
    ok: true,
    output: extraction.extraction,
    createdAt: spec.createdAt,
  });

  const people = new Map<string, Participant>();
  let sortKey = 1;
  for (const p of spec.people) {
    const sk = sortKey++;
    const attendance: AttendanceState = p.consentAt ? "ACCEPTED" : p.organizer ? "ACCEPTED" : p.attendance ?? "PENDING";
    const attendanceAt = p.consentAt ?? p.attendanceAt ?? (attendance !== "PENDING" ? spec.createdAt : null);
    const [row] = await db
      .insert(participants)
      .values({
        outingId: outing.id,
        displayName: p.name,
        role: p.organizer ? "ORGANIZER" : "INVITEE",
        payerType: p.sponsored ? "SPONSORED" : "PAYER",
        required: p.required ?? true,
        sortKey: sk,
        attendance,
        attendanceAt,
        // Deterministic demo token (re-derivable from the session secret), stored hashed like any other.
        inviteTokenHash: hashToken(demoInviteToken(secret, `${outing.id}:${sk}`)),
        createdAt: spec.createdAt,
        updatedAt: spec.createdAt,
      })
      .returning();
    people.set(p.key, row);
  }
  const organizer = [...people.values()].find((p) => p.role === "ORGANIZER")!;
  await audit(db, outing.id, `PARTICIPANT:${organizer.id}`, "OUTING_CREATED", spec.createdAt, { organizerName: organizer.displayName, aiSource: "FIXTURE", demoFixture: true });
  await audit(db, outing.id, `PARTICIPANT:${organizer.id}`, "INVITEES_ADDED", new Date(spec.createdAt.getTime() + 2 * MIN), {
    count: people.size - 1,
    displayNames: spec.people.filter((p) => !p.organizer).map((p) => p.name),
  });

  // Budget votes for the current round (private; never exposed per person).
  for (const p of spec.people) {
    if (p.voteMinor === undefined) continue;
    await db.insert(budgetVotes).values({
      outingId: outing.id,
      participantId: people.get(p.key)!.id,
      round: 1,
      amountMinor: p.voteMinor,
      unit: "TOTAL",
      createdAt: new Date(spec.createdAt.getTime() + 5 * MIN),
      updatedAt: new Date(spec.createdAt.getTime() + 5 * MIN),
    });
  }

  let quote: QuoteVersion | null = null;
  const consentRows = new Map<string, Consent>();
  const attemptRows = new Map<string, PaymentAttempt>();
  if (c && quoteId) {
    // Reveal + proposal history so the hub's earlier stages are consistent.
    const votes = spec.people.filter((p) => p.voteMinor !== undefined).map((p) => p.voteMinor!);
    if (votes.length >= 3) {
      const revealedAt = new Date(spec.createdAt.getTime() + 20 * MIN);
      const reveal: StoredReveal = {
        round: 1,
        aggregate: aggregateVotes(votes, people.size, "USD"),
        summary: null,
        revealedAt: revealedAt.toISOString(),
      };
      await db.update(outings).set({ budgetRevealedAt: revealedAt, budgetReveal: reveal }).where(eq(outings.id, outing.id));
      await audit(db, outing.id, `PARTICIPANT:${organizer.id}`, "BUDGET_REVEALED", revealedAt, { round: 1, voteCount: votes.length });
    }
    const proposal: StoredProposal = {
      ranked: [
        {
          offeringId: c.offering.id,
          fit: "GREAT",
          reasons: ["Fixture ranker: category matches the brief.", "Fixture ranker: fixed total, so more attendees lower each share."],
          concerns: [],
        },
      ],
      note: "Fixture ranker: deterministic demo ranking, not a model.",
      source: "FIXTURE",
      model: null,
      warnings: [],
      budgetMinor: c.proposedBudgetMinor,
      createdAt: new Date(spec.createdAt.getTime() + 25 * MIN).toISOString(),
    };
    await db.update(outings).set({ proposal }).where(eq(outings.id, outing.id));
    await audit(db, outing.id, `PARTICIPANT:${organizer.id}`, "BUDGET_AGREED", new Date(spec.createdAt.getTime() + 25 * MIN), {
      proposedBudgetMinor: c.proposedBudgetMinor,
      aiSource: "FIXTURE",
    });

    const all = [...people.values()];
    const terms = buildCommitmentTerms({
      outingId: outing.id,
      quoteId,
      quoteVersion: 1,
      merchantId: c.merchant.id,
      merchantName: c.merchant.name,
      offeringId: c.offering.id,
      offeringName: c.offering.name,
      pricingModel: c.offering.pricingModel,
      totalMinor: c.offering.priceMinor,
      currency: "USD",
      capacity: c.offering.capacity,
      minPayers: c.minPayers,
      activityAt: c.activityAt.toISOString(),
      deadlineAt: c.deadlineAt.toISOString(),
      policy: "ALL_REQUIRED",
      sponsoredParticipantIds: all.filter((p) => p.payerType === "SPONSORED").map((p) => p.id),
      requiredParticipantIds: all.filter((p) => p.required).map((p) => p.id),
    });
    const availability = checkAvailability(c.offering, c.merchant.timezone, c.activityAt);
    [quote] = await db
      .insert(quoteVersions)
      .values({
        id: quoteId,
        outingId: outing.id,
        version: 1,
        status: "ACTIVE",
        merchantId: c.merchant.id,
        offeringId: c.offering.id,
        pricingModel: c.offering.pricingModel,
        totalMinor: terms.totalMinor,
        currency: "USD",
        capacity: terms.capacity,
        minPayers: terms.minPayers,
        capMinor: terms.capMinor,
        activityAt: c.activityAt,
        deadlineAt: c.deadlineAt,
        expiresAt: new Date(c.deadlineAt.getTime() + DAY),
        terms,
        termsHash: hashTerms(terms),
        merchantConfirmedAt: c.openedAt,
        availabilitySource: availability.source,
        createdAt: c.openedAt,
      })
      .returning();
    await audit(db, outing.id, `PARTICIPANT:${organizer.id}`, "COLLECTION_OPENED", c.openedAt, {
      quoteId,
      quoteVersion: 1,
      offeringName: c.offering.name,
      totalMinor: terms.totalMinor,
      capMinor: terms.capMinor,
      minPayers: c.minPayers,
      deadlineAt: terms.deadlineAt,
      availabilitySource: availability.source,
    });

    for (const p of spec.people) {
      const row = people.get(p.key)!;
      if (p.sponsored && row.attendance === "ACCEPTED") {
        await audit(db, outing.id, `PARTICIPANT:${row.id}`, "ATTENDANCE_ACCEPTED", row.attendanceAt ?? c.openedAt, {
          participantId: row.id,
          displayName: row.displayName,
          payerType: "SPONSORED",
        });
      }
      if (!p.consentAt || p.sponsored) continue;
      const [consent] = await db
        .insert(consents)
        .values({
          outingId: outing.id,
          participantId: row.id,
          quoteId,
          termsHash: quote.termsHash,
          capMinor: quote.capMinor,
          currency: "USD",
          statement: commitStatement(quote.capMinor, "USD"),
          acceptedAt: p.consentAt,
          createdAt: p.consentAt,
        })
        .returning();
      consentRows.set(p.key, consent);
      await audit(db, outing.id, `PARTICIPANT:${row.id}`, "CONSENT_RECORDED", p.consentAt, {
        participantId: row.id,
        displayName: row.displayName,
        quoteVersion: 1,
        capMinor: quote.capMinor,
      });
      if (!p.authorizeAt) continue;
      const [attempt] = await db
        .insert(paymentAttempts)
        .values({
          outingId: outing.id,
          participantId: row.id,
          consentId: consent.id,
          quoteId,
          provider: "FIXTURE",
          status: "CREATED",
          currency: "USD",
          requestedMinor: quote.capMinor,
          createdAt: p.consentAt,
          updatedAt: p.consentAt,
        })
        .returning();
      attemptRows.set(p.key, await fixtureAuthorize(db, attempt, outing, p.authorizeAt));
      await audit(db, outing.id, `PARTICIPANT:${row.id}`, "PAYMENT_AUTHORIZED", p.authorizeAt, {
        participantId: row.id,
        displayName: row.displayName,
        provider: "FIXTURE",
        authorizedMinor: quote.capMinor,
      });
    }
  }
  const fresh = (await db.query.outings.findFirst({ where: eq(outings.id, outing.id) }))!;
  return { outing: fresh, quote, people, consents: consentRows, attempts: attemptRows };
}

function must<T>(r: ProviderResult<T>): { ok: true } & T {
  if (!r.ok) throw new Error(`fixture provider: ${r.code} ${r.message}`);
  return r;
}

/** Create, approve and authorize a FIXTURE order at a fixed simulated time. */
async function fixtureAuthorize(db: Db, attempt: PaymentAttempt, outing: Outing, at: Date): Promise<PaymentAttempt> {
  const fx = fixtureAt(db, at);
  const order = must(
    await fx.createAuthorizeOrder({
      requestId: `seed-order-${attempt.id}`,
      paymentAttemptId: attempt.id,
      amountMinor: attempt.requestedMinor,
      currency: "USD",
      description: `${outing.title} (fixture demo)`,
    }),
  );
  await fx.approveOrder(order.orderId);
  const { authorization } = must(await fx.authorizeOrder({ orderId: order.orderId, requestId: `seed-authorize-${attempt.id}` }));
  const [row] = await db
    .update(paymentAttempts)
    .set({
      status: "AUTHORIZED",
      providerOrderId: order.orderId,
      authorizationId: authorization.authorizationId,
      authorizedMinor: authorization.amountMinor,
      authorizedAt: authorization.createTime,
      authorizationExpiresAt: authorization.expirationTime,
      verified: true,
      verifiedAt: at,
      providerStatus: authorization.providerStatus,
      updatedAt: at,
    })
    .where(eq(paymentAttempts.id, attempt.id))
    .returning();
  return row;
}

async function insertOperation(
  db: Db,
  input: { attempt: PaymentAttempt; kind: OperationKind; amountMinor: number; status: OperationStatus; at: Date; sequence?: number; providerRef?: string | null; providerStatus?: string | null; lastError?: string | null; attempts?: number },
) {
  await db.insert(paymentOperations).values({
    outingId: input.attempt.outingId,
    paymentAttemptId: input.attempt.id,
    kind: input.kind,
    amountMinor: input.amountMinor,
    currency: "USD",
    requestId: operationRequestId(input.kind, input.attempt.id),
    status: input.status,
    sequence: input.sequence ?? 0,
    attempts: input.attempts ?? (input.status === "PENDING" || input.status === "SKIPPED" ? 0 : 1),
    nextAttemptAt: input.at,
    providerRef: input.providerRef ?? null,
    providerStatus: input.providerStatus ?? null,
    lastError: input.lastError ?? null,
    // FAILED here = definitive provider refusal (terminal, like the engine records it).
    completedAt: input.status === "SUCCEEDED" || input.status === "SKIPPED" || input.status === "FAILED" ? input.at : null,
    createdAt: input.at,
    updatedAt: input.at,
  });
}

async function setAttempt(db: Db, id: string, status: PaymentStatus, patch: Partial<typeof paymentAttempts.$inferInsert>, at: Date) {
  const [row] = await db.update(paymentAttempts).set({ ...patch, status, updatedAt: at }).where(eq(paymentAttempts.id, id)).returning();
  return row;
}

/** Real policy decision over the seeded facts, frozen into a snapshot exactly like the engine does. */
async function freeze(db: Db, s: SeededOuting, frozenAt: Date): Promise<SettlementDecision> {
  const quote = s.quote!;
  const people = [...s.people.values()];
  const decision = decideSettlement({
    now: frozenAt,
    outingId: s.outing.id,
    policy: "ALL_REQUIRED",
    deadlineAt: quote.deadlineAt,
    quote: {
      id: quote.id,
      termsHash: quote.termsHash,
      totalMinor: quote.totalMinor,
      currency: "USD",
      capMinor: quote.capMinor,
      minPayers: quote.minPayers,
      capacity: quote.capacity,
      expiresAt: quote.expiresAt,
    },
    participants: people.map((p) => ({ id: p.id, sortKey: p.sortKey, payerType: p.payerType, required: p.required, attendance: p.attendance, attendanceAt: p.attendanceAt })),
    consents: [...s.consents.values()].map((c) => ({
      id: c.id,
      participantId: c.participantId,
      quoteId: c.quoteId,
      termsHash: c.termsHash,
      capMinor: c.capMinor,
      currency: "USD",
      acceptedAt: c.acceptedAt,
      withdrawnAt: c.withdrawnAt,
    })),
    authorizations: [...s.attempts.values()].map((a) => ({
      paymentAttemptId: a.id,
      participantId: a.participantId,
      consentId: a.consentId,
      status: a.status,
      verified: a.verified,
      authorizedMinor: a.authorizedMinor,
      currency: "USD",
      authorizedAt: a.authorizedAt,
      expiresAt: a.authorizationExpiresAt,
    })),
    merchantAvailable: true,
  });
  const captures =
    decision.kind === "SETTLE"
      ? decision.allocations.map((a, i) => ({
          paymentAttemptId: a.paymentAttemptId,
          participantId: a.participantId,
          sequence: i + 1,
          amountMinor: a.allocationMinor,
          capMinor: a.capMinor,
          authorizedMinor: a.authorizedMinor,
        }))
      : [];
  const roster: SettlementRoster = {
    version: 1,
    trigger: "DEADLINE",
    early: false,
    decision,
    deadlineAt: quote.deadlineAt.toISOString(),
    frozenAt: frozenAt.toISOString(),
    evaluatedAt: frozenAt.toISOString(),
    quote: {
      id: quote.id,
      termsHash: quote.termsHash,
      totalMinor: quote.totalMinor,
      currency: quote.currency,
      capMinor: quote.capMinor,
      minPayers: quote.minPayers,
      capacity: quote.capacity,
    },
    merchantAvailability: { available: true, source: "FIXTURE" },
    participants: people.map((p) => ({ id: p.id, sortKey: p.sortKey, role: p.role, payerType: p.payerType, required: p.required, attendance: p.attendance })),
    planned: { captures, voids: decision.voidPaymentAttemptIds, failedApprovals: [] },
    reconcileNotes: [],
  };
  await db.insert(settlementSnapshots).values({
    outingId: s.outing.id,
    quoteId: quote.id,
    termsHash: quote.termsHash,
    decision: decision.kind,
    reasons: decision.kind === "CANCEL" ? decision.reasons : [],
    frozenAt,
    totalMinor: quote.totalMinor,
    currency: quote.currency,
    payerCount: decision.kind === "SETTLE" ? decision.payerCount : 0,
    roster,
    createdAt: frozenAt,
  });
  await audit(db, s.outing.id, "WORKER:demo-seed", "SETTLEMENT_DECIDED", frozenAt, {
    decision: decision.kind,
    trigger: "DEADLINE",
    ...(decision.kind === "CANCEL" ? { reasons: decision.reasons } : { payerCount: decision.payerCount, totalMinor: decision.totalMinor }),
  });
  return decision;
}

async function capture(db: Db, s: SeededOuting, attempt: PaymentAttempt, amountMinor: number, at: Date, sequence: number): Promise<PaymentAttempt> {
  const { capture: cap } = must(
    await fixtureAt(db, at).captureAuthorization({
      authorizationId: attempt.authorizationId!,
      amountMinor,
      currency: "USD",
      requestId: operationRequestId("CAPTURE", attempt.id),
    }),
  );
  await insertOperation(db, { attempt, kind: "CAPTURE", amountMinor, status: "SUCCEEDED", at, sequence, providerRef: cap.captureId, providerStatus: cap.providerStatus });
  await audit(db, s.outing.id, "WORKER:demo-seed", "PAYMENT_CAPTURED", at, { paymentAttemptId: attempt.id, amountMinor });
  return setAttempt(db, attempt.id, "CAPTURED", { capturedMinor: amountMinor, captureId: cap.captureId, providerStatus: cap.providerStatus }, at);
}

async function voidHold(db: Db, s: SeededOuting, attempt: PaymentAttempt, at: Date): Promise<PaymentAttempt> {
  const res = must(await fixtureAt(db, at).voidAuthorization({ authorizationId: attempt.authorizationId!, requestId: operationRequestId("VOID", attempt.id) }));
  await insertOperation(db, { attempt, kind: "VOID", amountMinor: attempt.authorizedMinor - attempt.capturedMinor, status: "SUCCEEDED", at, providerStatus: res.providerStatus });
  await audit(db, s.outing.id, "WORKER:demo-seed", "PAYMENT_VOIDED", at, { paymentAttemptId: attempt.id });
  return setAttempt(db, attempt.id, "VOIDED", { providerStatus: res.providerStatus }, at);
}

/* -------------------------------------------------------------------------- */
/* Time helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Next local `weekday` (0=Sun) at `hour`:00 in `tz` strictly after `after`. */
export function nextLocalWeekdayAt(after: Date, weekday: number, hour: number, tz: string): Date {
  const p = zonedParts(after, tz);
  for (let d = 0; d < 15; d++) {
    const cal = new Date(Date.UTC(p.year, p.month - 1, p.day + d));
    if (cal.getUTCDay() !== weekday) continue;
    const t = zonedTimeToUtc({ year: cal.getUTCFullYear(), month: cal.getUTCMonth() + 1, day: cal.getUTCDate(), hour }, tz);
    if (t.getTime() > after.getTime()) return t;
  }
  throw new Error("no matching weekday found");
}

/** Local `hour`:00 on the calendar day `daysAhead` after `from` in `tz`. */
function localDayAt(from: Date, daysAhead: number, hour: number, tz: string): Date {
  const p = zonedParts(from, tz);
  const cal = new Date(Date.UTC(p.year, p.month - 1, p.day + daysAhead));
  return zonedTimeToUtc({ year: cal.getUTCFullYear(), month: cal.getUTCMonth() + 1, day: cal.getUTCDate(), hour }, tz);
}

function ceilToMinutes(d: Date, minutes: number): Date {
  const step = minutes * MIN;
  return new Date(Math.ceil(d.getTime() / step) * step);
}

/* -------------------------------------------------------------------------- */
/* Personas                                                                   */
/* -------------------------------------------------------------------------- */

export interface DemoPersona {
  participantId: string;
  displayName: string;
  role: Participant["role"];
  payerType: Participant["payerType"];
  required: boolean;
  attendance: AttendanceState;
  hint: string;
  /** Deterministic demo invitation link (only when SESSION_SECRET is stable). */
  link: string | null;
}

export interface DemoOutingSummary {
  outingId: string;
  title: string;
  status: OutingStatus;
  cleanup: CleanupState;
  /** Everyone on the outing, organizer first, so the demo hub can open any stage as anyone. */
  personas: DemoPersona[];
}

export interface DemoState {
  /** The COLLECTING "Maya's birthday karaoke" demo outing. */
  outingId: string | null;
  personas: DemoPersona[];
  budgetOutingId: string | null;
  budgetPersonas: DemoPersona[];
  merchant: { id: string; name: string } | null;
  outings: DemoOutingSummary[];
}

const SETTLED_HINT: Partial<Record<PaymentStatus, string>> = {
  CAPTURED: "Final share collected",
  CAPTURE_PENDING: "Collecting final share",
  VOIDED: "Hold released",
  VOID_PENDING: "Hold release pending",
  REFUNDED: "Refunded",
  REFUND_PENDING: "Refund pending",
  FAILED: "Payment failed",
  UNKNOWN: "Payment being reconciled",
};

function personaHint(p: Participant, attempt: PaymentAttempt | undefined, outing: Outing): string {
  if (p.role === "ORGANIZER" && !attempt) return "Organizer";
  const who = p.role === "ORGANIZER" ? "Organizer · " : "";
  if (p.payerType === "SPONSORED") return p.attendance === "ACCEPTED" ? "Sponsored guest · accepted" : "Sponsored guest";
  if (outing.status === "BUDGETING" || outing.status === "DRAFT" || outing.status === "PROPOSED") return p.role === "ORGANIZER" ? "Organizer" : "Invitee";
  const settled = attempt ? SETTLED_HINT[attempt.status] : undefined;
  if (settled) return `${who}${settled}`;
  if (attempt && attempt.status === "AUTHORIZED" && attempt.verified && !attempt.late) return `${who}Committed`;
  if (p.attendance === "DECLINED") return `${who}Declined`;
  if (outing.status !== "COLLECTING") return `${who}${p.required ? "Required · never committed" : "Optional · did not commit"}`;
  return `${who}${p.required ? "Required · not committed yet" : "Optional · not committed yet"}`;
}

async function personasFor(db: Db, outing: Outing | undefined): Promise<DemoPersona[]> {
  if (!outing) return [];
  const cfg = config();
  const people = await db.query.participants.findMany({ where: eq(participants.outingId, outing.id), orderBy: (p, { asc }) => [asc(p.sortKey)] });
  const attempts = await db.query.paymentAttempts.findMany({
    where: eq(paymentAttempts.outingId, outing.id),
    orderBy: (a, { desc: d }) => [d(a.createdAt)],
  });
  const base = cfg.appBaseUrl.replace(/\/+$/, "");
  return people.map((p) => {
    const attempt = attempts.find((a) => a.participantId === p.id);
    return {
      participantId: p.id,
      displayName: p.displayName,
      role: p.role,
      payerType: p.payerType,
      required: p.required,
      attendance: p.attendance,
      hint: personaHint(p, attempt, outing),
      link: cfg.sessionSecretIsEphemeral ? null : `${base}/i/${demoInviteToken(cfg.sessionSecret, `${outing.id}:${p.sortKey}`)}`,
    };
  });
}

/** Current demo personas (no secrets beyond the deterministic demo links). */
export async function listDemoState(db: Db): Promise<DemoState> {
  const fixtureOutings = await db.query.outings.findMany({ where: eq(outings.isFixture, true), orderBy: [desc(outings.createdAt)] });
  const main = fixtureOutings.find((o) => o.title === DEMO_MAIN_TITLE);
  const budget = fixtureOutings.find((o) => o.title === DEMO_BUDGET_TITLE);
  const merchant = await db.query.merchants.findFirst({ where: eq(merchants.slug, DEMO_MERCHANT_SLUG) });
  const summaries: DemoOutingSummary[] = [];
  for (const o of fixtureOutings) {
    summaries.push({ outingId: o.id, title: o.title, status: o.status, cleanup: o.cleanup, personas: await personasFor(db, o) });
  }
  return {
    outingId: main?.id ?? null,
    personas: summaries.find((s) => s.outingId === main?.id)?.personas ?? [],
    budgetOutingId: budget?.id ?? null,
    budgetPersonas: summaries.find((s) => s.outingId === budget?.id)?.personas ?? [],
    merchant: merchant ? { id: merchant.id, name: merchant.name } : null,
    outings: summaries,
  };
}

/* -------------------------------------------------------------------------- */
/* Seed                                                                       */
/* -------------------------------------------------------------------------- */

export async function seedDemo(db: Db, opts: { now?: Date; secret?: string } = {}): Promise<DemoState> {
  const now = opts.now ?? new Date();
  const secret = opts.secret ?? config().sessionSecret;
  const { merchant, offerings: cat } = await seedCatalogue(db);
  await deleteFixtureOutings(db);
  const tz = merchant.timezone;
  const ago = (ms: number) => new Date(now.getTime() - ms);

  /* 1. Main demo: COLLECTING, 4 of 5 payers committed, deadline ~2 h away. */
  {
    const deadlineAt = ceilToMinutes(new Date(now.getTime() + 2 * HOUR), 5);
    const activityAt = nextLocalWeekdayAt(new Date(deadlineAt.getTime() + HOUR), 5, 19, tz);
    const s = await seedOuting(
      db,
      {
        key: "main",
        title: DEMO_MAIN_TITLE,
        brief:
          "Karaoke for Maya's birthday on Friday evening! Six of us, ideally a private room. Let's cover Maya's share. Around $100 total, split fairly.",
        status: "COLLECTING",
        createdAt: ago(3 * HOUR),
        people: [
          { key: "alex", name: "Alex", organizer: true, voteMinor: 10_000, consentAt: ago(55 * MIN), authorizeAt: ago(54 * MIN) },
          { key: "ben", name: "Ben", voteMinor: 10_000, consentAt: ago(48 * MIN), authorizeAt: ago(47 * MIN) },
          { key: "freya", name: "Freya", voteMinor: 7_500, consentAt: ago(31 * MIN), authorizeAt: ago(30 * MIN) },
          { key: "jules", name: "Jules", voteMinor: 15_000, consentAt: ago(14 * MIN), authorizeAt: ago(13 * MIN) },
          { key: "noor", name: "Noor", voteMinor: 10_000 },
          { key: "maya", name: "Maya", sponsored: true, attendance: "ACCEPTED", attendanceAt: ago(40 * MIN), voteMinor: 10_000 },
        ],
        collection: {
          merchant,
          offering: cat["private-karaoke-room"],
          minPayers: 5,
          activityAt,
          deadlineAt,
          openedAt: ago(HOUR),
          proposedBudgetMinor: 10_000,
        },
      },
      secret,
    );
    await db.insert(jobs).values({
      kind: "SETTLE_DEADLINE",
      outingId: s.outing.id,
      runAt: deadlineAt,
      dedupeKey: settleJobKey(s.outing.id, s.quote!.id),
      payload: { quoteId: s.quote!.id },
    });
  }

  /* 2. Budget poker demo: BUDGETING, 4 of 6 voted (reveal possible). */
  await seedOuting(
    db,
    {
      key: "budget",
      title: DEMO_BUDGET_TITLE,
      brief: "Escape room or karaoke next Friday night for six of us. Somewhere in the $75-150 range in total?",
      status: "BUDGETING",
      createdAt: ago(40 * MIN),
      people: [
        { key: "chloe", name: "Chloe", organizer: true, voteMinor: 10_000 },
        { key: "dev", name: "Dev", voteMinor: 7_500 },
        { key: "emil", name: "Emil", voteMinor: 10_000 },
        { key: "farah", name: "Farah", voteMinor: 15_000 },
        { key: "gus", name: "Gus" },
        { key: "hedda", name: "Hedda" },
      ],
    },
    secret,
  );

  /* 3. History: CONFIRMED, 3 payers -> $33.34 / $33.33 / $33.33 (under-capture of a $33.34 hold). */
  {
    const deadlineAt = ago(2 * DAY + 3 * HOUR);
    const s = await seedOuting(
      db,
      {
        key: "h-confirmed-3",
        title: "Sam's farewell karaoke (synthetic)",
        brief: "Farewell karaoke for Sam, three of us, private room, about $100 total.",
        status: "CONFIRMED",
        createdAt: new Date(deadlineAt.getTime() - 20 * HOUR),
        people: [
          { key: "priya", name: "Priya", organizer: true, consentAt: new Date(deadlineAt.getTime() - 10 * HOUR), authorizeAt: new Date(deadlineAt.getTime() - 10 * HOUR + MIN) },
          { key: "tom", name: "Tom", consentAt: new Date(deadlineAt.getTime() - 8 * HOUR), authorizeAt: new Date(deadlineAt.getTime() - 8 * HOUR + MIN) },
          { key: "lena", name: "Lena", consentAt: new Date(deadlineAt.getTime() - 5 * HOUR), authorizeAt: new Date(deadlineAt.getTime() - 5 * HOUR + MIN) },
        ],
        collection: {
          merchant,
          offering: cat["private-karaoke-room"],
          minPayers: 3,
          activityAt: localDayAt(deadlineAt, 1, 19, tz),
          deadlineAt,
          openedAt: new Date(deadlineAt.getTime() - 18 * HOUR),
          proposedBudgetMinor: 10_000,
        },
      },
      secret,
    );
    await settleAll(db, s, new Date(deadlineAt.getTime() + MIN));
  }

  /* 4. History: CONFIRMED with a sponsored guest, 5 payers x $20, guest $0. */
  {
    const deadlineAt = ago(5 * DAY);
    const s = await seedOuting(
      db,
      {
        key: "h-confirmed-sponsored",
        title: "Jonas's 30th (synthetic)",
        brief: "Karaoke for Jonas's birthday, six of us, cover Jonas's share. $100 total.",
        status: "CONFIRMED",
        createdAt: new Date(deadlineAt.getTime() - 30 * HOUR),
        people: [
          { key: "ola", name: "Ola", organizer: true, consentAt: new Date(deadlineAt.getTime() - 20 * HOUR), authorizeAt: new Date(deadlineAt.getTime() - 20 * HOUR + MIN) },
          { key: "rui", name: "Rui", consentAt: new Date(deadlineAt.getTime() - 15 * HOUR), authorizeAt: new Date(deadlineAt.getTime() - 15 * HOUR + MIN) },
          { key: "sara", name: "Sara", consentAt: new Date(deadlineAt.getTime() - 12 * HOUR), authorizeAt: new Date(deadlineAt.getTime() - 12 * HOUR + MIN) },
          { key: "tariq", name: "Tariq", consentAt: new Date(deadlineAt.getTime() - 9 * HOUR), authorizeAt: new Date(deadlineAt.getTime() - 9 * HOUR + MIN) },
          { key: "una", name: "Una", consentAt: new Date(deadlineAt.getTime() - 3 * HOUR), authorizeAt: new Date(deadlineAt.getTime() - 3 * HOUR + MIN) },
          { key: "jonas", name: "Jonas", sponsored: true, attendance: "ACCEPTED", attendanceAt: new Date(deadlineAt.getTime() - 16 * HOUR) },
        ],
        collection: {
          merchant,
          offering: cat["private-karaoke-room"],
          minPayers: 5,
          activityAt: localDayAt(deadlineAt, 1, 20, tz),
          deadlineAt,
          openedAt: new Date(deadlineAt.getTime() - 24 * HOUR),
          proposedBudgetMinor: 10_000,
        },
      },
      secret,
    );
    await settleAll(db, s, new Date(deadlineAt.getTime() + MIN));
  }

  /* 5. History: CANCELLED (required missing), holds voided, clean-up COMPLETE. */
  {
    const deadlineAt = ago(DAY + 2 * HOUR);
    const s = await seedOuting(
      db,
      {
        key: "h-cancelled-void",
        title: "Office escape room (synthetic)",
        brief: "Escape room with the team, four of us, around $120 total.",
        status: "CANCELLED",
        createdAt: new Date(deadlineAt.getTime() - 26 * HOUR),
        people: [
          { key: "omar", name: "Omar", organizer: true, consentAt: new Date(deadlineAt.getTime() - 20 * HOUR), authorizeAt: new Date(deadlineAt.getTime() - 20 * HOUR + MIN) },
          { key: "kai", name: "Kai", consentAt: new Date(deadlineAt.getTime() - 9 * HOUR), authorizeAt: new Date(deadlineAt.getTime() - 9 * HOUR + MIN) },
          { key: "rosa", name: "Rosa", consentAt: new Date(deadlineAt.getTime() - 2 * HOUR) },
          { key: "ines", name: "Ines" },
        ],
        collection: {
          merchant,
          offering: cat["escape-room"],
          minPayers: 4,
          activityAt: localDayAt(deadlineAt, 1, 18, tz),
          deadlineAt,
          openedAt: new Date(deadlineAt.getTime() - 24 * HOUR),
          proposedBudgetMinor: 12_000,
        },
      },
      secret,
    );
    const frozenAt = new Date(deadlineAt.getTime() + MIN);
    const decision = await freeze(db, s, frozenAt);
    if (decision.kind !== "CANCEL") throw new Error("seed: expected CANCEL");
    let t = frozenAt.getTime();
    for (const a of s.attempts.values()) await voidHold(db, s, a, new Date((t += MIN)));
    await db
      .update(outings)
      .set({ status: "CANCELLED", frozenAt, cancelledAt: frozenAt, cancelReasons: decision.reasons, cleanup: "COMPLETE", updatedAt: new Date(t) })
      .where(eq(outings.id, s.outing.id));
    await db.update(quoteVersions).set({ status: "EXPIRED" }).where(eq(quoteVersions.id, s.quote!.id));
    await audit(db, s.outing.id, "WORKER:demo-seed", "OUTING_CANCELLED", frozenAt, { reasons: decision.reasons, cleanup: "COMPLETE" });
  }

  /* 6. History: capture failed mid-way -> compensation, REFUND_PENDING (one refund UNKNOWN, retryable). */
  {
    const deadlineAt = ago(7 * HOUR);
    const s = await seedOuting(
      db,
      {
        key: "h-capture-failed",
        title: "Launch party karaoke (synthetic)",
        brief: "Team launch party, six of us, party suite, $180 total.",
        status: "CANCELLED",
        createdAt: new Date(deadlineAt.getTime() - 30 * HOUR),
        people: ["Hana", "Leo", "Mia", "Noah", "Zoe", "Finn"].map((name, i) => ({
          key: name.toLowerCase(),
          name,
          organizer: i === 0,
          consentAt: new Date(deadlineAt.getTime() - (20 - i * 3) * HOUR),
          authorizeAt: new Date(deadlineAt.getTime() - (20 - i * 3) * HOUR + MIN),
        })),
        collection: {
          merchant,
          offering: cat["karaoke-party-suite"],
          minPayers: 6,
          activityAt: localDayAt(deadlineAt, 1, 20, tz),
          deadlineAt,
          openedAt: new Date(deadlineAt.getTime() - 24 * HOUR),
          proposedBudgetMinor: 18_000,
        },
      },
      secret,
    );
    const frozenAt = new Date(deadlineAt.getTime() + MIN);
    const decision = await freeze(db, s, frozenAt);
    if (decision.kind !== "SETTLE") throw new Error("seed: expected SETTLE");
    const byParticipant = new Map([...s.attempts.values()].map((a) => [a.participantId, a]));
    let t = frozenAt.getTime();
    const captured: PaymentAttempt[] = [];
    for (const [i, alloc] of decision.allocations.entries()) {
      const attempt = byParticipant.get(alloc.participantId)!;
      const at = new Date((t += MIN));
      if (i < 2) {
        captured.push(await capture(db, s, attempt, alloc.allocationMinor, at, i + 1));
      } else if (i === 2) {
        // Declined capture: stop, release this hold, skip the rest.
        await insertOperation(db, {
          attempt,
          kind: "CAPTURE",
          amountMinor: alloc.allocationMinor,
          status: "FAILED",
          at,
          sequence: i + 1,
          providerStatus: "DECLINED",
          lastError: "INSTRUMENT_DECLINED: capture declined (fixture simulation)",
        });
        await audit(db, s.outing.id, "WORKER:demo-seed", "CAPTURE_FAILED", at, { paymentAttemptId: attempt.id, sequence: i + 1 });
        await voidHoldAfterFailure(db, s, attempt, new Date((t += MIN)));
      } else {
        await insertOperation(db, { attempt, kind: "CAPTURE", amountMinor: alloc.allocationMinor, status: "SKIPPED", at, sequence: i + 1, lastError: "Skipped after an earlier capture failed" });
        await voidHold(db, s, attempt, new Date((t += MIN)));
      }
    }
    // Compensation: refund completed captures. First refund completed; second outcome unknown (timeout).
    const [first, second] = captured;
    const refundAt = new Date((t += MIN));
    const { refund } = must(
      await fixtureAt(db, refundAt).refundCapture({ captureId: first.captureId!, amountMinor: first.capturedMinor, currency: "USD", requestId: operationRequestId("REFUND", first.id) }),
    );
    await insertOperation(db, { attempt: first, kind: "REFUND", amountMinor: first.capturedMinor, status: "SUCCEEDED", at: refundAt, providerRef: refund.refundId, providerStatus: refund.providerStatus });
    await setAttempt(db, first.id, "REFUNDED", { refundedMinor: first.capturedMinor, refundId: refund.refundId, providerStatus: refund.providerStatus }, refundAt);
    const unknownAt = new Date((t += MIN));
    await insertOperation(db, {
      attempt: second,
      kind: "REFUND",
      amountMinor: second.capturedMinor,
      status: "UNKNOWN",
      at: unknownAt,
      attempts: 8,
      lastError: "TIMEOUT: no response from the provider (fixture simulation); reconcile or retry with the same request id",
    });
    await setAttempt(db, second.id, "REFUND_PENDING", {}, unknownAt);
    await db
      .update(outings)
      .set({ status: "CANCELLED", frozenAt, cancelledAt: unknownAt, cancelReasons: ["CAPTURE_FAILED"], cleanup: "REFUND_PENDING", updatedAt: unknownAt })
      .where(eq(outings.id, s.outing.id));
    await audit(db, s.outing.id, "WORKER:demo-seed", "OUTING_CANCELLED", unknownAt, { reasons: ["CAPTURE_FAILED"], cleanup: "REFUND_PENDING" });
  }

  /* 7. COLLECTING, closes later TODAY (merchant time), one required participant missing. */
  {
    const midnight = localDayAt(now, 1, 0, tz);
    const remaining = midnight.getTime() - now.getTime();
    const deadlineAt = new Date(now.getTime() + Math.max(2 * MIN, Math.min(4 * HOUR, remaining - 15 * MIN)));
    const s = await seedOuting(
      db,
      {
        key: "collecting-today",
        title: "Escape room with the climbing crew (synthetic)",
        brief: "Escape room for four of us tomorrow evening, $120 total.",
        status: "COLLECTING",
        createdAt: ago(5 * HOUR),
        people: [
          { key: "ida", name: "Ida", organizer: true, consentAt: ago(4 * HOUR), authorizeAt: ago(4 * HOUR - MIN) },
          { key: "max", name: "Max", consentAt: ago(3 * HOUR), authorizeAt: ago(3 * HOUR - MIN) },
          { key: "sofia", name: "Sofia", consentAt: ago(90 * MIN), authorizeAt: ago(89 * MIN) },
          { key: "elias", name: "Elias" },
        ],
        collection: {
          merchant,
          offering: cat["escape-room"],
          minPayers: 4,
          activityAt: localDayAt(now, 1, 18, tz),
          deadlineAt,
          openedAt: ago(4 * HOUR + 10 * MIN),
          proposedBudgetMinor: 12_000,
        },
      },
      secret,
    );
    await db.insert(jobs).values({
      kind: "SETTLE_DEADLINE",
      outingId: s.outing.id,
      runAt: deadlineAt,
      dedupeKey: settleJobKey(s.outing.id, s.quote!.id),
      payload: { quoteId: s.quote!.id },
    });
  }

  return listDemoState(db);
}

/** Freeze (real policy) and capture every allocation; marks the outing CONFIRMED. */
async function settleAll(db: Db, s: SeededOuting, frozenAt: Date): Promise<void> {
  const decision = await freeze(db, s, frozenAt);
  if (decision.kind !== "SETTLE") throw new Error(`seed: expected SETTLE for ${s.outing.title}, got ${decision.reasons.join(",")}`);
  const byParticipant = new Map([...s.attempts.values()].map((a) => [a.participantId, a]));
  let t = frozenAt.getTime();
  for (const [i, alloc] of decision.allocations.entries()) {
    await capture(db, s, byParticipant.get(alloc.participantId)!, alloc.allocationMinor, new Date((t += MIN)), i + 1);
  }
  const settledAt = new Date((t += MIN));
  await db
    .update(outings)
    .set({ status: "CONFIRMED", frozenAt, settledAt, cleanup: "COMPLETE", updatedAt: settledAt })
    .where(eq(outings.id, s.outing.id));
  await audit(db, s.outing.id, "WORKER:demo-seed", "OUTING_CONFIRMED", settledAt, { payerCount: decision.payerCount, totalMinor: decision.totalMinor });
}

async function voidHoldAfterFailure(db: Db, s: SeededOuting, attempt: PaymentAttempt, at: Date): Promise<void> {
  const res = must(await fixtureAt(db, at).voidAuthorization({ authorizationId: attempt.authorizationId!, requestId: operationRequestId("VOID", attempt.id) }));
  await insertOperation(db, { attempt, kind: "VOID", amountMinor: attempt.authorizedMinor, status: "SUCCEEDED", at, providerStatus: res.providerStatus });
  await setAttempt(db, attempt.id, "VOIDED", { lastError: "Capture declined (fixture simulation); hold released", providerStatus: res.providerStatus }, at);
}

/** Is `participantId` part of a FIXTURE outing? Returns the outing id if so. */
export async function fixtureOutingOf(db: Db, participantId: string): Promise<string | null> {
  const rows = await db
    .select({ outingId: participants.outingId })
    .from(participants)
    .innerJoin(outings, eq(outings.id, participants.outingId))
    .where(and(eq(participants.id, participantId), eq(outings.isFixture, true)))
    .limit(1);
  return rows[0]?.outingId ?? null;
}
