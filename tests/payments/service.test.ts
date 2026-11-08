/** Payer-side payment service against a real Postgres test DB + the FIXTURE provider. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb as setupTestDb } from "../helpers/db";
import {
  auditEvents,
  consents,
  jobs,
  outings,
  participants,
  paymentAttempts,
  paymentOperations,
  settlementSnapshots,
} from "@/lib/db/schema";
import { resetConfigForTests } from "@/lib/env";
import { FixtureProvider } from "@/lib/payments/fixture";
import { resetPaymentProviders, setPaymentProviderOverride } from "@/lib/payments";
import type { AuthorizationView, CreatedOrder, CreateOrderInput, ProviderResult } from "@/lib/payments/provider";
import {
  approveFixturePayment,
  cancelApproval,
  completeApproval,
  reconcilePaymentAttempt,
  startPayment,
  withdraw,
} from "@/lib/services/payments";
import { consentTo, insertQuote, seedCollectingOuting, useDemoConfig, type SeededOuting } from "./helpers";

const getDb = setupTestDb(); // aliased: the shared helper is not a React hook
const T0 = new Date("2026-11-04T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const UNKNOWN = { ok: false as const, kind: "UNKNOWN" as const, code: "TIMEOUT", message: "simulated timeout" };

/** Fixture provider with test hooks (tampering, UNKNOWN outcomes, races). */
class TestFixture extends FixtureProvider {
  tamper: ((a: AuthorizationView) => AuthorizationView) | null = null;
  /** Return UNKNOWN for the next N authorize calls; `applied` = the authorization really happened first. */
  authorizeUnknown = { times: 0, applied: false };
  createUnknown = false;
  afterAuthorize: (() => Promise<void>) | null = null;

  override async createAuthorizeOrder(input: CreateOrderInput): Promise<ProviderResult<CreatedOrder>> {
    if (this.createUnknown) return UNKNOWN;
    return super.createAuthorizeOrder(input);
  }

  override async authorizeOrder(input: { orderId: string; requestId: string }): Promise<ProviderResult<{ authorization: AuthorizationView }>> {
    if (this.authorizeUnknown.times > 0) {
      this.authorizeUnknown.times -= 1;
      if (this.authorizeUnknown.applied) await super.authorizeOrder(input);
      return UNKNOWN;
    }
    const r = await super.authorizeOrder(input);
    if (this.afterAuthorize) await this.afterAuthorize();
    if (r.ok && this.tamper) return { ok: true, authorization: this.tamper(r.authorization) };
    return r;
  }
}

let providerNow = T0;
let fx: TestFixture;
let s: SeededOuting;
let deadline: Date;

beforeEach(async () => {
  useDemoConfig();
  resetPaymentProviders();
  providerNow = T0;
  fx = new TestFixture({ db: getDb(), now: () => providerNow });
  setPaymentProviderOverride("FIXTURE", fx);
  s = await seedCollectingOuting(getDb(), { now: T0, deadlineInMs: HOUR });
  deadline = s.outing.deadlineAt!;
});

afterAll(() => {
  resetPaymentProviders();
  resetConfigForTests();
});

const at = (ms: number) => new Date(T0.getTime() + ms);
const attemptRow = (id: string) => getDb().query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, id) });
const opsFor = (id: string) => getDb().select().from(paymentOperations).where(eq(paymentOperations.paymentAttemptId, id));
const jobByKey = (key: string) => getDb().query.jobs.findFirst({ where: eq(jobs.dedupeKey, key) });

async function startAndApprove(participantId: string, approveAt = at(60_000)) {
  const started = await startPayment(getDb(), { outingId: s.outing.id, participantId, now: T0 });
  const approved = await approveFixturePayment(getDb(), {
    attemptId: started.paymentAttemptId,
    participantId,
    outcome: "APPROVE",
    now: approveAt,
  });
  return { started, approved };
}

