/**
 * Budget-poker vote amounts: the five PER-PERSON amounts (integer minor units,
 * "what would you personally pay?") offered as one-tap votes. Pure; no I/O.
 *
 * "AI never decides money": the AI may SUGGEST five amounts, these rules
 * decide whether that suggestion is allowed, and a deterministic ladder is
 * used whenever it is not. The organizer and voters still decide the budget;
 * votes themselves stay any positive amount up to MAX_BUDGET_MINOR.
 *
 * Outings created before per-person voting voted on a TOTAL for the whole
 * group. Their stored amounts still pass `validateBudgetOptions` (a whole $5
 * is also a whole $1), and LEGACY_TOTAL_OPTIONS_MINOR serves the oldest ones.
 */
import { perPersonShareMinor } from "./budget-fit";
import { ceilDiv } from "./money";
import type { PricingModel } from "./types";

/* --------------------------------- Types ----------------------------------- */

export type StatedBudgetUnit = "TOTAL" | "PER_PERSON" | "UNKNOWN";

/** The budget as the brief states it (already validated against the brief text). */
export interface StatedBudget {
  amountMinor: number | null;
  unit: StatedBudgetUnit;
}

/** The catalogue fields the ladder needs: public price data only. */
export interface PricedOffering {
  category: string;
  pricingModel: PricingModel;
  priceMinor: number;
}

export interface BudgetOptionsInput {
  /** Five PER-PERSON amounts suggested by the AI, or null when it suggested none. Untrusted. */
  suggestionMinor: readonly number[] | null;
  stated: StatedBudget;
  /** People coming, as the brief states it. */
  groupSize: number | null;
  /** The brief says the group covers one guest's share: that guest comes but does not pay. */
  coversGuest: boolean;
  /** Catalogue categories the brief maps to (already filtered to the real catalogue). */
  categories: readonly string[];
  /** Active offerings, all categories. */
  catalogue: readonly PricedOffering[];
}

/** Where the ladder's middle amount came from. */
export type BudgetAnchorBasis = "BRIEF_TOTAL" | "BRIEF_PER_PERSON" | "CATEGORY_MEDIAN" | "DEFAULT";

/** Where the final options came from. FIXED_LIST is the default list, used only as a last resort. */
export type BudgetOptionsBasis = "AI_SUGGESTION" | BudgetAnchorBasis | "FIXED_LIST";

export interface BudgetAnchor {
  amountMinor: number;
  basis: BudgetAnchorBasis;
}

export interface BudgetOptionsDecision {
  optionsMinor: number[];
  basis: BudgetOptionsBasis;
  /** What the brief's budget means for one payer (a PER_PERSON amount, or a TOTAL / people paying), if any. */
  statedPerPersonMinor: number | null;
  /** Middle amount of the deterministic ladder; null when the AI suggestion was used as-is. */
  anchorMinor: number | null;
  /** Plain-language reasons an AI suggestion was not used. */
  notes: string[];
}

export type BudgetOptionsValidation = { ok: true; optionsMinor: number[] } | { ok: false; reason: string };

/* ------------------------------- Constants --------------------------------- */

/** $100,000: upper bound for any budget vote / agreed budget. */
export const MAX_BUDGET_MINOR = 10_000_000;
export const BUDGET_OPTION_COUNT = 5;
/** Options are whole dollars: a per-person amount is too small for coarser steps to stay centred on the anchor. */
export const BUDGET_OPTION_STEP_MINOR = 100;
export const MIN_BUDGET_OPTION_MINOR = 100;
/** The largest option may be at most this many times the smallest (keeps the range about one outing). */
export const MAX_OPTION_SPREAD = 10;
/** Anchor when neither the brief nor the catalogue gives one: $20 per person. */
export const DEFAULT_ANCHOR_MINOR = 2_000;
/** The ladder around the default anchor: $10, $15, $20, $30, $40 per person. */
export const DEFAULT_BUDGET_OPTIONS_MINOR: readonly number[] = [1_000, 1_500, 2_000, 3_000, 4_000];
/** TOTAL amounts served to outings created before vote amounts were stored (they voted on a group total). */
export const LEGACY_TOTAL_OPTIONS_MINOR: readonly number[] = [5_000, 7_500, 10_000, 15_000, 20_000];
/** Ladder multipliers 0.5, 0.75, 1, 1.5, 2 as exact fractions, so no float ever touches an amount. */
const LADDER_FRACTIONS: readonly (readonly [numerator: number, denominator: number])[] = [
  [1, 2],
  [3, 4],
  [1, 1],
  [3, 2],
  [2, 1],
];
/** Largest anchor whose top rung (2x) still fits under MAX_BUDGET_MINOR. */
const MAX_ANCHOR_MINOR = MAX_BUDGET_MINOR / 2;

