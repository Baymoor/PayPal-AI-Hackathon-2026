/**
 * /api/merchant/setup/* diagnostics routes: dashboard-password sessions only (never the one-click demo
 * sign-in), same-origin, rate-limited, secret-free. No database needed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resetConfigForTests } from "@/lib/env";
import { resetRateLimits } from "@/lib/rate-limit";
import { cookiePair } from "./helpers";
import { MERCHANT_COOKIE, encodeSigned, merchantCookie } from "@/lib/auth/session";

const aiMock = vi.hoisted(() => ({ extractBrief: vi.fn() }));
vi.mock("@/lib/ai", () => ({ getOutingsAi: () => ({ source: "ANTHROPIC", extractBrief: aiMock.extractBrief }) }));

import { POST as paypalPOST } from "@/app/api/merchant/setup/paypal/route";
import { POST as anthropicPOST } from "@/app/api/merchant/setup/anthropic/route";

const SECRETS = {
  PAYPAL_CLIENT_ID: "cid-FAKE-1234567890",
  PAYPAL_CLIENT_SECRET: "csecret-FAKE-abcdef",
  PAYPAL_WEBHOOK_ID: "whid-FAKE-777",
  OUTINGS_ANTHROPIC_API_KEY: "sk-ant-FAKE-zzzzzz",
  SESSION_SECRET: "session-FAKE-secret-value",
  CRON_SECRET: "cron-FAKE-secret-value",
  DATABASE_URL: "postgres://u:dbpass-FAKE@localhost/x",
};
const ACCESS_TOKEN = "tok-FAKE-access-token";

const cfg = (env: Record<string, string | undefined>) => loadConfig({ NODE_ENV: "test", ...env } as unknown as NodeJS.ProcessEnv);
const MERCHANT_ID = "00000000-0000-4000-8000-000000000001";
/** The owner: signed in with the dashboard password. */
const cookie = () => cookiePair(merchantCookie(MERCHANT_ID, "password"));
/** A visitor who used the one-click demo sign-in. */
const demoCookie = () => cookiePair(merchantCookie(MERCHANT_ID, "demo"));
/** A valid session issued before sessions recorded how they were opened. */
const legacyCookie = () => `${MERCHANT_COOKIE}=${encodeURIComponent(encodeSigned({ v: 1, merchantId: MERCHANT_ID, iat: Math.floor(Date.now() / 1000) }))}`;
const post = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000${path}`, { method: "POST", body: "{}", headers: { host: "localhost:3000", "content-type": "application/json", ...headers } });

beforeEach(() => {
  resetRateLimits();
  resetConfigForTests(cfg({ DEMO_FIXTURES_ENABLED: "true", SESSION_SECRET: SECRETS.SESSION_SECRET }));
  aiMock.extractBrief.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  resetConfigForTests();
  resetRateLimits();
});

const routes = [
  ["paypal", paypalPOST],
  ["anthropic", anthropicPOST],
] as const;

describe.each(routes)("%s route access control", (name, POST) => {
  const path = `/api/merchant/setup/${name}`;

  it("requires a merchant session (401)", async () => {
    const res = await POST(post(path));
    expect(res.status).toBe(401);
  });

  it("rejects a garbage / forged session cookie", async () => {
    const res = await POST(post(path, { cookie: "outings_m=forged.value" }));
    expect(res.status).toBe(401);
  });

  it("refuses the one-click demo sign-in (403) and calls nothing", async () => {
    resetConfigForTests(cfg({ ...SECRETS, DEMO_FIXTURES_ENABLED: "true" }));
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    for (const visitor of [demoCookie(), legacyCookie(), cookiePair(merchantCookie(MERCHANT_ID))]) {
      const res = await POST(post(path, { cookie: visitor }));
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(JSON.parse(text).error).toMatchObject({ code: "FORBIDDEN" });
      expect(JSON.parse(text).error.message).toMatch(/dashboard password/);
      for (const s of Object.values(SECRETS)) expect(text).not.toContain(s);
    }
    expect(f).not.toHaveBeenCalled();
    expect(aiMock.extractBrief).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests even with a valid session", async () => {
    const res = await POST(post(path, { cookie: cookie(), origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("is rate limited", async () => {
    let last = 200;
    for (let i = 0; i < 12; i++) last = (await POST(post(path, { cookie: cookie() }))).status;
    expect(last).toBe(429);
  });
});

describe("FIXTURE mode is labelled", () => {
  it("paypal: no credentials means a labelled NOT_CONFIGURED, and fetch is never called", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const res = await paypalPOST(post("/api/merchant/setup/paypal", { cookie: cookie() }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: false, mode: "FIXTURE", status: "NOT_CONFIGURED" });
    expect(body.label).toMatch(/FIXTURE/);
    expect(f).not.toHaveBeenCalled();
  });

  it("anthropic: no key means a clear message and no model call", async () => {
    const res = await anthropicPOST(post("/api/merchant/setup/anthropic", { cookie: cookie() }));
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, mode: "FIXTURE", status: "NOT_CONFIGURED" });
    expect(body.label).toMatch(/FIXTURE/);
    expect(body.message).toMatch(/No Anthropic key configured/);
    expect(aiMock.extractBrief).not.toHaveBeenCalled();
  });
});

describe("PayPal sandbox OAuth check (fetch mocked)", () => {
  beforeEach(() => {
    resetConfigForTests(cfg({ PAYPAL_CLIENT_ID: SECRETS.PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: SECRETS.PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID: SECRETS.PAYPAL_WEBHOOK_ID, SESSION_SECRET: SECRETS.SESSION_SECRET, CRON_SECRET: SECRETS.CRON_SECRET }));
  });
  const run = async () => {
    const res = await paypalPOST(post("/api/merchant/setup/paypal", { cookie: cookie() }));
    const text = await res.text();
    return { body: JSON.parse(text), text };
  };

  it("valid credentials: ok, no token or secrets in the response", async () => {
    const f = vi.fn<(...args: unknown[]) => Promise<Response>>(async () => new Response(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 32400 }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const { body, text } = await run();
    expect(body).toMatchObject({ ok: true, status: "CREDENTIALS_VALID", mode: "PAYPAL_SANDBOX" });
    expect(typeof body.latencyMs).toBe("number");
    expect(String(f.mock.calls[0]![0])).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    for (const s of [ACCESS_TOKEN, ...Object.values(SECRETS)]) expect(text).not.toContain(s);
  });

  it("401 means invalid credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 })));
    const { body, text } = await run();
    expect(body).toMatchObject({ ok: false, status: "INVALID_CREDENTIALS", httpStatus: 401 });
    for (const s of Object.values(SECRETS)) expect(text).not.toContain(s);
  });

  it("network error means PayPal unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const { body } = await run();
    expect(body).toMatchObject({ ok: false, status: "UNREACHABLE" });
  });
});

describe("Anthropic check (AI mocked)", () => {
  beforeEach(() => {
    resetConfigForTests(cfg({ OUTINGS_ANTHROPIC_API_KEY: SECRETS.OUTINGS_ANTHROPIC_API_KEY, OUTINGS_AI_MODEL: "claude-test-model", SESSION_SECRET: SECRETS.SESSION_SECRET }));
  });

  it("returns ok, model, latency and summary rows without the key", async () => {
    aiMock.extractBrief.mockResolvedValue({ source: "ANTHROPIC", model: "claude-test-model", warnings: [], output: { summary: [{ icon: "people", text: "4 people" }] } });
    const res = await anthropicPOST(post("/api/merchant/setup/anthropic", { cookie: cookie() }));
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, status: "OK", model: "claude-test-model", summary: [{ icon: "people", text: "4 people" }] });
    expect(text).not.toContain(SECRETS.OUTINGS_ANTHROPIC_API_KEY);
  });

  it("a failing call is reported without leaking the error text or key", async () => {
    aiMock.extractBrief.mockRejectedValue(Object.assign(new Error(`401 invalid x-api-key ${SECRETS.OUTINGS_ANTHROPIC_API_KEY}`), { status: 401 }));
    const res = await anthropicPOST(post("/api/merchant/setup/anthropic", { cookie: cookie() }));
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: false, status: "ERROR", httpStatus: 401 });
    expect(text).not.toContain(SECRETS.OUTINGS_ANTHROPIC_API_KEY);
  });
});
