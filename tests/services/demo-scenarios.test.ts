/**
 * One-click demo scenarios (lib/demo/scenarios.ts, POST /api/demo/scenario, POST /api/demo/tick).
 *
 * Each scenario must create a valid COLLECTING fixture outing through the real services, and the
 * REAL engine (runWorkerTick + the real FixtureProvider) must take it to the advertised outcome once
 * the deadline has passed. The deadline is moved into the past in the test database instead of
 * waiting for it; nothing else is faked.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { body, request, setupServiceTests, testConfig } from "./helpers";
import { auditEvents, jobs, outings, paymentAttempts, paymentOperations, quoteVersions, settlementSnapshots } from "@/lib/db/schema";
import { resetConfigForTests } from "@/lib/env";
import { hashTerms, type CommitmentTerms } from "@/lib/domain/policy";
import { zonedParts } from "@/lib/services/catalogue";
import { consent } from "@/lib/services/outings";
import { approveFixturePayment, startPayment } from "@/lib/services/payments";
import { FixtureProvider, readFixtureObject } from "@/lib/payments/fixture";
import { getPaymentProvider, resetPaymentProviders, setPaymentProviderOverride } from "@/lib/payments";
import { runWorkerTick } from "@/lib/jobs/runner";
import { settleJobKey } from "@/lib/jobs/queue";
import { createDemoScenario, demoScenarioStatus, demoTickAllowed, type DemoScenario, type DemoScenarioKind } from "@/lib/demo/scenarios";
import { DEMO_MERCHANT_NAME, DEMO_SCENARIO_TITLES } from "@/lib/demo/constants";
import { deleteFixtureOutings } from "@/lib/demo/seed";
import * as scenarioRoute from "@/app/api/demo/scenario/route";
import * as tickRoute from "@/app/api/demo/tick/route";

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  const { aiState: state } = await import("./fake-ai");
  return { ...actual, getOutingsAi: () => state.current };
});

const getDb = setupServiceTests();
const W = "test-worker";

beforeEach(() => {
  resetPaymentProviders();
  // The real FixtureProvider, bound to the test database (the payments service and the engine share it).
  setPaymentProviderOverride("FIXTURE", new FixtureProvider({ db: getDb() }));
});

afterAll(() => {
  resetPaymentProviders();
  delete process.env.DEMO_ALLOW_PUBLIC_TICK;
});

const tick = () => runWorkerTick(getDb(), getPaymentProvider, { workerId: W });

const outingRow = async (id: string) => (await getDb().query.outings.findFirst({ where: eq(outings.id, id) }))!;
const attemptsOf = (id: string) => getDb().query.paymentAttempts.findMany({ where: eq(paymentAttempts.outingId, id) });
const opsOf = (id: string) => getDb().query.paymentOperations.findMany({ where: eq(paymentOperations.outingId, id) });
const auditOf = (id: string) => getDb().select().from(auditEvents).where(eq(auditEvents.outingId, id)).orderBy(auditEvents.createdAt);

function personaId(s: DemoScenario, name: string): string {
  const p = s.personas.find((x) => x.displayName === name);
  if (!p) throw new Error(`no persona ${name}`);
  return p.participantId;
}

/** The deadline passes (in the test database) instead of waiting for it; the SETTLE_DEADLINE job becomes due too. */
async function passDeadline(outingId: string): Promise<void> {
  const db = getDb();
  await db.update(outings).set({ deadlineAt: new Date() }).where(eq(outings.id, outingId));
  await db.update(jobs).set({ runAt: new Date() }).where(and(eq(jobs.outingId, outingId), eq(jobs.kind, "SETTLE_DEADLINE")));
}

/** The viewer's live commitment, through the same services the UI calls. */
async function commitAs(s: DemoScenario, name: string): Promise<void> {
  const db = getDb();
  const participantId = personaId(s, name);
  const outing = await outingRow(s.outingId);
  const quote = (await db.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, outing.currentQuoteId!) }))!;
  const now = new Date();
  await consent(db, { outingId: s.outingId, participantId }, { termsHash: quote.termsHash }, now);
  const started = await startPayment(db, { outingId: s.outingId, participantId, now, reviewedTermsHash: quote.termsHash });
  expect(started.provider).toBe("FIXTURE");
  const approved = await approveFixturePayment(db, { attemptId: started.paymentAttemptId, participantId, outcome: "APPROVE", now: new Date() });
  expect(approved.outcome).toBe("AUTHORIZED");
}