/* ------------------------------- Validation -------------------------------- */

const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isHeadcount = (value: number | null): value is number => isAmount(value) && value > 0;

/** Exactly five whole-dollar amounts, strictly increasing, $1 .. MAX_BUDGET_MINOR, largest <= 10 x smallest. */
export function validateBudgetOptions(values: unknown): BudgetOptionsValidation {
  if (!Array.isArray(values) || values.length !== BUDGET_OPTION_COUNT) {
    return { ok: false, reason: `there must be exactly ${BUDGET_OPTION_COUNT} amounts` };
  }
  if (!values.every(isAmount)) return { ok: false, reason: "every amount must be a whole number of cents" };
  if (values.some((v) => v % BUDGET_OPTION_STEP_MINOR !== 0)) return { ok: false, reason: "every amount must be a whole dollar amount" };
  if (values.some((v, i) => i > 0 && v <= values[i - 1])) return { ok: false, reason: "amounts must be strictly increasing" };
  const smallest = values[0];
  const largest = values[values.length - 1];
  if (smallest < MIN_BUDGET_OPTION_MINOR) return { ok: false, reason: "the smallest amount must be at least $1" };
  if (largest > MAX_BUDGET_MINOR) return { ok: false, reason: "the largest amount is above the budget limit" };
  if (largest > smallest * MAX_OPTION_SPREAD) return { ok: false, reason: `the largest amount must be at most ${MAX_OPTION_SPREAD} times the smallest` };
  return { ok: true, optionsMinor: [...values] };
}

/* --------------------------------- Anchors --------------------------------- */

/** People expected to pay: everyone the brief counts, minus a covered guest; null when the size is unknown. */
export function expectedPayers(groupSize: number | null, coversGuest: boolean): number | null {
  if (!isHeadcount(groupSize)) return null;
  return Math.max(1, groupSize - (coversGuest ? 1 : 0));
}

/** What the brief's budget means for one payer: a PER_PERSON amount as stated, or a TOTAL / people paying (rounded up). */
export function statedPerPersonMinor(stated: StatedBudget, payers: number | null): number | null {
  if (!isAmount(stated.amountMinor) || stated.amountMinor <= 0) return null;
  if (stated.unit === "PER_PERSON") return stated.amountMinor;
  if (stated.unit === "TOTAL" && isHeadcount(payers)) return ceilDiv(stated.amountMinor, payers);
  return null;
}

/**
 * What one payer would pay for the offering. A fixed total needs the number of
 * payers (unknown -> not comparable); a per-attendee price is the share itself
 * until the group size says a covered guest raises it.
 */
export function perPersonCostMinor(offering: PricedOffering, groupSize: number | null, payers: number | null): number | null {
  if (!isAmount(offering.priceMinor) || offering.priceMinor <= 0) return null;
  if (isHeadcount(groupSize) && isHeadcount(payers) && payers <= groupSize) {
    return perPersonShareMinor(offering, { attendees: groupSize, payers });
  }
  return offering.pricingModel === "PER_ATTENDEE" ? offering.priceMinor : null;
}

/** Median; for an even count the LOWER middle value, so a budget suggestion never leans upwards. */
export function lowerMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** Lower median of the per-person costs of active offerings in the brief's categories. */
export function categoryMedianMinor(
  catalogue: readonly PricedOffering[],
  categories: readonly string[],
  groupSize: number | null,
  payers: number | null,
): number | null {
  const wanted = new Set(categories.map((c) => c.toLowerCase()));
  const costs = catalogue
    .filter((o) => wanted.has(o.category.toLowerCase()))
    .map((o) => perPersonCostMinor(o, groupSize, payers))
    .filter((cost): cost is number => cost !== null && cost > 0);
  return lowerMedian(costs);
}

