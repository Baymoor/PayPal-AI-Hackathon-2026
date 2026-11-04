import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../helpers/db";
import { jobs, paymentAttempts } from "@/lib/db/schema";
import { enqueueJob, settleJobKey } from "@/lib/jobs/queue";
import { runWorkerTick } from "@/lib/jobs/runner";
import { runDeadlineSettlement } from "@/lib/settlement/deadline";
import { processDueOperations } from "@/lib/settlement/operations";
import { readRoster } from "@/lib/settlement/snapshot";
import { FakeProvider } from "./fake-provider";
import { buildOuting, HOUR, loadAttempts, loadOps, loadOuting, loadSnapshot, payers, resolverFor } from "./builders";

const getDb = useTestDb();
const W = "test-worker";

describe("deadline settlement — gating", () => {
  it("never settles before the stored deadline", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), deadlineAt: new Date(Date.now() + HOUR), provider: fake });

    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("NOT_DUE");

    const outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("COLLECTING");
    expect(outing.frozenAt).toBeNull();
    expect(await loadSnapshot(db, built.outingId)).toBeUndefined();
    expect(await loadOps(db, built.outingId)).toHaveLength(0);
    expect(fake.calls.capture).toBe(0);

    // A queued job that fires early is retried, not executed.
    await enqueueJob(db, { kind: "SETTLE_DEADLINE", outingId: built.outingId, runAt: new Date(Date.now() - 1000), dedupeKey: settleJobKey(built.outingId, built.quoteId), payload: { quoteId: built.quoteId } });
    const tick = await runWorkerTick(db, resolverFor(fake), { workerId: W });
    expect(tick.errors.some((e) => e.includes("not due"))).toBe(true);
    const job = await db.query.jobs.findFirst({ where: eq(jobs.outingId, built.outingId) });
    expect(job?.status).toBe("QUEUED");
    expect((await loadOuting(db, built.outingId)).status).toBe("COLLECTING");
  });

  it("a late-running job evaluates against the stored deadline, not the run time", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const deadlineAt = new Date(Date.now() - 3 * HOUR);
    // Five timely payers plus an optional payer whose authorization completed 10 minutes after the deadline.
    const built = await buildOuting(db, {
      deadlineAt,
      provider: fake,
      people: [...payers(5), { name: "Late Larry", required: false, auth: { createTime: new Date(deadlineAt.getTime() + 10 * 60_000) } }],
    });

    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("SETTLE");
    if (r.outcome !== "SETTLE") return;
    expect(r.captures).toBe(5);
    expect(r.voids).toBe(1);

    const snapshot = (await loadSnapshot(db, built.outingId))!;
    const roster = readRoster(snapshot);
    expect(roster.decision.kind).toBe("SETTLE");
    expect(roster.decision.ineligible).toEqual([{ participantId: built.people[5]!.id, required: false, reason: "LATE_AUTHORIZATION" }]);
    const larry = (await loadAttempts(db, built.outingId)).find((a) => a.id === built.people[5]!.attemptId)!;
    expect(larry.late).toBe(true);
    expect(larry.status).toBe("VOID_PENDING");
  });

  it("is idempotent: a second run finds the snapshot and plans nothing new", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), provider: fake });
    const first = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(first.outcome).toBe("SETTLE");
    const second = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: "other-worker" });
    expect(second.outcome).toBe("ALREADY_SETTLED");
    expect(await loadOps(db, built.outingId)).toHaveLength(5);
  });

  it("a stale job for a superseded quote is a no-op", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), provider: fake });
    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W, quoteId: "00000000-0000-0000-0000-000000000000" });
    expect(r.outcome).toBe("STALE_QUOTE");
    expect((await loadOuting(db, built.outingId)).status).toBe("COLLECTING");
  });
});

