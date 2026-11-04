import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { useTestDb } from "../helpers/db";
import { paymentAttempts, paymentOperations } from "@/lib/db/schema";
import { planPaymentOperation } from "@/lib/payments/plan";
import { enqueueJob, settleJobKey } from "@/lib/jobs/queue";
import { runWorkerTick } from "@/lib/jobs/runner";
import { runDeadlineSettlement } from "@/lib/settlement/deadline";
import { processDueOperations, recomputeCleanup } from "@/lib/settlement/operations";
import { FakeProvider } from "./fake-provider";
import { buildOuting, loadAttempts, loadOps, loadOuting, payers, resolverFor } from "./builders";

// eslint-disable-next-line react-hooks/rules-of-hooks -- vitest lifecycle helper, not a React hook
const getDb = useTestDb();
const W = "ops-worker";
const noBackoff = () => 0;

async function settled(db: ReturnType<typeof getDb>, fake: FakeProvider, n = 5) {
  const built = await buildOuting(db, { people: payers(n), provider: fake });
  const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
  expect(r.outcome).toBe("SETTLE");
  return built;
}

describe("capture safety", () => {
  it("refuses to plan a capture above the authorized amount, and the DB refuses to record one", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), provider: fake });
    const attemptId = built.people[0]!.attemptId!;
    await expect(
      db.transaction((tx) => planPaymentOperation(tx, { outingId: built.outingId, paymentAttemptId: attemptId, kind: "CAPTURE", amountMinor: 2001, currency: "USD" })),
    ).rejects.toThrow(/above authorized/);
    let thrown: unknown = null;
    try {
      await db.update(paymentAttempts).set({ capturedMinor: 2001 }).where(eq(paymentAttempts.id, attemptId));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const cause = (thrown as Error & { cause?: Error }).cause;
    expect(`${(thrown as Error).message} ${cause?.message ?? ""}`).toMatch(/payment_capture_le_authorized/);
    const row = await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attemptId) });
    expect(row?.capturedMinor).toBe(0);
  });

  it("refuses to send a capture whose amount was tampered above the frozen allocation / cap", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await settled(db, fake);
    const ops = await loadOps(db, built.outingId);
    const first = ops.find((o) => o.sequence === 1)!;
    // Simulate corruption: amount raised after planning (still <= authorized so the DB allows the row).
    await db.update(paymentOperations).set({ amountMinor: 2000 + 0 }).where(eq(paymentOperations.id, first.id));
    await db.execute(sql`update payment_attempts set authorized_minor = 2500 where id = ${first.paymentAttemptId}`);
    await db.update(paymentOperations).set({ amountMinor: 2500 }).where(eq(paymentOperations.id, first.id));

    const r = await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W, backoffMs: noBackoff });
    expect(r.errors).toEqual([]);
    expect(fake.captureCount(built.people[0]!.authorizationId!)).toBe(0);
    const after = (await loadOps(db, built.outingId)).find((o) => o.id === first.id)!;
    expect(after.status).toBe("FAILED");
    expect(after.lastError).toMatch(/CAPTURE_REFUSED/);
    const outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CANCELLED");
    expect(outing.cancelReasons).toContain("CAPTURE_FAILED");
    expect(fake.calls.capture).toBe(0);
  });
});

