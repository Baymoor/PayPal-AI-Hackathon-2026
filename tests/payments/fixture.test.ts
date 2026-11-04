/** FIXTURE payment simulator against a real Postgres test database. */
import { describe, expect, it, beforeEach } from "vitest";
import { useTestDb as setupTestDb } from "../helpers/db";
import { paymentAttempts } from "@/lib/db/schema";
import {
  FIXTURE_AUTHORIZATION_VALIDITY_MS,
  FIXTURE_PROVIDER_LABEL,
  FixtureProvider,
  clearFixtureFailure,
  readFixtureObject,
  resolveFixturePending,
  setFixtureFailure,
} from "@/lib/payments/fixture";
import { seedCollectingOuting } from "./helpers";

const getDb = setupTestDb(); // aliased: the shared helper is not a React hook

let clock = new Date("2026-11-04T12:00:00Z");
let fx: FixtureProvider;
let attemptId: string;
let outingId: string;
let seeded: Awaited<ReturnType<typeof seedCollectingOuting>>;

async function insertAttempt(): Promise<string> {
  const p = seeded.payers[0];
  const [a] = await getDb()
    .insert(paymentAttempts)
    .values({
      outingId: seeded.outing.id,
      participantId: p.id,
      consentId: seeded.consents.get(p.id)!.id,
      quoteId: seeded.quote.id,
      provider: "FIXTURE",
      currency: "USD",
      requestedMinor: 2000,
    })
    .returning();
  return a.id;
}

beforeEach(async () => {
  clock = new Date("2026-11-04T12:00:00Z");
  fx = new FixtureProvider({ db: getDb(), now: () => clock });
  seeded = await seedCollectingOuting(getDb(), { now: clock });
  attemptId = await insertAttempt();
  outingId = seeded.outing.id;
});

async function authorized(amountMinor = 2000) {
  const order = await fx.createAuthorizeOrder({ requestId: `o-${attemptId}`, paymentAttemptId: attemptId, amountMinor, currency: "USD", description: "hold" });
  if (!order.ok) throw new Error(order.code);
  await fx.approveOrder(order.orderId);
  const auth = await fx.authorizeOrder({ orderId: order.orderId, requestId: `a-${attemptId}` });
  if (!auth.ok) throw new Error(auth.code);
  return { orderId: order.orderId, authorizationId: auth.authorization.authorizationId };
}