describe("each scenario creates a valid COLLECTING fixture outing", () => {
  const expected: Record<Exclude<DemoScenarioKind, "big-group">, string[]> = {
    "settle-soon": ["Alex", "Ben", "Freya", "Jules"],
    holdout: ["Alex", "Ben", "Freya", "Jules"],
    "capture-failure": ["Alex", "Ben", "Freya", "Jules", "Noor"],
  };

  for (const kind of Object.keys(expected) as (keyof typeof expected)[]) {
    it(kind, async () => {
      const db = getDb();
      const now = new Date();
      const s = await createDemoScenario(db, { kind, deadlineSeconds: 120, now });

      expect(s.kind).toBe(kind);
      expect(s.title).toBe(DEMO_SCENARIO_TITLES[kind]);
      expect(Date.parse(s.deadlineAt)).toBe(now.getTime() + 120_000);
      expect(s.personas.map((p) => p.displayName)).toEqual(["Alex", "Ben", "Freya", "Jules", "Noor", "Maya"]);
      expect(s.personas.every((p) => p.note.length > 0)).toBe(true);
      expect(s.personas[0].role).toBe("ORGANIZER");

      const outing = await outingRow(s.outingId);
      expect(outing).toMatchObject({ status: "COLLECTING", isFixture: true, minPayers: 5, frozenAt: null });
      expect(outing.deadlineAt!.toISOString()).toBe(s.deadlineAt);

      // Terms built by openCollection: $100 fixed total at The Sound Room, $20 cap, hash over the exact terms.
      const quote = (await db.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, outing.currentQuoteId!) }))!;
      const terms = quote.terms as CommitmentTerms;
      expect(quote).toMatchObject({ status: "ACTIVE", totalMinor: 10_000, capMinor: 2_000, pricingModel: "FIXED_TOTAL", minPayers: 5, capacity: 10 });
      expect(terms).toMatchObject({ merchantName: DEMO_MERCHANT_NAME, offeringName: "Private karaoke room", deadlineAt: s.deadlineAt });
      expect(hashTerms(terms)).toBe(quote.termsHash);
      expect(terms.sponsoredParticipantIds).toEqual([personaId(s, "Maya")]);
      expect(terms.requiredParticipantIds).toHaveLength(6);
      // Friday 19:00 at the merchant, after the deadline.
      const local = zonedParts(quote.activityAt, "Europe/Copenhagen");
      expect([local.hour, quote.activityAt.getUTCMinutes()]).toEqual([19, 0]);
      expect(new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay()).toBe(5);
      expect(quote.activityAt.getTime()).toBeGreaterThan(Date.parse(s.deadlineAt));

      // Deadline job at the server deadline.
      const job = await db.query.jobs.findFirst({ where: eq(jobs.dedupeKey, settleJobKey(s.outingId, quote.id)) });
      expect(job?.runAt.toISOString()).toBe(s.deadlineAt);

      // Maya accepted; the planned payers hold a verified FIXTURE authorization of exactly the cap.
      const maya = await db.query.participants.findFirst({ where: (p, { eq: e }) => e(p.id, personaId(s, "Maya")) });
      expect(maya).toMatchObject({ payerType: "SPONSORED", attendance: "ACCEPTED" });
      const attempts = await attemptsOf(s.outingId);
      const holders = s.personas.filter((p) => attempts.some((a) => a.participantId === p.participantId)).map((p) => p.displayName);
      expect(holders).toEqual(expected[kind]);
      for (const a of attempts) {
        expect(a).toMatchObject({ provider: "FIXTURE", status: "AUTHORIZED", verified: true, late: false, authorizedMinor: 2_000, capturedMinor: 0 });
        expect(a.authorizationId).toMatch(/^FXAUTH-/);
      }

      const status = (await demoScenarioStatus(db, s.outingId))!;
      expect(status).toMatchObject({ kind, status: "COLLECTING", payers: { total: 5, committed: expected[kind].length } });
      expect(status.headline).toMatch(/Nothing is settled before the deadline/);

      // A worker pass before the deadline settles nothing.
      await tick();
      expect((await outingRow(s.outingId)).status).toBe("COLLECTING");
      expect(await db.query.settlementSnapshots.findFirst({ where: eq(settlementSnapshots.outingId, s.outingId) })).toBeUndefined();
    });
  }

  it("injects the capture decline (Jules) and the lost refund response (Ben) into the simulator only for capture-failure", async () => {
    const db = getDb();
    const s = await createDemoScenario(db, { kind: "capture-failure" });
    expect(s.deadlineSeconds).toBe(120);
    const attempts = await attemptsOf(s.outingId);
    const failuresOf = async (name: string) => {
      const a = attempts.find((x) => x.participantId === personaId(s, name))!;
      return ((await readFixtureObject(db, a.authorizationId!))!.data as { failures?: Record<string, string> }).failures ?? {};
    };
    expect(await failuresOf("Jules")).toEqual({ CAPTURE: "DECLINE" });
    expect(await failuresOf("Ben")).toEqual({ REFUND: "TIMEOUT_AFTER" });
    expect(await failuresOf("Alex")).toEqual({});
    const created = await db.select().from(auditEvents).where(and(eq(auditEvents.outingId, s.outingId), eq(auditEvents.type, "DEMO_SCENARIO_CREATED")));
    expect(created[0]?.data).toMatchObject({ kind: "capture-failure", provider: "FIXTURE" });
  });
});

