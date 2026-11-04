import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../helpers/db";
import { jobs, webhookEvents } from "@/lib/db/schema";
import { loadConfig, resetConfigForTests } from "@/lib/env";
import { handlePaypalWebhook, redactWebhookPayload } from "@/lib/webhooks/paypal";
import { FakeProvider } from "./fake-provider";
import { buildOuting, payers, resolverFor } from "./builders";

const getDb = useTestDb();

function configured(webhookId: string | undefined) {
  resetConfigForTests(
    loadConfig({
      NODE_ENV: "test",
      PAYPAL_CLIENT_ID: "client",
      PAYPAL_CLIENT_SECRET: "secret",
      PAYPAL_WEBHOOK_ID: webhookId,
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
    } as NodeJS.ProcessEnv),
  );
}

function event(overrides: Record<string, unknown> = {}, resource: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "WH-EVENT-1",
    event_type: "PAYMENT.AUTHORIZATION.CREATED",
    resource_type: "authorization",
    create_time: new Date().toISOString(),
    resource: {
      id: "auth-1-1",
      status: "CREATED",
      amount: { currency_code: "USD", value: "20.00" },
      payer: { email_address: "buyer@example.com", name: { given_name: "Buyer", surname: "One" } },
      ...resource,
    },
    ...overrides,
  });
}

const headers = new Headers({ "paypal-transmission-id": "t1", "paypal-transmission-sig": "sig" });

describe("PayPal webhook intake", () => {
  beforeEach(() => configured("WH-123"));
  afterEach(() => resetConfigForTests());

  it("rejects everything when PAYPAL_WEBHOOK_ID is not configured", async () => {
    configured(undefined);
    const db = getDb();
    const fake = new FakeProvider();
    const r = await handlePaypalWebhook(db, resolverFor(fake), { headers, rawBody: event() });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("NOT_CONFIGURED");
    expect(fake.calls.verifyWebhook).toBe(0);
    expect(await db.query.webhookEvents.findMany()).toHaveLength(0);
  });

  it("rejects an unverified delivery and stores nothing", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    fake.webhookVerified = false;
    const r = await handlePaypalWebhook(db, resolverFor(fake), { headers, rawBody: event() });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("VERIFICATION_FAILED");
    expect(await db.query.webhookEvents.findMany()).toHaveLength(0);
    expect(await db.query.jobs.findMany()).toHaveLength(0);
  });

  it("verified event → stored redacted, matched to the attempt, reconcile job enqueued; duplicate is a no-op", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), provider: fake });
    const attempt = built.people[0]!;
    const body = event({}, { id: attempt.authorizationId, custom_id: attempt.attemptId });

    const r = await handlePaypalWebhook(db, resolverFor(fake), { headers, rawBody: body });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe("RECONCILE_ENQUEUED");
    expect(r.body.paymentAttemptId).toBe(attempt.attemptId);

    const stored = await db.query.webhookEvents.findFirst({ where: eq(webhookEvents.providerEventId, "WH-EVENT-1") });
    expect(stored?.verified).toBe(true);
    expect(stored?.processedAt).not.toBeNull();
    expect(JSON.stringify(stored?.payload)).not.toContain("buyer@example.com");
    expect(JSON.stringify(stored?.payload)).not.toContain("Buyer");
    expect((stored?.payload as { resource: { payer: unknown } }).resource.payer).toBe("[redacted]");

    const queued = await db.query.jobs.findMany({ where: eq(jobs.kind, "RECONCILE_PAYMENT") });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({ paymentAttemptId: attempt.attemptId, source: "WEBHOOK" });

    const dup = await handlePaypalWebhook(db, resolverFor(fake), { headers, rawBody: body });
    expect(dup.status).toBe(200);
    expect(dup.body.code).toBe("DUPLICATE");
    expect(await db.query.webhookEvents.findMany()).toHaveLength(1);
    expect(await db.query.jobs.findMany({ where: eq(jobs.kind, "RECONCILE_PAYMENT") })).toHaveLength(1);
  });

  it("flags amount / currency inconsistencies but still reconciles from provider state", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), provider: fake });
    const attempt = built.people[1]!;
    const body = event({ id: "WH-EVENT-2" }, { id: attempt.authorizationId, amount: { currency_code: "USD", value: "25.00" } });
    const r = await handlePaypalWebhook(db, resolverFor(fake), { headers, rawBody: body });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe("RECONCILE_ENQUEUED");
    expect(r.body.note).toMatch(/authorization amount 2500 != requested 2000/);
    const stored = await db.query.webhookEvents.findFirst({ where: eq(webhookEvents.providerEventId, "WH-EVENT-2") });
    expect(stored?.processingError).toMatch(/2500/);
  });

  it("maps capture events via related authorization id and ignores unknown resources", async () => {
    const db = getDb();
    const fake = new FakeProvider();
    const built = await buildOuting(db, { people: payers(5), provider: fake });
    const attempt = built.people[2]!;
    const capture = event(
      { id: "WH-EVENT-3", event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture" },
      { id: "cap-xyz", status: "COMPLETED", supplementary_data: { related_ids: { authorization_id: attempt.authorizationId } } },
    );
    const r = await handlePaypalWebhook(db, resolverFor(fake), { headers, rawBody: capture });
    expect(r.body.code).toBe("RECONCILE_ENQUEUED");
    expect(r.body.paymentAttemptId).toBe(attempt.attemptId);

    const unknown = event({ id: "WH-EVENT-4", event_type: "PAYMENT.CAPTURE.DENIED" }, { id: "cap-nobody", supplementary_data: {} });
    const u = await handlePaypalWebhook(db, resolverFor(fake), { headers, rawBody: unknown });
    expect(u.status).toBe(200);
    expect(u.body.code).toBe("NO_MATCHING_ATTEMPT");

    const other = await handlePaypalWebhook(db, resolverFor(fake), { headers, rawBody: event({ id: "WH-EVENT-5", event_type: "BILLING.PLAN.CREATED" }) });
    expect(other.body.code).toBe("IGNORED_EVENT");

    const bad = await handlePaypalWebhook(db, resolverFor(fake), { headers, rawBody: "{not json" });
    expect(bad.status).toBe(400);
  });

  it("redacts nested PII keys", () => {
    const out = redactWebhookPayload({ resource: { payer: { email_address: "x" }, shipping: { address: {} }, amount: { value: "1.00" } } }) as {
      resource: { payer: unknown; shipping: unknown; amount: { value: string } };
    };
    expect(out.resource.payer).toBe("[redacted]");
    expect(out.resource.shipping).toBe("[redacted]");
    expect(out.resource.amount.value).toBe("1.00");
  });
});
