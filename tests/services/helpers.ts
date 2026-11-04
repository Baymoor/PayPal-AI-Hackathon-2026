/**
 * Shared setup for service and access tests: test database, deterministic
 * config (demo fixtures on, no real PayPal/Anthropic keys), session cookies
 * for direct route-handler calls, and a builder that drives an outing
 * through the real services up to COLLECTING.
 *
 * Every test file must also mock the AI module:
 *   vi.mock("@/lib/ai", async (orig) => ({ ...(await orig()), getOutingsAi: () => aiState.current }));
 */
import { afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb as registerTestDb, testDatabaseUrl } from "../helpers/db";
import { closeDb, type Db } from "@/lib/db/client";
import { loadConfig, resetConfigForTests } from "@/lib/env";
import { participantCookie, merchantCookie, withOuting, type ParticipantSession } from "@/lib/auth/session";
import { paymentAttempts, consents, type PaymentAttempt } from "@/lib/db/schema";
import { resetRateLimits } from "@/lib/rate-limit";
import { seedCatalogue, nextLocalWeekdayAt } from "@/lib/demo/seed";
import * as svc from "@/lib/services/outings";
import { resetFakeAi } from "./fake-ai";

export const TEST_SESSION_SECRET = "test-session-secret-0123456789abcdef0123456789abcdef";
export const TEST_MERCHANT_PASSWORD = "sound-room-test-password";
export const BASE = "http://localhost:3000";

export function testConfig(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: testDatabaseUrl(),
    APP_BASE_URL: BASE,
    SESSION_SECRET: TEST_SESSION_SECRET,
    DEMO_FIXTURES_ENABLED: "true",
    MERCHANT_DASHBOARD_PASSWORD: TEST_MERCHANT_PASSWORD,
    ...overrides,
  } as NodeJS.ProcessEnv);
}

/** Registers DB + config lifecycle hooks. Route handlers use getDb(), so point DATABASE_URL at the test DB. */
export function setupServiceTests(): () => Db {
  process.env.DATABASE_URL = testDatabaseUrl();
  resetConfigForTests(testConfig());
  const getDb = registerTestDb();
  beforeEach(() => {
    resetConfigForTests(testConfig());
    resetRateLimits();
    resetFakeAi();
  });
  afterAll(async () => {
    await closeDb();
    resetConfigForTests();
  });
  return getDb;
}

/* --------------------------------- HTTP ----------------------------------- */

/** "outings_p=<value>" from a Set-Cookie string. */
export function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0];
}

export function participantCookieFor(entries: Record<string, string>): string {
  let s: ParticipantSession = { v: 1, outings: {} };
  for (const [outingId, participantId] of Object.entries(entries)) s = withOuting(s, outingId, participantId);
  return cookiePair(participantCookie(s));
}

export function merchantCookieFor(merchantId: string): string {
  return cookiePair(merchantCookie(merchantId));
}

export function request(
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

export async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/* ------------------------------- Builders ---------------------------------- */

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export interface Flow {
  outingId: string;
  organizerId: string;
  /** name -> participantId */
  ids: Record<string, string>;
  links: Record<string, string>;
  offerings: Awaited<ReturnType<typeof seedCatalogue>>["offerings"];
  merchantId: string;
}

/** Create an outing with invitees (DRAFT). */
export async function createWithInvitees(db: Db, names: string[], now = new Date()): Promise<Flow> {
  const { merchant, offerings } = await seedCatalogue(db);
  const { outingId, participantId } = await svc.createOuting(db, { organizerName: "Alex", brief: "Karaoke for Maya's birthday on Friday" }, now);
  const actor = { outingId, participantId };
  const { invites } = names.length ? await svc.addInvitees(db, actor, { names }, now) : { invites: [] };
  const ids: Record<string, string> = { Alex: participantId };
  const links: Record<string, string> = {};
  for (const i of invites) {
    ids[i.displayName] = i.participantId;
    links[i.displayName] = i.link;
  }
  return { outingId, organizerId: participantId, ids, links, offerings, merchantId: merchant.id };
}

export const actorOf = (f: Flow, name = "Alex") => ({ outingId: f.outingId, participantId: f.ids[name] });

/** Collection timing that passes validateCommitmentDeadline and the karaoke availability model. */
export function collectionTimes(now: Date) {
  const deadlineAt = new Date(now.getTime() + 2 * HOUR);
  const activityAt = nextLocalWeekdayAt(new Date(deadlineAt.getTime() + HOUR), 5, 19, "Europe/Copenhagen");
  return { deadlineAt, activityAt };
}

/**
 * Canonical demo: Alex + Ben, Freya, Jules, Noor (payers) + Maya (sponsored),
 * $100 private karaoke room, minPayers 5 -> cap $20. Returns at COLLECTING.
 */
export async function openCanonical(db: Db, now = new Date(), opts: { offeringSlug?: string; minPayers?: number } = {}) {
  const f = await createWithInvitees(db, ["Ben", "Freya", "Jules", "Noor", "Maya"], now);
  const org = actorOf(f);
  await svc.startBudget(db, org, now);
  for (const [name, amount] of [["Alex", 10_000], ["Ben", 10_000], ["Freya", 7_500], ["Jules", 15_000]] as const) {
    await svc.vote(db, actorOf(f, name), { amountMinor: amount }, now);
  }
  await svc.reveal(db, org, now);
  await svc.agreeBudget(db, org, { amountMinor: 10_000 }, now);
  const offering = f.offerings[opts.offeringSlug ?? "private-karaoke-room"];
  await svc.selectOffering(db, org, { offeringId: offering.id }, now);
  await svc.patchParticipant(db, org, f.ids.Maya, { payerType: "SPONSORED" }, now);
  const times = collectionTimes(now);
  const opened = await svc.openCollection(db, org, { ...times, minPayers: opts.minPayers ?? 5 }, now);
  return { ...f, ...times, opened };
}

/** Simulate a provider-verified authorization (the payments WP owns the real flow). */
export async function insertAuthorizedAttempt(
  db: Db,
  input: { outingId: string; participantId: string; quoteId: string; amountMinor: number; authorizedAt: Date; status?: PaymentAttempt["status"]; captured?: number; refunded?: number },
): Promise<PaymentAttempt> {
  const consent = await db.query.consents.findFirst({ where: eq(consents.participantId, input.participantId) });
  if (!consent) throw new Error("consent first");
  const [row] = await db
    .insert(paymentAttempts)
    .values({
      outingId: input.outingId,
      participantId: input.participantId,
      consentId: consent.id,
      quoteId: input.quoteId,
      provider: "FIXTURE",
      status: input.status ?? "AUTHORIZED",
      currency: "USD",
      requestedMinor: input.amountMinor,
      authorizedMinor: input.amountMinor,
      capturedMinor: input.captured ?? 0,
      refundedMinor: input.refunded ?? 0,
      providerOrderId: `FXORD-${crypto.randomUUID()}`,
      authorizationId: `FXAUTH-${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`,
      authorizedAt: input.authorizedAt,
      authorizationExpiresAt: new Date(input.authorizedAt.getTime() + 29 * 24 * HOUR),
      verified: true,
      verifiedAt: input.authorizedAt,
    })
    .returning();
  return row;
}
