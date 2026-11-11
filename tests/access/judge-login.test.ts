/**
 * Judge sign-in through the real route handlers: the login itself, the session cookie, and every place the
 * gate decides between real resources (outing creation, Claude) and the free demo paths.
 *
 * The credentials here are made up for the tests. The real password only ever exists on the server.
 */
import { describe, expect, it, vi } from "vitest";
import { body, cookiePair, merchantCookieFor, request, setupServiceTests, testConfig, TEST_SESSION_SECRET } from "../services/helpers";
import { aiState, FakeAi } from "../services/fake-ai";
import {
  JUDGE_COOKIE,
  JUDGE_SESSION_EXPIRES_AT,
  hasJudgeSession,
  isJudgeRequest,
  judgeCookie,
  judgeGateEnabled,
  judgeLoginHref,
  requireJudge,
  safeNextPath,
} from "@/lib/auth/judge";
import { encodeSigned } from "@/lib/auth/session";
import { aiRuns } from "@/lib/db/schema";
import { loadConfig, resetConfigForTests } from "@/lib/env";
import { ServiceError } from "@/lib/http";
import { seedCatalogue } from "@/lib/demo/seed";

import * as loginRoute from "@/app/api/judge/login/route";
import * as logoutRoute from "@/app/api/judge/logout/route";
import * as sessionRoute from "@/app/api/judge/session/route";
import * as createRoute from "@/app/api/outings/route";
import * as aiQueryRoute from "@/app/api/merchant/ai/query/route";
import * as studioRoute from "@/app/api/merchant/ai/studio/route";

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  const { aiState: state } = await import("../services/fake-ai");
  return { ...actual, getOutingsAi: () => state.current };
});

const getDb = setupServiceTests();

const JUDGE_USERNAME = "test-judge";
const JUDGE_PASSWORD = "made-up-judge-password-for-tests";
const NEW_OUTING = { organizerName: "Alex", brief: "Karaoke for Maya's birthday on Friday" };

/** Switches the judge gate on for the current test (setupServiceTests restores the gate-off config before each). */
function gateOn(overrides: Record<string, string | undefined> = {}): void {
  resetConfigForTests(testConfig({ JUDGE_USERNAME, JUDGE_PASSWORD, ...overrides }));
}

const login = (credentials: unknown, headers?: Record<string, string>) => loginRoute.POST(request("/api/judge/login", { body: credentials, headers }));
const judgeCookiePair = () => cookiePair(judgeCookie());
const withCookie = (cookie: string) => request("/x", { cookie });
const signedJudgeCookie = (session: unknown, secret?: string) => `${JUDGE_COOKIE}=${encodeURIComponent(encodeSigned(session, secret))}`;

describe("judge gate configuration", () => {
  it("is off without JUDGE_PASSWORD (also when it is blank), and then everyone counts as a judge", () => {
    expect(judgeGateEnabled()).toBe(false);
    resetConfigForTests(testConfig({ JUDGE_PASSWORD: "   " }));
    expect(judgeGateEnabled()).toBe(false);
    expect(isJudgeRequest(request("/x"))).toBe(true);
    expect(() => requireJudge(request("/x"))).not.toThrow();
    // ...but nobody holds a judge session, so the footer never claims "Signed in as judge".
    expect(hasJudgeSession(request("/x"))).toBe(false);
  });

  it("is on with JUDGE_PASSWORD; the username defaults to judge", () => {
    const cfg = testConfig({ JUDGE_PASSWORD });
    expect(cfg.judge).toEqual({ username: "judge", password: JUDGE_PASSWORD });
    expect(testConfig({ JUDGE_PASSWORD, JUDGE_USERNAME }).judge?.username).toBe(JUDGE_USERNAME);
  });

  it("refuses a password shorter than 16 characters, without echoing it", () => {
    const load = () => loadConfig({ NODE_ENV: "test", JUDGE_PASSWORD: "short-pass-15ch" } as unknown as NodeJS.ProcessEnv);
    expect(load).toThrow(/JUDGE_PASSWORD must be at least 16 characters/);
    expect(load).not.toThrow(/short-pass-15ch/);
    expect(testConfig({ JUDGE_PASSWORD: "exactly-16-chars" }).judge).not.toBeNull();
  });
});

