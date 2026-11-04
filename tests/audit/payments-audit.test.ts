/**
 * Audit regressions for the payer-side payment service (lib/services/payments.ts)
 * and attempt reconciliation (lib/settlement/reconcile.ts).
 *
 * 1. A provider authorization that materialises for an attempt we had already
 *    closed (FAILED without an authorization id — e.g. a reconcile marked it
 *    late while the authorize call was still in flight) must be recorded and
 *    voided, never dropped on the floor as a silent hold.
 * 2. Provider selection: demo (isFixture) outings always pay through the
 *    FIXTURE simulator when fixtures are enabled; real outings never use the
 *    simulator while PayPal sandbox is configured.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb as setupTestDb } from "../helpers/db";
import { outings, paymentAttempts, paymentOperations } from "@/lib/db/schema";
import { resetConfigForTests } from "@/lib/env";
import { FixtureProvider } from "@/lib/payments/fixture";
import { getPaymentProvider, resetPaymentProviders, setPaymentProviderOverride } from "@/lib/payments";
import type { AuthorizationView, ProviderResult } from "@/lib/payments/provider";
import { approveFixturePayment, startPayment } from "@/lib/services/payments";
import { reconcileAttempt } from "@/lib/settlement/reconcile";
import { FakeProvider } from "../settlement/fake-provider";
import { seedCollectingOuting, useDemoConfig, type SeededOuting } from "../payments/helpers";

const getDb = setupTestDb();
const T0 = new Date("2026-11-04T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** Fixture provider whose authorize call lets the test interleave a concurrent DB change before the response "arrives". */
class RacyFixture extends FixtureProvider {
  beforeAuthorizeReturns: (() => Promise<void>) | null = null;
  override async authorizeOrder(input: { orderId: string; requestId: string }): Promise<ProviderResult<{ authorization: AuthorizationView }>> {
    const r = await super.authorizeOrder(input);
    if (this.beforeAuthorizeReturns) await this.beforeAuthorizeReturns();
    return r;
  }
}

let fx: RacyFixture;
let s: SeededOuting;

beforeEach(async () => {
  useDemoConfig();
  resetPaymentProviders();
  fx = new RacyFixture({ db: getDb(), now: () => T0 });
  setPaymentProviderOverride("FIXTURE", fx);
  s = await seedCollectingOuting(getDb(), { now: T0, deadlineInMs: HOUR });
});

afterAll(() => {
  resetPaymentProviders();
  resetConfigForTests();
});

const attemptRow = (id: string) => getDb().query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, id) });
const opsFor = (id: string) => getDb().select().from(paymentOperations).where(eq(paymentOperations.paymentAttemptId, id));

describe("a hold that appears for an already-closed attempt is recorded and released", () => {
  it("authorize response arriving after a concurrent reconcile closed the attempt -> authorization recorded + VOID planned", async () => {
    const payer = s.payers[0];
    const started = await startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: T0 });

    // While the authorize call is in flight (attempt UNKNOWN), a reconcile job decided the approval was late and closed the attempt.
    fx.beforeAuthorizeReturns = async () => {
      await getDb()
        .update(paymentAttempts)
        .set({ status: "FAILED", late: true, lastError: "LATE_APPROVAL: simulated concurrent reconcile" })
        .where(eq(paymentAttempts.id, started.paymentAttemptId));
    };
    const approved = await approveFixturePayment(getDb(), { attemptId: started.paymentAttemptId, participantId: payer.id, outcome: "APPROVE", now: at(60_000) });
    expect(approved.outcome).not.toBe("AUTHORIZED");

    const a = await attemptRow(started.paymentAttemptId);
    // The provider DID create a hold; we must know about it and release it.
    expect(a!.authorizationId).not.toBeNull();
    expect(a!.status).toBe("VOID_PENDING");
    expect(await opsFor(a!.id)).toMatchObject([{ kind: "VOID", amountMinor: 2000 }]);
  });

  it("reconciliation of a FAILED attempt whose order turns out to carry a live authorization plans a VOID", async () => {
    const payer = s.payers[1];
    const started = await startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: T0 });
    const before = await attemptRow(started.paymentAttemptId);
    // Buyer approved; our authorize call was sent but the attempt was closed as late before the response was recorded.
    await fx.approveOrder(before!.providerOrderId!);
    const auth = await fx.authorizeOrder({ orderId: before!.providerOrderId!, requestId: `outings-authorize-${before!.id}` });
    expect(auth.ok).toBe(true);
    await getDb()
      .update(paymentAttempts)
      .set({ status: "FAILED", late: true, lastError: "LATE_APPROVAL: no hold was placed" })
      .where(eq(paymentAttempts.id, before!.id));

    // A webhook (PAYMENT.AUTHORIZATION.CREATED) or a manual nudge triggers reconciliation.
    const r = await reconcileAttempt(getDb(), (name) => getPaymentProvider(name), { attemptId: before!.id, now: at(120_000), workerId: "audit" });
    expect(r.read).toBe("OK");
    const a = await attemptRow(before!.id);
    expect(a!.authorizationId).not.toBeNull();
    expect(a!.status).toBe("VOID_PENDING");
    expect(await opsFor(a!.id)).toMatchObject([{ kind: "VOID" }]);
  });
});

