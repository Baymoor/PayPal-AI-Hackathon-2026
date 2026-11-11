/**
 * One-click starters, the fictional demo venues and brief-sized budget-poker
 * options, end to end against Postgres:
 * - each starter brief, read by the deterministic FIXTURE parser through the
 *   real API, maps to its category, gets vote options that fit the theme, and
 *   ranks its own venue first,
 * - vote options come from a validated AI suggestion or the deterministic
 *   ladder, with honest provenance; old outings keep the historic list,
 * - every venue offering can be shared through openCollection,
 * - the demo merchant sign-in only opens demo venues, each scoped to itself,
 * - seed / reset and the lazy scenario path create the venues.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { aiState, defaultExtraction, FakeAi } from "./fake-ai";
import { HOUR, body, cookiePair, params, request, setupServiceTests } from "./helpers";
import * as svc from "@/lib/services/outings";
import { buildOutingView } from "@/lib/services/views";
import { merchants, offerings, outings, quoteVersions } from "@/lib/db/schema";
import type { OutingView } from "@/lib/contracts/views";
import type { AiResult, BriefExtraction } from "@/lib/ai/types";
import { FixtureOutingsAi } from "@/lib/ai/fixture";
import { headcountOf, perPersonShareMinor } from "@/lib/domain/budget-fit";
import { DEFAULT_BUDGET_OPTIONS_MINOR, LEGACY_TOTAL_OPTIONS_MINOR, validateBudgetOptions } from "@/lib/domain/budget-options";
import { nextLocalWeekdayAt, seedCatalogue, seedDemo } from "@/lib/demo/seed";
import { DEMO_VENUE_SPECS, seedDemoVenues, type VenueOfferingSpec } from "@/lib/demo/venues";
import { DEMO_MERCHANT_SLUG, DEMO_TIMEZONE, DEMO_VENUE_NAMES, DEMO_VENUE_SLUGS } from "@/lib/demo/constants";
import { OUTING_STARTERS, type OutingStarter } from "@/lib/demo/starters";
import { createDemoScenario } from "@/lib/demo/scenarios";
import { FixtureProvider } from "@/lib/payments/fixture";
import { resetPaymentProviders, setPaymentProviderOverride } from "@/lib/payments";
import { resetRateLimits } from "@/lib/rate-limit";
import * as createRoute from "@/app/api/outings/route";
import * as outingRoute from "@/app/api/outings/[id]/route";
import * as startBudgetRoute from "@/app/api/outings/[id]/start-budget/route";
import * as agreeRoute from "@/app/api/outings/[id]/budget/agree/route";
import * as demoLoginRoute from "@/app/api/merchant/demo-login/route";
import * as bookingsRoute from "@/app/api/merchant/bookings/route";

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  const { aiState: state } = await import("./fake-ai");
  return { ...actual, getOutingsAi: () => state.current };
});

const getDb = setupServiceTests();

beforeEach(() => {
  resetPaymentProviders();
  setPaymentProviderOverride("FIXTURE", new FixtureProvider({ db: getDb() }));
});
afterAll(() => resetPaymentProviders());

/** The full demo catalogue: The Sound Room plus the four fictional venues. */
async function seedAllVenues() {
  const db = getDb();
  await seedCatalogue(db);
  await seedDemoVenues(db);
}

async function venueOf(offeringId: string): Promise<{ slug: string; category: string; priceMinor: number }> {
  const offering = (await getDb().query.offerings.findFirst({ where: eq(offerings.id, offeringId) }))!;
  const merchant = (await getDb().query.merchants.findFirst({ where: eq(merchants.id, offering.merchantId) }))!;
  return { slug: merchant.slug, category: offering.category, priceMinor: offering.priceMinor };
}

async function storedOptions(outingId: string): Promise<svc.StoredBudgetOptions | undefined> {
  const outing = (await getDb().query.outings.findFirst({ where: eq(outings.id, outingId) }))!;
  return svc.storedExtraction(outing)?.budgetOptions;
}

/* ------------------------------ starters (API) ------------------------------ */