describe("the real engine settles each scenario at the deadline", () => {
  it("settle-soon: Noor commits live, then the deadline confirms 5 x $20 (Maya $0)", async () => {
    const db = getDb();
    const s = await createDemoScenario(db, { kind: "settle-soon" });
    await commitAs(s, "Noor");
    await passDeadline(s.outingId);

    const r = await tick();
    expect(r.errors).toEqual([]);
    const outing = await outingRow(s.outingId);
    expect(outing).toMatchObject({ status: "CONFIRMED", cleanup: "NONE" });

    const snapshot = (await db.query.settlementSnapshots.findFirst({ where: eq(settlementSnapshots.outingId, s.outingId) }))!;
    expect(snapshot).toMatchObject({ decision: "SETTLE", payerCount: 5, totalMinor: 10_000 });
    const captures = (await opsOf(s.outingId)).filter((o) => o.kind === "CAPTURE");
    expect(captures.map((c) => [c.status, c.amountMinor])).toEqual(Array.from({ length: 5 }, () => ["SUCCEEDED", 2_000]));
    const attempts = await attemptsOf(s.outingId);
    expect(attempts).toHaveLength(5);
    expect(attempts.every((a) => a.status === "CAPTURED" && a.capturedMinor === 2_000)).toBe(true);
    expect(attempts.some((a) => a.participantId === personaId(s, "Maya"))).toBe(false);

    const status = (await demoScenarioStatus(db, s.outingId))!;
    expect(status.headline).toBe("Confirmed: 5 shares collected, $100 in total (simulated).");
  });

  it("holdout: Noor never commits, so the deadline cancels and every hold is released", async () => {
    const db = getDb();
    const s = await createDemoScenario(db, { kind: "holdout" });
    await passDeadline(s.outingId);

    const r = await tick();
    expect(r.errors).toEqual([]);
    const outing = await outingRow(s.outingId);
    expect(outing).toMatchObject({ status: "CANCELLED", cleanup: "COMPLETE" });
    expect(outing.cancelReasons).toContain("REQUIRED_MISSING");

    const ops = await opsOf(s.outingId);
    expect(ops.filter((o) => o.kind === "CAPTURE")).toHaveLength(0);
    expect(ops.filter((o) => o.kind === "VOID").map((o) => o.status)).toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
    expect((await attemptsOf(s.outingId)).every((a) => a.status === "VOIDED" && a.capturedMinor === 0)).toBe(true);
    expect((await demoScenarioStatus(db, s.outingId))!.headline).toMatch(/^Cancelled at the deadline: no booking payment collected/);
  });

  it("capture-failure: never confirmed; compensates, refunds the completed captures, releases the rest, cleans up", async () => {
    const db = getDb();
    const s = await createDemoScenario(db, { kind: "capture-failure" });
    const nameOf = (participantId: string) => s.personas.find((p) => p.participantId === participantId)!.displayName;
    await passDeadline(s.outingId);

    // Pass 1: capture Alex, Ben, Freya; Jules is declined -> COMPENSATING -> refunds + voids -> CANCELLED.
    await tick();
    let outing = await outingRow(s.outingId);
    expect(outing.status).toBe("CANCELLED");
    expect(outing.cancelReasons).toContain("CAPTURE_FAILED");
    expect(outing.settledAt).toBeNull();
    // Ben's refund was applied by the simulator but its response was "lost": clean-up is still pending.
    expect(outing.cleanup).toBe("REFUND_PENDING");

    // SETTLING -> COMPENSATING (same transaction as the recorded capture failure) -> CANCELLED (a later one).
    const events = await auditOf(s.outingId);
    const at = (type: string) => events.filter((e) => e.type === type).map((e) => e.createdAt.getTime());
    expect(at("OUTING_CONFIRMED")).toEqual([]);
    expect(at("CAPTURE_FAILED")).toHaveLength(1);
    expect(at("OUTING_COMPENSATING")).toHaveLength(1);
    expect(at("CAPTURE_FAILED")[0]).toBeLessThanOrEqual(at("OUTING_COMPENSATING")[0]);
    expect(Math.max(...at("OUTING_CANCELLED"))).toBeGreaterThan(at("OUTING_COMPENSATING")[0]);

    let ops = await opsOf(s.outingId);
    const attemptOwner = new Map((await attemptsOf(s.outingId)).map((a) => [a.id, a.participantId]));
    const byKind = (kind: string) =>
      Object.fromEntries(ops.filter((o) => o.kind === kind).map((o) => [nameOf(attemptOwner.get(o.paymentAttemptId)!), o.status]));
    expect(byKind("CAPTURE")).toEqual({ Alex: "SUCCEEDED", Ben: "SUCCEEDED", Freya: "SUCCEEDED", Jules: "FAILED", Noor: "SKIPPED" });
    expect(ops.find((o) => o.kind === "CAPTURE" && o.status === "FAILED")!.providerStatus).toBe("INSTRUMENT_DECLINED");
    expect(byKind("REFUND")).toEqual({ Alex: "SUCCEEDED", Ben: "UNKNOWN", Freya: "SUCCEEDED" });
    expect(byKind("VOID")).toEqual({ Jules: "SUCCEEDED", Noor: "SUCCEEDED" });
    expect((await demoScenarioStatus(db, s.outingId))!.headline).toBe("Not confirmed: a payment failed. Completed payments are being refunded.");

    // Pass 2, once the retry backoff has elapsed: the engine reads the provider back and records the refund (no second refund).
    await db
      .update(paymentOperations)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(and(eq(paymentOperations.outingId, s.outingId), eq(paymentOperations.status, "UNKNOWN")));
    const r = await tick();
    expect(r.errors).toEqual([]);
    outing = await outingRow(s.outingId);
    expect(outing).toMatchObject({ status: "CANCELLED", cleanup: "COMPLETE" });

    ops = await opsOf(s.outingId);
    expect(ops.filter((o) => o.kind === "REFUND").every((o) => o.status === "SUCCEEDED" && o.amountMinor === 2_000)).toBe(true);
    const attempts = await attemptsOf(s.outingId);
    const statusOf = Object.fromEntries(attempts.map((a) => [nameOf(a.participantId), [a.status, a.capturedMinor, a.refundedMinor]]));
    expect(statusOf).toEqual({
      Alex: ["REFUNDED", 2_000, 2_000],
      Ben: ["REFUNDED", 2_000, 2_000],
      Freya: ["REFUNDED", 2_000, 2_000],
      Jules: ["VOIDED", 0, 0],
      Noor: ["VOIDED", 0, 0],
    });
    // Ben's capture was refunded exactly once at the (simulated) provider.
    const ben = attempts.find((a) => nameOf(a.participantId) === "Ben")!;
    const capture = (await readFixtureObject(db, ben.captureId!))!.data as { status: string; refundIds: string[]; refundedMinor: number };
    expect(capture).toMatchObject({ status: "REFUNDED", refundedMinor: 2_000 });
    expect(capture.refundIds).toHaveLength(1);

    const status = (await demoScenarioStatus(db, s.outingId))!;
    expect(status).toMatchObject({ capturedMinor: 6_000, refundedMinor: 6_000, cleanup: "COMPLETE" });
    expect(status.headline).toBe("Not confirmed: a payment failed. All $60 collected was refunded and every other hold released (simulated).");
  });

  it("a demo reset removes scenario outings and their simulator objects", async () => {
    const db = getDb();
    const s = await createDemoScenario(db, { kind: "capture-failure" });
    expect(await deleteFixtureOutings(db)).toBe(1);
    expect(await outingRow(s.outingId)).toBeUndefined();
    const left = await db.execute(sql`select count(*)::int as n from fixture_provider_objects`);
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });
});

