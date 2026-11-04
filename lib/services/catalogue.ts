/**
 * Merchant catalogue: active offerings, the sanitized catalogue the AI may
 * rank (prices always come from OUR database, never from model output), and
 * the demo availability model.
 *
 * Availability model (labelled FIXTURE in the UI): `offerings.availability`
 * = { weekdays, startHours, source }. `weekdays` uses the JS convention
 * 0 = Sunday … 6 = Saturday and, like `startHours`, is evaluated in the
 * MERCHANT's timezone. A slot is available when the activity starts exactly
 * on one of the listed hours (minute 0) of a listed weekday.
 */
import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { merchants, offerings, type Merchant, type Offering } from "../db/schema";
import type { CatalogueItemForAi } from "../ai/types";

export interface CatalogueEntry {
  offering: Offering;
  merchant: Merchant;
}

export async function listActiveOfferings(db: DbOrTx): Promise<CatalogueEntry[]> {
  const rows = await db
    .select({ offering: offerings, merchant: merchants })
    .from(offerings)
    .innerJoin(merchants, eq(offerings.merchantId, merchants.id))
    .where(eq(offerings.active, true))
    .orderBy(asc(merchants.name), asc(offerings.priceMinor), asc(offerings.slug));
  return rows;
}

export async function getOfferingWithMerchant(db: DbOrTx, offeringId: string): Promise<CatalogueEntry | null> {
  const rows = await db
    .select({ offering: offerings, merchant: merchants })
    .from(offerings)
    .innerJoin(merchants, eq(offerings.merchantId, merchants.id))
    .where(eq(offerings.id, offeringId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getActiveOfferingWithMerchant(db: DbOrTx, offeringId: string): Promise<CatalogueEntry | null> {
  const rows = await db
    .select({ offering: offerings, merchant: merchants })
    .from(offerings)
    .innerJoin(merchants, eq(offerings.merchantId, merchants.id))
    .where(and(eq(offerings.id, offeringId), eq(offerings.active, true)))
    .limit(1);
  return rows[0] ?? null;
}

/** Sanitized catalogue for the model. Only fields we are happy to show a model; no internal ids beyond offeringId. */
export function toCatalogueForAi(entries: readonly CatalogueEntry[]): CatalogueItemForAi[] {
  return entries.map(({ offering, merchant }) => ({
    offeringId: offering.id,
    name: offering.name,
    merchantName: merchant.name,
    category: offering.category,
    description: offering.description,
    pricingModel: offering.pricingModel,
    priceMinor: offering.priceMinor,
    currency: offering.currency,
    capacity: offering.capacity,
    minAttendees: offering.minAttendees,
    tags: offering.tags ?? [],
  }));
}

export function catalogueCategories(entries: readonly CatalogueEntry[]): string[] {
  return [...new Set(entries.map((e) => e.offering.category))].sort();
}

/* ------------------------------- time zones -------------------------------- */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  hour: number;
  minute: number;
  second: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Calendar fields of an instant in an IANA timezone. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
  };
}

/** The UTC instant of a local wall-clock time in `timeZone` (DST-safe for non-ambiguous times). */
export function zonedTimeToUtc(
  local: { year: number; month: number; day: number; hour: number; minute?: number },
  timeZone: string,
): Date {
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute ?? 0, 0, 0);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const offset = asUtc - guess;
    const next = wall - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** True when both instants fall on the same local calendar date in `timeZone`. */
export function sameLocalDate(a: Date, b: Date, timeZone: string): boolean {
  const pa = zonedParts(a, timeZone);
  const pb = zonedParts(b, timeZone);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

/* ------------------------------ availability -------------------------------- */

export interface AvailabilityResult {
  available: boolean;
  source: "FIXTURE" | "MERCHANT_API";
  reason: string | null;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Check a requested activity start against the offering's availability model.
 * FIXTURE source = demo catalogue model; the quote records the source so the
 * UI can label it honestly.
 */
export function checkAvailability(offering: Offering, merchantTimezone: string, activityAt: Date): AvailabilityResult {
  const model = offering.availability;
  const source = model?.source === "MERCHANT_API" ? "MERCHANT_API" : "FIXTURE";
  if (!offering.active) return { available: false, source, reason: "This offering is no longer available" };
  if (!model || !Array.isArray(model.weekdays) || !Array.isArray(model.startHours)) {
    return { available: false, source, reason: "No availability is published for this offering" };
  }
  const p = zonedParts(activityAt, merchantTimezone);
  if (!model.weekdays.includes(p.weekday)) {
    const days = [...model.weekdays].sort().map((d) => DAY_NAMES[d] ?? String(d));
    return { available: false, source, reason: `${offering.name} is only available on ${days.join(", ")}` };
  }
  if (p.minute !== 0 || p.second !== 0 || !model.startHours.includes(p.hour)) {
    const hours = [...model.startHours].sort((a, b) => a - b).map((h) => `${String(h).padStart(2, "0")}:00`);
    return { available: false, source, reason: `${offering.name} starts at ${hours.join(", ")} (${merchantTimezone})` };
  }
  return { available: true, source, reason: null };
}