describe("one-click starters in FIXTURE AI mode", () => {
  it.each(OUTING_STARTERS.map((s) => [s.label, s] as const))("%s: category, vote options and venue ranking", async (_label, starter: OutingStarter) => {
    await seedAllVenues();
    aiState.current = new FixtureOutingsAi();

    const created = await createRoute.POST(request("/api/outings", { body: { organizerName: "Alex", brief: starter.brief } }));
    expect(created.status).toBe(201);
    const { outingId } = await body<{ outingId: string }>(created);
    const cookie = cookiePair(created.headers.get("set-cookie")!);

    const view = await body<OutingView>(await outingRoute.GET(request(`/api/outings/${outingId}`, { cookie }), params({ id: outingId })));
    expect(view.brief.source).toBe("FIXTURE");
    expect(view.brief.model).toBeNull();
    expect(view.brief.extraction?.categories).toContain(starter.category);

    // Vote options: valid, per person, built from the brief's own budget, and the theme venue's share is votable.
    const options = view.budget.options;
    expect(validateBudgetOptions(options).ok).toBe(true);
    const stored = (await storedOptions(outingId))!;
    expect(stored.optionsMinor).toEqual(options);
    expect(["BRIEF_TOTAL", "BRIEF_PER_PERSON"]).toContain(stored.basis);
    // Deterministic app rule, never labelled as model (or fixture AI) output.
    expect(stored.source).toBeNull();
    expect(stored.model).toBeNull();
    const themeOffering = DEMO_VENUE_SPECS.find((v) => v.slug === starter.venueSlug)?.offerings[0];
    const themePrice = themeOffering?.priceMinor ?? 10_000; // The Sound Room's private karaoke room
    // What one payer would pay for it: the price over the people the brief says pay (a covered guest does not).
    const extraction = view.brief.extraction!;
    const headcount = headcountOf(extraction.groupSize.count!, extraction.guestOfHonour.coverTheirShare ? 1 : 0);
    const themeShare = perPersonShareMinor({ pricingModel: "FIXED_TOTAL", priceMinor: themePrice }, headcount);
    expect(options[0]).toBeLessThanOrEqual(themeShare);
    expect(options[4]).toBeGreaterThanOrEqual(themeShare);
    expect(options[4]).toBeLessThan(themePrice); // per-person amounts, not the whole booking
    expect(options[2]).toBe(stored.anchorMinor);

    // Agree the brief's own budget: the starter's venue ranks first.
    expect((await startBudgetRoute.POST(request(`/api/outings/${outingId}/start-budget`, { cookie, body: {} }), params({ id: outingId }))).status).toBe(200);
    const agreed = await agreeRoute.POST(request(`/api/outings/${outingId}/budget/agree`, { cookie, body: { amountMinor: options[2] } }), params({ id: outingId }));
    expect(agreed.status).toBe(200);
    const after = await body<OutingView>(await outingRoute.GET(request(`/api/outings/${outingId}`, { cookie }), params({ id: outingId })));
    const top = after.proposal!.candidates[0];
    const venue = await venueOf(top.offeringId);
    expect(venue.slug).toBe(starter.venueSlug);
    expect(venue.category).toBe(starter.category);
    expect(top.fit).toBe("GREAT");
    // Other activities may be listed for comparison, but never as more than a stretch.
    for (const other of after.proposal!.candidates.slice(1)) {
      if ((await venueOf(other.offeringId)).category !== starter.category) expect(other.fit, other.name).toBe("STRETCH");
    }
  });

  it("the karaoke starter gets $10, $15, $20, $30, $40: the amounts the demo and e2e rely on", async () => {
    await seedAllVenues();
    aiState.current = new FixtureOutingsAi();
    const karaoke = OUTING_STARTERS.find((s) => s.id === "karaoke-birthday")!;
    const { outingId } = await svc.createOuting(getDb(), { organizerName: "Alex", brief: karaoke.brief });
    expect((await storedOptions(outingId))?.optionsMinor).toEqual([1_000, 1_500, 2_000, 3_000, 4_000]);
    expect(await storedOptions(outingId)).toMatchObject({ basis: "BRIEF_TOTAL", anchorMinor: 2_000 }); // $100 over 5 payers
  });
});

/* --------------------------- vote option provenance ------------------------- */

/** FakeAi whose brief extraction carries a chosen (possibly hostile) vote suggestion, bypassing validateBrief. */
function aiSuggesting(suggestion: number[] | null, budget: BriefExtraction["budget"]): FakeAi {
  const ai = new FakeAi();
  ai.extractBrief = async (): Promise<AiResult<BriefExtraction>> => ({
    source: "FIXTURE",
    model: null,
    output: { ...defaultExtraction("Wine tasting"), categories: ["wine-tasting"], budget, groupSize: { count: 6, isEstimate: false }, suggestedVotePerPersonMinor: suggestion },
    warnings: [],
  });
  return ai;
}

