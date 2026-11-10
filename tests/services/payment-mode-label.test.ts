/**
 * The payment mode a participant's screen describes is per OUTING, not per
 * deployment. The hosted demo runs with PayPal sandbox keys AND demo outings
 * that always pay through the simulator; those must never read "PayPal sandbox".
 *
 * Pure: no database (config only).
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigForTests } from "@/lib/env";
import { paymentModeForOuting, providerNameForOuting } from "@/lib/services/payments";

const PAYPAL_KEYS = { PAYPAL_CLIENT_ID: "sandbox-client", PAYPAL_CLIENT_SECRET: "sandbox-secret" };
const DEMO_ON = { DEMO_FIXTURES_ENABLED: "true" };
const demoOuting = { isFixture: true };
const realOuting = { isFixture: false };

function useEnv(env: Record<string, string>): void {
  resetConfigForTests(loadConfig(env as NodeJS.ProcessEnv));
}

afterEach(() => resetConfigForTests());

describe("paymentModeForOuting", () => {
  it("labels a demo outing FIXTURE on a deployment with PayPal sandbox keys", () => {
    useEnv({ ...PAYPAL_KEYS, ...DEMO_ON });
    expect(paymentModeForOuting(demoOuting)).toBe("FIXTURE");
    expect(paymentModeForOuting(realOuting)).toBe("PAYPAL_SANDBOX");
  });

  it("labels every outing FIXTURE when there are no PayPal keys", () => {
    useEnv(DEMO_ON);
    expect(paymentModeForOuting(demoOuting)).toBe("FIXTURE");
    expect(paymentModeForOuting(realOuting)).toBe("FIXTURE");
  });

  it("labels a demo outing DISABLED, never PayPal sandbox, once the simulator is switched off", () => {
    useEnv(PAYPAL_KEYS);
    expect(paymentModeForOuting(demoOuting)).toBe("DISABLED");
    expect(paymentModeForOuting(realOuting)).toBe("PAYPAL_SANDBOX");
  });

  it("agrees with the provider a new payment attempt would use", () => {
    for (const env of [{ ...PAYPAL_KEYS, ...DEMO_ON }, DEMO_ON]) {
      useEnv(env);
      for (const outing of [demoOuting, realOuting]) {
        const simulated = providerNameForOuting(outing) === "FIXTURE";
        expect(paymentModeForOuting(outing) === "FIXTURE").toBe(simulated);
      }
    }
  });
});
