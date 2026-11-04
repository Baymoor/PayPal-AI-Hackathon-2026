/**
 * Audit follow-up regressions (edge cases the independent audit reported but did not fix).
 *
 * 1. operations.ts: a VOID refused with PREVIOUSLY_CAPTURED must not stay a
 *    terminal FAILED op (NEEDS_ATTENTION forever). The void is superseded by
 *    the refund of that capture, and clean-up reaches COMPLETE only once the
 *    provider confirmed the refund.
 * 2. services/payments.ts: an authorization that the provider shows as already
 *    CAPTURED on the mismatch / stray path must have its captured money
 *    planned for REFUND (a VOID would be refused, and "no void needed" left
 *    the money captured for a booking that is not confirmed).
 * 3. operations.ts: a first capture answered with a definitive
 *    AUTHORIZATION_ALREADY_CAPTURED / PREVIOUSLY_CAPTURED re-reads the
 *    authorization before declaring failure: a COMPLETED final capture of
 *    exactly the planned amount is this operation's idempotent outcome; any
 *    other capture fails closed (compensation) and is refunded.
 * 4. return / cancel routes: no participant session for the attempt's outing
 *    -> neutral redirect that never reveals the outing id.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { testDatabaseUrl, useTestDb } from "../helpers/db";
import { auditEvents, paymentAttempts, paymentOperations } from "@/lib/db/schema";
import { closeDb } from "@/lib/db/client";
import { resetConfigForTests } from "@/lib/env";
import { resetPaymentProviders, setPaymentProviderOverride } from "@/lib/payments";
import { reconcilePaymentAttempt, startPayment } from "@/lib/services/payments";
import { runDeadlineSettlement } from "@/lib/settlement/deadline";
import { processDueOperations } from "@/lib/settlement/operations";
import { GET as returnRoute } from "@/app/api/payments/paypal/return/route";
import { GET as cancelRoute } from "@/app/api/payments/paypal/cancel/route";
import { FakeProvider } from "../settlement/fake-provider";
import { buildOuting, loadAttempts, loadOps, loadOuting, payers, resolverFor } from "../settlement/builders";
import { seedCollectingOuting, sessionCookie, useDemoConfig, type SeededOuting } from "../payments/helpers";

const getDb = useTestDb();
const W = "followup-worker";
const noBackoff = () => 0;
const ORIGIN = "http://localhost:3301";
const T0 = new Date("2026-11-04T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

const attemptRow = (id: string) => getDb().query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, id) });
const opsFor = (id: string) => getDb().select().from(paymentOperations).where(eq(paymentOperations.paymentAttemptId, id));

async function oobCapture(fake: FakeProvider, authorizationId: string, amountMinor: number, requestId: string): Promise<string> {
  const r = await fake.captureAuthorization({ authorizationId, amountMinor, currency: "USD", requestId });
  if (!r.ok) throw new Error(`out-of-band capture failed: ${r.code}`);
  return r.capture.captureId;
}

async function settled(fake: FakeProvider, n = 5) {
  const db = getDb();
  const built = await buildOuting(db, { people: payers(n), provider: fake });
  const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
  expect(r.outcome).toBe("SETTLE");
  return built;
}

const run = (fake: FakeProvider, opts: { outingId?: string; backoffMs?: () => number } = {}) =>
  processDueOperations(getDb(), resolverFor(fake), { now: new Date(), workerId: W, backoffMs: opts.backoffMs ?? noBackoff, ...(opts.outingId ? { outingId: opts.outingId } : {}) });

/* -------------------------------------------------------------------------- */
/* 1. VOID refused with PREVIOUSLY_CAPTURED                                   */
/* -------------------------------------------------------------------------- */