describe("startPayment", () => {
  it("creates an AUTHORIZE order for exactly the consented cap, labelled FIXTURE", async () => {
    const payer = s.payers[0];
    const r = await startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: T0 });
    expect(r).toMatchObject({ provider: "FIXTURE", providerLabel: "Fixture · not real PayPal", reused: false });
    expect(r.approveUrl).toBe(`/o/${s.outing.id}/pay/fixture?attempt=${r.paymentAttemptId}`);

    const a = await attemptRow(r.paymentAttemptId);
    expect(a).toMatchObject({ status: "APPROVAL_PENDING", requestedMinor: 2000, currency: "USD", provider: "FIXTURE", quoteId: s.quote.id });
    expect(a!.requestedMinor).toBe(s.consents.get(payer.id)!.capMinor);
    const order = await fx.getOrder(a!.providerOrderId!);
    expect(order.ok && order.order.amountMinor).toBe(2000);
    expect(order.ok && order.order.customId).toBe(r.paymentAttemptId);
  });

  it("rejects stale consent after the terms changed (409 TERMS_CHANGED) and a stale reviewed hash", async () => {
    const payer = s.payers[0];
    await expect(
      startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: T0, reviewedTermsHash: "not-the-current-hash" }),
    ).rejects.toMatchObject({ code: "TERMS_CHANGED", status: 409 });

    const v2 = await insertQuote(getDb(), s.outing, {
      offeringId: s.quote.offeringId,
      merchantId: s.quote.merchantId,
      totalMinor: 10_000,
      minPayers: 4, // material change -> cap $25 -> new hash
      version: 2,
      now: T0,
      deadlineAt: deadline,
      activityAt: s.outing.activityAt!,
      sponsoredIds: [s.sponsored.id],
      requiredIds: [s.organizer.id, s.payers[0].id, s.sponsored.id],
    });
    await getDb().update(outings).set({ currentQuoteId: v2.id }).where(eq(outings.id, s.outing.id));
    await expect(startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: T0 })).rejects.toMatchObject({
      code: "TERMS_CHANGED",
      status: 409,
    });
    expect(await getDb().select().from(paymentAttempts)).toHaveLength(0);

    // After renewed consent the hold is the NEW cap.
    await consentTo(getDb(), payer, v2, at(1000));
    const r = await startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: at(2000) });
    expect((await attemptRow(r.paymentAttemptId))!.requestedMinor).toBe(2500);
  });

  it("requires consent, a payer role, attendance, and an open window", async () => {
    await getDb().update(consents).set({ withdrawnAt: T0 }).where(eq(consents.participantId, s.payers[0].id));
    await expect(startPayment(getDb(), { outingId: s.outing.id, participantId: s.payers[0].id, now: T0 })).rejects.toMatchObject({
      code: "CONSENT_REQUIRED",
    });
    await expect(startPayment(getDb(), { outingId: s.outing.id, participantId: s.sponsored.id, now: T0 })).rejects.toMatchObject({
      code: "NOT_A_PAYER",
    });
    await getDb().update(participants).set({ attendance: "DECLINED" }).where(eq(participants.id, s.payers[1].id));
    await expect(startPayment(getDb(), { outingId: s.outing.id, participantId: s.payers[1].id, now: T0 })).rejects.toMatchObject({
      code: "NOT_ATTENDING",
    });
    await expect(startPayment(getDb(), { outingId: s.outing.id, participantId: s.organizer.id, now: deadline })).rejects.toMatchObject({
      code: "DEADLINE_PASSED",
      status: 409,
    });
    await getDb().update(outings).set({ frozenAt: T0 }).where(eq(outings.id, s.outing.id));
    await expect(startPayment(getDb(), { outingId: s.outing.id, participantId: s.organizer.id, now: T0 })).rejects.toMatchObject({
      code: "OUTING_NOT_COLLECTING",
    });
  });

  it("a double start reuses the pending approval link; after authorization a new start is rejected", async () => {
    const payer = s.payers[0];
    const r1 = await startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: T0 });
    const r2 = await startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: at(60_000) });
    expect(r2).toMatchObject({ paymentAttemptId: r1.paymentAttemptId, approveUrl: r1.approveUrl, reused: true });
    expect(await getDb().select().from(paymentAttempts)).toHaveLength(1);

    await approveFixturePayment(getDb(), { attemptId: r1.paymentAttemptId, participantId: payer.id, outcome: "APPROVE", now: at(120_000) });
    await expect(startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: at(180_000) })).rejects.toMatchObject({
      code: "ALREADY_AUTHORIZED",
      status: 409,
    });
  });

  it("concurrent starts by the same payer open at most one attempt", async () => {
    const payer = s.payers[0];
    const results = await Promise.allSettled([
      startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: T0 }),
      startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: T0 }),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "PAYMENT_IN_PROGRESS" });
    expect(await getDb().select().from(paymentAttempts)).toHaveLength(1);
  });

  it("provider UNKNOWN on order creation -> attempt UNKNOWN, RECONCILE job, 503; reconciliation closes it", async () => {
    fx.createUnknown = true;
    const payer = s.payers[0];
    await expect(startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: T0 })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      status: 503,
    });
    const [a] = await getDb().select().from(paymentAttempts);
    expect(a).toMatchObject({ status: "UNKNOWN", providerOrderId: null });
    expect(await jobByKey(`reconcile:${a.id}`)).toMatchObject({ kind: "RECONCILE_PAYMENT", status: "QUEUED", payload: { paymentAttemptId: a.id } });

    // No approval link was ever issued, so it does not block a new attempt, and reconciliation fails it.
    fx.createUnknown = false;
    const r = await startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: at(1000) });
    expect(r.paymentAttemptId).not.toBe(a.id);
    expect(await reconcilePaymentAttempt(getDb(), { paymentAttemptId: a.id, now: at(20_000) })).toBe("FAILED");
    expect((await attemptRow(a.id))!.status).toBe("FAILED");
  });

  it("refuses when payments are disabled", async () => {
    resetConfigForTests();
    useDemoConfig({ DEMO_FIXTURES_ENABLED: "false" });
    await expect(startPayment(getDb(), { outingId: s.outing.id, participantId: s.payers[0].id, now: T0 })).rejects.toMatchObject({
      code: "PAYMENTS_DISABLED",
      status: 503,
    });
  });
});