describe("deadline settlement — canonical splits end to end", () => {
  it("$100 / 5 payers → five $20 captures → CONFIRMED", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), provider: fake });
    await enqueueJob(db, { kind: "SETTLE_DEADLINE", outingId: built.outingId, runAt: built.deadlineAt, dedupeKey: settleJobKey(built.outingId, built.quoteId), payload: { quoteId: built.quoteId } });

    const tick = await runWorkerTick(db, resolverFor(fake), { workerId: W });
    expect(tick.errors).toEqual([]);
    expect(tick.jobsRun).toBeGreaterThanOrEqual(1);

    const outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CONFIRMED");
    expect(outing.settledAt).not.toBeNull();
    expect(outing.frozenAt).not.toBeNull();
    expect(outing.cleanup).toBe("NONE");

    const ops = await loadOps(db, built.outingId);
    expect(ops.map((o) => [o.kind, o.sequence, o.amountMinor, o.status])).toEqual([1, 2, 3, 4, 5].map((s) => ["CAPTURE", s, 2000, "SUCCEEDED"]));
    const attempts = await loadAttempts(db, built.outingId);
    expect(attempts.every((a) => a.status === "CAPTURED" && a.capturedMinor === 2000 && a.captureId)).toBe(true);
    for (const p of built.people) expect(fake.captureCount(p.authorizationId!)).toBe(1);
    expect(fake.calls.capture).toBe(5);

    const snapshot = (await loadSnapshot(db, built.outingId))!;
    expect(snapshot.decision).toBe("SETTLE");
    expect(snapshot.payerCount).toBe(5);
    expect(snapshot.totalMinor).toBe(10_000);
  });

  it("$100 / 10 payers with $20 holds → ten $10 final captures (under-capture)", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(10), provider: fake });
    expect(built.capMinor).toBe(2000);

    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("SETTLE");
    await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W });

    const outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CONFIRMED");
    const attempts = await loadAttempts(db, built.outingId);
    expect(attempts).toHaveLength(10);
    expect(attempts.every((a) => a.status === "CAPTURED" && a.authorizedMinor === 2000 && a.capturedMinor === 1000)).toBe(true);
    for (const p of built.people) {
      const caps = fake.capturesOf(p.authorizationId!);
      expect(caps).toHaveLength(1);
      expect(caps[0]!.amountMinor).toBe(1000);
    }
    const ops = await loadOps(db, built.outingId);
    expect(ops.reduce((acc, o) => acc + o.amountMinor, 0)).toBe(10_000);
  });

  it("6 attendees incl. 1 sponsored guest → 5 payers at $20, guest $0", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: [...payers(5), { name: "Maya", sponsored: true }], provider: fake });

    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("SETTLE");
    if (r.outcome !== "SETTLE") return;
    expect(r.captures).toBe(5);
    const roster = readRoster((await loadSnapshot(db, built.outingId))!);
    expect(roster.decision.kind === "SETTLE" && roster.decision.sponsoredParticipantIds).toEqual([built.people[5]!.id]);
    expect(roster.planned.captures.every((c) => c.amountMinor === 2000)).toBe(true);

    await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W });
    expect((await loadOuting(db, built.outingId)).status).toBe("CONFIRMED");
    expect(fake.calls.capture).toBe(5);
  });

  it("$100 / 3 payers → 33.34, 33.33, 33.33 in stable order", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(3), minPayers: 3, provider: fake });
    expect(built.capMinor).toBe(3334);
    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("SETTLE");
    const ops = await loadOps(db, built.outingId);
    expect(ops.map((o) => o.amountMinor)).toEqual([3334, 3333, 3333]);
    await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W });
    expect((await loadOuting(db, built.outingId)).status).toBe("CONFIRMED");
  });
});

describe("deadline settlement — ALL_REQUIRED cancellations", () => {
  it("a required holdout cancels; every hold is voided; cleanup becomes COMPLETE only after the provider confirmed", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, {
      provider: fake,
      people: [...payers(4), { name: "Holdout", attendance: "PENDING", consent: false, auth: false }],
    });

    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("CANCEL");
    if (r.outcome !== "CANCEL") return;
    expect(r.reasons).toContain("REQUIRED_MISSING");
    expect(r.voids).toBe(4);

    let outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CANCELLED");
    expect(outing.cancelledAt).not.toBeNull();
    expect(outing.cancelReasons).toContain("REQUIRED_MISSING");
    expect(outing.cleanup).toBe("VOID_PENDING");
    expect((await loadAttempts(db, built.outingId)).every((a) => a.status === "VOID_PENDING")).toBe(true);
    expect(fake.calls.void).toBe(0);
    expect(fake.calls.capture).toBe(0);

    const ops = await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W });
    expect(ops.errors).toEqual([]);
    expect(ops.operationsRun).toBe(4);
    outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CANCELLED");
    expect(outing.cleanup).toBe("COMPLETE");
    expect((await loadAttempts(db, built.outingId)).every((a) => a.status === "VOIDED")).toBe(true);
    for (const p of built.people.slice(0, 4)) expect(fake.voidsPerformed.get(p.authorizationId!)).toBe(1);
    expect(fake.calls.capture).toBe(0);
  });

  it("an expired authorization of a required payer cancels (fail closed)", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, {
      provider: fake,
      people: [...payers(4), { name: "Expired Eve", auth: { expires: new Date(Date.now() - 60_000) } }],
    });
    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("CANCEL");
    const roster = readRoster((await loadSnapshot(db, built.outingId))!);
    expect(roster.decision.kind === "CANCEL" && roster.decision.reasons).toContain("REQUIRED_MISSING");
    expect(roster.decision.ineligible).toEqual([{ participantId: built.people[4]!.id, required: true, reason: "AUTHORIZATION_EXPIRED" }]);
    await processDueOperations(db, resolverFor(fake), { now: new Date(), workerId: W });
    expect(fake.calls.capture).toBe(0);
    expect((await loadOuting(db, built.outingId)).cleanup).toBe("COMPLETE");
  });

  it("an authorization the provider reports EXPIRED is released before the decision and cancels", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), provider: fake });
    fake.expireAuthorization(built.people[2]!.authorizationId!);
    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("CANCEL");
    const attempts = await loadAttempts(db, built.outingId);
    const expired = attempts.find((a) => a.id === built.people[2]!.attemptId)!;
    expect(expired.status).toBe("VOIDED");
    expect(expired.lastError).toMatch(/expired/);
    expect(attempts.filter((a) => a.status === "VOID_PENDING")).toHaveLength(4);
  });

  it("fails closed when the provider cannot be read", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), provider: fake });
    fake.readsFail = true;
    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("CANCEL");
    if (r.outcome !== "CANCEL") return;
    expect(r.reasons).toContain("UNVERIFIABLE");
    expect(fake.calls.capture).toBe(0);
    const snapshot = (await loadSnapshot(db, built.outingId))!;
    expect(readRoster(snapshot).reconcileNotes).toHaveLength(5);
  });

  it("cancels when the merchant offering is no longer available", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), provider: fake, offeringActive: false });
    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("CANCEL");
    if (r.outcome !== "CANCEL") return;
    expect(r.reasons).toEqual(["MERCHANT_UNAVAILABLE"]);
  });

  it("an attempt whose approval never completed is FAILED, not a hold", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { provider: fake, people: [...payers(5), { name: "Abandoned Al", required: false, auth: { orderOnly: true } }] });
    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W });
    expect(r.outcome).toBe("SETTLE");
    const al = (await loadAttempts(db, built.outingId)).find((a) => a.id === built.people[5]!.attemptId)!;
    expect(al.status).toBe("FAILED");
    expect(al.lastError).toMatch(/approval not completed/);
    expect((await loadOps(db, built.outingId)).filter((o) => o.paymentAttemptId === al.id)).toHaveLength(0);
  });
});