/** Brief amount first, then what the matching catalogue costs per person, then the default. */
export function chooseAnchor(input: Omit<BudgetOptionsInput, "suggestionMinor">): BudgetAnchor {
  const payers = expectedPayers(input.groupSize, input.coversGuest);
  const stated = statedPerPersonMinor(input.stated, payers);
  if (stated !== null) return { amountMinor: stated, basis: input.stated.unit === "TOTAL" ? "BRIEF_TOTAL" : "BRIEF_PER_PERSON" };
  const median = categoryMedianMinor(input.catalogue, input.categories, input.groupSize, payers);
  if (median !== null) return { amountMinor: median, basis: "CATEGORY_MEDIAN" };
  return { amountMinor: DEFAULT_ANCHOR_MINOR, basis: "DEFAULT" };
}

/* ---------------------------------- Ladder --------------------------------- */

/** round(value x numerator / denominator) to the nearest whole dollar, half up, in integer arithmetic. */
function scaleToStep(valueMinor: number, [numerator, denominator]: readonly [number, number]): number {
  const scaled = valueMinor * numerator;
  const unit = denominator * BUDGET_OPTION_STEP_MINOR;
  return Math.floor((2 * scaled + unit) / (2 * unit)) * BUDGET_OPTION_STEP_MINOR;
}

/** anchor x [0.5, 0.75, 1, 1.5, 2], each rounded to a whole dollar, forced strictly increasing and >= $1. */
export function fallbackLadder(anchorMinor: number): number[] {
  const anchor = Math.min(Math.max(anchorMinor, 0), MAX_ANCHOR_MINOR);
  const ladder: number[] = [];
  for (const fraction of LADDER_FRACTIONS) {
    const floor = ladder.length === 0 ? MIN_BUDGET_OPTION_MINOR : ladder[ladder.length - 1] + BUDGET_OPTION_STEP_MINOR;
    ladder.push(Math.max(scaleToStep(anchor, fraction), floor));
  }
  return ladder;
}

/* --------------------------------- Decision -------------------------------- */

const NOT_USED = "The AI's suggested vote amounts were not used:";

/** Why an anchor the app trusts must sit inside the AI's range, in the brief's or the catalogue's words. */
function outsideRangeReason(basis: BudgetAnchorBasis): string {
  return basis === "CATEGORY_MEDIAN"
    ? `${NOT_USED} they do not include what matching venues cost per person.`
    : `${NOT_USED} they do not include the budget stated in the brief.`;
}

/** Why an AI suggestion cannot be used, or null when it can. */
function rejectSuggestion(suggestion: readonly number[], anchor: BudgetAnchor): string | null {
  const validation = validateBudgetOptions(suggestion);
  if (!validation.ok) return `${NOT_USED} ${validation.reason}.`;
  // The DEFAULT anchor is only a guess, so it constrains nothing.
  if (anchor.basis === "DEFAULT") return null;
  // The model may not move the vote away from what the organizer wrote or what the venues cost. This is
  // also what catches a model answering with whole-group totals: they land far above the per-person anchor.
  const [smallest, largest] = [suggestion[0], suggestion[suggestion.length - 1]];
  if (anchor.amountMinor < smallest || anchor.amountMinor > largest) return outsideRangeReason(anchor.basis);
  return null;
}

/**
 * Final options = the validated AI suggestion, else the deterministic ladder,
 * else the default list (only reachable if the ladder were invalid).
 */
export function chooseBudgetOptions(input: BudgetOptionsInput): BudgetOptionsDecision {
  const statedPerPerson = statedPerPersonMinor(input.stated, expectedPayers(input.groupSize, input.coversGuest));
  const anchor = chooseAnchor(input);
  const notes: string[] = [];
  if (input.suggestionMinor !== null) {
    const rejection = rejectSuggestion(input.suggestionMinor, anchor);
    if (rejection === null) {
      return { optionsMinor: [...input.suggestionMinor], basis: "AI_SUGGESTION", statedPerPersonMinor: statedPerPerson, anchorMinor: null, notes };
    }
    notes.push(rejection);
  }
  const ladder = validateBudgetOptions(fallbackLadder(anchor.amountMinor));
  if (ladder.ok) {
    return { optionsMinor: ladder.optionsMinor, basis: anchor.basis, statedPerPersonMinor: statedPerPerson, anchorMinor: anchor.amountMinor, notes };
  }
  return { optionsMinor: [...DEFAULT_BUDGET_OPTIONS_MINOR], basis: "FIXED_LIST", statedPerPersonMinor: statedPerPerson, anchorMinor: null, notes };
}
