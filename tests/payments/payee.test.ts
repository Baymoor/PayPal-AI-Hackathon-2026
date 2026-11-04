/**
 * PayPal payee comes from the outing's merchant row (merchants.paypal_merchant_id),
 * falling back to PAYPAL_MERCHANT_ID, else omitted — both when the order is
 * created and when the authorization's payee is verified.
 *
 * Drives the real payment service + the real PayPal adapter against a MOCKED
 * fetch (request shapes only; not proof of live sandbox behaviour).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb as setupTestDb } from "../helpers/db";
import { merchants, paymentAttempts, paymentOperations } from "@/lib/db/schema";
import { resetConfigForTests } from "@/lib/env";
import { resetPaymentProviders, setPaymentProviderOverride } from "@/lib/payments";
import { FixtureProvider } from "@/lib/payments/fixture";
import { PaypalProvider } from "@/lib/payments/paypal";
import type { CreatedOrder, CreateOrderInput, ProviderResult } from "@/lib/payments/provider";
import { completeApproval, expectedPayeeFor, startPayment } from "@/lib/services/payments";
import { seedCatalogue } from "@/lib/demo/seed";
import { DEMO_MERCHANT_SLUG } from "@/lib/demo/constants";
import { seedCollectingOuting, useDemoConfig, type SeededOuting } from "./helpers";

const getDb = setupTestDb();
const T0 = new Date("2026-11-04T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

const ROW_PAYEE = "ROWMERCHANT01";
const ENV_PAYEE = "ENVMERCHANT01";
const CALLER_PAYEE = "APICALLER0001";
const ORDER_ID = "5O190127TN364715T";
const paypalEnv = (merchantId?: string) => ({
  PAYPAL_CLIENT_ID: "sandbox-client",
  PAYPAL_CLIENT_SECRET: "sandbox-secret",
  ...(merchantId ? { PAYPAL_MERCHANT_ID: merchantId } : {}),
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface CreateBody {
  purchase_units: { custom_id: string; amount: { currency_code: string; value: string }; payee?: Record<string, string> }[];
}

/**
 * Minimal mocked PayPal sandbox: creates one order and authorizes it, echoing
 * the order's payee on the authorization unless `authPayee` overrides it
 * (PayPal pays the API caller when no payee was sent).
 */
