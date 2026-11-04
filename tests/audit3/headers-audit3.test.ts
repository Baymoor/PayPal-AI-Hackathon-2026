/**
 * Third independent audit: security headers that must hold at RUNTIME.
 *
 * - `next.config.ts` `headers()` runs at BUILD time, so an image built without
 *   APP_BASE_URL (the Dockerfile) never sent Strict-Transport-Security even when the
 *   runtime APP_BASE_URL is https. The proxy (every page and API request) now sets it
 *   from the runtime environment as well.
 * - `X-Powered-By: Next.js` is a needless fingerprint; it is switched off.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import nextConfig from "@/next.config";
import { HSTS_VALUE, staticSecurityHeaders } from "@/lib/security/headers";
import { proxy } from "@/proxy";

afterEach(() => vi.unstubAllEnvs());

const env = (nodeEnv: string, appBaseUrl: string | undefined) => {
  vi.stubEnv("NODE_ENV", nodeEnv);
  if (appBaseUrl === undefined) vi.stubEnv("APP_BASE_URL", undefined as unknown as string);
  else vi.stubEnv("APP_BASE_URL", appBaseUrl);
};
const run = (url = "https://outings.example/o/abc") => proxy(new NextRequest(url));

describe("runtime security headers (proxy.ts)", () => {
  it("sends HSTS from the RUNTIME environment in production behind https", () => {
    env("production", "https://outings.example");
    const res = run();
    expect(res.headers.get("strict-transport-security")).toBe(HSTS_VALUE);
    // Same value as the build-time static header, so a host that has both sees one policy.
    expect(staticSecurityHeaders({ nodeEnv: "production", appBaseUrl: "https://outings.example" })).toContainEqual({
      key: "Strict-Transport-Security",
      value: HSTS_VALUE,
    });
    // The per-request CSP is still there.
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(res.headers.get("content-security-policy")).not.toContain("unsafe-eval");
  });

  it("never sends HSTS outside production or on a plain-http base URL", () => {
    env("production", "http://localhost:3000");
    expect(run("http://localhost:3000/").headers.get("strict-transport-security")).toBeNull();
    env("production", undefined);
    expect(run().headers.get("strict-transport-security")).toBeNull();
    env("development", "https://outings.example");
    expect(run().headers.get("strict-transport-security")).toBeNull();
  });
});

describe("next.config.ts", () => {
  it("does not advertise the framework (X-Powered-By off)", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