describe("exactly-once sending under concurrency", () => {
  it("two concurrent worker ticks send each capture exactly once", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    fake.latencyMs = 25;
    const built = await buildOuting(db, { people: payers(6), provider: fake });
    await enqueueJob(db, { kind: "SETTLE_DEADLINE", outingId: built.outingId, runAt: new Date(Date.now() - 1000), dedupeKey: settleJobKey(built.outingId, built.quoteId), payload: { quoteId: built.quoteId } });
    // A duplicate enqueue is absorbed by the dedupe key.
    await enqueueJob(db, { kind: "SETTLE_DEADLINE", outingId: built.outingId, runAt: new Date(Date.now() - 1000), dedupeKey: settleJobKey(built.outingId, built.quoteId), payload: { quoteId: built.quoteId } });

    const [a, b, c] = await Promise.all([
      runWorkerTick(db, resolverFor(fake), { workerId: "worker-a" }),
      runWorkerTick(db, resolverFor(fake), { workerId: "worker-b" }),
      runWorkerTick(db, resolverFor(fake), { workerId: "worker-c" }),
    ]);
    expect([...a.errors, ...b.errors, ...c.errors]).toEqual([]);
    // One more tick to drain anything a losing worker skipped.
    await runWorkerTick(db, resolverFor(fake), { workerId: "worker-d" });

    expect((await loadOuting(db, built.outingId)).status).toBe("CONFIRMED");
    for (const p of built.people) expect(fake.captureCount(p.authorizationId!)).toBe(1);
    expect(fake.calls.capture).toBe(6);
    const ops = await loadOps(db, built.outingId);
    expect(ops.every((o) => o.status === "SUCCEEDED" && o.attempts === 1)).toBe(true);
  });

  it("concurrent processDueOperations calls on the same outing never double-send", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    fake.latencyMs = 20;
    const built = await settled(db, fake, 5);
    const runs = await Promise.all(
      ["p", "q", "r", "s"].map((id) => processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: id, outingId: built.outingId, backoffMs: noBackoff })),
    );
    expect(runs.flatMap((r) => r.errors)).toEqual([]);
    expect(runs.reduce((acc, r) => acc + r.operationsRun, 0)).toBe(5);
    for (const p of built.people) expect(fake.captureCount(p.authorizationId!)).toBe(1);
    expect((await loadOuting(db, built.outingId)).status).toBe("CONFIRMED");
  });
});

describe("UNKNOWN outcomes are reconciled before any retry", () => {
  it("timeout AFTER a successful capture → UNKNOWN → reconciled from provider state → no second capture", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await settled(db, fake);
    const victim = built.people[1]!;
    fake.timeoutAfter("capture", victim.authorizationId!);

    // Large backoff: the op must stay UNKNOWN until the next run.
    const first = await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W, backoffMs: () => 60_000 });
    expect(first.errors).toEqual([]);
    let ops = await loadOps(db, built.outingId);
    const op2 = ops.find((o) => o.sequence === 2)!;
    expect(op2.status).toBe("UNKNOWN");
    expect(ops.find((o) => o.sequence === 1)!.status).toBe("SUCCEEDED");
    // Capture 3 must wait: strictly sequential.
    expect(ops.find((o) => o.sequence === 3)!.status).toBe("PENDING");
    expect((await loadOuting(db, built.outingId)).status).toBe("SETTLING");

    // Make it due again and reconcile.
    await db.update(paymentOperations).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(paymentOperations.id, op2.id));
    const second = await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W, backoffMs: noBackoff });
    expect(second.errors).toEqual([]);

    ops = await loadOps(db, built.outingId);
    expect(ops.every((o) => o.status === "SUCCEEDED")).toBe(true);
    expect(ops.find((o) => o.sequence === 2)!.lastError).toMatch(/reconciled/);
    expect(fake.captureCount(victim.authorizationId!)).toBe(1);
    expect(fake.calls.capture).toBe(5);
    expect((await loadOuting(db, built.outingId)).status).toBe("CONFIRMED");
  });

  it("timeout BEFORE the provider acted → reconciled as not attempted → re-sent with the same requestId", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await settled(db, fake);
    const victim = built.people[2]!;
    fake.timeoutBefore("capture", victim.authorizationId!);

    const r = await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W, backoffMs: noBackoff });
    expect(r.errors).toEqual([]);
    expect(fake.captureCount(victim.authorizationId!)).toBe(1);
    expect(fake.calls.capture).toBe(6); // one extra attempt, same idempotency key
    const op3 = (await loadOps(db, built.outingId)).find((o) => o.sequence === 3)!;
    expect(op3.status).toBe("SUCCEEDED");
    expect(op3.attempts).toBe(2);
    expect((await loadOuting(db, built.outingId)).status).toBe("CONFIRMED");
  });

  it("a stale IN_FLIGHT operation (crashed worker) is treated as UNKNOWN and reconciled", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await settled(db, fake);
    const first = (await loadOps(db, built.outingId)).find((o) => o.sequence === 1)!;
    // Pretend a worker claimed and sent it, then died 10 minutes ago.
    await fake.captureAuthorization({ authorizationId: built.people[0]!.authorizationId!, amountMinor: 2000, currency: "USD", requestId: first.requestId });
    await db.execute(sql`update payment_operations set status = 'IN_FLIGHT', attempts = 1, updated_at = now() - interval '10 minutes' where id = ${first.id}`);

    const r = await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W, backoffMs: noBackoff, leaseMs: 60_000 });
    expect(r.errors).toEqual([]);
    expect(fake.captureCount(built.people[0]!.authorizationId!)).toBe(1);
    expect((await loadOuting(db, built.outingId)).status).toBe("CONFIRMED");
  });
});