describe("POST /api/judge/login", () => {
  it("sets a signed, httpOnly, SameSite=Lax cookie that expires on 22 Dec 2026", async () => {
    gateOn();
    const res = await login({ username: JUDGE_USERNAME, password: JUDGE_PASSWORD });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^outings_judge=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Expires=Tue, 22 Dec 2026 00:00:00 GMT");
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).not.toContain(JUDGE_PASSWORD);
    expect(decodeURIComponent(cookiePair(setCookie))).not.toContain(JUDGE_PASSWORD);

    const cookie = cookiePair(setCookie);
    expect(hasJudgeSession(withCookie(cookie))).toBe(true);
    expect(() => requireJudge(withCookie(cookie))).not.toThrow();
    const state = await body(await sessionRoute.GET(request("/api/judge/session", { cookie })));
    expect(state).toEqual({ gateEnabled: true, signedIn: true });
  });

  it("marks the cookie Secure in production", () => {
    gateOn({ NODE_ENV: "production" });
    expect(judgeCookie()).toContain("; Secure");
  });

  it("gives the same generic error for a wrong username and for a wrong password", async () => {
    gateOn();
    const wrongUser = await login({ username: "someone-else", password: JUDGE_PASSWORD });
    const wrongPass = await login({ username: JUDGE_USERNAME, password: "not-the-judge-password" });
    const bothWrong = await login({ username: "", password: "" });
    const answers = await Promise.all([wrongUser, wrongPass, bothWrong].map(async (res) => ({ status: res.status, cookie: res.headers.get("set-cookie"), body: await res.text() })));
    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.cookie).toBeNull();
      expect(JSON.parse(answer.body)).toEqual({ error: { code: "INVALID_CREDENTIALS", message: "Wrong username or password" } });
    }
    expect(new Set(answers.map((a) => a.body)).size).toBe(1);
  });

  it("is switched off (503) when the gate is off, whatever is sent", async () => {
    const res = await login({ username: "judge", password: "" });
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects cross-origin posts on login and logout", async () => {
    gateOn();
    const evil = { origin: "https://evil.example", host: "localhost:3000" };
    const res = await login({ username: JUDGE_USERNAME, password: JUDGE_PASSWORD }, evil);
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await logoutRoute.POST(request("/api/judge/logout", { body: {}, headers: evil }))).status).toBe(403);
  });

  it("locks out after 5 wrong attempts: even the right password is refused until the bucket refills", async () => {
    gateOn();
    for (let i = 0; i < 5; i++) expect((await login({ username: JUDGE_USERNAME, password: `wrong-guess-number-${i}` })).status).toBe(401);
    const locked = await login({ username: JUDGE_USERNAME, password: JUDGE_PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("60");
    expect(locked.headers.get("set-cookie")).toBeNull();
    expect((await body<{ error: { code: string } }>(locked)).error.code).toBe("RATE_LIMITED");
  });

  it("a burst of concurrent wrong guesses gets no more than the 5 the failure limit allows", async () => {
    gateOn();
    const burst = await Promise.all(Array.from({ length: 9 }, (_, i) => login({ username: JUDGE_USERNAME, password: `concurrent-wrong-guess-${i}` })));
    const statuses = burst.map((res) => res.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
    for (const res of burst) expect(res.headers.get("set-cookie")).toBeNull();
    // The bucket is empty now: the right password is refused too.
    expect((await login({ username: JUDGE_USERNAME, password: JUDGE_PASSWORD })).status).toBe(429);
  });

  it("correct sign-ins are not charged to the failure bucket, alone or in a burst", async () => {
    gateOn();
    const ok = { username: JUDGE_USERNAME, password: JUDGE_PASSWORD };
    const signIns = await Promise.all([login(ok), login(ok), login(ok), login(ok)]);
    for (const res of signIns) {
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toMatch(/^outings_judge=/);
    }
    // All 5 wrong guesses are still available afterwards, then the lockout starts.
    for (let i = 0; i < 5; i++) expect((await login({ username: JUDGE_USERNAME, password: `wrong-after-success-${i}` })).status).toBe(401);
    expect((await login(ok)).status).toBe(429);
  });

  it("allows about 10 attempts a minute per client", async () => {
    gateOn();
    const ok = { username: JUDGE_USERNAME, password: JUDGE_PASSWORD };
    for (let i = 0; i < 10; i++) expect((await login(ok)).status).toBe(200);
    const eleventh = await login(ok);
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("set-cookie")).toBeNull();
  });
});

