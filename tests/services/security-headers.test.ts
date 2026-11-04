import { describe, expect, it } from "vitest";
import { buildCsp, generateNonce, shouldSendHsts, staticSecurityHeaders } from "@/lib/security/headers";

describe("security headers", () => {
  it("production CSP is strict and has no eval", () => {
    const csp = buildCsp({ nonce: "abc", isDev: false });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("ws:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self' https://www.sandbox.paypal.com https://www.paypal.com");
  });

  it("dev CSP allows unsafe-eval and websockets only in dev", () => {
    const csp = buildCsp({ nonce: "abc", isDev: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("ws:");
  });

  it("nonces are unique", () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });

  it("HSTS only for production with https APP_BASE_URL", () => {
    expect(shouldSendHsts({ nodeEnv: "production", appBaseUrl: "https://x.example" })).toBe(true);
    expect(shouldSendHsts({ nodeEnv: "production", appBaseUrl: "http://localhost:3000" })).toBe(false);
    expect(shouldSendHsts({ nodeEnv: "production", appBaseUrl: undefined })).toBe(false);
    expect(shouldSendHsts({ nodeEnv: "development", appBaseUrl: "https://x.example" })).toBe(false);
    const keys = staticSecurityHeaders({ nodeEnv: "development", appBaseUrl: undefined }).map((h) => h.key);
    expect(keys).not.toContain("Strict-Transport-Security");
    expect(keys).toEqual(expect.arrayContaining(["Referrer-Policy", "X-Content-Type-Options", "X-Frame-Options", "Permissions-Policy"]));
  });
});
