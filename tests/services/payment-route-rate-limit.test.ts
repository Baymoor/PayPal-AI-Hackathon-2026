/**
 * POST /api/outings/:id/payments reaches the payment provider with our own
 * credentials on every call (a resumed approval replays the order request), so
 * it must be rate limited per client like every other mutation.
 *
 * Pure: requests carry no session, so the route answers before any database access.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as startPaymentRoute } from "@/app/api/outings/[id]/payments/route";
import { RATE_LIMITS, resetRateLimits } from "@/lib/rate-limit";

const OUTING_ID = "11111111-1111-4111-8111-111111111111";

function startPayment(): Promise<Response> {
  const req = new Request(`http://localhost/api/outings/${OUTING_ID}/payments`, { method: "POST", body: "{}" });
  return startPaymentRoute(req, { params: Promise.resolve({ id: OUTING_ID }) });
}

beforeEach(() => resetRateLimits());
afterEach(() => resetRateLimits());

describe("POST /api/outings/:id/payments", () => {
  it("answers 429 once one client has used its burst, before doing any work", async () => {
    for (let i = 0; i < RATE_LIMITS.mutation.capacity; i++) {
      expect((await startPayment()).status).toBe(401);
    }
    const limited = await startPayment();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});
