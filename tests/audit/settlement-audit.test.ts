/**
 * Audit regressions for the settlement engine (lib/settlement/deadline.ts).
 *
 * 1. The deadline / early-cancel decision must not overwrite the money
 *    clean-up state with COMPLETE while a previously planned VOID is still
 *    unresolved (or has exhausted its retries): COMPLETE means "the provider
 *    confirmed every void and refund".
 * 2. A provider that cannot be reached at all (adapter throws, e.g. missing
 *    credentials for the provider an attempt was created with) must fail
 *    closed exactly like a failed provider read: the hold is unverified and
 *    the outing cancels with UNVERIFIABLE — never settles on stale facts.
 */
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { useTestDb } from "../helpers/db";
import { paymentAttempts, paymentOperations } from "@/lib/db/schema";
import { planPaymentOperation } from "@/lib/payments/plan";
import { runDeadlineSettlement } from "@/lib/settlement/deadline";
import { processDueOperations } from "@/lib/settlement/operations";
import { FakeProvider } from "../settlement/fake-provider";
import { buildOuting, HOUR, loadAttempts, loadOps, loadOuting, loadSnapshot, payers, resolverFor } from "../settlement/builders";

const getDb = useTestDb();
const W = "audit-worker";

/** Plan a VOID for `attemptId` (as withdraw does) and make its op look exhausted (UNKNOWN, attempts == maxAttempts). */
async function plantExhaustedVoid(db: ReturnType<typeof getDb>, outingId: string, attemptId: string) {
  await db.transaction(async (tx) => {
    await planPaymentOperation(tx, { outingId, paymentAttemptId: attemptId, kind: "VOID", amountMinor: 2000, currency: "USD" });
  });
  await db.execute(sql`
    update payment_operations set status = 'UNKNOWN', attempts = max_attempts, last_error = 'TIMEOUT'
    where payment_attempt_id = ${attemptId} and kind = 'VOID'
  `);
}

describe("clean-up state is never set to COMPLETE over an unconfirmed void", () => {
  it("early organizer cancel keeps NEEDS_ATTENTION when the only hold's VOID already exhausted its retries", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(1), minPayers: 1, deadlineAt: new Date(Date.now() + 2 * HOUR), provider: fake });
    const only = built.people[0]!;
    // The payer withdrew earlier: a VOID was planned and then timed out until exhaustion.
    await plantExhaustedVoid(db, built.outingId, only.attemptId!);
    expect((await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, only.attemptId!) }))!.status).toBe("VOID_PENDING");

    const r = await runDeadlineSettlement(db, resolverFor(fake), {
      outingId: built.outingId,
      now: new Date(),
      workerId: W,
      early: true,
      reason: "ORGANIZER_CANCELLED",
    });
    expect(r.outcome).toBe("CANCEL");

    const outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CANCELLED");
    // The hold at the provider is still live: nothing may claim the clean-up is complete.
    expect(fake.voidsPerformed.get(only.authorizationId!) ?? 0).toBe(0);
    expect(outing.cleanup).toBe("NEEDS_ATTENTION");

    // No due operation exists for this CANCELLED outing, so the worker would never "repair" the state later.
    const run = await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W });
    expect(run.operationsRun).toBe(0);
    expect((await loadOuting(db, built.outingId)).cleanup).toBe("NEEDS_ATTENTION");
  });

  it("a deadline CANCEL reports VOID_PENDING (not COMPLETE) while a withdrawn payer's void is still queued", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    // Required holdout -> CANCEL at the deadline. Payer 1 withdrew before the deadline: VOID planned but not yet sent.
    const built = await buildOuting(db, {
      people: [...payers(2), { name: "Holdout", attendance: "PENDING", consent: false, auth: false }],
      minPayers: 2,
      provider: fake,
    });
    const withdrawn = built.people[0]!;
    await db.transaction(async (tx) => {
      await planPaymentOperation(tx, { outingId: built.outingId, paymentAttemptId: withdrawn.attemptId!, kind: "VOID", amountMinor: 5000, currency: "USD" });
    });
    // Payer 2's hold is also still live but its void will be planned by the decision itself. Make both voids time out.
    for (const p of built.people.slice(0, 2)) fake.alwaysTimeout("void", p.authorizationId!);

    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("CANCEL");
    const outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CANCELLED");
    expect(outing.cleanup).toBe("VOID_PENDING");
    const ops = await loadOps(db, built.outingId);
    expect(ops.filter((o) => o.kind === "VOID")).toHaveLength(2);
    expect(ops.every((o) => o.status !== "SUCCEEDED")).toBe(true);
  });
});

describe("fail closed when the provider adapter itself is unavailable", () => {
  it("an adapter that throws during the pre-decision read marks the hold unverified and cancels with UNVERIFIABLE", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), provider: fake });
    const broken = () => {
      throw new Error("PayPal sandbox credentials are not configured");
    };

    const r = await runDeadlineSettlement(db, broken, { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("CANCEL");
    if (r.outcome !== "CANCEL") return;
    expect(r.reasons).toContain("UNVERIFIABLE");

    const snapshot = await loadSnapshot(db, built.outingId);
    expect(snapshot?.decision).toBe("CANCEL");
    const attempts = await loadAttempts(db, built.outingId);
    // Every hold lost its verified flag (the facts could not be re-read) and is planned for release.
    expect(attempts.every((a) => a.verified === false)).toBe(true);
    expect(attempts.every((a) => a.status === "VOID_PENDING")).toBe(true);
    expect((await db.select().from(paymentOperations).where(eq(paymentOperations.outingId, built.outingId))).every((o) => o.kind === "VOID")).toBe(true);
    expect(fake.calls.capture).toBe(0);
  });
});
