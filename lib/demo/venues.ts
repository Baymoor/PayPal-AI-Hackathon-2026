/**
 * Demo venues: one merchant row per venue and its FIXED_TOTAL offerings.
 *
 * The four venues below are FICTIONAL (invented names and descriptions, not
 * real businesses) so each one-click starter on /new has a matching merchant
 * in the catalogue. Every offering is FIXED_TOTAL because openCollection only
 * shares fixed-total bookings (one price for the group, split between payers).
 *
 * `upsertVenue` is the single write path for demo merchants, including The
 * Sound Room (`seedCatalogue` in ./seed.ts), so payee handling is identical.
 */
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { merchants, offerings, type Merchant, type Offering } from "../db/schema";
import type { PricingModel } from "../domain/types";
import { config } from "../env";
import { DEMO_TIMEZONE, DEMO_VENUE_NAMES, type DemoVenueSlug } from "./constants";

/* --------------------------------- Types ----------------------------------- */

export interface VenueOfferingSpec {
  slug: string;
  name: string;
  category: string;
  description: string;
  location: string;
  pricingModel: PricingModel;
  priceMinor: number;
  minAttendees: number;
  capacity: number;
  durationMinutes: number;
  tags: string[];
  /** Weekly start-time model in the merchant timezone (0 = Sunday); labelled FIXTURE availability. */
  availability: { weekdays: number[]; startHours: number[]; source: "FIXTURE" };
}

export interface VenueSpec {
  slug: string;
  name: string;
  timezone: string;
  offerings: readonly VenueOfferingSpec[];
}

export interface SeededVenue {
  merchant: Merchant;
  /** Offering rows keyed by offering slug. */
  offerings: Record<string, Offering>;
}

/* --------------------------------- Venues ---------------------------------- */

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEDNESDAY_TO_SUNDAY = [0, 3, 4, 5, 6];

function venue(slug: Exclude<DemoVenueSlug, "the-sound-room">, offeringSpecs: VenueOfferingSpec[]): VenueSpec {
  return { slug, name: DEMO_VENUE_NAMES[slug], timezone: DEMO_TIMEZONE, offerings: offeringSpecs };
}

/** The four fictional demo venues (The Sound Room is seeded by seedCatalogue). */
export const DEMO_VENUE_SPECS: readonly VenueSpec[] = [
  venue("velvet-seats-screening-room", [
    {
      slug: "private-screening-room",
      name: "Private screening room",
      category: "cinema",
      description:
        "A private cinema room for up to 10 with a big screen, sofas and your choice of film. One fixed price for the room, so every extra guest lowers each share.",
      location: "Velvet Seats Screening Room, Nørrebro, Copenhagen",
      pricingModel: "FIXED_TOTAL",
      priceMinor: 12_000,
      minAttendees: 2,
      capacity: 10,
      durationMinutes: 150,
      tags: ["private room", "movie", "film", "fixed total"],
      availability: { weekdays: ALL_DAYS, startHours: [17, 18, 19, 20, 21], source: "FIXTURE" },
    },
  ]),
  venue("cork-and-pebble", [
    {
      slug: "private-tasting-table",
      name: "Private wine tasting table",
      category: "wine-tasting",
      description:
        "Six wines from small producers, poured by a sommelier at your own table for up to 8, with bread and cheese. One fixed price for the table.",
      location: "Cork & Pebble Tasting Room, Christianshavn, Copenhagen",
      pricingModel: "FIXED_TOTAL",
      priceMinor: 24_000,
      minAttendees: 2,
      capacity: 8,
      durationMinutes: 120,
      tags: ["private table", "wine", "tasting", "fixed total"],
      availability: { weekdays: WEDNESDAY_TO_SUNDAY, startHours: [16, 17, 18, 19, 20], source: "FIXTURE" },
    },
  ]),
  venue("iron-lantern-gym", [
    {
      slug: "coach-led-group-session",
      name: "Coach-led small-group session",
      category: "fitness",
      description:
        "A 60-minute strength circuit for up to 6 with one of our coaches at our newly opened gym. All levels. One fixed price for the group.",
      location: "Iron Lantern Gym, Nordhavn, Copenhagen",
      pricingModel: "FIXED_TOTAL",
      priceMinor: 9_000,
      minAttendees: 2,
      capacity: 6,
      durationMinutes: 60,
      tags: ["coach-led", "new gym", "workout", "fixed total"],
      availability: { weekdays: ALL_DAYS, startHours: [7, 8, 9, 10, 17, 18, 19], source: "FIXTURE" },
    },
  ]),
  venue("glasswall-padel", [
    {
      slug: "padel-court-90",
      name: "Padel court for four, 90 minutes",
      category: "padel",
      description: "One indoor court for 90 minutes, rackets and balls included. One fixed price for the court, split between the players.",
      location: "Glasswall Padel, Amager, Copenhagen",
      pricingModel: "FIXED_TOTAL",
      priceMinor: 6_000,
      minAttendees: 2,
      capacity: 4,
      durationMinutes: 90,
      tags: ["court", "doubles", "racket sport", "fixed total"],
      availability: { weekdays: ALL_DAYS, startHours: [8, 10, 12, 14, 16, 18, 20], source: "FIXTURE" },
    },
  ]),
];