describe("judge session cookie", () => {
  const validSession = () => JSON.parse(Buffer.from(decodeURIComponent(judgeCookiePair().split("=")[1]).split(".")[0], "base64url").toString("utf8")) as Record<string, unknown>;

  it("rejects a tampered cookie", () => {
    gateOn();
    const good = judgeCookiePair();
    const [name, value] = [good.slice(0, good.indexOf("=")), decodeURIComponent(good.slice(good.indexOf("=") + 1))];
    const [payload, signature] = value.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ ...validSession(), exp: 9_999_999_999 }), "utf8").toString("base64url");
    const tampered = [
      `${name}=${encodeURIComponent(`${forgedPayload}.${signature}`)}`, // new payload, old signature
      `${name}=${encodeURIComponent(`${payload}.${signature.slice(0, -2)}xx`)}`, // broken signature
      `${name}=${encodeURIComponent(payload)}`, // no signature
      `${name}=forged.value`,
      signedJudgeCookie(validSession(), "another-secret-0123456789abcdef0123456789"), // signed with the wrong secret
      signedJudgeCookie({ v: 1, exp: 9_999_999_999 }), // our signature, but no credential fingerprint
    ];
    for (const cookie of tampered) {
      expect(hasJudgeSession(withCookie(cookie)), cookie).toBe(false);
      expect(() => requireJudge(withCookie(cookie))).toThrow(ServiceError);
    }
    expect(hasJudgeSession(withCookie(good))).toBe(true);
  });

  it("rejects an expired cookie, from its own signed expiry and not the browser's", () => {
    gateOn();
    const cookie = judgeCookiePair();
    const expiry = JUDGE_SESSION_EXPIRES_AT.getTime();
    expect(hasJudgeSession(withCookie(cookie), expiry - 1000)).toBe(true);
    expect(hasJudgeSession(withCookie(cookie), expiry)).toBe(false);
    expect(hasJudgeSession(withCookie(cookie), expiry + 86_400_000)).toBe(false);
    const alreadyExpired = cookiePair(judgeCookie(new Date(Date.now() - 60_000)));
    expect(hasJudgeSession(withCookie(alreadyExpired))).toBe(false);
  });

  it("stops working when the judge password or username changes", () => {
    gateOn();
    const cookie = judgeCookiePair();
    gateOn({ JUDGE_PASSWORD: "a-different-made-up-password" });
    expect(hasJudgeSession(withCookie(cookie))).toBe(false);
    gateOn({ JUDGE_USERNAME: "another-judge" });
    expect(hasJudgeSession(withCookie(cookie))).toBe(false);
    gateOn();
    expect(hasJudgeSession(withCookie(cookie))).toBe(true);
  });

  it("logout clears it", async () => {
    gateOn();
    const res = await logoutRoute.POST(request("/api/judge/logout", { body: {}, cookie: judgeCookiePair() }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^outings_judge=;/);
    expect(setCookie).toContain("Max-Age=0");
    expect(hasJudgeSession(withCookie(cookiePair(setCookie)))).toBe(false);
  });

  it("the session route reports signed-out visitors and deployments without a gate", async () => {
    expect(await body(await sessionRoute.GET(request("/api/judge/session")))).toEqual({ gateEnabled: false, signedIn: false });
    gateOn();
    expect(await body(await sessionRoute.GET(request("/api/judge/session")))).toEqual({ gateEnabled: true, signedIn: false });
  });
});

describe("the next parameter of the sign-in page", () => {
  it("keeps same-site relative paths", () => {
    expect(safeNextPath("/new")).toBe("/new");
    expect(safeNextPath("/merchant")).toBe("/merchant");
    expect(safeNextPath("/o/123?tab=money#top")).toBe("/o/123?tab=money#top");
    expect(judgeLoginHref("/new")).toBe("/judge/login?next=%2Fnew");
  });

  it("cannot open-redirect: anything that could leave the site becomes /new", () => {
    const hostile = [
      "https://evil.example",
      "http://evil.example/new",
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "javascript:alert(1)",
      "data:text/html,x",
      "evil.example",
      "new",
      " /new",
      "/./\\evil.example",
      "/..//evil.example",
      "/a/../..//evil.example",
      `/${"a".repeat(600)}`,
      "",
    ];
    for (const next of hostile) expect(safeNextPath(next), JSON.stringify(next)).toBe("/new");
    expect(safeNextPath(undefined)).toBe("/new");
    expect(safeNextPath(["/merchant", "https://evil.example"])).toBe("/new");
    expect(judgeLoginHref("https://evil.example")).toBe("/judge/login?next=%2Fnew");
  });

  it("whatever it returns resolves on the site itself", () => {
    for (const next of ["/new", "/%2F%2Fevil.example", "/a//b", "/@evil.example", "/?next=https://evil.example"]) {
      expect(new URL(safeNextPath(next), "https://outings.example").origin).toBe("https://outings.example");
    }
  });
});

