/**
 * Daily Claude token budget for the AG Studio assistant proxy: reserve before
 * the call, settle to real usage after, start again each UTC day, and refuse
 * with a plain message (never a model call) once the day's budget is spent.
 *
 * Pure: no database and no network (the refused request returns before Claude is called).
 */
import { afterEach, describe, expect, it } from "vitest";
import { POST as studioRoute } from "@/app/api/merchant/ai/studio/route";
import {
  STUDIO_DAILY_TOKEN_BUDGET,
  StudioTokenBudget,
  estimateStudioTurnTokens,
  resetStudioTokenBudgetForTests,
  studioTokenBudget,
} from "@/lib/ai/studio-budget";
import { merchantCookie } from "@/lib/auth/session";
import { loadConfig, resetConfigForTests } from "@/lib/env";

const DAY_ONE = new Date("2026-12-01T10:00:00Z");
const LATE_DAY_ONE = new Date("2026-12-01T23:59:59Z");
const DAY_TWO = new Date("2026-12-02T00:00:01Z");

/** A budget whose clock the test moves by hand. */
function budgetAt(limit: number, start: Date): { budget: StudioTokenBudget; setNow: (at: Date) => void } {
  let now = start;
  return { budget: new StudioTokenBudget(limit, () => now), setNow: (at) => void (now = at) };
}

describe("StudioTokenBudget", () => {
  it("reserves until the day's budget is used, then refuses", () => {
    const { budget } = budgetAt(100, DAY_ONE);
    expect(budget.tryReserve(60)).not.toBeNull();
    expect(budget.remaining()).toBe(40);
    expect(budget.tryReserve(41)).toBeNull();
    expect(budget.remaining()).toBe(40);
    expect(budget.tryReserve(40)).not.toBeNull();
    expect(budget.tryReserve(1)).toBeNull();
  });

  it("settles a reservation down to what the turn really used", () => {
    const { budget } = budgetAt(100, DAY_ONE);
    const reservation = budget.tryReserve(80)!;
    budget.settle(reservation, 25);
    expect(budget.remaining()).toBe(75);
  });

  it("gives the whole reservation back when Claude was never reached", () => {
    const { budget } = budgetAt(100, DAY_ONE);
    budget.settle(budget.tryReserve(80)!, 0);
    expect(budget.remaining()).toBe(100);
  });

  it("counts usage above the estimate, so the estimate can never hide spending", () => {
    const { budget } = budgetAt(100, DAY_ONE);
    budget.settle(budget.tryReserve(10)!, 30);
    expect(budget.remaining()).toBe(70);
  });

  it("starts again at midnight UTC", () => {
    const { budget, setNow } = budgetAt(100, LATE_DAY_ONE);
    expect(budget.tryReserve(100)).not.toBeNull();
    expect(budget.tryReserve(1)).toBeNull();
    setNow(DAY_TWO);
    expect(budget.remaining()).toBe(100);
  });

  it("ignores the settlement of a turn that started on a day already closed", () => {
    const { budget, setNow } = budgetAt(100, LATE_DAY_ONE);
    const yesterday = budget.tryReserve(90)!;
    setNow(DAY_TWO);
    budget.settle(yesterday, 50);
    expect(budget.remaining()).toBe(100);
  });
});

describe("estimateStudioTurnTokens", () => {
  it("overestimates: every 3 request characters count as a token, plus the full output allowance", () => {
    expect(estimateStudioTurnTokens(3_000, 8_192)).toBe(1_000 + 8_192);
    expect(estimateStudioTurnTokens(1, 0)).toBe(1);
  });

  it("lets the largest allowed request fit inside one day's budget", () => {
    expect(estimateStudioTurnTokens(600_000, 8_192)).toBeLessThan(STUDIO_DAILY_TOKEN_BUDGET);
  });
});

describe("POST /api/merchant/ai/studio", () => {
  afterEach(() => {
    resetStudioTokenBudgetForTests();
    resetConfigForTests();
  });

  it("answers 503 with a plain message, without calling Claude, once today's budget is spent", async () => {
    const env: Record<string, string> = {
      SESSION_SECRET: "studio-budget-test-secret",
      OUTINGS_ANTHROPIC_API_KEY: "sk-ant-FAKE-zzzzzz",
      DEMO_FIXTURES_ENABLED: "true",
    };
    resetConfigForTests(loadConfig(env as NodeJS.ProcessEnv));
    resetStudioTokenBudgetForTests();
    expect(studioTokenBudget().tryReserve(STUDIO_DAILY_TOKEN_BUDGET)).not.toBeNull();

    const cookie = merchantCookie("11111111-1111-4111-8111-111111111111").split(";")[0];
    const res = await studioRoute(
      new Request("http://localhost/api/merchant/ai/studio", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ input: [] }),
      }),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("AI_DAILY_LIMIT_REACHED");
    expect(body.error.message).toContain("filter box");
    expect(studioTokenBudget().remaining()).toBe(0);
  });
});