describe("FixtureProvider", () => {
  it("is labelled as a fixture and never verifies webhooks", async () => {
    expect(fx.name).toBe("FIXTURE");
    expect(fx.label).toBe(FIXTURE_PROVIDER_LABEL);
    expect(FIXTURE_PROVIDER_LABEL).toMatch(/not real PayPal/);
    expect(await fx.verifyWebhook()).toEqual({ ok: true, verified: false });
  });

  it("creates an order whose approval happens only on our fixture page; replays by requestId", async () => {
    const input = { requestId: "req-1", paymentAttemptId: attemptId, amountMinor: 2000, currency: "USD" as const, description: "hold" };
    const first = await fx.createAuthorizeOrder(input);
    expect(first).toMatchObject({ ok: true, providerStatus: "PAYER_ACTION_REQUIRED", approveUrl: `/o/${outingId}/pay/fixture?attempt=${attemptId}` });
    const replay = await fx.createAuthorizeOrder(input);
    expect(replay).toEqual(first);
    const other = await fx.createAuthorizeOrder({ ...input, requestId: "req-2" });
    expect(other.ok && first.ok && other.orderId !== first.orderId).toBe(true);
  });

  it("requires buyer approval before authorize; authorize is idempotent; create_time is server time, valid 29 days", async () => {
    const order = await fx.createAuthorizeOrder({ requestId: "o", paymentAttemptId: attemptId, amountMinor: 2000, currency: "USD", description: "hold" });
    if (!order.ok) throw new Error("order");
    expect(await fx.authorizeOrder({ orderId: order.orderId, requestId: "a1" })).toMatchObject({ ok: false, kind: "INVALID", code: "ORDER_NOT_APPROVED" });

    await fx.approveOrder(order.orderId);
    const a1 = await fx.authorizeOrder({ orderId: order.orderId, requestId: "a1" });
    expect(a1.ok).toBe(true);
    if (!a1.ok) return;
    expect(a1.authorization).toMatchObject({ status: "CREATED", amountMinor: 2000, currency: "USD", customId: attemptId, orderId: order.orderId });
    expect(a1.authorization.createTime).toEqual(clock);
    expect(a1.authorization.expirationTime).toEqual(new Date(clock.getTime() + FIXTURE_AUTHORIZATION_VALIDITY_MS));

    clock = new Date(clock.getTime() + 60_000);
    const replay = await fx.authorizeOrder({ orderId: order.orderId, requestId: "a1" });
    expect(replay).toEqual(a1); // stored result replayed verbatim, incl. the original create_time
    expect(await fx.authorizeOrder({ orderId: order.orderId, requestId: "a2" })).toMatchObject({ ok: false, code: "ORDER_ALREADY_AUTHORIZED" });

    const read = await fx.getOrder(order.orderId);
    expect(read.ok && read.order.status).toBe("COMPLETED");
    expect(read.ok && read.order.authorizations.map((a) => a.authorizationId)).toEqual([a1.authorization.authorizationId]);
  });

  it("reusing a requestId for a different operation is rejected", async () => {
    const { authorizationId } = await authorized();
    expect(await fx.voidAuthorization({ authorizationId, requestId: `a-${attemptId}` })).toMatchObject({ ok: false, code: "DUPLICATE_REQUEST_ID" });
  });

  it("captures at most the authorized amount, once, with final-capture semantics", async () => {
    const { authorizationId, orderId } = await authorized(2000);
    expect(await fx.captureAuthorization({ authorizationId, amountMinor: 2001, currency: "USD", requestId: "c0" })).toMatchObject({
      ok: false,
      kind: "INVALID",
      code: "MAX_CAPTURE_AMOUNT_EXCEEDED",
    });
    const cap = await fx.captureAuthorization({ authorizationId, amountMinor: 1000, currency: "USD", requestId: "c1" });
    expect(cap).toMatchObject({ ok: true, capture: { status: "COMPLETED", amountMinor: 1000, finalCapture: true } });
    // Replay returns the same capture; a second capture is refused.
    expect(await fx.captureAuthorization({ authorizationId, amountMinor: 1000, currency: "USD", requestId: "c1" })).toEqual(cap);
    expect(await fx.captureAuthorization({ authorizationId, amountMinor: 500, currency: "USD", requestId: "c2" })).toMatchObject({
      ok: false,
      code: "AUTHORIZATION_ALREADY_CAPTURED",
    });
    const auth = await fx.getAuthorization(authorizationId);
    expect(auth.ok && auth.authorization.status).toBe("CAPTURED");
    // getAuthorization carries the captures (the settlement engine reconciles from them).
    expect(auth.ok && auth.authorization.captures).toMatchObject([{ status: "COMPLETED", amountMinor: 1000, finalCapture: true }]);
    const raw = (await readFixtureObject(getDb(), authorizationId))?.data as { releasedMinor: number };
    expect(raw.releasedMinor).toBe(1000); // remainder released by the final capture
    const order = await fx.getOrder(orderId);
    expect(order.ok && order.order.authorizations[0].captures.map((c) => c.amountMinor)).toEqual([1000]);
  });

  it("a void after capture fails; capture after void is declined; voids are idempotent", async () => {
    const one = await authorized();
    await fx.captureAuthorization({ authorizationId: one.authorizationId, amountMinor: 2000, currency: "USD", requestId: "c" });
    expect(await fx.voidAuthorization({ authorizationId: one.authorizationId, requestId: "v" })).toMatchObject({
      ok: false,
      kind: "INVALID",
      code: "PREVIOUSLY_CAPTURED",
    });

    // second attempt row for a fresh authorization
    attemptId = await insertAttempt();
    const two = await authorized();
    const v1 = await fx.voidAuthorization({ authorizationId: two.authorizationId, requestId: "v2" });
    expect(v1).toEqual({ ok: true, providerStatus: "VOIDED" });
    expect(await fx.voidAuthorization({ authorizationId: two.authorizationId, requestId: "v2" })).toEqual(v1);
    expect(await fx.voidAuthorization({ authorizationId: two.authorizationId, requestId: "v3" })).toEqual({ ok: true, providerStatus: "VOIDED" });
    expect(await fx.captureAuthorization({ authorizationId: two.authorizationId, amountMinor: 100, currency: "USD", requestId: "c9" })).toMatchObject({
      ok: false,
      kind: "DECLINED",
      code: "AUTHORIZATION_VOIDED",
    });
  });

  it("authorizations expire after 29 days", async () => {
    const { authorizationId } = await authorized();
    clock = new Date(clock.getTime() + FIXTURE_AUTHORIZATION_VALIDITY_MS + 1);
    const read = await fx.getAuthorization(authorizationId);
    expect(read.ok && read.authorization.status).toBe("EXPIRED");
    expect(await fx.captureAuthorization({ authorizationId, amountMinor: 1000, currency: "USD", requestId: "c" })).toMatchObject({
      ok: false,
      kind: "DECLINED",
      code: "AUTHORIZATION_EXPIRED",
    });
  });

  it("concurrent captures with the same requestId produce exactly one capture", async () => {
    const { authorizationId } = await authorized();
    const req = { authorizationId, amountMinor: 1500, currency: "USD" as const, requestId: "same" };
    const [r1, r2, r3] = await Promise.all([fx.captureAuthorization(req), fx.captureAuthorization(req), fx.captureAuthorization(req)]);
    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    if (r1.ok && r2.ok && r3.ok) {
      expect(new Set([r1.capture.captureId, r2.capture.captureId, r3.capture.captureId]).size).toBe(1);
    }
  });

  it("failure injection: DECLINE leaves the hold untouched until cleared", async () => {
    const { authorizationId } = await authorized();
    await setFixtureFailure(getDb(), { authorizationId, operation: "CAPTURE", mode: "DECLINE" });
    expect(await fx.captureAuthorization({ authorizationId, amountMinor: 1000, currency: "USD", requestId: "c1" })).toMatchObject({
      ok: false,
      kind: "DECLINED",
      code: "INSTRUMENT_DECLINED",
    });
    const still = await fx.getAuthorization(authorizationId);
    expect(still.ok && still.authorization.status).toBe("CREATED");
    await clearFixtureFailure(getDb(), { authorizationId, operation: "CAPTURE" });
    // A failed request is not stored, so the same key can be retried after the cause is fixed.
    expect(await fx.captureAuthorization({ authorizationId, amountMinor: 1000, currency: "USD", requestId: "c1" })).toMatchObject({ ok: true });
  });

  it("failure injection: TIMEOUT_AFTER applies the operation, reports UNKNOWN, and the same requestId replays the real result", async () => {
    const { authorizationId, orderId } = await authorized();
    await setFixtureFailure(getDb(), { authorizationId, operation: "CAPTURE", mode: "TIMEOUT_AFTER" });
    const lost = await fx.captureAuthorization({ authorizationId, amountMinor: 1000, currency: "USD", requestId: "c1" });
    expect(lost).toMatchObject({ ok: false, kind: "UNKNOWN", code: "TIMEOUT" });
    const order = await fx.getOrder(orderId);
    expect(order.ok && order.order.authorizations[0].captures).toHaveLength(1);
    const retry = await fx.captureAuthorization({ authorizationId, amountMinor: 1000, currency: "USD", requestId: "c1" });
    expect(retry).toMatchObject({ ok: true, capture: { amountMinor: 1000, status: "COMPLETED" } });
  });

  it("failure injection: void DECLINE and TIMEOUT_AFTER; VOID cannot be PENDING", async () => {
    const { authorizationId } = await authorized();
    await expect(setFixtureFailure(getDb(), { authorizationId, operation: "VOID", mode: "PENDING" })).rejects.toThrow(/no PENDING/);
    await setFixtureFailure(getDb(), { authorizationId, operation: "VOID", mode: "DECLINE" });
    expect(await fx.voidAuthorization({ authorizationId, requestId: "v" })).toMatchObject({ ok: false, kind: "DECLINED" });
    await setFixtureFailure(getDb(), { authorizationId, operation: "VOID", mode: "TIMEOUT_AFTER" });
    expect(await fx.voidAuthorization({ authorizationId, requestId: "v" })).toMatchObject({ ok: false, kind: "UNKNOWN" });
    const read = await fx.getAuthorization(authorizationId);
    expect(read.ok && read.authorization.status).toBe("VOIDED");
  });

  it("failure injection: PENDING capture, then resolved", async () => {
    const { authorizationId, orderId } = await authorized();
    await setFixtureFailure(getDb(), { authorizationId, operation: "CAPTURE", mode: "PENDING" });
    const cap = await fx.captureAuthorization({ authorizationId, amountMinor: 1000, currency: "USD", requestId: "c" });
    expect(cap).toMatchObject({ ok: true, capture: { status: "PENDING" } });
    if (!cap.ok) return;
    await resolveFixturePending(getDb(), { kind: "CAPTURE", captureId: cap.capture.captureId, outcome: "COMPLETED" });
    const order = await fx.getOrder(orderId);
    expect(order.ok && order.order.authorizations[0].captures[0].status).toBe("COMPLETED");
  });

  it("refunds at most the captured amount; refund DECLINE / PENDING injection", async () => {
    const { authorizationId } = await authorized();
    const cap = await fx.captureAuthorization({ authorizationId, amountMinor: 2000, currency: "USD", requestId: "c" });
    if (!cap.ok) throw new Error("capture");
    const captureId = cap.capture.captureId;
    expect(await fx.refundCapture({ captureId, amountMinor: 2001, currency: "USD", requestId: "r0" })).toMatchObject({ ok: false, code: "REFUND_AMOUNT_EXCEEDED" });

    await setFixtureFailure(getDb(), { authorizationId, operation: "REFUND", mode: "DECLINE" });
    expect(await fx.refundCapture({ captureId, amountMinor: 2000, currency: "USD", requestId: "r1" })).toMatchObject({ ok: false, kind: "DECLINED" });
    await setFixtureFailure(getDb(), { authorizationId, operation: "REFUND", mode: "PENDING" });
    const pending = await fx.refundCapture({ captureId, amountMinor: 2000, currency: "USD", requestId: "r1" });
    expect(pending).toMatchObject({ ok: true, refund: { status: "PENDING", amountMinor: 2000 } });
    if (!pending.ok) return;
    // Reserved: no double refund while pending.
    expect(await fx.refundCapture({ captureId, amountMinor: 1, currency: "USD", requestId: "r2" })).toMatchObject({ ok: false, code: "REFUND_AMOUNT_EXCEEDED" });
    await resolveFixturePending(getDb(), { kind: "REFUND", refundId: pending.refund.refundId, outcome: "COMPLETED" });
    expect(await fx.getRefund(pending.refund.refundId)).toMatchObject({ ok: true, refund: { status: "COMPLETED" } });
    const order = await fx.getOrder((await fx.getAuthorization(authorizationId).then((a) => (a.ok ? a.authorization.orderId : ""))));
    expect(order.ok && order.order.authorizations[0].captures[0].status).toBe("REFUNDED");
  });

  it("unknown resources are INVALID (404), not UNKNOWN", async () => {
    expect(await fx.getOrder("FXORD-NOPE")).toMatchObject({ ok: false, kind: "INVALID", code: "RESOURCE_NOT_FOUND" });
    expect(await fx.captureAuthorization({ authorizationId: "FXAUTH-NOPE", amountMinor: 1, currency: "USD", requestId: "x" })).toMatchObject({
      ok: false,
      code: "RESOURCE_NOT_FOUND",
    });
  });
});
