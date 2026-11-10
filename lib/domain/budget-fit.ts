/**
 * Budget fit: what an offering would cost, in the unit the group voted in,
 * compared with the amount the group agreed. Pure; no I/O.
 *
 * Per-person budgets use one rule for both pricing models:
 *
 *   share = booking total / people paying
 *
 * - FIXED_TOTAL: the booking total is the listed price, whoever comes.
 * - PER_ATTENDEE: the booking total is the listed price x people coming.
 *
 * A covered (sponsored) guest comes but does not pay, so they raise everyone
 * else's share under both models.
 *
 * Display and ranking only. The quote, the cap and the settled shares come
 * from policy.ts and money.ts; nothing here authorizes or allocates money.
 */
import { assertMinor, assertPositiveMinor, ceilDiv } from "./money";
import type { BudgetUnit, PricingModel } from "./types";

/* --------------------------------- Types ----------------------------------- */

/** The catalogue fields a cost comparison needs: public price data only. */
export interface PricedBooking {
  pricingModel: PricingModel;
  priceMinor: number;
}

/** Who comes and who pays. A covered guest is an attendee but not a payer. */
export interface Headcount {
  attendees: number;
  payers: number;
}

export type BudgetFitKind = "WITHIN" | "OVER";

export interface BudgetFit {
  kind: BudgetFitKind;
  /** The offering's cost in the budget's unit: a share (PER_PERSON) or the booking total (TOTAL). */
  costMinor: number;
  budgetMinor: number;
  /** How far the cost is above the budget; 0 when WITHIN. */
  overByMinor: number;
}

export class InvalidHeadcountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHeadcountError";
  }
}

/* -------------------------------- Headcount -------------------------------- */

const isCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

function assertHeadcount({ attendees, payers }: Headcount): void {
  if (!isCount(attendees) || !isCount(payers)) throw new InvalidHeadcountError("attendees and payers must be whole numbers");
  if (payers < 1) throw new InvalidHeadcountError("at least one person must pay");
  if (payers > attendees) throw new InvalidHeadcountError("payers cannot outnumber attendees");
}

/** Everyone who comes, minus the covered guests; always leaves at least one payer. */
export function headcountOf(attendees: number, coveredGuests: number): Headcount {
  if (!isCount(attendees) || attendees < 1) throw new InvalidHeadcountError("at least one person must attend");
  if (!isCount(coveredGuests)) throw new InvalidHeadcountError("coveredGuests must be a whole number");
  return { attendees, payers: Math.max(1, attendees - coveredGuests) };
}

/* ---------------------------------- Costs ---------------------------------- */

/** What the whole booking costs when this many people come. */
export function bookingTotalMinor(offering: PricedBooking, attendees: number): number {
  assertPositiveMinor(offering.priceMinor, "priceMinor");
  if (offering.pricingModel === "FIXED_TOTAL") return offering.priceMinor;
  if (!isCount(attendees) || attendees < 1) throw new InvalidHeadcountError("at least one person must attend");
  return offering.priceMinor * attendees;
}

/**
 * The most any one payer would pay: ceil(booking total / payers). Equal
 * shares can differ by a cent; rounding up keeps "within budget" true for
 * every payer, not just the ones with the smaller share.
 */
export function perPersonShareMinor(offering: PricedBooking, headcount: Headcount): number {
  assertHeadcount(headcount);
  return ceilDiv(bookingTotalMinor(offering, headcount.attendees), headcount.payers);
}

/** The offering's cost in the unit the budget is expressed in. */
export function comparableCostMinor(offering: PricedBooking, headcount: Headcount, unit: BudgetUnit): number {
  return unit === "PER_PERSON" ? perPersonShareMinor(offering, headcount) : bookingTotalMinor(offering, headcount.attendees);
}

/* ----------------------------------- Fit ----------------------------------- */

/** WITHIN when the cost is at or under the budget; both amounts must be in the same unit. */
export function budgetFit(costMinor: number, budgetMinor: number): BudgetFit {
  assertMinor(costMinor, "costMinor");
  assertPositiveMinor(budgetMinor, "budgetMinor");
  const overByMinor = Math.max(0, costMinor - budgetMinor);
  return { kind: overByMinor === 0 ? "WITHIN" : "OVER", costMinor, budgetMinor, overByMinor };
}