function fakePaypal(opts: { envMerchantId?: string; authPayee?: Record<string, string> } = {}) {
  const created: CreateBody[] = [];
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    if (url.endsWith("/v1/oauth2/token")) return json(200, { access_token: "test-token", token_type: "Bearer", expires_in: 32_400 });
    const body = typeof init.body === "string" && init.body ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.endsWith("/v2/checkout/orders") && init.method === "POST") {
      created.push(body as CreateBody);
      return json(201, {
        id: ORDER_ID,
        status: "PAYER_ACTION_REQUIRED",
        links: [{ href: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`, rel: "payer-action", method: "GET" }],
      });
    }
    if (url.endsWith(`/v2/checkout/orders/${ORDER_ID}/authorize`) && init.method === "POST") {
      const unit = created[created.length - 1].purchase_units[0];
      const auth = {
        id: "3C679366HH908993F",
        status: "CREATED",
        amount: unit.amount,
        custom_id: unit.custom_id,
        expiration_time: at(29 * 24 * HOUR).toISOString(),
        create_time: at(60_000).toISOString(),
        payee: opts.authPayee ?? unit.payee ?? { merchant_id: CALLER_PAYEE },
        links: [],
      };
      return json(201, { id: ORDER_ID, status: "COMPLETED", intent: "AUTHORIZE", purchase_units: [{ custom_id: unit.custom_id, amount: unit.amount, payments: { authorizations: [auth] } }] });
    }
    return json(404, { name: "RESOURCE_NOT_FOUND", message: `unexpected ${init.method} ${url}` });
  };
  // Mirrors PaypalProvider.fromConfig(): the adapter's own fallback is PAYPAL_MERCHANT_ID.
  const provider = new PaypalProvider({ clientId: "client-id", clientSecret: "client-secret", fetch: fetchFn, merchantId: opts.envMerchantId });
  return { provider, created };
}

let s: SeededOuting;

beforeEach(async () => {
  useDemoConfig();
  resetPaymentProviders();
  s = await seedCollectingOuting(getDb(), { now: T0, deadlineInMs: HOUR });
});

afterAll(() => {
  resetPaymentProviders();
  resetConfigForTests();
});

async function setRowPayee(value: string | null) {
  await getDb().update(merchants).set({ paypalMerchantId: value }).where(eq(merchants.id, s.quote.merchantId));
}

/** Configure PayPal sandbox mode with the mocked adapter, start + approve one payer's hold. */
async function payThroughPaypal(opts: { envMerchantId?: string; authPayee?: Record<string, string> }) {
  useDemoConfig(paypalEnv(opts.envMerchantId));
  resetPaymentProviders();
  const pp = fakePaypal(opts);
  setPaymentProviderOverride("PAYPAL", pp.provider);
  const payer = s.payers[0];
  const started = await startPayment(getDb(), { outingId: s.outing.id, participantId: payer.id, now: T0 });
  expect(started.provider).toBe("PAYPAL");
  const approved = await completeApproval(getDb(), { attemptId: started.paymentAttemptId, participantId: payer.id, orderId: ORDER_ID, now: at(60_000) });
  const attempt = await getDb().query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, started.paymentAttemptId) });
  const ops = await getDb().select().from(paymentOperations).where(eq(paymentOperations.paymentAttemptId, started.paymentAttemptId));
  return { sentPayee: pp.created[0].purchase_units[0].payee, outcome: approved.outcome, attempt: attempt!, ops };
}

describe("PayPal payee from the merchant row", () => {
  it("orders are paid to merchants.paypal_merchant_id (over PAYPAL_MERCHANT_ID) and that payee is accepted on authorization", async () => {
    await setRowPayee(ROW_PAYEE);
    const r = await payThroughPaypal({ envMerchantId: ENV_PAYEE });
    expect(r.sentPayee).toEqual({ merchant_id: ROW_PAYEE });
    expect(r.outcome).toBe("AUTHORIZED");
    expect(r.attempt.status).toBe("AUTHORIZED");
    expect(r.ops).toHaveLength(0);
  });

  it("an email in the merchant row is sent as payee.email_address", async () => {
    await setRowPayee("sound-room@business.example.com");
    const r = await payThroughPaypal({ envMerchantId: ENV_PAYEE, authPayee: { email_address: "sound-room@business.example.com" } });
    expect(r.sentPayee).toEqual({ email_address: "sound-room@business.example.com" });
    expect(r.outcome).toBe("AUTHORIZED");
  });

  it.each([null, "   "])("falls back to PAYPAL_MERCHANT_ID when the merchant row has no payee (%j)", async (row) => {
    await setRowPayee(row);
    const r = await payThroughPaypal({ envMerchantId: ENV_PAYEE });
    expect(r.sentPayee).toEqual({ merchant_id: ENV_PAYEE });
    expect(r.outcome).toBe("AUTHORIZED");
  });

  it("omits the payee when neither the row nor PAYPAL_MERCHANT_ID is set (no payee check)", async () => {
    await setRowPayee(null);
    const r = await payThroughPaypal({});
    expect(r.sentPayee).toBeUndefined();
    expect(r.outcome).toBe("AUTHORIZED");
    expect(r.attempt.status).toBe("AUTHORIZED");
  });

  it("an authorization paid to anyone but the merchant row's payee is a PAYEE mismatch: never admitted, VOID planned", async () => {
    await setRowPayee(ROW_PAYEE);
    // Even the deployment-wide PAYPAL_MERCHANT_ID is the wrong payee once the merchant row names one.
    const r = await payThroughPaypal({ envMerchantId: ENV_PAYEE, authPayee: { merchant_id: ENV_PAYEE } });
    expect(r.sentPayee).toEqual({ merchant_id: ROW_PAYEE });
    expect(r.outcome).toBe("FAILED");
    expect(r.attempt.status).toBe("VOID_PENDING");
    expect(r.attempt.lastError).toMatch(/AUTHORIZATION_MISMATCH: PAYEE/);
    expect(r.ops).toMatchObject([{ kind: "VOID", amountMinor: 2000 }]);
  });

  it("verification falls back to PAYPAL_MERCHANT_ID when the merchant row is empty", async () => {
    await setRowPayee(null);
    const r = await payThroughPaypal({ envMerchantId: ENV_PAYEE, authPayee: { merchant_id: "SOMEONEELSE01" } });
    expect(r.outcome).toBe("FAILED");
    expect(r.attempt.lastError).toMatch(/AUTHORIZATION_MISMATCH: PAYEE/);
    expect(r.ops).toMatchObject([{ kind: "VOID" }]);
  });
});

describe("FIXTURE attempts and the resolver", () => {
  class SpyFixture extends FixtureProvider {
    inputs: CreateOrderInput[] = [];
    override async createAuthorizeOrder(input: CreateOrderInput): Promise<ProviderResult<CreatedOrder>> {
      this.inputs.push(input);
      return super.createAuthorizeOrder(input);
    }
  }

  it("FIXTURE orders never carry a payee, even when the merchant row has one", async () => {
    await setRowPayee(ROW_PAYEE);
    const fx = new SpyFixture({ db: getDb(), now: () => T0 });
    setPaymentProviderOverride("FIXTURE", fx);
    const r = await startPayment(getDb(), { outingId: s.outing.id, participantId: s.payers[0].id, now: T0 });
    expect(r.provider).toBe("FIXTURE");
    expect(fx.inputs).toHaveLength(1);
    expect(fx.inputs[0]).not.toHaveProperty("payeeMerchantId");
  });

  it("expectedPayeeFor: row, then PAYPAL_MERCHANT_ID, else undefined; FIXTURE always undefined", async () => {
    await setRowPayee(ROW_PAYEE);
    useDemoConfig(paypalEnv(ENV_PAYEE));
    expect(await expectedPayeeFor(getDb(), "PAYPAL", s.quote.merchantId)).toBe(ROW_PAYEE);
    expect(await expectedPayeeFor(getDb(), "PAYPAL", null)).toBe(ENV_PAYEE);
    expect(await expectedPayeeFor(getDb(), "FIXTURE", s.quote.merchantId)).toBeUndefined();
    useDemoConfig(paypalEnv());
    expect(await expectedPayeeFor(getDb(), "PAYPAL", null)).toBeUndefined();
  });
});

describe("demo seed and the payee column", () => {
  const demoMerchant = () => getDb().query.merchants.findFirst({ where: eq(merchants.slug, DEMO_MERCHANT_SLUG) });

  it("leaves paypal_merchant_id null by default, copies PAYPAL_MERCHANT_ID when set, and keeps a manually set value on re-seed", async () => {
    await seedCatalogue(getDb());
    expect((await demoMerchant())!.paypalMerchantId).toBeNull();

    await getDb().update(merchants).set({ paypalMerchantId: ROW_PAYEE }).where(eq(merchants.slug, DEMO_MERCHANT_SLUG));
    await seedCatalogue(getDb());
    expect((await demoMerchant())!.paypalMerchantId).toBe(ROW_PAYEE);

    useDemoConfig(paypalEnv(ENV_PAYEE));
    await seedCatalogue(getDb());
    expect((await demoMerchant())!.paypalMerchantId).toBe(ENV_PAYEE);
  });
});