describe("partial group capture failure → compensation", () => {
  it("stops, voids the rest, refunds completed captures, never confirms; refund PENDING is polled to COMPLETE", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await settled(db, fake);
    const [p1, p2, p3, p4, p5] = built.people;
    fake.declineCapture(p3!.authorizationId!, "INSTRUMENT_DECLINED");

    const r = await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W, backoffMs: noBackoff });
    expect(r.errors).toEqual([]);

    const outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CANCELLED");
    expect(outing.settledAt).toBeNull();
    expect(outing.cancelReasons).toEqual(["CAPTURE_FAILED"]);
    expect(outing.cleanup).toBe("COMPLETE");

    const ops = await loadOps(db, built.outingId);
    const capture = (seq: number) => ops.find((o) => o.kind === "CAPTURE" && o.sequence === seq)!;
    expect([1, 2].map((s) => capture(s).status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    expect(capture(3).status).toBe("FAILED");
    expect(capture(3).lastError).toMatch(/INSTRUMENT_DECLINED/);
    expect([4, 5].map((s) => capture(s).status)).toEqual(["SKIPPED", "SKIPPED"]);
    expect(fake.captureCount(p4!.authorizationId!)).toBe(0);
    expect(fake.captureCount(p5!.authorizationId!)).toBe(0);
    expect(fake.calls.capture).toBe(3);

    const refunds = ops.filter((o) => o.kind === "REFUND");
    expect(refunds.map((o) => o.paymentAttemptId).sort()).toEqual([p1!.attemptId, p2!.attemptId].sort());
    expect(refunds.every((o) => o.status === "SUCCEEDED" && o.amountMinor === 2000)).toBe(true);
    const voids = ops.filter((o) => o.kind === "VOID");
    expect(voids.map((o) => o.paymentAttemptId).sort()).toEqual([p3!.attemptId, p4!.attemptId, p5!.attemptId].sort());
    expect(voids.every((o) => o.status === "SUCCEEDED")).toBe(true);

    const attempts = await loadAttempts(db, built.outingId);
    const byId = new Map(attempts.map((a) => [a.id, a]));
    expect(byId.get(p1!.attemptId!)!.status).toBe("REFUNDED");
    expect(byId.get(p1!.attemptId!)!.refundedMinor).toBe(2000);
    expect(byId.get(p2!.attemptId!)!.status).toBe("REFUNDED");
    expect(byId.get(p3!.attemptId!)!.status).toBe("VOIDED");
    expect(byId.get(p4!.attemptId!)!.status).toBe("VOIDED");
    expect(byId.get(p5!.attemptId!)!.status).toBe("VOIDED");
    // Nobody paid more than their allocation; the failed share was not redistributed.
    expect(attempts.every((a) => a.capturedMinor <= 2000)).toBe(true);
  });

  it("a PENDING refund stays visible as REFUND_PENDING and is polled until the provider completes it", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await settled(db, fake);
    const [p1, , p3] = built.people;
    fake.declineCapture(p3!.authorizationId!);

    // Capture p1 first so we know its capture id, then make its refund come back PENDING.
    const pre = await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W, outingId: "00000000-0000-0000-0000-000000000000" });
    expect(pre.operationsRun).toBe(0);
    const run = async () => {
      // Arm the PENDING refund as soon as p1's capture exists.
      const r = await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W, backoffMs: () => 60_000 });
      expect(r.errors).toEqual([]);
    };
    // First pass captures p1 and p2, fails p3; refunds are planned and sent in the same run.
    // To get a PENDING refund we arm the capture before refunds are sent: do it by intercepting after capture 1.
    fake.refundPending("cap-0001"); // first capture id issued by the fake
    await run();

    let outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CANCELLED");
    expect(outing.cleanup).toBe("REFUND_PENDING");
    let a1 = (await loadAttempts(db, built.outingId)).find((a) => a.id === p1!.attemptId)!;
    expect(a1.status).toBe("REFUND_PENDING");
    expect(a1.refundId).not.toBeNull();
    const refundOp = (await loadOps(db, built.outingId)).find((o) => o.kind === "REFUND" && o.paymentAttemptId === p1!.attemptId)!;
    expect(refundOp.status).toBe("UNKNOWN");
    expect(refundOp.providerRef).toBe(a1.refundId);
    expect(refundOp.providerStatus).toBe("PENDING");

    // Still pending on the next poll.
    await db.update(paymentOperations).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(paymentOperations.id, refundOp.id));
    await run();
    expect((await loadOuting(db, built.outingId)).cleanup).toBe("REFUND_PENDING");
    expect(fake.refundsPerformed.get("cap-0001")).toBe(1);

    // Provider completes it; the next poll records it.
    fake.completeRefund(a1.refundId!);
    await db.update(paymentOperations).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(paymentOperations.id, refundOp.id));
    await run();
    outing = await loadOuting(db, built.outingId);
    expect(outing.cleanup).toBe("COMPLETE");
    a1 = (await loadAttempts(db, built.outingId)).find((a) => a.id === p1!.attemptId)!;
    expect(a1.status).toBe("REFUNDED");
    expect(fake.refundsPerformed.get("cap-0001")).toBe(1);
    expect(fake.calls.getRefund).toBeGreaterThanOrEqual(2);
  });

  it("a capture that fails with AUTHORIZATION_EXPIRED still gets its void (reported as already released)", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await settled(db, fake, 5);
    fake.expireAuthorization(built.people[1]!.authorizationId!);
    const r = await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W, backoffMs: noBackoff });
    expect(r.errors).toEqual([]);
    const outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CANCELLED");
    expect(outing.cleanup).toBe("COMPLETE");
    const ops = await loadOps(db, built.outingId);
    const voidOp = ops.find((o) => o.kind === "VOID" && o.paymentAttemptId === built.people[1]!.attemptId)!;
    expect(voidOp.status).toBe("SUCCEEDED");
    expect(voidOp.lastError).toMatch(/expired/);
    const a2 = (await loadAttempts(db, built.outingId)).find((a) => a.id === built.people[1]!.attemptId)!;
    expect(a2.status).toBe("VOIDED");
    expect(fake.calls.capture).toBe(2); // p1 succeeded, p2 failed definitively, nothing else sent
  });
});