/* --------------------------------- Writes ---------------------------------- */

/**
 * Upsert a venue's merchant row and offerings by slug (ids stay stable for
 * outings that reference them).
 *
 * Payee: PayPal orders for a merchant's outings are paid to
 * merchants.paypal_merchant_id (lib/services/payments.ts). A demo merchant gets
 * PAYPAL_MERCHANT_ID when it is set (sandbox credentials configured) and stays
 * null otherwise, so PayPal pays the API caller's own sandbox account. To point
 * it at a separate sandbox business account without the env var:
 *   UPDATE merchants SET paypal_merchant_id = '<merchant id or email>' WHERE slug = '<venue slug>';
 * Re-seeding keeps a value set that way unless PAYPAL_MERCHANT_ID overrides it.
 */
export async function upsertVenue(db: Db, spec: VenueSpec): Promise<SeededVenue> {
  const envPayee = config().paypal?.merchantId ?? null;
  const [merchant] = await db
    .insert(merchants)
    .values({ slug: spec.slug, name: spec.name, timezone: spec.timezone, paypalMerchantId: envPayee })
    .onConflictDoUpdate({
      target: merchants.slug,
      set: { name: spec.name, timezone: spec.timezone, paypalMerchantId: sql`coalesce(excluded.paypal_merchant_id, "merchants"."paypal_merchant_id")` },
    })
    .returning();
  const rows: Record<string, Offering> = {};
  for (const item of spec.offerings) {
    const [row] = await db
      .insert(offerings)
      .values({ merchantId: merchant.id, ...item, currency: "USD", active: true })
      .onConflictDoUpdate({
        target: [offerings.merchantId, offerings.slug],
        set: {
          name: item.name,
          category: item.category,
          description: item.description,
          location: item.location,
          pricingModel: item.pricingModel,
          priceMinor: item.priceMinor,
          currency: "USD",
          minAttendees: item.minAttendees,
          capacity: item.capacity,
          durationMinutes: item.durationMinutes,
          tags: item.tags,
          availability: item.availability,
          active: true,
        },
      })
      .returning();
    rows[item.slug] = row;
  }
  return { merchant, offerings: rows };
}

/** Explicit seed / demo reset: upsert the four fictional venues (resets their price, capacity, availability, active flag). */
export async function seedDemoVenues(db: Db): Promise<SeededVenue[]> {
  const seeded: SeededVenue[] = [];
  for (const spec of DEMO_VENUE_SPECS) seeded.push(await upsertVenue(db, spec));
  return seeded;
}

/**
 * Lazy path (public demo buttons): create venues and offerings that do not
 * exist yet, and never touch existing rows, which real outings may reference
 * and an owner may have changed.
 */
export async function ensureDemoVenues(db: Db): Promise<void> {
  const envPayee = config().paypal?.merchantId ?? null;
  for (const spec of DEMO_VENUE_SPECS) {
    await db
      .insert(merchants)
      .values({ slug: spec.slug, name: spec.name, timezone: spec.timezone, paypalMerchantId: envPayee })
      .onConflictDoNothing({ target: merchants.slug });
    const merchant = await db.query.merchants.findFirst({ columns: { id: true }, where: eq(merchants.slug, spec.slug) });
    if (!merchant) throw new Error(`Demo venue ${spec.slug} could not be created`);
    for (const item of spec.offerings) {
      await db
        .insert(offerings)
        .values({ merchantId: merchant.id, ...item, currency: "USD", active: true })
        .onConflictDoNothing({ target: [offerings.merchantId, offerings.slug] });
    }
  }
}
