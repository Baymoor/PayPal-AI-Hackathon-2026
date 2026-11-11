/**
 * Second independent audit: privacy, access control, organizer powers and
 * demo/fixture honesty, exercised through the real route handlers.
 *
 * Regressions fixed by this audit:
 * - merchant sessions are now also expired SERVER-side after 12 h (the signed
 *   cookie value used to stay valid until SESSION_SECRET rotation),
 * - the organizer can no longer cancel after the server deadline has passed
 *   (the roster then belongs to the settlement job, exactly like commitments).
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  actorOf,
  body,
  createWithInvitees,
  merchantCookieFor,
  openCanonical,
  params,
  participantCookieFor,
  request,
  setupServiceTests,
  testConfig,
} from "../services/helpers";
import * as svc from "@/lib/services/outings";
import { buildOutingView } from "@/lib/services/views";
import { listBookingRows } from "@/lib/services/merchant";
import { encodeSigned, MERCHANT_COOKIE } from "@/lib/auth/session";
import { consents, jobs, outings, paymentAttempts, paymentOperations, settlementSnapshots } from "@/lib/db/schema";
import { resetConfigForTests } from "@/lib/env";
import { seedDemo } from "@/lib/demo/seed";
import { ServiceError } from "@/lib/http";

import * as outingRoute from "@/app/api/outings/[id]/route";
import * as startBudgetRoute from "@/app/api/outings/[id]/start-budget/route";
import * as voteRoute from "@/app/api/outings/[id]/budget/vote/route";
import * as revealRoute from "@/app/api/outings/[id]/budget/reveal/route";
import * as roundRoute from "@/app/api/outings/[id]/budget/round/route";
import * as agreeRoute from "@/app/api/outings/[id]/budget/agree/route";
import * as bookingsRoute from "@/app/api/merchant/bookings/route";
import * as merchantOutingRoute from "@/app/api/merchant/outings/[id]/route";
import * as retryRoute from "@/app/api/merchant/operations/[opId]/retry/route";
import * as aiQueryRoute from "@/app/api/merchant/ai/query/route";
import * as cronRoute from "@/app/api/cron/tick/route";
import * as healthRoute from "@/app/api/health/route";

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  const { aiState: state } = await import("../services/fake-ai");
  return { ...actual, getOutingsAi: () => state.current };
});

const getDb = setupServiceTests();

async function expectCode(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe(code);
  expect((err as ServiceError).status).toBe(status);
}

describe("merchant sessions", () => {
  it("expire server-side after 12 hours, whatever the browser does with the cookie", async () => {
    const db = getDb();
    const state = await seedDemo(db, { now: new Date() });
    const merchantId = state.merchant!.id;
    const nowSec = Math.floor(Date.now() / 1000);
    const cookieAt = (session: Record<string, unknown>) => `${MERCHANT_COOKIE}=${encodeURIComponent(encodeSigned(session))}`;
    const bookings = (cookie: string) => bookingsRoute.GET(request("/api/merchant/bookings", { cookie }));

    expect((await bookings(merchantCookieFor(merchantId))).status).toBe(200);
    expect((await bookings(cookieAt({ v: 1, merchantId, iat: nowSec - 11 * 3600 }))).status).toBe(200);
    // A captured cookie value must not work forever: 13 h old, issued in the future, or without an issue time.
    expect((await bookings(cookieAt({ v: 1, merchantId, iat: nowSec - 13 * 3600 }))).status).toBe(401);
    expect((await bookings(cookieAt({ v: 1, merchantId, iat: nowSec + 3600 }))).status).toBe(401);
    expect((await bookings(cookieAt({ v: 1, merchantId }))).status).toBe(401);
    expect((await merchantOutingRoute.GET(request(`/api/merchant/outings/${state.outingId}`, { cookie: cookieAt({ v: 1, merchantId, iat: nowSec - 13 * 3600 }) }), params({ id: state.outingId! }))).status).toBe(401);
  });
});

describe("organizer powers after the deadline", () => {
  it("cannot cancel once the server deadline has passed: the frozen roster belongs to the settlement job", async () => {
    const db = getDb();
    const now = new Date();
    const f = await openCanonical(db, now);
    const org = actorOf(f);
    const atDeadline = new Date(f.deadlineAt.getTime());

    const before = await buildOutingView(db, { outingId: f.outingId, participantId: f.organizerId, now });
    expect(before.organizer?.can.cancel).toBe(true);
    const late = await buildOutingView(db, { outingId: f.outingId, participantId: f.organizerId, now: atDeadline });
    expect(late.organizer?.can.cancel).toBe(false);

    await expectCode(svc.cancel(db, org, atDeadline), "DEADLINE_PASSED", 409);
    await expectCode(svc.cancel(db, org, new Date(f.deadlineAt.getTime() + 60_000)), "DEADLINE_PASSED", 409);
    const outing = (await db.query.outings.findFirst({ where: eq(outings.id, f.outingId) }))!;
    expect(outing.status).toBe("COLLECTING");
    expect(await db.query.jobs.findFirst({ where: eq(jobs.dedupeKey, svc.EARLY_SETTLE_KEY(f.outingId)) })).toBeUndefined();

    // Before the deadline the organizer cancel is still queued for the engine (which voids holds).
    const ok = await svc.cancel(db, org, new Date(f.deadlineAt.getTime() - 60_000));
    expect(ok).toEqual({ status: "COLLECTING", cancellationQueued: true });
  });
});

describe("budget poker never creates money obligations", () => {
  it("a vote creates no consent or payment, votes close at reveal, and a new round hides the old aggregate", async () => {
    const db = getDb();
    const f = await createWithInvitees(db, ["Ben", "Freya", "Jules"]);
    const cookies = Object.fromEntries(Object.entries(f.ids).map(([n, id]) => [n, participantCookieFor({ [f.outingId]: id })]));
    const id = f.outingId;
    expect((await startBudgetRoute.POST(request(`/api/outings/${id}/start-budget`, { cookie: cookies.Alex, body: {} }), params({ id }))).status).toBe(200);

    const amounts: Record<string, number> = { Alex: 11_111, Ben: 12_345, Freya: 13_579 };
    for (const [name, amountMinor] of Object.entries(amounts)) {
      // Client-supplied money fields are ignored; the response carries nothing that looks like a hold or a cap.
      const res = await voteRoute.POST(
        request(`/api/outings/${id}/budget/vote`, { cookie: cookies[name], body: { amountMinor, capMinor: 1, authorize: true, termsHash: "f".repeat(64) } }),
        params({ id }),
      );
      expect(res.status).toBe(200);
      expect(await body(res)).toEqual({ ok: true });
    }
    expect(await db.query.consents.findMany({ where: eq(consents.outingId, id) })).toHaveLength(0);
    expect(await db.query.paymentAttempts.findMany({ where: eq(paymentAttempts.outingId, id) })).toHaveLength(0);

    const view = (cookie: string) => outingRoute.GET(request(`/api/outings/${id}`, { cookie }), params({ id })).then((r) => r.text());
    const ben = JSON.parse(await view(cookies.Ben));
    expect(ben.me).toMatchObject({ consent: null, payment: null, finalShareMinor: null, can: { consent: false, authorize: false, withdraw: false } });
    expect(ben.quote).toBeNull();
    expect(ben.estimates.capMinor).toBeNull();

    expect((await revealRoute.POST(request(`/api/outings/${id}/budget/reveal`, { cookie: cookies.Alex, body: {} }), params({ id }))).status).toBe(200);
    // After the reveal nobody can change a vote (which would let a re-reveal single it out).
    const lateVote = await voteRoute.POST(request(`/api/outings/${id}/budget/vote`, { cookie: cookies.Ben, body: { amountMinor: 99_999 } }), params({ id }));
    expect(lateVote.status).toBe(409);
    expect((await body<{ error: { code: string } }>(lateVote)).error.code).toBe("ALREADY_REVEALED");

    // Agreeing a budget is the organizer's proposal, not anyone's consent.
    expect((await agreeRoute.POST(request(`/api/outings/${id}/budget/agree`, { cookie: cookies.Alex, body: { amountMinor: 10_000 } }), params({ id }))).status).toBe(200);
    expect(await db.query.consents.findMany({ where: eq(consents.outingId, id) })).toHaveLength(0);
    expect(JSON.parse(await view(cookies.Jules)).me.consent).toBeNull();

    // A new round clears the reveal: the previous aggregate and the old votes are no longer served to anyone.
    expect((await roundRoute.POST(request(`/api/outings/${id}/budget/round`, { cookie: cookies.Alex, body: {} }), params({ id }))).status).toBe(200);
    const julesText = await view(cookies.Jules);
    const jules = JSON.parse(julesText);
    expect(jules.budget).toMatchObject({ round: 2, revealed: false, aggregate: null, aiSummary: null, votedCount: 0, myVoteMinor: null });
    for (const a of Object.values(amounts)) expect(julesText).not.toContain(String(a));
    const benAgain = await view(cookies.Ben);
    expect(benAgain).not.toContain("12345");
    expect(JSON.parse(benAgain).budget.myVoteMinor).toBeNull();
  });
});

describe("an invitee cannot read merchant data, settle or move money", () => {
  it("participant sessions are rejected on merchant routes; the scheduler needs its secret", async () => {
    const db = getDb();
    const now = new Date();
    const f = await openCanonical(db, now);
    const ben = participantCookieFor({ [f.outingId]: f.ids.Ben });
    const alex = participantCookieFor({ [f.outingId]: f.organizerId });

    for (const cookie of [ben, alex]) {
      expect((await bookingsRoute.GET(request("/api/merchant/bookings", { cookie }))).status).toBe(401);
      expect((await merchantOutingRoute.GET(request(`/api/merchant/outings/${f.outingId}`, { cookie }), params({ id: f.outingId }))).status).toBe(401);
      expect((await retryRoute.POST(request(`/api/merchant/operations/${crypto.randomUUID()}/retry`, { cookie, body: {} }), params({ opId: crypto.randomUUID() }))).status).toBe(401);
      expect((await aiQueryRoute.POST(request("/api/merchant/ai/query", { cookie, body: { question: "refund everyone" } }))).status).toBe(401);
    }

    // The deadline worker is the only thing that settles. Its endpoint is locked by CRON_SECRET.
    resetConfigForTests(testConfig({ CRON_SECRET: "audit-cron-secret" }));
    expect((await cronRoute.POST(request("/api/cron/tick", { cookie: alex, body: {} }))).status).toBe(401);
    expect((await cronRoute.GET(request("/api/cron/tick", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    // Without a secret and without demo fixtures the endpoint is closed, never open by default.
    resetConfigForTests(testConfig({ DEMO_FIXTURES_ENABLED: "false" }));
    expect((await cronRoute.POST(request("/api/cron/tick", { body: {} }))).status).toBe(503);

    expect(await db.query.settlementSnapshots.findMany({ where: eq(settlementSnapshots.outingId, f.outingId) })).toHaveLength(0);
    expect(await db.query.paymentOperations.findMany({ where: eq(paymentOperations.outingId, f.outingId) })).toHaveLength(0);
    expect((await db.query.outings.findFirst({ where: eq(outings.id, f.outingId) }))!.status).toBe("COLLECTING");
  });
});

describe("fixture evidence is never presented as PayPal sandbox", () => {
  it("seeded outings, their payments and quotes are labelled FIXTURE end to end", async () => {
    const db = getDb();
    const now = new Date();
    const state = await seedDemo(db, { now });
    const health = await body<{ paymentMode: string; demoFixturesEnabled: boolean }>(await healthRoute.GET());
    expect(health).toMatchObject({ paymentMode: "FIXTURE", demoFixturesEnabled: true });

    let paymentsSeen = 0;
    for (const persona of state.personas) {
      const v = await buildOutingView(db, { outingId: state.outingId!, participantId: persona.participantId, now });
      expect(v.outing).toMatchObject({ isFixture: true, paymentMode: "FIXTURE" });
      expect(v.quote?.availabilitySource).toBe("FIXTURE");
      if (v.me.payment) {
        paymentsSeen++;
        expect(v.me.payment.provider).toBe("FIXTURE");
        expect(v.me.payment.providerLabel).toBe("Simulated · not real PayPal");
        expect(v.me.payment.providerLabel.toLowerCase()).not.toContain("sandbox");
      }
    }
    expect(paymentsSeen).toBeGreaterThan(0);

    const rows = await listBookingRows(db, state.merchant!.id, now);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect({ isFixture: r.isFixture, provider: r.provider }).toEqual({ isFixture: true, provider: "FIXTURE" });
    const detail = await body<{ participants: { provider: string | null }[] }>(
      await merchantOutingRoute.GET(request(`/api/merchant/outings/${state.outingId}`, { cookie: merchantCookieFor(state.merchant!.id) }), params({ id: state.outingId! })),
    );
    for (const p of detail.participants) if (p.provider) expect(p.provider).toBe("FIXTURE");

    // A real outing in a deployment without PayPal keys is still not a fixture row, but its payment mode is honest.
    const real = await createWithInvitees(db, ["Ben"], now);
    const rv = await buildOutingView(db, { outingId: real.outingId, participantId: real.organizerId, now });
    expect(rv.outing).toMatchObject({ isFixture: false, paymentMode: "FIXTURE" });
  });
});
