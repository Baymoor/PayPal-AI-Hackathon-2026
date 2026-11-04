/**
 * Trusted-proxy-aware client IP and the token-bucket limiter (lib/rate-limit.ts).
 * Pure unit tests: no database.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigForTests } from "@/lib/env";
import { clientIp, rateLimit, resetRateLimits, takeToken, UNKNOWN_CLIENT } from "@/lib/rate-limit";

const cfg = (env: Record<string, string | undefined> = {}) => loadConfig({ NODE_ENV: "test", ...env } as unknown as NodeJS.ProcessEnv);

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/outings", { method: "POST", headers });
}

beforeEach(() => {
  resetRateLimits();
  resetConfigForTests(cfg());
});

afterAll(() => {
  resetRateLimits();
  resetConfigForTests();
});

describe("TRUSTED_PROXY_HOPS config", () => {
  it("defaults to 0 when unset or empty and accepts whole numbers 0..10", () => {
    expect(cfg().trustedProxyHops).toBe(0);
    expect(cfg({ TRUSTED_PROXY_HOPS: "" }).trustedProxyHops).toBe(0);
    expect(cfg({ TRUSTED_PROXY_HOPS: "0" }).trustedProxyHops).toBe(0);
    expect(cfg({ TRUSTED_PROXY_HOPS: " 2 " }).trustedProxyHops).toBe(2);
    expect(cfg({ TRUSTED_PROXY_HOPS: "10" }).trustedProxyHops).toBe(10);
  });

  it.each(["-1", "1.5", "abc", "11", "0x1", "1e0"])("rejects %j", (v) => {
    expect(() => cfg({ TRUSTED_PROXY_HOPS: v })).toThrow(/TRUSTED_PROXY_HOPS/);
  });
});

describe("clientIp", () => {
  const spoofed = { "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.2", "x-real-ip": "198.51.100.1" };

  it("0 hops (default): trusts no forwarding header at all", () => {
    expect(clientIp(req(spoofed), 0)).toBe(UNKNOWN_CLIENT);
    expect(clientIp(req({ "x-real-ip": "198.51.100.1" }), 0)).toBe(UNKNOWN_CLIENT);
    expect(clientIp(req())).toBe(UNKNOWN_CLIENT); // default comes from config (0)
  });

  it("N hops: takes the N-th X-Forwarded-For entry from the right, never a client-supplied left entry", () => {
    expect(clientIp(req(spoofed), 1)).toBe("10.0.0.2");
    expect(clientIp(req(spoofed), 2)).toBe("203.0.113.7");
    expect(clientIp(req(spoofed), 3)).toBe("6.6.6.6");
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7" }), 1)).toBe("203.0.113.7");
    expect(clientIp(req({ "x-forwarded-for": " 203.0.113.7 ,  10.0.0.2 " }), 2)).toBe("203.0.113.7");
  });

  it("falls back to X-Real-IP when X-Forwarded-For is missing, too short or blank at that hop, then to 'unknown'", () => {
    expect(clientIp(req({ "x-real-ip": " 198.51.100.1 " }), 1)).toBe("198.51.100.1");
    expect(clientIp(req({ "x-forwarded-for": "10.0.0.2", "x-real-ip": "198.51.100.1" }), 2)).toBe("198.51.100.1");
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7, ", "x-real-ip": "198.51.100.1" }), 1)).toBe("198.51.100.1");
    expect(clientIp(req({ "x-forwarded-for": "10.0.0.2" }), 2)).toBe(UNKNOWN_CLIENT);
    expect(clientIp(req(), 1)).toBe(UNKNOWN_CLIENT);
  });

  it("reads the hop count from config and caps key length", () => {
    resetConfigForTests(cfg({ TRUSTED_PROXY_HOPS: "1" }));
    expect(clientIp(req(spoofed))).toBe("10.0.0.2");
    expect(clientIp(req({ "x-forwarded-for": `1.1.1.1, ${"a".repeat(200)}` }))).toHaveLength(64);
  });
});

describe("rateLimit keyed on the trusted client IP", () => {
  const rule = { capacity: 3, refillPerMinute: 3 };
  const T = 1_800_000_000_000;

  function statuses(headers: (i: number) => Record<string, string>, n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      try {
        rateLimit(req(headers(i)), "test:route", rule, T);
        out.push(200);
      } catch (e) {
        out.push((e as { status?: number }).status ?? 500);
      }
    }
    return out;
  }

  it("1 hop: rotating a spoofed left-most X-Forwarded-For entry does not escape the bucket", () => {
    resetConfigForTests(cfg({ TRUSTED_PROXY_HOPS: "1" }));
    expect(statuses((i) => ({ "x-forwarded-for": `192.0.2.${i}, 203.0.113.7` }), 5)).toEqual([200, 200, 200, 429, 429]);
    // A different real client (as seen by the trusted proxy) has its own bucket.
    expect(statuses(() => ({ "x-forwarded-for": "203.0.113.8" }), 1)).toEqual([200]);
  });

  it("0 hops: forwarding headers cannot mint fresh buckets; everyone shares one key per route", () => {
    expect(statuses((i) => ({ "x-forwarded-for": `192.0.2.${i}`, "x-real-ip": `198.51.100.${i}` }), 4)).toEqual([200, 200, 200, 429]);
    expect(statuses(() => ({}), 1)).toEqual([429]);
    // Buckets are per route.
    expect(() => rateLimit(req(), "other:route", rule, T)).not.toThrow();
  });

  it("buckets refill over time", () => {
    const key = "203.0.113.7|refill";
    for (let i = 0; i < 3; i++) expect(takeToken(key, rule, T)).toBe(true);
    expect(takeToken(key, rule, T)).toBe(false);
    expect(takeToken(key, rule, T + 20_000)).toBe(true); // 3/min -> one token after 20 s
    expect(takeToken(key, rule, T + 20_000)).toBe(false);
  });
});