describe("deadline settlement — early cancellation", () => {
  it("organizer cancel before the deadline cancels unconditionally and voids holds", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), deadlineAt: new Date(Date.now() + 2 * HOUR), provider: fake });
    await enqueueJob(db, { kind: "SETTLE_DEADLINE", outingId: built.outingId, runAt: new Date(), dedupeKey: `settle-early:${built.outingId}`, payload: { early: true, reason: "ORGANIZER_CANCELLED" } });

    const tick = await runWorkerTick(db, resolverFor(fake), { workerId: W });
    expect(tick.errors).toEqual([]);
    const outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("CANCELLED");
    expect(outing.cancelReasons).toEqual(["ORGANIZER_CANCELLED"]);
    expect(outing.frozenAt).not.toBeNull();
    expect(outing.cleanup).toBe("COMPLETE");
    expect((await loadAttempts(db, built.outingId)).every((a) => a.status === "VOIDED")).toBe(true);
    expect(fake.calls.capture).toBe(0);
    expect(fake.calls.void).toBe(5);
  });

  it("required decline before the deadline cancels with REQUIRED_DECLINED", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, {
      deadlineAt: new Date(Date.now() + 2 * HOUR),
      provider: fake,
      people: [...payers(4), { name: "Declined Dan", attendance: "DECLINED", consent: false, auth: false }],
    });
    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W, early: true, reason: "REQUIRED_DECLINED" });
    expect(r.outcome).toBe("CANCEL");
    if (r.outcome !== "CANCEL") return;
    expect(r.reasons).toEqual(["REQUIRED_DECLINED"]);
    expect(r.voids).toBe(4);
    expect((await loadOuting(db, built.outingId)).status).toBe("CANCELLED");
  });

  it("an early REQUIRED_DECLINED job on a still-feasible outing does nothing and does not freeze", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), deadlineAt: new Date(Date.now() + 2 * HOUR), provider: fake });
    const r = await runDeadlineSettlement(db, resolverFor(fake), { outingId: built.outingId, now: new Date(), workerId: W, early: true, reason: "REQUIRED_DECLINED" });
    expect(r.outcome).toBe("STILL_FEASIBLE");
    const outing = await loadOuting(db, built.outingId);
    expect(outing.status).toBe("COLLECTING");
    expect(outing.frozenAt).toBeNull();
    expect(await loadSnapshot(db, built.outingId)).toBeUndefined();
    expect((await loadAttempts(db, built.outingId)).every((a) => a.status === "AUTHORIZED")).toBe(true);
  });
});

describe("worker sweep", () => {
  it("settles an overdue COLLECTING outing even when its job was lost", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), provider: fake });
    const tick = await runWorkerTick(db, resolverFor(fake), { workerId: W });
    expect(tick.sweptOutings).toBe(1);
    expect((await loadOuting(db, built.outingId)).status).toBe("CONFIRMED");
    // Re-enqueueing the settle job afterwards is harmless.
    await enqueueJob(db, { kind: "SETTLE_DEADLINE", outingId: built.outingId, runAt: new Date(), dedupeKey: settleJobKey(built.outingId, built.quoteId), onConflict: "requeue" });
    const again = await runWorkerTick(db, resolverFor(fake), { workerId: W });
    expect(again.errors).toEqual([]);
    expect(fake.calls.capture).toBe(5);
    const attempts = await db.query.paymentAttempts.findMany({ where: eq(paymentAttempts.outingId, built.outingId) });
    expect(attempts.every((a) => a.capturedMinor === 2000)).toBe(true);
  });
});