describe("a void refused with PREVIOUSLY_CAPTURED is superseded by the refund of that capture", () => {
  it("the VOID op does not stay FAILED; clean-up is REFUND_PENDING until the provider confirms the refund, then COMPLETE", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    // Required holdout -> CANCEL at the deadline; both holds are planned for VOID.
    const built = await buildOuting(db, {
      people: [...payers(2), { name: "Holdout", attendance: "PENDING", consent: false, auth: false }],
      minPayers: 2,
      provider: fake,
    });
    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("CANCEL");
    const [p1, p2] = built.people;

    // Between planning and sending the void, payer 1's hold was captured out of band (full cap, final).
    const captureId = await oobCapture(fake, p1!.authorizationId!, 5000, "out-of-band-capture");
    fake.refundPending(captureId);

    // A real backoff: a PENDING refund is polled on later ticks, not re-polled to exhaustion within one run.
    const poll = () => run(fake, { backoffMs: () => 60_000 });
    expect((await poll()).errors).toEqual([]);

    let ops = await loadOps(db, built.outingId);
    const voidOp = ops.find((o) => o.kind === "VOID" && o.paymentAttemptId === p1!.attemptId)!;
    // Superseded, not a terminal failure: the hold no longer exists as a hold, the money is handled by the refund.
    expect(voidOp.status).toBe("SUCCEEDED");
    expect(voidOp.providerStatus).toBe("PREVIOUSLY_CAPTURED");
    expect(voidOp.lastError).toMatch(/captured/i);
    expect(voidOp.lastError).toMatch(/refund/i);
    expect(fake.voidsPerformed.get(p1!.authorizationId!) ?? 0).toBe(0);

    const refundOp = ops.find((o) => o.kind === "REFUND" && o.paymentAttemptId === p1!.attemptId)!;
    expect(refundOp.amountMinor).toBe(5000);
    expect(refundOp.status).toBe("UNKNOWN"); // refund requested, PENDING at the provider
    let a1 = (await attemptRow(p1!.attemptId!))!;
    expect(a1.captureId).toBe(captureId);
    expect(a1.capturedMinor).toBe(5000);
    expect(a1.status).toBe("REFUND_PENDING");
    expect((await attemptRow(p2!.attemptId!))!.status).toBe("VOIDED");

    let outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CANCELLED");
    expect(outing.cleanup).toBe("REFUND_PENDING");

    // The provider completes the refund; the next poll records it and the clean-up is COMPLETE, not NEEDS_ATTENTION.
    fake.completeRefund(a1.refundId!);
    await db.update(paymentOperations).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(paymentOperations.id, refundOp.id));
    expect((await poll()).errors).toEqual([]);

    ops = await loadOps(db, built.outingId);
    expect(ops.find((o) => o.id === refundOp.id)!.status).toBe("SUCCEEDED");
    expect(ops.find((o) => o.id === voidOp.id)!.status).toBe("SUCCEEDED");
    a1 = (await attemptRow(p1!.attemptId!))!;
    expect(a1.status).toBe("REFUNDED");
    expect(a1.refundedMinor).toBe(5000);
    expect(fake.refundsPerformed.get(captureId)).toBe(1);
    outing = await loadOuting(db, built.outingId);
    expect(outing.cleanup).toBe("COMPLETE");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. First capture answered with ALREADY_CAPTURED                            */
/* -------------------------------------------------------------------------- */

describe("a definitive ALREADY_CAPTURED answer to a capture is checked against provider state", () => {
  it("a COMPLETED final capture of exactly the planned amount is this operation's outcome: SUCCEEDED, booking CONFIRMED", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await settled(fake);
    const p1 = built.people[0]!;
    // Our capture reached the provider but the idempotent replay is gone (key expired / different request id):
    // the provider holds a COMPLETED final capture of exactly the allocated $20 and refuses a second one.
    const captureId = await oobCapture(fake, p1.authorizationId!, 2000, "replay-key-lost");

    expect((await run(fake)).errors).toEqual([]);

    const outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CONFIRMED");
    expect(outing.cleanup).toBe("NONE");
    const ops = await loadOps(db, built.outingId);
    const first = ops.find((o) => o.kind === "CAPTURE" && o.sequence === 1)!;
    expect(first.status).toBe("SUCCEEDED");
    expect(first.providerRef).toBe(captureId);
    expect(ops.filter((o) => o.kind === "CAPTURE").every((o) => o.status === "SUCCEEDED")).toBe(true);
    expect(ops.some((o) => o.kind !== "CAPTURE")).toBe(false);
    const a1 = (await attemptRow(p1.attemptId!))!;
    expect(a1.status).toBe("CAPTURED");
    expect(a1.captureId).toBe(captureId);
    expect(a1.capturedMinor).toBe(2000);
    // Exactly one capture per authorization ever happened.
    expect(fake.captureCount(p1.authorizationId!)).toBe(1);
    expect(built.people.every((p) => fake.captureCount(p.authorizationId!) === 1)).toBe(true);
  });

  it("a capture of a different amount behind ALREADY_CAPTURED is not ours: fail closed, compensate, and refund it", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await settled(fake);
    const [p1, ...rest] = built.people;
    const captureId = await oobCapture(fake, p1!.authorizationId!, 1500, "someone-else");

    expect((await run(fake)).errors).toEqual([]);

    const outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CANCELLED");
    expect(outing.settledAt).toBeNull();
    expect(outing.cancelReasons).toContain("CAPTURE_FAILED");
    const ops = await loadOps(db, built.outingId);
    const first = ops.find((o) => o.kind === "CAPTURE" && o.sequence === 1)!;
    expect(first.status).toBe("FAILED");
    expect(ops.filter((o) => o.kind === "CAPTURE" && o.sequence > 1).every((o) => o.status === "SKIPPED")).toBe(true);
    expect(rest.every((p) => fake.captureCount(p.authorizationId!) === 0)).toBe(true);

    // The foreign capture is refunded (the void of that hold was refused as PREVIOUSLY_CAPTURED), the other holds are voided.
    const a1 = (await attemptRow(p1!.attemptId!))!;
    expect(a1.captureId).toBe(captureId);
    expect(a1.capturedMinor).toBe(1500);
    expect(a1.refundedMinor).toBe(1500);
    expect(a1.status).toBe("REFUNDED");
    expect(fake.refundsPerformed.get(captureId)).toBe(1);
    const others = (await loadAttempts(db, built.outingId)).filter((a) => a.id !== p1!.attemptId);
    expect(others.every((a) => a.status === "VOIDED")).toBe(true);
    expect(ops.filter((o) => o.kind !== "CAPTURE").every((o) => o.status === "SUCCEEDED")).toBe(true);
    expect(outing.cleanup).toBe("COMPLETE");
  });
});

