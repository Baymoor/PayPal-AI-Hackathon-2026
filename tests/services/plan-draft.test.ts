/**
 * draftPlan service + POST /api/outings/:id/plan-draft: organizer only,
 * PROPOSED only, rate-limited, honest ai_runs, no vote data in or out, and
 * nothing persisted. Validated suggestions pass the real openCollection.
 */
import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { aiState, FakeAi } from "./fake-ai";
import { BASE, body, params, participantCookieFor, request, setupServiceTests, MIN } from "./helpers";
import * as svc from "@/lib/services/outings";
import { buildOutingView } from "@/lib/services/views";
import { aiRuns, outings, participants, quoteVersions } from "@/lib/db/schema";
import { seedCatalogue } from "@/lib/demo/seed";
import { FixtureOutingsAi } from "@/lib/ai/fixture";
import { ServiceError } from "@/lib/http";
import type { PlanDraftInput, PlanDraftResponse } from "@/lib/ai/types";
import * as planRoute from "@/app/api/outings/[id]/plan-draft/route";

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  const { aiState: state } = await import("./fake-ai");
  return { ...actual, getOutingsAi: () => state.current };
});

const getDb = setupServiceTests();

const CANONICAL = "A karaoke night for Maya's birthday. Six of us, Friday evening. We want a private room and to cover Maya's share.";
const NOW = new Date("2026-11-04T12:00:00Z"); // Wednesday 13:00 in Copenhagen
/** Per-person votes; the median, $20, is agreed. */
const VOTES = { Alex: 2_000, Ben: 2_000, Freya: 1_500, Jules: 3_000 } as const;

async function expectCode(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe(code);
  expect((err as ServiceError).status).toBe(status);
}

/** Canonical brief -> invites -> budget poker -> agreed $100 (PROPOSED). */
async function proposed(db: ReturnType<typeof getDb>, opts: { stopAt?: "BUDGETING" } = {}) {
  const { offerings } = await seedCatalogue(db);
  const { outingId, participantId } = await svc.createOuting(db, { organizerName: "Alex", brief: CANONICAL }, NOW);
  const org = { outingId, participantId };
  const { invites } = await svc.addInvitees(db, org, { names: ["Ben", "Freya", "Jules", "Noor", "Maya"] }, NOW);
  const ids: Record<string, string> = { Alex: participantId, ...Object.fromEntries(invites.map((i) => [i.displayName, i.participantId])) };
  await svc.startBudget(db, org, NOW);
  if (opts.stopAt === "BUDGETING") return { outingId, ids, org, offerings };
  for (const [name, amountMinor] of Object.entries(VOTES)) await svc.vote(db, { outingId, participantId: ids[name] }, { amountMinor }, NOW);
  await svc.reveal(db, org, NOW);
  await svc.agreeBudget(db, org, { amountMinor: 2_000 }, NOW);
  return { outingId, ids, org, offerings };
}

/** Every number anywhere inside a value. */
function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
  else if (value && typeof value === "object" && !(value instanceof Date)) Object.values(value).forEach((v) => numbersIn(v, out));
  return out;
}