describe("big-group: ten payers share the $100 room", () => {
  const NINE = ["Alex", "Ben", "Freya", "Jules", "Noor", "Maya", "Leo", "Ida", "Omar"];

  it("creates a valid COLLECTING outing with 9 authorized $20 holds and no sponsored guest", async () => {
    const db = getDb();
    const now = new Date();
    const s = await createDemoScenario(db, { kind: "big-group", now });
    expect(s.title).toBe(DEMO_SCENARIO_TITLES["big-group"]);
    expect(s.deadlineSeconds).toBe(120);
    expect(s.personas.map((p) => p.displayName)).toEqual([...NINE, "Kai"]);
    expect(s.personas.every((p) => p.note.length > 0 && p.payerType === "PAYER")).toBe(true);
    expect(s.personas[0].role).toBe("ORGANIZER");

    const outing = await outingRow(s.outingId);
    expect(outing).toMatchObject({ status: "COLLECTING", isFixture: true, minPayers: 5, frozenAt: null });
    const quote = (await db.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, outing.currentQuoteId!) }))!;
    const terms = quote.terms as CommitmentTerms;
    expect(quote).toMatchObject({ status: "ACTIVE", totalMinor: 10_000, capMinor: 2_000, pricingModel: "FIXED_TOTAL", minPayers: 5, capacity: 10 });
    expect(hashTerms(terms)).toBe(quote.termsHash);
    expect(terms.sponsoredParticipantIds).toEqual([]);
    expect(terms.requiredParticipantIds).toHaveLength(10);

    const attempts = await attemptsOf(s.outingId);
    expect(attempts).toHaveLength(9);
    expect(s.personas.filter((p) => attempts.some((a) => a.participantId === p.participantId)).map((p) => p.displayName)).toEqual(NINE);
    for (const a of attempts) {
      expect(a).toMatchObject({ provider: "FIXTURE", status: "AUTHORIZED", verified: true, late: false, authorizedMinor: 2_000, capturedMinor: 0 });
    }
    expect(await demoScenarioStatus(db, s.outingId)).toMatchObject({ kind: "big-group", status: "COLLECTING", payers: { total: 10, committed: 9 } });
  });

  it("after Kai commits and the deadline passes, the real engine captures 10 x $10 and releases the rest of each hold", async () => {
    const db = getDb();
    const s = await createDemoScenario(db, { kind: "big-group" });
    await commitAs(s, "Kai");
    await passDeadline(s.outingId);

    const r = await tick();
    expect(r.errors).toEqual([]);
    expect(await outingRow(s.outingId)).toMatchObject({ status: "CONFIRMED", cleanup: "NONE" });
    const snapshot = (await db.query.settlementSnapshots.findFirst({ where: eq(settlementSnapshots.outingId, s.outingId) }))!;
    expect(snapshot).toMatchObject({ decision: "SETTLE", payerCount: 10, totalMinor: 10_000 });

    const attempts = await attemptsOf(s.outingId);
    expect(attempts).toHaveLength(10);
    const captures = (await opsOf(s.outingId)).filter((o) => o.kind === "CAPTURE");
    expect(captures).toHaveLength(10);
    for (const c of captures) {
      expect([c.status, c.amountMinor]).toEqual(["SUCCEEDED", 1_000]);
      const a = attempts.find((x) => x.id === c.paymentAttemptId)!;
      expect(c.amountMinor).toBeLessThanOrEqual(a.authorizedMinor);
    }
    expect(captures.reduce((sum, c) => sum + c.amountMinor, 0)).toBe(10_000);
    for (const a of attempts) {
      expect(a).toMatchObject({ status: "CAPTURED", authorizedMinor: 2_000, capturedMinor: 1_000, refundedMinor: 0 });
      // Simulator final_capture semantics: one $10 capture closes the $20 authorization and releases the remaining $10.
      const auth = (await readFixtureObject(db, a.authorizationId!))!.data as { status: string; amountMinor: number; capturedMinor: number; releasedMinor: number };
      expect(auth).toMatchObject({ status: "CAPTURED", amountMinor: 2_000, capturedMinor: 1_000, releasedMinor: 1_000 });
      const cap = (await readFixtureObject(db, a.captureId!))!.data as { status: string; amountMinor: number; finalCapture: boolean };
      expect(cap).toMatchObject({ status: "COMPLETED", amountMinor: 1_000, finalCapture: true });
    }
    expect((await opsOf(s.outingId)).filter((o) => o.kind === "VOID" || o.kind === "REFUND")).toHaveLength(0);
    expect((await demoScenarioStatus(db, s.outingId))!.headline).toBe("Confirmed: 10 shares collected, $100 in total (simulated).");
  });
});