describe("POST /api/outings behind the judge gate", () => {
  const create = (cookie?: string) => createRoute.POST(request("/api/outings", { body: NEW_OUTING, cookie }));

  it("returns 401 JUDGE_LOGIN_REQUIRED with the gate on and no judge cookie, and creates nothing", async () => {
    const db = getDb();
    await seedCatalogue(db);
    gateOn();
    for (const cookie of [undefined, "outings_judge=forged.value"]) {
      const res = await create(cookie);
      expect(res.status).toBe(401);
      expect(await body(res)).toEqual({ error: { code: "JUDGE_LOGIN_REQUIRED", message: "Sign in as a judge to use this." } });
    }
    expect(await db.query.outings.findMany()).toHaveLength(0);
    expect((aiState.current as FakeAi).calls).toHaveLength(0);
  });

  it("works with the judge cookie", async () => {
    await seedCatalogue(getDb());
    gateOn();
    const signedIn = await login({ username: JUDGE_USERNAME, password: JUDGE_PASSWORD });
    const res = await create(cookiePair(signedIn.headers.get("set-cookie")!));
    expect(res.status).toBe(201);
    expect((await body<{ outingId: string }>(res)).outingId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("works for everyone with the gate off", async () => {
    await seedCatalogue(getDb());
    expect((await create()).status).toBe(201);
  });
});

describe("merchant AI behind the judge gate", () => {
  const studio = (cookie: string) => studioRoute.POST(request("/api/merchant/ai/studio", { body: { input: [] }, cookie }));
  const ask = (cookie: string) => aiQueryRoute.POST(request("/api/merchant/ai/query", { body: { question: "Show outings closing today with missing required participants" }, cookie }));

  /** A stand-in for the real model: labelled ANTHROPIC so a test can tell which parser answered. */
  function useRealModelStandIn(): FakeAi {
    const model = new FakeAi();
    Object.defineProperty(model, "source", { value: "ANTHROPIC" });
    model.dashboardQuery = async (input) => {
      model.calls.push({ method: "dashboardQuery", input });
      return { source: "ANTHROPIC", model: "stand-in-model", warnings: [], output: { filters: [{ field: "status", op: "eq", value: "CONFIRMED" }], sort: null, focus: null, explanation: "From the model." } };
    };
    aiState.current = model;
    return model;
  }

  it("the studio assistant returns 401 JUDGE_LOGIN_REQUIRED for a merchant who is not a judge", async () => {
    const { merchant } = await seedCatalogue(getDb());
    gateOn({ OUTINGS_ANTHROPIC_API_KEY: "sk-ant-FAKE-not-a-key" });
    const res = await studio(merchantCookieFor(merchant.id));
    expect(res.status).toBe(401);
    expect((await body<{ error: { code: string } }>(res)).error.code).toBe("JUDGE_LOGIN_REQUIRED");
  });

  it("the studio assistant still needs the merchant session, and lets a signed-in judge through", async () => {
    const { merchant } = await seedCatalogue(getDb());
    gateOn();
    const judgeOnly = await studio(judgeCookiePair());
    expect(judgeOnly.status).toBe(401);
    expect((await body<{ error: { code: string } }>(judgeOnly)).error.code).toBe("UNAUTHORIZED");
    // Past both checks: no model is connected in tests, so the route answers 503 instead of calling Claude.
    const both = await studio(`${merchantCookieFor(merchant.id)}; ${judgeCookiePair()}`);
    expect(both.status).toBe(503);
    expect((await body<{ error: { code: string } }>(both)).error.code).toBe("AI_UNAVAILABLE");
  });

  it("the natural-language filter uses the sample parser for anonymous visitors and never calls the model", async () => {
    const db = getDb();
    const { merchant } = await seedCatalogue(db);
    gateOn();
    const model = useRealModelStandIn();
    const res = await ask(merchantCookieFor(merchant.id));
    expect(res.status).toBe(200);
    const out = await body<{ source: string; model: string | null; query: { filters: { field: string }[] } }>(res);
    expect(out.source).toBe("FIXTURE");
    expect(out.model).toBeNull();
    expect(out.query.filters.map((f) => f.field)).toEqual(["closesToday", "missingRequired"]);
    expect(model.calls).toHaveLength(0);
    const runs = await db.select().from(aiRuns);
    expect(runs.map((r) => r.source)).toEqual(["FIXTURE"]);
  });

  it("the natural-language filter uses the real model for a signed-in judge, and for everyone with the gate off", async () => {
    const { merchant } = await seedCatalogue(getDb());
    gateOn();
    const model = useRealModelStandIn();
    const judge = await ask(`${merchantCookieFor(merchant.id)}; ${judgeCookiePair()}`);
    expect((await body<{ source: string }>(judge)).source).toBe("ANTHROPIC");
    expect(model.calls).toHaveLength(1);

    resetConfigForTests(testConfig());
    const gateOff = await ask(merchantCookieFor(merchant.id));
    expect((await body<{ source: string }>(gateOff)).source).toBe("ANTHROPIC");
    expect(model.calls).toHaveLength(2);
  });
});

// Keeps the constant honest: tests sign cookies with the same secret the helpers configure.
it("test config signs with the shared test secret", () => {
  expect(testConfig().sessionSecret).toBe(TEST_SESSION_SECRET);
});