describe("draftPlan", () => {
  it("returns a validated draft at PROPOSED, records a FIXTURE ai_run, persists nothing, and the draft opens collection", async () => {
    const db = getDb();
    aiState.current = new FixtureOutingsAi();
    const f = await proposed(db);
    const before = (await db.query.outings.findFirst({ where: eq(outings.id, f.outingId) }))!;
    expect(before.status).toBe("PROPOSED");

    const res = await svc.draftPlan(db, { outingId: f.outingId, organizerId: f.ids.Alex, now: NOW });
    const room = f.offerings["private-karaoke-room"];
    expect(res).toMatchObject({
      source: "FIXTURE",
      model: null,
      dropped: [],
      draft: {
        offeringId: room.id,
        offeringName: "Private karaoke room",
        timezone: "Europe/Copenhagen",
        activityStartLocal: "2026-11-06T19:00",
        activityAt: "2026-11-06T18:00:00.000Z",
        deadlineLocal: "2026-11-05T13:00",
        deadlineAt: "2026-11-05T12:00:00.000Z",
        minPayers: 5,
        sponsor: { participantId: f.ids.Maya, displayName: "Maya" },
      },
    });
    expect(res.draft.rationale.length).toBeGreaterThan(0);
    expect(res.draft.rationale.every((r) => r.startsWith("Sample plan:"))).toBe(true);

    const runs = await db.query.aiRuns.findMany({ where: and(eq(aiRuns.outingId, f.outingId), eq(aiRuns.purpose, "PLAN_DRAFT")) });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ source: "FIXTURE", model: null, ok: true, error: null });
    expect((runs[0].output as { dropped: unknown[] }).dropped).toEqual([]);

    // Not persisted as terms: nothing selected, sponsored, versioned or quoted.
    const after = (await db.query.outings.findFirst({ where: eq(outings.id, f.outingId) }))!;
    expect(after).toMatchObject({ status: "PROPOSED", selectedOfferingId: null, version: before.version, currentQuoteId: null, deadlineAt: null });
    const maya = (await db.query.participants.findFirst({ where: eq(participants.id, f.ids.Maya) }))!;
    expect(maya.payerType).toBe("PAYER");
    expect(await db.query.quoteVersions.findMany({ where: eq(quoteVersions.outingId, f.outingId) })).toEqual([]);

    // The organizer applies it explicitly; the real openCollection accepts every suggested value.
    const t = new Date(NOW.getTime() + 5 * MIN);
    await svc.selectOffering(db, f.org, { offeringId: res.draft.offeringId! }, t);
    await svc.patchParticipant(db, f.org, res.draft.sponsor!.participantId!, { payerType: "SPONSORED" }, t);
    const opened = await svc.openCollection(
      db,
      f.org,
      { activityAt: new Date(res.draft.activityAt!), deadlineAt: new Date(res.draft.deadlineAt!), minPayers: res.draft.minPayers! },
      t,
    );
    expect(opened.capMinor).toBe(2_000);
    await expectCode(svc.draftPlan(db, { outingId: f.outingId, organizerId: f.ids.Alex, now: t }), "INVALID_STATE", 409);
  });

  it("sends the AI names and public catalogue data only, and returns no vote data", async () => {
    const db = getDb();
    const fake = new FakeAi();
    aiState.current = fake;
    const f = await proposed(db);
    const res = await svc.draftPlan(db, { outingId: f.outingId, organizerId: f.ids.Alex, now: NOW });

    const input = fake.calls.find((c) => c.method === "draftPlan")!.input as PlanDraftInput;
    expect(Object.keys(input).sort()).toEqual(["agreedBudgetMinor", "budgetUnit", "catalogue", "extraction", "now", "roster", "selectedOfferingId", "timezone"]);
    expect(input.agreedBudgetMinor).toBe(2_000);
    expect(input.budgetUnit).toBe("PER_PERSON");
    expect(input.roster.map((p) => p.name)).toEqual(["Alex", "Ben", "Freya", "Jules", "Noor", "Maya"]);
    for (const p of input.roster) expect(Object.keys(p).sort()).toEqual(["isOrganizer", "name", "payer", "sponsored"]);
    const ids = Object.values(f.ids);
    const inputJson = JSON.stringify(input);
    for (const id of ids) expect(inputJson).not.toContain(id);
    expect(inputJson).not.toMatch(/vote/i);
    // Individual votes ($75, $150) never reach the model or the response.
    for (const amount of [VOTES.Freya, VOTES.Jules]) {
      expect(numbersIn(input)).not.toContain(amount);
      expect(numbersIn(res)).not.toContain(amount);
    }
    expect(JSON.stringify(res)).not.toMatch(/vote|budget|priceMinor|capMinor/i);
  });

  it("is organizer-only and PROPOSED-only", async () => {
    const db = getDb();
    const f = await proposed(db);
    await expectCode(svc.draftPlan(db, { outingId: f.outingId, organizerId: f.ids.Ben, now: NOW }), "FORBIDDEN", 403);

    const g = await proposed(db, { stopAt: "BUDGETING" });
    await expectCode(svc.draftPlan(db, { outingId: g.outingId, organizerId: g.ids.Alex, now: NOW }), "INVALID_STATE", 409);
    expect(await db.query.aiRuns.findMany({ where: and(eq(aiRuns.outingId, g.outingId), eq(aiRuns.purpose, "PLAN_DRAFT")) })).toEqual([]);
  });

  it("is rate-limited per outing", async () => {
    const db = getDb();
    const f = await proposed(db);
    const call = (now: Date) => svc.draftPlan(db, { outingId: f.outingId, organizerId: f.ids.Alex, now });
    for (let i = 0; i < svc.PLAN_DRAFT_RATE_LIMIT.capacity; i++) await call(NOW);
    await expectCode(call(NOW), "RATE_LIMITED", 429);
    // A non-organizer is rejected before the bucket is touched; the bucket refills over time.
    await expectCode(svc.draftPlan(db, { outingId: f.outingId, organizerId: f.ids.Ben, now: NOW }), "FORBIDDEN", 403);
    await expect(call(new Date(NOW.getTime() + MIN))).resolves.toMatchObject({ source: "FIXTURE" });
  });

  it("drops every invalid model suggestion with a note instead of fixing it up", async () => {
    const db = getDb();
    const f = await proposed(db);
    const hostile = new FakeAi();
    hostile.draftPlan = async (input) => ({
      source: "FIXTURE",
      model: null,
      warnings: [],
      output: {
        offeringId: input.catalogue.find((c) => c.pricingModel === "PER_ATTENDEE")?.offeringId ?? "missing",
        activityStartLocal: "2026-11-06T19:30",
        deadlineLocal: "2026-11-09T12:00",
        minPayers: 99,
        sponsoredParticipantName: "Zed",
        rationale: ["Book it now at https://evil.example"],
        cautions: [],
      },
    });
    aiState.current = hostile;
    const res = await svc.draftPlan(db, { outingId: f.outingId, organizerId: f.ids.Alex, now: NOW });
    expect(res.draft).toMatchObject({ offeringId: null, activityAt: null, deadlineAt: null, minPayers: null, sponsor: null });
    expect(res.dropped.map((d) => d.field).sort()).toEqual(["activityStart", "deadline", "minPayers", "offeringId", "sponsor"]);
    expect(res.dropped.find((d) => d.field === "offeringId")?.reason).toMatch(/priced per attendee/);
    expect(res.draft.rationale).toEqual(["Book it now at"]);
    const run = (await db.query.aiRuns.findFirst({ where: and(eq(aiRuns.outingId, f.outingId), eq(aiRuns.purpose, "PLAN_DRAFT")) }))!;
    expect(run.ok).toBe(true);
    expect((run.output as { dropped: unknown[] }).dropped).toHaveLength(5);
  });

  it("records failed AI calls honestly and reports 503 / 502", async () => {
    const db = getDb();
    const f = await proposed(db);
    const broken = new FakeAi();
    broken.draftPlan = async () => {
      throw new Error("AiProviderError: upstream 529");
    };
    aiState.current = broken;
    await expectCode(svc.draftPlan(db, { outingId: f.outingId, organizerId: f.ids.Alex, now: NOW }), "AI_UNAVAILABLE", 503);

    const garbled = new FakeAi();
    garbled.draftPlan = async () => ({ source: "FIXTURE", model: null, warnings: [], output: { offeringId: 42 } as never });
    aiState.current = garbled;
    await expectCode(svc.draftPlan(db, { outingId: f.outingId, organizerId: f.ids.Alex, now: NOW }), "AI_OUTPUT_INVALID", 502);

    const runs = await db.query.aiRuns.findMany({ where: and(eq(aiRuns.outingId, f.outingId), eq(aiRuns.purpose, "PLAN_DRAFT")) });
    expect(runs.map((r) => [r.ok, r.source])).toEqual([
      [false, "FIXTURE"],
      [false, "FIXTURE"],
    ]);
  });

  it("exposes organizer.can.draftPlan only to the organizer at PROPOSED", async () => {
    const db = getDb();
    const f = await proposed(db);
    expect((await buildOutingView(db, { outingId: f.outingId, participantId: f.ids.Alex, now: NOW })).organizer?.can.draftPlan).toBe(true);
    expect((await buildOutingView(db, { outingId: f.outingId, participantId: f.ids.Ben, now: NOW })).organizer).toBeNull();
    const g = await proposed(db, { stopAt: "BUDGETING" });
    expect((await buildOutingView(db, { outingId: g.outingId, participantId: g.ids.Alex, now: NOW })).organizer?.can.draftPlan).toBe(false);
  });
});

describe("POST /api/outings/:id/plan-draft", () => {
  it("serves the organizer session only, same-origin", async () => {
    const db = getDb();
    const f = await proposed(db);
    const path = `/api/outings/${f.outingId}/plan-draft`;
    const call = (cookie?: string, headers?: Record<string, string>) =>
      planRoute.POST(request(path, { method: "POST", cookie, headers }), params({ id: f.outingId }));

    const ok = await call(participantCookieFor({ [f.outingId]: f.ids.Alex }), { origin: BASE, host: "localhost:3000" });
    expect(ok.status).toBe(200);
    const json = await body<PlanDraftResponse>(ok);
    expect(json.source).toBe("FIXTURE");
    expect(Object.keys(json).sort()).toEqual(["draft", "dropped", "model", "source"]);
    expect(json.draft.activityAt).toEqual(expect.any(String));
    expect(json.draft.activityStartLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

    expect((await call(participantCookieFor({ [f.outingId]: f.ids.Ben }))).status).toBe(403);
    expect((await call()).status).toBe(401);
    const cross = await call(participantCookieFor({ [f.outingId]: f.ids.Alex }), { origin: "https://evil.example", host: "localhost:3000" });
    expect(cross.status).toBe(403);
  });
});