describe("endpoints", () => {
  it("POST /api/demo/scenario creates a scenario and validates input", async () => {
    const res = await scenarioRoute.POST(request("/api/demo/scenario", { body: { kind: "holdout", deadlineSeconds: 90 } }));
    expect(res.status).toBe(201);
    const s = await body<DemoScenario & { tickAvailable: boolean }>(res);
    expect(s).toMatchObject({ kind: "holdout", deadlineSeconds: 90, tickAvailable: true });
    expect(Date.parse(s.deadlineAt) - Date.parse(s.serverNow)).toBeLessThanOrEqual(90_000);

    const got = await scenarioRoute.GET(request(`/api/demo/scenario?outingId=${s.outingId}`));
    expect(got.status).toBe(200);
    expect(await body(got)).toMatchObject({ outingId: s.outingId, status: "COLLECTING", kind: "holdout" });

    for (const bad of [{ kind: "nope" }, { kind: "holdout", deadlineSeconds: 30 }, { kind: "holdout", deadlineSeconds: 601 }]) {
      expect((await scenarioRoute.POST(request("/api/demo/scenario", { body: bad }))).status).toBe(400);
    }
    expect((await scenarioRoute.GET(request(`/api/demo/scenario?outingId=${crypto.randomUUID()}`))).status).toBe(404);
  });

  it("POST /api/demo/tick runs one worker pass and reports the outing", async () => {
    const s = await createDemoScenario(getDb(), { kind: "holdout" });
    const early = await tickRoute.POST(request("/api/demo/tick", { body: { outingId: s.outingId } }));
    expect(early.status).toBe(200);
    expect(await body(early)).toMatchObject({ ok: true, mode: "DEMO_TICK", outing: { status: "COLLECTING" } });

    await passDeadline(s.outingId);
    const res = await tickRoute.POST(request("/api/demo/tick", { body: { outingId: s.outingId } }));
    expect(await body(res)).toMatchObject({ ok: true, outing: { status: "CANCELLED", cleanup: "COMPLETE" } });
  });

  it("every demo endpoint is 404 when demo mode is off", async () => {
    resetConfigForTests(testConfig({ DEMO_FIXTURES_ENABLED: "false" }));
    expect((await scenarioRoute.POST(request("/api/demo/scenario", { body: { kind: "settle-soon" } }))).status).toBe(404);
    expect((await scenarioRoute.GET(request(`/api/demo/scenario?outingId=${crypto.randomUUID()}`))).status).toBe(404);
    expect((await tickRoute.POST(request("/api/demo/tick", { body: {} }))).status).toBe(404);
    expect(await getDb().query.outings.findFirst()).toBeUndefined();
  });

  it("the tick button needs DEMO_ALLOW_PUBLIC_TICK in production", async () => {
    resetConfigForTests(testConfig({ NODE_ENV: "production" }));
    const res = await tickRoute.POST(request("/api/demo/tick", { body: {} }));
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ error: { code: "DEMO_TICK_DISABLED" } });

    process.env.DEMO_ALLOW_PUBLIC_TICK = "true";
    try {
      expect((await tickRoute.POST(request("/api/demo/tick", { body: {} }))).status).toBe(200);
    } finally {
      delete process.env.DEMO_ALLOW_PUBLIC_TICK;
    }

    expect(demoTickAllowed(testConfig(), {})).toBe(true);
    expect(demoTickAllowed(testConfig({ NODE_ENV: "production" }), {})).toBe(false);
    expect(demoTickAllowed(testConfig({ NODE_ENV: "production" }), { DEMO_ALLOW_PUBLIC_TICK: "true" })).toBe(true);
    expect(demoTickAllowed(testConfig({ NODE_ENV: "production", DEMO_FIXTURES_ENABLED: "false" }), { DEMO_ALLOW_PUBLIC_TICK: "true" })).toBe(false);
  });
});
