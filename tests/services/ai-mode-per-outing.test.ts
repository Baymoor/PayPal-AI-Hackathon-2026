/**
 * AI mode is per OUTING, like payments. The hosted demo runs with a real Anthropic key, yet demo
 * (isFixture) outings, seeded or started from /demo, must always use the deterministic sample AI:
 * anonymous visitors never spend model budget, ai_runs say FIXTURE, and their screens never say Claude.
 * Real outings keep using the deployment's AI.
 *
 * "Claude" here is a FakeAi labelled ANTHROPIC behind the mocked `getOutingsAi`; the sample AI is a
 * FakeAi behind the mocked `getFixtureOutingsAi`. Nothing calls a real model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { FakeAi } from "./fake-ai";
import { actorOf, createWithInvitees, setupServiceTests, testConfig } from "./helpers";
import { aiRuns } from "@/lib/db/schema";
import { loadConfig, resetConfigForTests } from "@/lib/env";
import { aiModeForOuting } from "@/lib/ai";
import * as svc from "@/lib/services/outings";
import { buildOutingView } from "@/lib/services/views";
import { seedDemo } from "@/lib/demo/seed";
import { createDemoScenario } from "@/lib/demo/scenarios";
import { FixtureProvider } from "@/lib/payments/fixture";
import { resetPaymentProviders, setPaymentProviderOverride } from "@/lib/payments";
import type { OutingsAi } from "@/lib/ai/types";

const ais = vi.hoisted(() => ({ configured: null as OutingsAi | null, sample: null as OutingsAi | null }));

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  return { ...actual, getOutingsAi: () => ais.configured!, getFixtureOutingsAi: () => ais.sample! };
});

const getDb = setupServiceTests();
const ANTHROPIC_KEY = { OUTINGS_ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key" };
const MODEL = "claude-test-model";

let claude: FakeAi;
let sample: FakeAi;

beforeEach(() => {
  // A deployment with a real-looking Anthropic key AND demo mode on: the hosted demo's configuration.
  resetConfigForTests(testConfig(ANTHROPIC_KEY));
  claude = new FakeAi("ANTHROPIC", MODEL);
  sample = new FakeAi();
  ais.configured = claude;
  ais.sample = sample;
  resetPaymentProviders();
  setPaymentProviderOverride("FIXTURE", new FixtureProvider({ db: getDb() }));
});

const methods = (ai: FakeAi) => ai.calls.map((c) => c.method);

async function aiRunsOf(outingId: string) {
  const rows = await getDb().select().from(aiRuns).where(eq(aiRuns.outingId, outingId)).orderBy(asc(aiRuns.createdAt));
  return rows.map((r) => ({ purpose: r.purpose, source: r.source, model: r.model, ok: r.ok }));
}

describe("aiModeForOuting", () => {
  const demoOuting = { isFixture: true };
  const realOuting = { isFixture: false };
  const useEnv = (env: Record<string, string>) => resetConfigForTests(loadConfig({ NODE_ENV: "test", ...env } as NodeJS.ProcessEnv));

  it("gives demo outings the sample AI on a deployment with an Anthropic key", () => {
    useEnv({ ...ANTHROPIC_KEY, DEMO_FIXTURES_ENABLED: "true" });
    expect(aiModeForOuting(demoOuting)).toBe("FIXTURE");
    expect(aiModeForOuting(realOuting)).toBe("ANTHROPIC");
  });

  it("gives every outing the sample AI when there is no key", () => {
    useEnv({ DEMO_FIXTURES_ENABLED: "true" });
    expect(aiModeForOuting(demoOuting)).toBe("FIXTURE");
    expect(aiModeForOuting(realOuting)).toBe("FIXTURE");
  });

  it("never gives a demo outing the real model once demo mode is off", () => {
    useEnv(ANTHROPIC_KEY);
    expect(aiModeForOuting(demoOuting)).toBe("DISABLED");
    expect(aiModeForOuting(realOuting)).toBe("ANTHROPIC");
  });
});

describe("demo outings use the sample AI even with an Anthropic key", () => {
  it("reveal summary, venue ranking and plan draft of a seeded demo outing call the sample AI, never Claude", async () => {
    const db = getDb();
    const now = new Date();
    const state = await seedDemo(db, { now });
    const outingId = state.budgetOutingId!;
    const organizer = state.budgetPersonas.find((p) => p.role === "ORGANIZER")!;
    const actor = { outingId, participantId: organizer.participantId };

    const reveal = await svc.reveal(db, actor, now);
    const proposal = await svc.agreeBudget(db, actor, { amountMinor: 2_000 }, now);
    const draft = await svc.draftPlan(db, { outingId, organizerId: organizer.participantId, now });

    expect(methods(claude)).toEqual([]);
    expect(methods(sample)).toEqual(["summarizeReveal", "proposeOfferings", "draftPlan"]);
    expect(reveal.summary).toMatchObject({ source: "FIXTURE", model: null });
    expect(proposal).toMatchObject({ source: "FIXTURE", model: null });
    expect(draft).toMatchObject({ source: "FIXTURE", model: null });
    // ai_runs tell the truth: every row of the demo outing is FIXTURE, none claims a model.
    expect(await aiRunsOf(outingId)).toEqual([
      { purpose: "BRIEF_EXTRACTION", source: "FIXTURE", model: null, ok: true },
      { purpose: "BUDGET_REVEAL_SUMMARY", source: "FIXTURE", model: null, ok: true },
      { purpose: "CATALOGUE_PROPOSAL", source: "FIXTURE", model: null, ok: true },
      { purpose: "PLAN_DRAFT", source: "FIXTURE", model: null, ok: true },
    ]);
  });

  it("a /demo story reads its brief with the sample parser and never calls Claude", async () => {
    const db = getDb();
    const s = await createDemoScenario(db, { kind: "settle-soon" });
    expect(methods(claude)).toEqual([]);
    expect(await aiRunsOf(s.outingId)).toEqual([{ purpose: "BRIEF_EXTRACTION", source: "FIXTURE", model: null, ok: true }]);
    const view = await buildOutingView(db, { outingId: s.outingId, participantId: s.personas[0].participantId });
    expect(view.outing).toMatchObject({ isFixture: true, aiMode: "FIXTURE", paymentMode: "FIXTURE" });
    expect(view.brief.source).toBe("FIXTURE");
  });
});

describe("real outings still use the configured AI", () => {
  it("brief, reveal summary, ranking and plan draft of a real outing go to Claude and are recorded as ANTHROPIC", async () => {
    const db = getDb();
    const now = new Date();
    const f = await createWithInvitees(db, ["Ben", "Freya", "Jules", "Noor", "Maya"], now);
    const org = actorOf(f);
    await svc.startBudget(db, org, now);
    for (const name of ["Alex", "Ben", "Freya", "Jules", "Noor"]) await svc.vote(db, actorOf(f, name), { amountMinor: 2_000 }, now);
    await svc.reveal(db, org, now);
    await svc.agreeBudget(db, org, { amountMinor: 2_000 }, now);
    const draft = await svc.draftPlan(db, { outingId: f.outingId, organizerId: f.organizerId, now });

    expect(methods(sample)).toEqual([]);
    expect(methods(claude)).toEqual(["extractBrief", "summarizeReveal", "proposeOfferings", "draftPlan"]);
    expect(draft).toMatchObject({ source: "ANTHROPIC", model: MODEL });
    const runs = await aiRunsOf(f.outingId);
    expect(runs.map((r) => r.purpose)).toEqual(["BRIEF_EXTRACTION", "BUDGET_REVEAL_SUMMARY", "CATALOGUE_PROPOSAL", "PLAN_DRAFT"]);
    expect(runs.every((r) => r.source === "ANTHROPIC" && r.model === MODEL && r.ok)).toBe(true);
  });
});

describe("the outing view's aiMode follows the outing", () => {
  it("says FIXTURE for a demo outing and ANTHROPIC for a real one on the same deployment", async () => {
    const db = getDb();
    const now = new Date();
    const state = await seedDemo(db, { now });
    const real = await createWithInvitees(db, ["Ben"], now);

    const demoView = await buildOutingView(db, { outingId: state.outingId!, participantId: state.personas[0].participantId, now });
    const realView = await buildOutingView(db, { outingId: real.outingId, participantId: real.organizerId, now });

    expect(demoView.outing).toMatchObject({ isFixture: true, aiMode: "FIXTURE", paymentMode: "FIXTURE" });
    expect(realView.outing).toMatchObject({ isFixture: false, aiMode: "ANTHROPIC" });
  });

  it("keeps the plan-draft button for a demo outing (sample AI) and drops it once demo mode is off", async () => {
    const db = getDb();
    const now = new Date();
    const state = await seedDemo(db, { now });
    const outingId = state.budgetOutingId!;
    const organizer = state.budgetPersonas.find((p) => p.role === "ORGANIZER")!;
    const actor = { outingId, participantId: organizer.participantId };
    await svc.reveal(db, actor, now);
    await svc.agreeBudget(db, actor, { amountMinor: 2_000 }, now);

    const view = await buildOutingView(db, { outingId, participantId: organizer.participantId, now });
    expect(view.outing.aiMode).toBe("FIXTURE");
    expect(view.organizer?.can.draftPlan).toBe(true);

    // Same Anthropic key, simulator off: the demo outing gets no AI, never Claude.
    resetConfigForTests(testConfig({ ...ANTHROPIC_KEY, DEMO_FIXTURES_ENABLED: "false" }));
    const off = await buildOutingView(db, { outingId, participantId: organizer.participantId, now });
    expect(off.outing.aiMode).toBe("DISABLED");
    expect(off.organizer?.can.draftPlan).toBe(false);
  });
});
