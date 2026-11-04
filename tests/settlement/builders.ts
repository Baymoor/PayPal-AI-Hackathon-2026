/**
 * Direct-insert builders for settlement tests: merchant, offering, outing,
 * quote (real terms + hash), participants, consents, payment attempts, and
 * matching authorizations in the fake provider.
 */
import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  consents,
  merchants,
  offerings,
  outings,
  participants,
  paymentAttempts,
  paymentOperations,
  quoteVersions,
  settlementSnapshots,
} from "@/lib/db/schema";
import { buildCommitmentTerms, hashTerms } from "@/lib/domain/policy";
import type { AttendanceState, OutingStatus, PaymentStatus } from "@/lib/domain/types";
import type { FakeProvider } from "./fake-provider";

export const HOUR = 60 * 60 * 1000;

export interface PersonSpec {
  name?: string;
  role?: "ORGANIZER" | "INVITEE";
  sponsored?: boolean;
  required?: boolean;
  attendance?: AttendanceState;
  attendanceAt?: Date;
  /** Payers consent by default. */
  consent?: boolean;
  consentAt?: Date;
  /** Payers hold a verified authorization for the cap by default. */
  auth?:
    | false
    | {
        amount?: number;
        createTime?: Date;
        expires?: Date | null;
        status?: PaymentStatus;
        verified?: boolean;
        late?: boolean;
        /** Only an order exists at the provider (buyer never completed approval). */
        orderOnly?: boolean;
        /** Do not seed the authorization at the provider (read will fail with not found). */
        skipProvider?: boolean;
      };
}

export interface BuildOutingOptions {
  people: PersonSpec[];
  totalMinor?: number;
  minPayers?: number;
  capacity?: number;
  deadlineAt?: Date;
  activityAt?: Date;
  quoteExpiresAt?: Date;
  status?: OutingStatus;
  provider?: FakeProvider;
  offeringActive?: boolean;
}

export interface BuiltPerson {
  id: string;
  sortKey: number;
  name: string;
  consentId?: string;
  attemptId?: string;
  authorizationId?: string;
  orderId?: string;
}

export interface BuiltOuting {
  outingId: string;
  quoteId: string;
  merchantId: string;
  offeringId: string;
  deadlineAt: Date;
  capMinor: number;
  totalMinor: number;
  termsHash: string;
  people: BuiltPerson[];
}

export function payers(n: number, extra: Partial<PersonSpec> = {}): PersonSpec[] {
  return Array.from({ length: n }, (_, i) => ({ name: `Payer ${i + 1}`, role: i === 0 ? "ORGANIZER" : "INVITEE", ...extra }) as PersonSpec);
}

let counter = 0;