describe("completeApproval", () => {
  it("authorizes, verifies and records the provider create_time; audit has no full provider ids", async () => {
    providerNow = at(90_000);
    const { started, approved } = await startAndApprove(s.payers[0].id);
    expect(approved).toMatchObject({ outcome: "AUTHORIZED", outingId: s.outing.id });
    const a = await attemptRow(started.paymentAttemptId);
    expect(a).toMatchObject({ status: "AUTHORIZED", authorizedMinor: 2000, verified: true, late: false });
    expect(a!.authorizedAt).toEqual(at(90_000));
    expect(a!.authorizationExpiresAt!.getTime()).toBeGreaterThan(deadline.getTime());
    expect(await opsFor(a!.id)).toHaveLength(0);

    const audit = await getDb().select().from(auditEvents).where(eq(auditEvents.outingId, s.outing.id));
    expect(audit.map((e) => e.type)).toEqual(expect.arrayContaining(["PAYMENT_STARTED", "PAYMENT_ORDER_CREATED", "PAYMENT_AUTHORIZED"]));
    const dump = JSON.stringify(audit.map((e) => e.data));
    expect(dump).not.toContain(a!.authorizationId!);
    expect(dump).not.toContain(a!.providerOrderId!);
    expect(dump).not.toContain(s.payers[0].displayName);

    // A refresh of the return page is idempotent.
    const again = await completeApproval(getDb(), {
      attemptId: a!.id,
      participantId: s.payers[0].id,
      orderId: a!.providerOrderId!,
      now: at(100_000),
    });
    expect(again.outcome).toBe("AUTHORIZED");
  });

  it("an approval arriving at/after the deadline is refused WITHOUT authorizing", async () => {
    const { started, approved } = await startAndApprove(s.payers[0].id, deadline);
    expect(approved.outcome).toBe("LATE");
    const a = await attemptRow(started.paymentAttemptId);
    expect(a).toMatchObject({ status: "FAILED", late: true, authorizationId: null, authorizedMinor: 0 });
    expect(a!.lastError).toMatch(/after the deadline/);
    const order = await fx.getOrder(a!.providerOrderId!);
    expect(order.ok && order.order.status).toBe("APPROVED");
    expect(order.ok && order.order.authorizations).toHaveLength(0); // no hold was placed
  });

  it("a provider authorization created after the deadline is recorded late and a VOID is planned", async () => {
    providerNow = new Date(deadline.getTime() + 1000); // PayPal's create_time is after our deadline
    const { started, approved } = await startAndApprove(s.payers[0].id, new Date(deadline.getTime() - 1000));
    expect(approved.outcome).toBe("LATE");
    const a = await attemptRow(started.paymentAttemptId);
    expect(a).toMatchObject({ status: "VOID_PENDING", late: true, verified: true, authorizedMinor: 2000 });
    expect(a!.authorizationId).toBeTruthy();
    const ops = await opsFor(a!.id);
    expect(ops).toMatchObject([{ kind: "VOID", amountMinor: 2000, requestId: `outings-void-${a!.id}`, status: "PENDING" }]);
    expect(await jobByKey(`ops:${s.outing.id}`)).toMatchObject({ kind: "PROCESS_OPERATIONS" });
  });

  it.each([
    ["AMOUNT", (a: AuthorizationView) => ({ ...a, amountMinor: 1999 })],
    ["CUSTOM_ID", (a: AuthorizationView) => ({ ...a, customId: "someone-else" })],
  ])("an authorization %s mismatch is never admitted: FAILED + VOID planned", async (what, tamper) => {
    fx.tamper = tamper;
    const { started, approved } = await startAndApprove(s.payers[0].id);
    expect(approved.outcome).toBe("FAILED");
    const a = await attemptRow(started.paymentAttemptId);
    expect(a!.status).toBe("VOID_PENDING");
    expect(a!.lastError).toContain(what);
    expect(await opsFor(a!.id)).toMatchObject([{ kind: "VOID" }]);
  });

  it("race rule: settlement froze the roster while authorize was in flight -> recorded late + VOID", async () => {
    fx.afterAuthorize = async () => {
      await getDb().insert(settlementSnapshots).values({
        outingId: s.outing.id,
        quoteId: s.quote.id,
        termsHash: s.quote.termsHash,
        decision: "CANCEL",
        reasons: ["REQUIRED_MISSING"],
        frozenAt: at(70_000),
        totalMinor: 10_000,
        currency: "USD",
        payerCount: 0,
        roster: { allocations: [] },
      });
      await getDb().update(outings).set({ status: "CANCELLING", frozenAt: at(70_000) }).where(eq(outings.id, s.outing.id));
    };
    const { started, approved } = await startAndApprove(s.payers[0].id);
    expect(approved.outcome).toBe("LATE");
    const a = await attemptRow(started.paymentAttemptId);
    expect(a).toMatchObject({ status: "VOID_PENDING", late: true });
    expect(await opsFor(a!.id)).toMatchObject([{ kind: "VOID", amountMinor: 2000 }]);
  });

  it("a snapshot that does not allocate the attempt forces a VOID even while the outing still says COLLECTING", async () => {
    await getDb().insert(settlementSnapshots).values({
      outingId: s.outing.id,
      quoteId: s.quote.id,
      termsHash: s.quote.termsHash,
      decision: "SETTLE",
      frozenAt: T0,
      totalMinor: 10_000,
      currency: "USD",
      payerCount: 5,
      roster: { allocations: [{ paymentAttemptId: "00000000-0000-4000-8000-000000000000", allocationMinor: 2000 }] },
    });
    const { started, approved } = await startAndApprove(s.payers[0].id);
    expect(approved.outcome).toBe("LATE");
    expect((await attemptRow(started.paymentAttemptId))!.status).toBe("VOID_PENDING");
  });

  it("provider UNKNOWN on authorize -> attempt UNKNOWN + RECONCILE job; reconciliation retries with the same key", async () => {
    fx.authorizeUnknown = { times: 1, applied: false };
    const { started, approved } = await startAndApprove(s.payers[0].id);
    expect(approved.outcome).toBe("PENDING");
    const a = await attemptRow(started.paymentAttemptId);
    expect(a).toMatchObject({ status: "UNKNOWN", authorizationId: null });
    expect(a!.lastError).toContain("TIMEOUT");
    expect(await jobByKey(`reconcile:${a!.id}`)).toMatchObject({ kind: "RECONCILE_PAYMENT", status: "QUEUED", payload: { paymentAttemptId: a!.id } });

    // While unknown, no second hold can be opened.
    await expect(startPayment(getDb(), { outingId: s.outing.id, participantId: s.payers[0].id, now: at(80_000) })).rejects.toMatchObject({
      code: "PAYMENT_BEING_CONFIRMED",
    });

    expect(await reconcilePaymentAttempt(getDb(), { paymentAttemptId: a!.id, now: at(90_000) })).toBe("AUTHORIZED");
    expect(await attemptRow(a!.id)).toMatchObject({ status: "AUTHORIZED", verified: true });
  });

  it("reconciliation after the deadline admits a timely provider authorization but voids one recorded after the freeze", async () => {
    fx.authorizeUnknown = { times: 1, applied: true }; // authorized at PayPal, response lost
    const { started } = await startAndApprove(s.payers[0].id);
    expect((await attemptRow(started.paymentAttemptId))!.status).toBe("UNKNOWN");
    // Deadline passed but settlement has not frozen yet: provider create_time (T0) decides -> admitted.
    expect(await reconcilePaymentAttempt(getDb(), { paymentAttemptId: started.paymentAttemptId, now: new Date(deadline.getTime() + 5000) })).toBe(
      "AUTHORIZED",
    );

    // Second payer: same situation, but the roster froze first -> late + VOID.
    fx.authorizeUnknown = { times: 1, applied: true };
    const second = await startAndApprove(s.payers[1].id);
    await getDb().update(outings).set({ status: "SETTLING", frozenAt: deadline }).where(eq(outings.id, s.outing.id));
    expect(await reconcilePaymentAttempt(getDb(), { paymentAttemptId: second.started.paymentAttemptId, now: new Date(deadline.getTime() + 5000) })).toBe(
      "LATE",
    );
    expect(await attemptRow(second.started.paymentAttemptId)).toMatchObject({ status: "VOID_PENDING", late: true });
  });

  it("a participant cannot complete, cancel or approve another participant's attempt", async () => {
    const owner = s.payers[0];
    const other = s.payers[1];
    const r = await startPayment(getDb(), { outingId: s.outing.id, participantId: owner.id, now: T0 });
    const a = (await attemptRow(r.paymentAttemptId))!;
    await expect(
      completeApproval(getDb(), { attemptId: a.id, participantId: other.id, orderId: a.providerOrderId!, now: T0 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(cancelApproval(getDb(), { attemptId: a.id, participantId: other.id, now: T0 })).rejects.toMatchObject({ status: 404 });
    await expect(approveFixturePayment(getDb(), { attemptId: a.id, participantId: other.id, outcome: "APPROVE", now: T0 })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      completeApproval(getDb(), { attemptId: a.id, participantId: owner.id, orderId: "FXORD-SOMEONE-ELSES", now: T0 }),
    ).rejects.toMatchObject({ code: "ORDER_MISMATCH", status: 400 });
    // Starting a payment for a different outing's participant is impossible too.
    const otherOuting = await seedCollectingOuting(getDb(), { now: T0 });
    await expect(startPayment(getDb(), { outingId: s.outing.id, participantId: otherOuting.payers[0].id, now: T0 })).rejects.toMatchObject({
      status: 404,
    });
    expect((await attemptRow(a.id))!.status).toBe("APPROVAL_PENDING");
  });

  it("a cancelled approval abandons the attempt; the next start opens a fresh one", async () => {
    const payer = s.payers[0];
    const r = await startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: T0 });
    const c = await approveFixturePayment(getDb(), { attemptId: r.paymentAttemptId, participantId: payer.id, outcome: "CANCEL", now: at(1000) });
    expect(c.outcome).toBe("CANCELLED");
    expect(await attemptRow(r.paymentAttemptId)).toMatchObject({ status: "FAILED", authorizationId: null });
    const r2 = await startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: at(2000) });
    expect(r2.paymentAttemptId).not.toBe(r.paymentAttemptId);
  });

  it("the fixture approval is 404 when demo fixtures are disabled", async () => {
    const r = await startPayment(getDb(), { outingId: s.outing.id, participantId: s.payers[0].id, now: T0 });
    resetConfigForTests();
    useDemoConfig({ DEMO_FIXTURES_ENABLED: "false" });
    await expect(
      approveFixturePayment(getDb(), { attemptId: r.paymentAttemptId, participantId: s.payers[0].id, outcome: "APPROVE", now: T0 }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("withdraw", () => {
  it("a required payer's withdrawal voids their hold and schedules an early cancel; nobody else changes", async () => {
    const required = s.payers[0];
    await startAndApprove(required.id);
    const otherConsentBefore = await getDb().query.consents.findFirst({ where: eq(consents.participantId, s.organizer.id) });

    const r = await withdraw(getDb(), { outingId: s.outing.id, participantId: required.id, now: at(10 * 60_000) });
    expect(r).toEqual({ withdrawn: true, alreadyWithdrawn: false, voidsPlanned: 1, earlyCancelScheduled: true });

    const [a] = await getDb().select().from(paymentAttempts).where(eq(paymentAttempts.participantId, required.id));
    expect(a.status).toBe("VOID_PENDING");
    expect(await opsFor(a.id)).toMatchObject([{ kind: "VOID", amountMinor: 2000 }]);
    expect(await getDb().query.participants.findFirst({ where: eq(participants.id, required.id) })).toMatchObject({ attendance: "WITHDRAWN" });
    const c = await getDb().query.consents.findFirst({ where: eq(consents.participantId, required.id) });
    expect(c!.withdrawnAt).toEqual(at(10 * 60_000));
    expect(await jobByKey(`settle-early:${s.outing.id}`)).toMatchObject({
      kind: "SETTLE_DEADLINE",
      payload: { early: true, reason: "REQUIRED_DECLINED" },
    });
    // Remaining participants: same consent, same cap — never charged more.
    expect(await getDb().query.consents.findFirst({ where: eq(consents.participantId, s.organizer.id) })).toEqual(otherConsentBefore);

    expect(await withdraw(getDb(), { outingId: s.outing.id, participantId: required.id, now: at(11 * 60_000) })).toMatchObject({
      alreadyWithdrawn: true,
    });
  });

  it("an optional payer's withdrawal closes a pending approval, which can then never authorize", async () => {
    const optional = s.payers[1];
    expect(optional.required).toBe(false);
    const r = await startPayment(getDb(), { outingId: s.outing.id, participantId: optional.id, now: T0 });
    const w = await withdraw(getDb(), { outingId: s.outing.id, participantId: optional.id, now: at(1000) });
    expect(w).toMatchObject({ voidsPlanned: 0, earlyCancelScheduled: false });
    expect(await jobByKey(`settle-early:${s.outing.id}`)).toBeUndefined();

    const a = (await attemptRow(r.paymentAttemptId))!;
    expect(a.status).toBe("FAILED");
    await fx.approveOrder(a.providerOrderId!);
    const late = await completeApproval(getDb(), { attemptId: a.id, participantId: optional.id, orderId: a.providerOrderId!, now: at(2000) });
    expect(late.outcome).toBe("FAILED");
    const order = await fx.getOrder(a.providerOrderId!);
    expect(order.ok && order.order.authorizations).toHaveLength(0);
  });

  it("is closed at the deadline", async () => {
    await expect(withdraw(getDb(), { outingId: s.outing.id, participantId: s.payers[0].id, now: deadline })).rejects.toMatchObject({
      code: "WITHDRAW_CLOSED",
      status: 409,
    });
    const p = await getDb().query.participants.findFirst({ where: and(eq(participants.id, s.payers[0].id)) });
    expect(p!.attendance).toBe("ACCEPTED");
  });
});