/* -------------------------------------------------------------------------- */
/* 2 + 4. Payments service and redirect routes (fake provider as FIXTURE)      */
/* -------------------------------------------------------------------------- */

describe("payments service and approval routes", () => {
  let fake: FakeProvider;
  let s: SeededOuting;

  beforeAll(() => {
    process.env.DATABASE_URL = testDatabaseUrl(); // route handlers use the shared pool
  });

  beforeEach(async () => {
    useDemoConfig();
    resetPaymentProviders();
    fake = new FakeProvider("FIXTURE");
    setPaymentProviderOverride("FIXTURE", fake);
    s = await seedCollectingOuting(getDb(), { now: T0, deadlineInMs: HOUR });
  });

  afterAll(async () => {
    resetPaymentProviders();
    resetConfigForTests();
    await closeDb();
  });

  function req(path: string, cookie?: string) {
    const headers: Record<string, string> = { host: "localhost:3301" };
    if (cookie) headers.cookie = cookie;
    return new Request(`${ORIGIN}${path}`, { method: "GET", headers });
  }

  /** Start a payment, then make the provider show an authorization for its order that was already CAPTURED out of band. */
  async function startWithCapturedAuthorization(participantId: string, status: "UNKNOWN" | "FAILED") {
    const db = getDb();
    const started = await startPayment(db, { outingId: s.outing.id, participantId, now: T0 });
    const before = (await attemptRow(started.paymentAttemptId))!;
    fake.seedAuthorization({ authorizationId: `auth-oob-${status}`, orderId: before.providerOrderId!, amountMinor: 2000, createTime: at(60_000), customId: before.id });
    const captureId = await oobCapture(fake, `auth-oob-${status}`, 2000, `oob-${status}`);
    await db
      .update(paymentAttempts)
      .set({ status, lastError: status === "UNKNOWN" ? "AUTHORIZE_IN_FLIGHT" : "LATE_APPROVAL: no hold was placed", late: status === "FAILED" })
      .where(eq(paymentAttempts.id, before.id));
    return { attemptId: before.id, captureId };
  }

  it("mismatch path: an authorization already CAPTURED at the provider gets a REFUND planned (never left captured, never voided)", async () => {
    const db = getDb();
    const { attemptId, captureId } = await startWithCapturedAuthorization(s.payers[0].id, "UNKNOWN");

    const outcome = await reconcilePaymentAttempt(db, { paymentAttemptId: attemptId, now: at(120_000) });
    expect(outcome).toBe("FAILED");

    const a = (await attemptRow(attemptId))!;
    expect(a.authorizationId).toBe("auth-oob-UNKNOWN");
    expect(a.lastError).toMatch(/AUTHORIZATION_MISMATCH/);
    expect(a.captureId).toBe(captureId);
    expect(a.capturedMinor).toBe(2000);
    expect(a.status).toBe("REFUND_PENDING");
    const ops = await opsFor(attemptId);
    expect(ops).toMatchObject([{ kind: "REFUND", amountMinor: 2000 }]);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.outingId, s.outing.id), eq(auditEvents.type, "PAYMENT_AUTHORIZATION_MISMATCH")));
    expect(audit?.data).toMatchObject({ mismatches: ["STATUS_CAPTURED"], voidPlanned: false, refundPlanned: true, capturedMinor: 2000 });

    // The worker refunds the captured money.
    expect((await run(fake, { outingId: s.outing.id })).errors).toEqual([]);
    const after = (await attemptRow(attemptId))!;
    expect(after.status).toBe("REFUNDED");
    expect(after.refundedMinor).toBe(2000);
    expect(fake.refundsPerformed.get(captureId)).toBe(1);
    expect(fake.calls.void).toBe(0);
  });

  it("stray path: a closed attempt whose order carries a CAPTURED authorization gets a REFUND planned", async () => {
    const db = getDb();
    const { attemptId, captureId } = await startWithCapturedAuthorization(s.payers[1].id, "FAILED");

    const outcome = await reconcilePaymentAttempt(db, { paymentAttemptId: attemptId, now: at(120_000) });
    expect(outcome).not.toBe("AUTHORIZED");

    const a = (await attemptRow(attemptId))!;
    expect(a.authorizationId).toBe("auth-oob-FAILED");
    expect(a.captureId).toBe(captureId);
    expect(a.capturedMinor).toBe(2000);
    expect(a.status).toBe("REFUND_PENDING");
    expect(await opsFor(attemptId)).toMatchObject([{ kind: "REFUND", amountMinor: 2000 }]);
  });

  it("return / cancel routes never reveal the outing id without a participant session for that outing", async () => {
    const db = getDb();
    const started = await startPayment(db, { outingId: s.outing.id, participantId: s.payers[0].id, now: T0 });
    const a = (await attemptRow(started.paymentAttemptId))!;
    const returnPath = `/api/payments/paypal/return?attempt=${a.id}&token=${a.providerOrderId}&PayerID=XYZ`;
    const cancelPath = `/api/payments/paypal/cancel?attempt=${a.id}&token=${a.providerOrderId}`;
    const NEUTRAL = "/?payment=signin";
    const otherOuting = sessionCookie({ "00000000-0000-4000-8000-000000000001": s.payers[0].id });

    for (const cookie of [undefined, otherOuting]) {
      const ret = await returnRoute(req(returnPath, cookie));
      expect(ret.status).toBe(303);
      expect(ret.headers.get("location")).toBe(NEUTRAL);
      expect(ret.headers.get("location")).not.toContain(s.outing.id);
      const can = await cancelRoute(req(cancelPath, cookie));
      expect(can.status).toBe(303);
      expect(can.headers.get("location")).toBe(NEUTRAL);
    }
    // Nothing happened to the attempt: no authorization, not abandoned.
    const untouched = (await attemptRow(a.id))!;
    expect(untouched.status).toBe("APPROVAL_PENDING");
    expect(untouched.authorizationId).toBeNull();
    expect(fake.calls.authorize).toBe(0);

    // With the owner's session the flow is unchanged (control): cancel lands on the outing.
    const owner = await cancelRoute(req(cancelPath, sessionCookie({ [s.outing.id]: s.payers[0].id })));
    expect(owner.headers.get("location")).toBe(`/o/${s.outing.id}?payment=cancelled`);
    expect((await attemptRow(a.id))!.status).toBe("FAILED");
  });
});