describe("budget-poker vote options", () => {
  const brief = "Wine tasting for six, around $300 total";

  it("uses a valid AI suggestion and records its honest source", async () => {
    await seedAllVenues();
    // $300 for six is $50 each, and the suggestion contains it.
    aiState.current = aiSuggesting([2_500, 4_000, 5_000, 7_500, 10_000], { amountMinor: 30_000, unit: "TOTAL" });
    const { outingId, participantId } = await svc.createOuting(getDb(), { organizerName: "Alex", brief });
    expect(await storedOptions(outingId)).toMatchObject({ basis: "AI_SUGGESTION", source: "FIXTURE", model: null, notes: [] });
    const view = await buildOutingView(getDb(), { outingId, participantId });
    expect(view.budget).toMatchObject({ unit: "PER_PERSON", options: [2_500, 4_000, 5_000, 7_500, 10_000] });
  });

  it("re-validates on the server: an invalid or off-brief suggestion falls back to the ladder", async () => {
    await seedAllVenues();
    aiState.current = aiSuggesting([10_000, 7_500, 5_000, 4_000, 2_500], { amountMinor: 30_000, unit: "TOTAL" });
    const bad = await svc.createOuting(getDb(), { organizerName: "Alex", brief });
    expect(await storedOptions(bad.outingId)).toMatchObject({ basis: "BRIEF_TOTAL", source: null, anchorMinor: 5_000, optionsMinor: [2_500, 3_800, 5_000, 7_500, 10_000] });
    expect((await storedOptions(bad.outingId))!.notes[0]).toMatch(/strictly increasing/);

    // Whole-group totals where per-person amounts were asked for: they leave out the $50 each the brief means.
    aiState.current = aiSuggesting([15_000, 20_000, 30_000, 40_000, 50_000], { amountMinor: 30_000, unit: "TOTAL" });
    const offBrief = await svc.createOuting(getDb(), { organizerName: "Alex", brief });
    expect(await storedOptions(offBrief.outingId)).toMatchObject({ basis: "BRIEF_TOTAL", optionsMinor: [2_500, 3_800, 5_000, 7_500, 10_000] });
    expect((await storedOptions(offBrief.outingId))!.notes[0]).toMatch(/do not include the budget stated/);
  });

  it("anchors on the category's catalogue price when the brief states no budget", async () => {
    await seedAllVenues();
    aiState.current = aiSuggesting(null, { amountMinor: null, unit: "UNKNOWN" });
    const { outingId } = await svc.createOuting(getDb(), { organizerName: "Alex", brief: "Wine tasting for six" });
    // The $240 tasting table over six payers is $40 each.
    expect(await storedOptions(outingId)).toMatchObject({ basis: "CATEGORY_MEDIAN", anchorMinor: 4_000, optionsMinor: [2_000, 3_000, 4_000, 6_000, 8_000] });
  });

  it("outings stored without options (or with tampered ones) get the default list for their unit; votes stay any amount", async () => {
    await seedAllVenues();
    aiState.current = new FixtureOutingsAi();
    const padel = OUTING_STARTERS.find((s) => s.id === "padel-doubles")!;
    const { outingId, participantId } = await svc.createOuting(getDb(), { organizerName: "Alex", brief: padel.brief });
    const outing = (await getDb().query.outings.findFirst({ where: eq(outings.id, outingId) }))!;
    const stored = svc.storedExtraction(outing)!;

    const { budgetOptions: _dropped, ...legacy } = stored;
    expect(_dropped).toBeDefined();
    await getDb().update(outings).set({ briefExtraction: legacy }).where(eq(outings.id, outingId));
    expect((await buildOutingView(getDb(), { outingId, participantId })).budget.options).toEqual([...DEFAULT_BUDGET_OPTIONS_MINOR]);

    await getDb()
      .update(outings)
      .set({ briefExtraction: { ...stored, budgetOptions: { ...stored.budgetOptions!, optionsMinor: [1, 2, 3] } } })
      .where(eq(outings.id, outingId));
    expect((await buildOutingView(getDb(), { outingId, participantId })).budget.options).toEqual([...DEFAULT_BUDGET_OPTIONS_MINOR]);

    // An outing from before per-person voting has no stored options and voted on a group total.
    await getDb().update(outings).set({ briefExtraction: legacy, budgetUnit: "TOTAL" }).where(eq(outings.id, outingId));
    expect((await buildOutingView(getDb(), { outingId, participantId })).budget).toMatchObject({ unit: "TOTAL", options: [...LEGACY_TOTAL_OPTIONS_MINOR] });
    await getDb().update(outings).set({ briefExtraction: stored, budgetUnit: "PER_PERSON" }).where(eq(outings.id, outingId));

    // Options are tiles, not limits: a custom vote outside them is still accepted.
    await svc.startBudget(getDb(), { outingId, participantId });
    await svc.vote(getDb(), { outingId, participantId }, { amountMinor: 12_345 });
    expect((await buildOutingView(getDb(), { outingId, participantId })).budget.myVoteMinor).toBe(12_345);
  });
});

