/** Test fixtures for the payments work package (inserted directly; no other services needed). */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  consents,
  merchants,
  offerings,
  outings,
  participants,
  quoteVersions,
  type Consent,
  type Outing,
  type Participant,
  type QuoteVersion,
} from "@/lib/db/schema";
import { buildCommitmentTerms, hashTerms } from "@/lib/domain/policy";
import { loadConfig, resetConfigForTests } from "@/lib/env";
import { encodeSigned, PARTICIPANT_COOKIE, type ParticipantSession } from "@/lib/auth/session";

export const TEST_SESSION_SECRET = "payments-test-session-secret-0123456789";

export function useDemoConfig(extra: Record<string, string> = {}): void {
  resetConfigForTests(
    loadConfig({
      NODE_ENV: "test",
      DEMO_FIXTURES_ENABLED: "true",
      APP_BASE_URL: "http://localhost:3301",
      SESSION_SECRET: TEST_SESSION_SECRET,
      ...extra,
    } as unknown as NodeJS.ProcessEnv),
  );
}

export interface SeededOuting {
  outing: Outing;
  quote: QuoteVersion;
  organizer: Participant;
  payers: Participant[];
  sponsored: Participant;
  consents: Map<string, Consent>;
}

let seq = 0;
const tokenHash = () => randomBytes(32).toString("hex");

/**
 * $100 FIXED_TOTAL karaoke room, minPayers 5 -> cap $20. Organizer + `payerCount`
 * payers (all ACCEPTED with consent to the current terms) + one sponsored guest.
 * payers[0] is required; payers[1] is optional (when payerCount > 1).
 */
export async function seedCollectingOuting(
  db: Db,
  opts: { now: Date; deadlineInMs?: number; payerCount?: number; totalMinor?: number; minPayers?: number } = { now: new Date() },
): Promise<SeededOuting> {
  const now = opts.now;
  const deadlineAt = new Date(now.getTime() + (opts.deadlineInMs ?? 60 * 60 * 1000));
  const activityAt = new Date(deadlineAt.getTime() + 24 * 60 * 60 * 1000);
  const totalMinor = opts.totalMinor ?? 10_000;
  const minPayers = opts.minPayers ?? 5;
  seq += 1;

  const [merchant] = await db.insert(merchants).values({ slug: `karaoke-${seq}`, name: "Neon Karaoke" }).returning();
  const [offering] = await db
    .insert(offerings)
    .values({
      merchantId: merchant.id,
      slug: "private-room",
      name: "Private karaoke room",
      category: "karaoke",
      description: "Two hours, up to ten people",
      location: "Copenhagen",
      pricingModel: "FIXED_TOTAL",
      priceMinor: totalMinor,
      capacity: 10,
      durationMinutes: 120,
      availability: { weekdays: [1, 2, 3, 4, 5, 6, 0], startHours: [18, 20], source: "FIXTURE" },
    })
    .returning();
  const [outing0] = await db
    .insert(outings)
    .values({
      title: "Friday karaoke",
      status: "COLLECTING",
      merchantId: merchant.id,
      selectedOfferingId: offering.id,
      minPayers,
      activityAt,
      deadlineAt,
      collectionOpenedAt: now,
    })
    .returning();

  let sortKey = 0;
  const mk = async (displayName: string, extra: Partial<typeof participants.$inferInsert> = {}) => {
    const [p] = await db
      .insert(participants)
      .values({
        outingId: outing0.id,
        displayName,
        sortKey: sortKey++,
        attendance: "ACCEPTED",
        attendanceAt: now,
        inviteTokenHash: tokenHash(),
        ...extra,
      })
      .returning();
    return p;
  };
  const organizer = await mk("Olivia", { role: "ORGANIZER" });
  const payers: Participant[] = [];
  const payerCount = opts.payerCount ?? 2;
  for (let i = 0; i < payerCount; i++) payers.push(await mk(`Payer ${i + 1}`, { required: i !== 1 }));
  const sponsored = await mk("Guest", { payerType: "SPONSORED" });

  const quote = await insertQuote(db, outing0, { offeringId: offering.id, merchantId: merchant.id, totalMinor, minPayers, version: 1, now, deadlineAt, activityAt, sponsoredIds: [sponsored.id], requiredIds: [organizer.id, payers[0].id, sponsored.id] });
  const [outing] = await db.update(outings).set({ currentQuoteId: quote.id }).where(eq(outings.id, outing0.id)).returning();

  const consentMap = new Map<string, Consent>();
  for (const p of [organizer, ...payers]) {
    consentMap.set(p.id, await consentTo(db, p, quote, now));
  }
  return { outing, quote, organizer, payers, sponsored, consents: consentMap };
}

export async function insertQuote(
  db: Db,
  outing: Outing,
  q: {
    offeringId: string;
    merchantId: string;
    totalMinor: number;
    minPayers: number;
    version: number;
    now: Date;
    deadlineAt: Date;
    activityAt: Date;
    sponsoredIds: string[];
    requiredIds: string[];
  },
): Promise<QuoteVersion> {
  const terms = buildCommitmentTerms({
    outingId: outing.id,
    quoteId: `quote-v${q.version}`,
    quoteVersion: q.version,
    merchantId: q.merchantId,
    merchantName: "Neon Karaoke",
    offeringId: q.offeringId,
    offeringName: "Private karaoke room",
    pricingModel: "FIXED_TOTAL",
    totalMinor: q.totalMinor,
    currency: "USD",
    capacity: 10,
    minPayers: q.minPayers,
    activityAt: q.activityAt.toISOString(),
    deadlineAt: q.deadlineAt.toISOString(),
    policy: "ALL_REQUIRED",
    sponsoredParticipantIds: q.sponsoredIds,
    requiredParticipantIds: q.requiredIds,
  });
  const [quote] = await db
    .insert(quoteVersions)
    .values({
      outingId: outing.id,
      version: q.version,
      merchantId: q.merchantId,
      offeringId: q.offeringId,
      pricingModel: "FIXED_TOTAL",
      totalMinor: q.totalMinor,
      currency: "USD",
      capacity: 10,
      minPayers: q.minPayers,
      capMinor: terms.capMinor,
      activityAt: q.activityAt,
      deadlineAt: q.deadlineAt,
      expiresAt: new Date(q.deadlineAt.getTime() + 2 * 60 * 60 * 1000),
      terms,
      termsHash: hashTerms(terms),
      merchantConfirmedAt: q.now,
      availabilitySource: "FIXTURE",
    })
    .returning();
  return quote;
}

export async function consentTo(db: Db, p: Participant, quote: QuoteVersion, at: Date): Promise<Consent> {
  const [c] = await db
    .insert(consents)
    .values({
      outingId: quote.outingId,
      participantId: p.id,
      quoteId: quote.id,
      termsHash: quote.termsHash,
      capMinor: quote.capMinor,
      currency: quote.currency,
      statement: "Authorize up to $20. Your final share may be lower.",
      acceptedAt: at,
    })
    .returning();
  return c;
}

/** Cookie header value for a participant session (signed with the test secret). */
export function sessionCookie(outings: Record<string, string>): string {
  const session: ParticipantSession = { v: 1, outings };
  return `${PARTICIPANT_COOKIE}=${encodeURIComponent(encodeSigned(session, TEST_SESSION_SECRET))}`;
}
