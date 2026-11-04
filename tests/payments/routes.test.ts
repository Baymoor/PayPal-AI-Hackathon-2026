/** Thin route handlers: session lookup, same-origin, ownership, redirects. Uses the FIXTURE provider. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDatabaseUrl, useTestDb as setupTestDb } from "../helpers/db";
import { paymentAttempts } from "@/lib/db/schema";
import { closeDb } from "@/lib/db/client";
import { resetConfigForTests } from "@/lib/env";
import { FixtureProvider } from "@/lib/payments/fixture";
import { resetPaymentProviders, setPaymentProviderOverride } from "@/lib/payments";
import { POST as startRoute } from "@/app/api/outings/[id]/payments/route";
import { POST as withdrawRoute } from "@/app/api/outings/[id]/withdraw/route";
import { GET as returnRoute } from "@/app/api/payments/paypal/return/route";
import { GET as cancelRoute } from "@/app/api/payments/paypal/cancel/route";
import { POST as fixtureApproveRoute } from "@/app/api/payments/fixture/approve/route";
import { seedCollectingOuting, sessionCookie, useDemoConfig, type SeededOuting } from "./helpers";

const ORIGIN = "http://localhost:3301";
const getDb = setupTestDb(); // aliased: the shared helper is not a React hook
let s: SeededOuting;
let fx: FixtureProvider;

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl(); // route handlers use the shared pool
});

beforeEach(async () => {
  useDemoConfig();
  resetPaymentProviders();
  fx = new FixtureProvider({ db: getDb() });
  setPaymentProviderOverride("FIXTURE", fx);
  s = await seedCollectingOuting(getDb(), { now: new Date() });
});

afterAll(async () => {
  resetPaymentProviders();
  resetConfigForTests();
  await closeDb();
});

function req(path: string, init: { method?: string; cookie?: string; body?: string; contentType?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = { host: "localhost:3301" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.origin !== null && init.method && init.method !== "GET") headers.origin = init.origin ?? ORIGIN;
  if (init.body !== undefined) headers["content-type"] = init.contentType ?? "application/json";
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body: init.body });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const cookieFor = (participantId: string) => sessionCookie({ [s.outing.id]: participantId });

async function start(participantId: string, body: unknown = {}) {
  return startRoute(
    req(`/api/outings/${s.outing.id}/payments`, { method: "POST", cookie: cookieFor(participantId), body: JSON.stringify(body) }),
    params(s.outing.id),
  );
}

describe("POST /api/outings/:id/payments", () => {
  it("ignores any client amount: the hold is the consented cap", async () => {
    const res = await start(s.payers[0].id, { amountMinor: 1, termsHash: s.quote.termsHash });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { approveUrl: string; paymentAttemptId: string; providerLabel: string };
    expect(body.approveUrl).toBe(`/o/${s.outing.id}/pay/fixture?attempt=${body.paymentAttemptId}`);
    expect(body.providerLabel).toBe("Fixture — not real PayPal");
    const a = await getDb().query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, body.paymentAttemptId) });
    expect(a!.requestedMinor).toBe(2000);
  });

  it("needs a session (401) and a same-origin request (403)", async () => {
    const anon = await startRoute(req(`/api/outings/${s.outing.id}/payments`, { method: "POST", body: "{}" }), params(s.outing.id));
    expect(anon.status).toBe(401);
    const cross = await startRoute(
      req(`/api/outings/${s.outing.id}/payments`, { method: "POST", cookie: cookieFor(s.payers[0].id), body: "{}", origin: "https://evil.example" }),
      params(s.outing.id),
    );
    expect(cross.status).toBe(403);
  });

  it("returns 409 TERMS_CHANGED for a stale reviewed terms hash", async () => {
    const res = await start(s.payers[0].id, { termsHash: "stale" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "TERMS_CHANGED" } });
  });
});

describe("approval return / cancel / fixture routes", () => {
  it("fixture approval (HTML form post) authorizes and redirects to the outing", async () => {
    const started = (await (await start(s.payers[0].id)).json()) as { paymentAttemptId: string };
    const res = await fixtureApproveRoute(
      req("/api/payments/fixture/approve", {
        method: "POST",
        cookie: cookieFor(s.payers[0].id),
        contentType: "application/x-www-form-urlencoded",
        body: new URLSearchParams({ attemptId: started.paymentAttemptId, outcome: "APPROVE" }).toString(),
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/o/${s.outing.id}?payment=authorized`);
    expect((await getDb().query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, started.paymentAttemptId) }))!.status).toBe("AUTHORIZED");
  });

  it("fixture approval route is 404 when demo fixtures are off", async () => {
    const started = (await (await start(s.payers[0].id)).json()) as { paymentAttemptId: string };
    resetConfigForTests();
    useDemoConfig({ DEMO_FIXTURES_ENABLED: "false" });
    const res = await fixtureApproveRoute(
      req("/api/payments/fixture/approve", {
        method: "POST",
        cookie: cookieFor(s.payers[0].id),
        body: JSON.stringify({ attemptId: started.paymentAttemptId, outcome: "APPROVE" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("the return route authorizes only for the attempt's own participant", async () => {
    const started = (await (await start(s.payers[0].id)).json()) as { paymentAttemptId: string };
    const a = (await getDb().query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, started.paymentAttemptId) }))!;
    await fx.approveOrder(a.providerOrderId!); // buyer approved "at the provider"
    const path = `/api/payments/paypal/return?attempt=${a.id}&token=${a.providerOrderId}&PayerID=XYZ`;

    const intruder = await returnRoute(req(path, { cookie: cookieFor(s.payers[1].id) }));
    expect(intruder.status).toBe(303);
    expect(intruder.headers.get("location")).toBe(`/o/${s.outing.id}?payment=failed&reason=not_found`);
    expect((await getDb().query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, a.id) }))!.status).toBe("APPROVAL_PENDING");

    const noSession = await returnRoute(req(path));
    // No session for this outing: neutral redirect, the outing id is never revealed (see tests/audit/followup.test.ts).
    expect(noSession.headers.get("location")).toBe("/?payment=signin");

    const owner = await returnRoute(req(path, { cookie: cookieFor(s.payers[0].id) }));
    expect(owner.status).toBe(303);
    expect(owner.headers.get("location")).toBe(`/o/${s.outing.id}?payment=authorized`);
  });

  it("the cancel route abandons the attempt", async () => {
    const started = (await (await start(s.payers[0].id)).json()) as { paymentAttemptId: string };
    const res = await cancelRoute(req(`/api/payments/paypal/cancel?attempt=${started.paymentAttemptId}`, { cookie: cookieFor(s.payers[0].id) }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/o/${s.outing.id}?payment=cancelled`);
    expect((await getDb().query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, started.paymentAttemptId) }))!.status).toBe("FAILED");
  });

  it("unknown / malformed attempt ids are 404", async () => {
    expect((await returnRoute(req("/api/payments/paypal/return?attempt=nope&token=x"))).status).toBe(404);
    expect((await returnRoute(req("/api/payments/paypal/return?attempt=00000000-0000-4000-8000-000000000000&token=x"))).status).toBe(404);
  });
});

describe("POST /api/outings/:id/withdraw", () => {
  it("withdraws the caller", async () => {
    const res = await withdrawRoute(req(`/api/outings/${s.outing.id}/withdraw`, { method: "POST", cookie: cookieFor(s.payers[1].id) }), params(s.outing.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ withdrawn: true, earlyCancelScheduled: false });
  });
});