describe("provider selection follows the outing, never mixes simulator and sandbox", () => {
  const paypalEnv = { PAYPAL_CLIENT_ID: "sandbox-client", PAYPAL_CLIENT_SECRET: "sandbox-secret" };

  it("a fixture (demo) outing always uses the FIXTURE simulator even when PayPal sandbox is configured", async () => {
    useDemoConfig(paypalEnv);
    resetPaymentProviders();
    setPaymentProviderOverride("FIXTURE", fx);
    const paypalFake = new FakeProvider("PAYPAL");
    setPaymentProviderOverride("PAYPAL", paypalFake);
    await getDb().update(outings).set({ isFixture: true }).where(eq(outings.id, s.outing.id));

    const r = await startPayment(getDb(), { outingId: s.outing.id, participantId: s.payers[0].id, now: T0 });
    expect(r.provider).toBe("FIXTURE");
    expect(r.providerLabel).toContain("Fixture");
    expect((await attemptRow(r.paymentAttemptId))!.provider).toBe("FIXTURE");
    expect(paypalFake.calls.createOrder).toBe(0);
  });

  it("a real outing uses PayPal sandbox when configured, never the simulator", async () => {
    useDemoConfig(paypalEnv);
    resetPaymentProviders();
    setPaymentProviderOverride("FIXTURE", fx);
    const paypalFake = new FakeProvider("PAYPAL");
    setPaymentProviderOverride("PAYPAL", paypalFake);

    const r = await startPayment(getDb(), { outingId: s.outing.id, participantId: s.payers[0].id, now: T0 });
    expect(r.provider).toBe("PAYPAL");
    expect((await attemptRow(r.paymentAttemptId))!.provider).toBe("PAYPAL");
    expect(paypalFake.calls.createOrder).toBe(1);
  });

  it("a fixture outing refuses new payments when the simulator is disabled (never falls back to real PayPal)", async () => {
    resetConfigForTests();
    useDemoConfig({ ...paypalEnv, DEMO_FIXTURES_ENABLED: "false" });
    resetPaymentProviders();
    const paypalFake = new FakeProvider("PAYPAL");
    setPaymentProviderOverride("PAYPAL", paypalFake);
    await getDb().update(outings).set({ isFixture: true }).where(eq(outings.id, s.outing.id));

    await expect(startPayment(getDb(), { outingId: s.outing.id, participantId: s.payers[0].id, now: T0 })).rejects.toMatchObject({ code: "PAYMENTS_DISABLED" });
    expect(paypalFake.calls.createOrder).toBe(0);
    expect(await getDb().query.paymentAttempts.findFirst({ where: eq(paymentAttempts.outingId, s.outing.id) })).toBeUndefined();
  });
});
