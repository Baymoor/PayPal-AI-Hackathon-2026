/**
 * Third independent audit: demo scenarios must not rewrite the shared catalogue.
 *
 * POST /api/demo/scenario is public in demo mode. The merchant and offering rows it
 * books are the SAME rows real (non-fixture) outings reference, so creating a scenario
 * must read them, never overwrite their price / capacity / availability / active flag
 * (that is what the explicit "reset" does). A deactivated offering must make the
 * scenario fail honestly instead of being silently reactivated.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { setupServiceTests } from "../services/helpers";
import { merchants, offerings, outings, quoteVersions } from "@/lib/db/schema";
import { FixtureProvider } from "@/lib/payments/fixture";
import { resetPaymentProviders, setPaymentProviderOverride } from "@/lib/payments";
import { createDemoScenario } from "@/lib/demo/scenarios";
import { seedCatalogue } from "@/lib/demo/seed";
import { DEMO_MERCHANT_SLUG } from "@/lib/demo/constants";
import { ServiceError } from "@/lib/http";

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  const { aiState: state } = await import("../services/fake-ai");
  return { ...actual, getOutingsAi: () => state.current };
});

const getDb = setupServiceTests();

beforeEach(() => {
  resetPaymentProviders();
  setPaymentProviderOverride("FIXTURE", new FixtureProvider({ db: getDb() }));
});
afterAll(() => resetPaymentProviders());

async function room() {
  const db = getDb();
  const merchant = (await db.query.merchants.findFirst({ where: eq(merchants.slug, DEMO_MERCHANT_SLUG) }))!;
  const offering = (await db.query.offerings.findFirst({
    where: and(eq(offerings.merchantId, merchant.id), eq(offerings.slug, "private-karaoke-room")),
  }))!;
  return { merchant, offering };
}

describe("createDemoScenario and the shared catalogue", () => {
  it("books the catalogue as it is: an owner's price / capacity / timezone change is used, not overwritten", async () => {
    const db = getDb();
    await seedCatalogue(db);
    const before = await room();
    await db.update(offerings).set({ priceMinor: 12_000, capacity: 8 }).where(eq(offerings.id, before.offering.id));
    await db.update(merchants).set({ timezone: "Europe/Oslo" }).where(eq(merchants.id, before.merchant.id));

    const s = await createDemoScenario(db, { kind: "holdout", deadlineSeconds: 120 });

    const after = await room();
    expect(after.offering).toMatchObject({ id: before.offering.id, priceMinor: 12_000, capacity: 8, active: true });
    expect(after.merchant).toMatchObject({ id: before.merchant.id, timezone: "Europe/Oslo" });

    // The scenario's terms come from the real rows (5 payers of a $120 room = $24 cap).
    const outing = (await db.query.outings.findFirst({ where: eq(outings.id, s.outingId) }))!;
    const quote = (await db.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, outing.currentQuoteId!) }))!;
    expect(quote).toMatchObject({ totalMinor: 12_000, capMinor: 2_400, capacity: 8 });
  });

  it("refuses to book a deactivated offering instead of reactivating it, and creates nothing", async () => {
    const db = getDb();
    await seedCatalogue(db);
    const { offering } = await room();
    await db.update(offerings).set({ active: false }).where(eq(offerings.id, offering.id));

    const err = await createDemoScenario(db, { kind: "settle-soon" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("OFFERING_UNAVAILABLE");

    expect((await room()).offering.active).toBe(false);
    expect(await db.query.outings.findMany()).toEqual([]);
  });

  it("still seeds the catalogue when it is missing entirely (fresh database)", async () => {
    const db = getDb();
    expect(await db.query.merchants.findMany()).toEqual([]);
    const s = await createDemoScenario(db, { kind: "holdout" });
    const { offering } = await room();
    expect(offering).toMatchObject({ priceMinor: 10_000, active: true });
    expect(s.personas).toHaveLength(6);
  });
});