describe("retries and attention", () => {
  it("exhausted retries leave the op FAILED/UNKNOWN and the outing NEEDS_ATTENTION; a manual re-queue recovers", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { provider: fake, people: [...payers(3), { name: "Holdout", attendance: "PENDING", consent: false, auth: false }] });
    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("CANCEL");
    const stuck = built.people[0]!;
    fake.alwaysTimeout("void", stuck.authorizationId!);
    await db.execute(sql`update payment_operations set max_attempts = 3 where payment_attempt_id = ${stuck.attemptId}`);

    const run = await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W, backoffMs: noBackoff });
    expect(run.errors).toEqual([]);
    let outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CANCELLED");
    expect(outing.cleanup).toBe("NEEDS_ATTENTION");
    let op = (await loadOps(db, built.outingId)).find((o) => o.paymentAttemptId === stuck.attemptId)!;
    expect(op.status).toBe("UNKNOWN");
    expect(op.attempts).toBe(3);
    // The other two voids went through.
    expect((await loadAttempts(db, built.outingId)).filter((a) => a.status === "VOIDED")).toHaveLength(2);

    // Provider recovers; merchant re-queues the SAME operation (same request id).
    fake.alwaysTimeout("void", stuck.authorizationId!, false);
    await db.update(paymentOperations).set({ status: "PENDING", attempts: 0, nextAttemptAt: new Date() }).where(eq(paymentOperations.id, op.id));
    await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W, backoffMs: noBackoff });
    op = (await loadOps(db, built.outingId)).find((o) => o.id === op.id)!;
    expect(op.status).toBe("SUCCEEDED");
    outing = await loadOuting(db, built.outingId);
    expect(outing.cleanup).toBe("COMPLETE");
    expect(fake.voidsPerformed.get(stuck.authorizationId!)).toBe(1);
  });

  it("recomputeCleanup is derived purely from operations", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await settled(db, fake);
    expect(await recomputeCleanup(db, built.outingId)).toBe("NONE");
    await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W });
    expect(await recomputeCleanup(db, built.outingId)).toBe("NONE");
  });
});