/* ------------------------- venues through openCollection --------------------- */

/** A start time the offering's availability model accepts, a few hours after `after`. */
function slotFor(item: VenueOfferingSpec, after: Date): Date {
  const weekday = item.availability.weekdays[0];
  const hour = item.availability.startHours[item.availability.startHours.length - 1];
  return nextLocalWeekdayAt(after, weekday, hour, DEMO_TIMEZONE);
}

const venueOfferings = DEMO_VENUE_SPECS.flatMap((v) => v.offerings.map((o) => [v.slug, o] as const));

describe("fictional demo venues", () => {
  it("are all FIXED_TOTAL and unique per slug", () => {
    expect(venueOfferings.length).toBeGreaterThanOrEqual(4);
    for (const [, o] of venueOfferings) expect(o.pricingModel).toBe("FIXED_TOTAL");
    expect(new Set(DEMO_VENUE_SPECS.map((v) => v.slug)).size).toBe(DEMO_VENUE_SPECS.length);
    expect(DEMO_VENUE_SPECS.map((v) => v.slug).every((s) => (DEMO_VENUE_SLUGS as readonly string[]).includes(s))).toBe(true);
  });

  it.each(venueOfferings.map(([slug, o]) => [`${slug}/${o.slug}`, slug, o] as const))(
    "%s can be shared through openCollection",
    async (_name, venueSlug, item) => {
      const db = getDb();
      await seedAllVenues();
      const now = new Date();
      const { outingId, participantId } = await svc.createOuting(db, { organizerName: "Alex", brief: "Something fun for three of us" }, now);
      const org = { outingId, participantId };
      await svc.addInvitees(db, org, { names: ["Ben", "Freya"] }, now);
      await svc.startBudget(db, org, now);
      await svc.agreeBudget(db, org, { amountMinor: item.priceMinor }, now);
      const offering = (await db
        .select({ id: offerings.id })
        .from(offerings)
        .innerJoin(merchants, eq(offerings.merchantId, merchants.id))
        .where(and(eq(merchants.slug, venueSlug), eq(offerings.slug, item.slug))))[0];
      await svc.selectOffering(db, org, { offeringId: offering.id }, now);

      const deadlineAt = new Date(now.getTime() + 2 * HOUR);
      const activityAt = slotFor(item, new Date(deadlineAt.getTime() + HOUR));
      const opened = await svc.openCollection(db, org, { activityAt, deadlineAt, minPayers: 3 }, now);

      const quote = (await db.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, opened.quoteId) }))!;
      const merchant = (await db.query.merchants.findFirst({ where: eq(merchants.slug, venueSlug) }))!;
      expect(quote).toMatchObject({ totalMinor: item.priceMinor, pricingModel: "FIXED_TOTAL", merchantId: merchant.id, capacity: item.capacity });
      expect(quote.capMinor).toBe(Math.ceil(item.priceMinor / 3));
      const outing = (await db.query.outings.findFirst({ where: eq(outings.id, outingId) }))!;
      expect(outing).toMatchObject({ status: "COLLECTING", merchantId: merchant.id });
    },
  );
});

/* ----------------------------- merchant demo login -------------------------- */