export async function buildOuting(db: Db, opts: BuildOutingOptions): Promise<BuiltOuting> {
  counter += 1;
  const totalMinor = opts.totalMinor ?? 10_000;
  const minPayers = opts.minPayers ?? 5;
  const capacity = opts.capacity ?? 10;
  const deadlineAt = opts.deadlineAt ?? new Date(Date.now() - 60_000);
  const activityAt = opts.activityAt ?? new Date(deadlineAt.getTime() + 24 * HOUR);
  const quoteExpiresAt = opts.quoteExpiresAt ?? new Date(deadlineAt.getTime() + 24 * HOUR);
  const openedAt = new Date(deadlineAt.getTime() - 6 * HOUR);

  const [merchant] = await db
    .insert(merchants)
    .values({ slug: `merchant-${counter}-${randomBytes(3).toString("hex")}`, name: "The Sound Room" })
    .returning();
  const [offering] = await db
    .insert(offerings)
    .values({
      merchantId: merchant!.id,
      slug: `karaoke-${counter}`,
      name: "Private karaoke room",
      category: "karaoke",
      description: "Private room, 2 hours",
      location: "Copenhagen",
      pricingModel: "FIXED_TOTAL",
      priceMinor: totalMinor,
      currency: "USD",
      minAttendees: 1,
      capacity,
      durationMinutes: 120,
      tags: ["music"],
      availability: { weekdays: [0, 1, 2, 3, 4, 5, 6], startHours: [18, 19, 20, 21], source: "FIXTURE" },
      active: opts.offeringActive ?? true,
    })
    .returning();

  const [outing] = await db
    .insert(outings)
    .values({
      title: `Outing ${counter}`,
      status: opts.status ?? "COLLECTING",
      merchantId: merchant!.id,
      selectedOfferingId: offering!.id,
      minPayers,
      maxAttendees: capacity,
      activityAt,
      deadlineAt,
      collectionOpenedAt: openedAt,
    })
    .returning();

  const people: BuiltPerson[] = [];
  for (const [i, spec] of opts.people.entries()) {
    const attendance = spec.attendance ?? "ACCEPTED";
    const [p] = await db
      .insert(participants)
      .values({
        outingId: outing!.id,
        displayName: spec.name ?? `Person ${i + 1}`,
        role: spec.role ?? (i === 0 ? "ORGANIZER" : "INVITEE"),
        payerType: spec.sponsored ? "SPONSORED" : "PAYER",
        required: spec.required ?? true,
        sortKey: i + 1,
        attendance,
        attendanceAt: attendance === "PENDING" ? null : (spec.attendanceAt ?? new Date(deadlineAt.getTime() - 2 * HOUR)),
        inviteTokenHash: randomBytes(32).toString("hex"),
      })
      .returning();
    people.push({ id: p!.id, sortKey: p!.sortKey, name: p!.displayName });
  }

  const terms = buildCommitmentTerms({
    outingId: outing!.id,
    quoteId: "pending",
    quoteVersion: 1,
    merchantId: merchant!.id,
    merchantName: merchant!.name,
    offeringId: offering!.id,
    offeringName: offering!.name,
    pricingModel: "FIXED_TOTAL",
    totalMinor,
    currency: "USD",
    capacity,
    minPayers,
    activityAt: activityAt.toISOString(),
    deadlineAt: deadlineAt.toISOString(),
    policy: "ALL_REQUIRED",
    sponsoredParticipantIds: people.filter((_, i) => opts.people[i]!.sponsored).map((p) => p.id),
    requiredParticipantIds: people.filter((_, i) => opts.people[i]!.required ?? true).map((p) => p.id),
  });
  const termsHash = hashTerms(terms);
  const [quote] = await db
    .insert(quoteVersions)
    .values({
      outingId: outing!.id,
      version: 1,
      merchantId: merchant!.id,
      offeringId: offering!.id,
      pricingModel: "FIXED_TOTAL",
      totalMinor,
      currency: "USD",
      capacity,
      minPayers,
      capMinor: terms.capMinor,
      activityAt,
      deadlineAt,
      expiresAt: quoteExpiresAt,
      terms,
      termsHash,
      merchantConfirmedAt: openedAt,
      availabilitySource: "FIXTURE",
    })
    .returning();
  await db.update(outings).set({ currentQuoteId: quote!.id }).where(eq(outings.id, outing!.id));

  for (const [i, spec] of opts.people.entries()) {
    const person = people[i]!;
    if (spec.sponsored) continue;
    if (spec.consent === false) continue;
    const [consent] = await db
      .insert(consents)
      .values({
        outingId: outing!.id,
        participantId: person.id,
        quoteId: quote!.id,
        termsHash,
        capMinor: terms.capMinor,
        currency: "USD",
        statement: `Authorize up to $${(terms.capMinor / 100).toFixed(2)}. Your final share may be lower.`,
        acceptedAt: spec.consentAt ?? new Date(deadlineAt.getTime() - 2 * HOUR),
      })
      .returning();
    person.consentId = consent!.id;
    if (spec.auth === false) continue;
    const auth = spec.auth ?? {};
    const amount = auth.amount ?? terms.capMinor;
    const createTime = auth.createTime ?? new Date(deadlineAt.getTime() - HOUR);
    const expires = auth.expires === undefined ? new Date(createTime.getTime() + 29 * 24 * HOUR) : auth.expires;
    const orderId = `order-${counter}-${i + 1}`;
    const authorizationId = auth.orderOnly ? null : `auth-${counter}-${i + 1}`;
    const status: PaymentStatus = auth.status ?? (auth.orderOnly ? "APPROVAL_PENDING" : "AUTHORIZED");
    const [attempt] = await db
      .insert(paymentAttempts)
      .values({
        outingId: outing!.id,
        participantId: person.id,
        consentId: consent!.id,
        quoteId: quote!.id,
        provider: "PAYPAL",
        status,
        currency: "USD",
        requestedMinor: terms.capMinor,
        authorizedMinor: authorizationId ? amount : 0,
        providerOrderId: orderId,
        authorizationId,
        authorizedAt: authorizationId ? createTime : null,
        authorizationExpiresAt: authorizationId ? expires : null,
        verified: auth.verified ?? Boolean(authorizationId),
        verifiedAt: authorizationId ? createTime : null,
        late: auth.late ?? false,
        providerStatus: authorizationId ? "CREATED" : "APPROVED",
      })
      .returning();
    person.attemptId = attempt!.id;
    person.orderId = orderId;
    person.authorizationId = authorizationId ?? undefined;
    if (opts.provider && !auth.skipProvider) {
      if (authorizationId) {
        opts.provider.seedAuthorization({ authorizationId, orderId, amountMinor: amount, createTime, expirationTime: expires, customId: attempt!.id });
      } else {
        opts.provider.seedOrder({ orderId, amountMinor: terms.capMinor, customId: attempt!.id });
      }
    }
  }

  return {
    outingId: outing!.id,
    quoteId: quote!.id,
    merchantId: merchant!.id,
    offeringId: offering!.id,
    deadlineAt,
    capMinor: terms.capMinor,
    totalMinor,
    termsHash,
    people,
  };
}

/* ------------------------------- readers -------------------------------- */

export async function loadOuting(db: Db, outingId: string) {
  const row = await db.query.outings.findFirst({ where: eq(outings.id, outingId) });
  if (!row) throw new Error("outing not found");
  return row;
}

export async function loadAttempts(db: Db, outingId: string) {
  return db.query.paymentAttempts.findMany({ where: eq(paymentAttempts.outingId, outingId), orderBy: [asc(paymentAttempts.createdAt)] });
}

export async function loadOps(db: Db, outingId: string) {
  return db.query.paymentOperations.findMany({ where: eq(paymentOperations.outingId, outingId), orderBy: [asc(paymentOperations.sequence), asc(paymentOperations.createdAt)] });
}

export async function loadSnapshot(db: Db, outingId: string) {
  return db.query.settlementSnapshots.findFirst({ where: eq(settlementSnapshots.outingId, outingId) });
}

export const resolverFor = (fake: FakeProvider) => () => fake;