describe("holds that appear after the roster is frozen", () => {
  it("an authorization recorded after the snapshot (not in the allocations) is voided by the sweep", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { provider: fake, people: [...payers(5), { name: "Slow Sam", required: false, auth: false }] });
    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("SETTLE");

    // The payments service records Sam's authorization after the freeze (race lost).
    const sam = built.people[5]!;
    const samAuth = fake.seedAuthorization({ authorizationId: "auth-sam", amountMinor: 2000, createTime: new Date(), customId: undefined });
    const [attempt] = await db
      .insert(paymentAttempts)
      .values({
        outingId: built.outingId,
        participantId: sam.id,
        consentId: sam.consentId!,
        quoteId: built.quoteId,
        provider: "PAYPAL",
        status: "AUTHORIZED",
        currency: "USD",
        requestedMinor: 2000,
        authorizedMinor: 2000,
        providerOrderId: samAuth.orderId,
        authorizationId: samAuth.authorizationId,
        authorizedAt: samAuth.createTime,
        authorizationExpiresAt: samAuth.expirationTime,
        verified: true,
        verifiedAt: new Date(),
        late: true,
      })
      .returning();

    const run = await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W });
    expect(run.errors).toEqual([]);
    const samAttempt = (await loadAttempts(db, built.outingId)).find((a) => a.id === attempt!.id)!;
    expect(samAttempt.status).toBe("VOIDED");
    expect(fake.voidsPerformed.get("auth-sam")).toBe(1);
    expect(fake.captureCount("auth-sam")).toBe(0);
    const outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CONFIRMED");
    expect(outing.cleanup).toBe("COMPLETE");
    expect(fake.calls.capture).toBe(5);
  });

  it("an authorize call that timed out is reconciled by RECONCILE_PAYMENT; a late hold is voided, never admitted", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const deadlineAt = new Date(Date.now() - 60_000);
    const built = await buildOuting(db, {
      provider: fake,
      deadlineAt,
      people: [...payers(5), { name: "Timeout Tina", required: false, auth: { orderOnly: true, status: "UNKNOWN" } }],
    });
    const tina = built.people[5]!;
    // The provider did authorize (after the deadline), but our authorize call timed out.
    fake.seedAuthorization({ authorizationId: "auth-tina", orderId: tina.orderId!, amountMinor: 2000, createTime: new Date(deadlineAt.getTime() + 30_000), customId: tina.attemptId });

    await enqueueJob(db, { kind: "RECONCILE_PAYMENT", outingId: built.outingId, runAt: new Date(), dedupeKey: `reconcile:${tina.attemptId}`, payload: { paymentAttemptId: tina.attemptId } });
    const tick = await runWorkerTick(db, resolverFor(fake), { workerId: W });
    expect(tick.errors).toEqual([]);

    const attempts = await loadAttempts(db, built.outingId);
    const t = attempts.find((a) => a.id === tina.attemptId)!;
    expect(t.authorizationId).toBe("auth-tina");
    expect(t.late).toBe(true);
    expect(t.status).toBe("VOIDED");
    expect(fake.captureCount("auth-tina")).toBe(0);
    expect((await loadOuting(db, built.outingId)).status).toBe("CONFIRMED");
    expect(fake.calls.capture).toBe(5);
  });
});