describe("merchant demo login by venue", () => {
  const login = (payload: unknown) => demoLoginRoute.POST(request("/api/merchant/demo-login", { body: payload }));

  it("opens only demo venues, each scoped to its own bookings", async () => {
    const db = getDb();
    await seedAllVenues();
    // A padel booking at Glasswall Padel.
    const padel = DEMO_VENUE_SPECS.find((v) => v.slug === "glasswall-padel")!.offerings[0];
    const now = new Date();
    const { outingId, participantId } = await svc.createOuting(db, { organizerName: "Alex", brief: "Padel for two" }, now);
    const org = { outingId, participantId };
    await svc.addInvitees(db, org, { names: ["Ben"] }, now);
    await svc.startBudget(db, org, now);
    await svc.agreeBudget(db, org, { amountMinor: padel.priceMinor }, now);
    const padelRow = (await db.select({ id: offerings.id }).from(offerings).where(eq(offerings.slug, padel.slug)))[0];
    await svc.selectOffering(db, org, { offeringId: padelRow.id }, now);
    const deadlineAt = new Date(now.getTime() + 2 * HOUR);
    await svc.openCollection(db, org, { deadlineAt, activityAt: slotFor(padel, new Date(deadlineAt.getTime() + HOUR)), minPayers: 2 }, now);

    const padelLogin = await login({ venue: "glasswall-padel" });
    expect(padelLogin.status).toBe(200);
    expect((await body<{ merchant: { name: string } }>(padelLogin)).merchant.name).toBe("Glasswall Padel");
    const padelCookie = cookiePair(padelLogin.headers.get("set-cookie")!);
    const padelRows = await body<{ outingId: string }[]>(await bookingsRoute.GET(request("/api/merchant/bookings", { cookie: padelCookie })));
    expect(padelRows.map((r) => r.outingId)).toEqual([outingId]);

    // Default is The Sound Room, which does not see the padel booking.
    const defaultLogin = await login({});
    expect(defaultLogin.status).toBe(200);
    expect((await body<{ merchant: { name: string } }>(defaultLogin)).merchant.name).toBe(DEMO_VENUE_NAMES[DEMO_MERCHANT_SLUG]);
    const soundRows = await body<{ outingId: string }[]>(
      await bookingsRoute.GET(request("/api/merchant/bookings", { cookie: cookiePair(defaultLogin.headers.get("set-cookie")!) })),
    );
    expect(soundRows.map((r) => r.outingId)).not.toContain(outingId);

    // Anything outside the demo set is 404 and sets no cookie, even an existing non-demo merchant.
    resetRateLimits();
    await db.insert(merchants).values({ slug: "someone-real", name: "Someone Real", timezone: DEMO_TIMEZONE });
    for (const venue of ["someone-real", "", "../the-sound-room", "THE-SOUND-ROOM"]) {
      const res = await login({ venue });
      expect(res.status, venue).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    resetRateLimits();
    expect((await login({ venue: 42 })).status).toBe(400);
  });

  it("answers 503 for a demo venue that has not been seeded yet", async () => {
    await seedCatalogue(getDb());
    const res = await login({ venue: "cork-and-pebble" });
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

/* ------------------------------- seeding paths ------------------------------ */

describe("seeding creates the venues", () => {
  it("seed/reset upserts them with the configured payee coalesced like The Sound Room", async () => {
    const db = getDb();
    await seedDemo(db, { now: new Date() });
    const rows = await db.query.merchants.findMany();
    expect(rows.map((m) => m.slug).sort()).toEqual([...DEMO_VENUE_SLUGS].sort());
    for (const m of rows) expect(m.paypalMerchantId).toBeNull();

    await db.update(merchants).set({ paypalMerchantId: "MANUAL-PAYEE" }).where(eq(merchants.slug, "cork-and-pebble"));
    await db.update(offerings).set({ priceMinor: 1 }).where(eq(offerings.slug, "private-tasting-table"));
    await seedDemo(db, { now: new Date() });
    expect((await db.query.merchants.findFirst({ where: eq(merchants.slug, "cork-and-pebble") }))!.paypalMerchantId).toBe("MANUAL-PAYEE");
    // The explicit reset restores the demo price.
    expect((await db.query.offerings.findFirst({ where: eq(offerings.slug, "private-tasting-table") }))!.priceMinor).toBe(24_000);
  });

  it("the lazy scenario path creates missing venues but never rewrites existing ones", async () => {
    const db = getDb();
    await seedCatalogue(db);
    await seedDemoVenues(db);
    await db.update(offerings).set({ priceMinor: 9_900 }).where(eq(offerings.slug, "padel-court-90"));
    await db.delete(offerings).where(eq(offerings.slug, "private-screening-room"));
    await db.delete(merchants).where(eq(merchants.slug, "velvet-seats-screening-room"));

    await createDemoScenario(db, { kind: "holdout" });

    expect((await db.query.offerings.findFirst({ where: eq(offerings.slug, "padel-court-90") }))!.priceMinor).toBe(9_900);
    const cinema = await db.query.merchants.findFirst({ where: eq(merchants.slug, "velvet-seats-screening-room") });
    expect(cinema).toBeDefined();
    expect((await db.query.offerings.findFirst({ where: eq(offerings.merchantId, cinema!.id) }))!.priceMinor).toBe(12_000);
  });
});
