/**
 * Budget-poker vote amounts: the five TOTAL amounts (integer minor units, for
 * the whole group) offered as one-tap votes. Pure; no I/O.
 *
 * "AI never decides money": the AI may SUGGEST five amounts, these rules
 * decide whether that suggestion is allowed, and a deterministic ladder is
 * used whenever it is not. The organizer and voters still decide the budget;
 * votes themselves stay any positive amount up to MAX_BUDGET_MINOR.
 */
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
  /** Five TOTAL amounts suggested by the AI, or null when it suggested none. Untrusted. */
  suggestionMinor: readonly number[] | null;
  stated: StatedBudget;
  groupSize: number | null;
  /** Catalogue categories the brief maps to (already filtered to the real catalogue). */
  categories: readonly string[];
  /** Active offerings, all categories. */
  catalogue: readonly PricedOffering[];
}

/** Where the ladder's middle amount came from. */
export type BudgetAnchorBasis = "BRIEF_TOTAL" | "BRIEF_PER_PERSON" | "CATEGORY_MEDIAN" | "DEFAULT";

/** Where the final options came from. FIXED_LIST is the historic list, used only as a last resort. */
export type BudgetOptionsBasis = "AI_SUGGESTION" | BudgetAnchorBasis | "FIXED_LIST";

export interface BudgetAnchor {
  amountMinor: number;
  basis: BudgetAnchorBasis;
}

export interface BudgetOptionsDecision {
  optionsMinor: number[];
  basis: BudgetOptionsBasis;
  /** The amount the brief states for the whole group (TOTAL or PER_PERSON x group size), if any. */
  statedTotalMinor: number | null;
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
/** Options are whole $5 steps so the tiles read cleanly. */
export const BUDGET_OPTION_STEP_MINOR = 500;
export const MIN_BUDGET_OPTION_MINOR = 500;
/** The largest option may be at most this many times the smallest (keeps the range about one outing). */
export const MAX_OPTION_SPREAD = 10;
/** Historic fixed list: still served to outings created before options were stored. */
export const DEFAULT_BUDGET_OPTIONS_MINOR: readonly number[] = [5000, 7500, 10_000, 15_000, 20_000];
/** Anchor when neither the brief nor the catalogue gives one; its ladder equals the historic list. */
export const DEFAULT_ANCHOR_MINOR = 10_000;
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

/** Exactly five whole-$5 amounts, strictly increasing, $5 .. MAX_BUDGET_MINOR, largest <= 10 x smallest. */
export function validateBudgetOptions(values: unknown): BudgetOptionsValidation {
  if (!Array.isArray(values) || values.length !== BUDGET_OPTION_COUNT) {
    return { ok: false, reason: `there must be exactly ${BUDGET_OPTION_COUNT} amounts` };
  }
  if (!values.every(isAmount)) return { ok: false, reason: "every amount must be a whole number of cents" };
  if (values.some((v) => v % BUDGET_OPTION_STEP_MINOR !== 0)) return { ok: false, reason: "every amount must be a multiple of $5" };
  if (values.some((v, i) => i > 0 && v <= values[i - 1])) return { ok: false, reason: "amounts must be strictly increasing" };
  const smallest = values[0];
  const largest = values[values.length - 1];
  if (smallest < MIN_BUDGET_OPTION_MINOR) return { ok: false, reason: "the smallest amount must be at least $5" };
  if (largest > MAX_BUDGET_MINOR) return { ok: false, reason: "the largest amount is above the budget limit" };
  if (largest > smallest * MAX_OPTION_SPREAD) return { ok: false, reason: `the largest amount must be at most ${MAX_OPTION_SPREAD} times the smallest` };
  return { ok: true, optionsMinor: [...values] };
}

/* --------------------------------- Anchors --------------------------------- */

/** The whole group's amount the brief states: a TOTAL, or PER_PERSON x group size when both are known. */
export function statedTotalMinor(stated: StatedBudget, groupSize: number | null): number | null {
  if (!isAmount(stated.amountMinor) || stated.amountMinor <= 0) return null;
  if (stated.unit === "TOTAL") return stated.amountMinor;
  if (stated.unit === "PER_PERSON" && isAmount(groupSize) && groupSize > 0) return stated.amountMinor * groupSize;
  return null;
}

/** What the whole group would pay: the fixed total, or the per-attendee price x group size (unknown size -> not comparable). */
export function comparableTotalMinor(offering: PricedOffering, groupSize: number | null): number | null {
  if (offering.pricingModel === "FIXED_TOTAL") return offering.priceMinor;
  return isAmount(groupSize) && groupSize > 0 ? offering.priceMinor * groupSize : null;
}

/** Median; for an even count the LOWER middle value, so a budget suggestion never leans upwards. */
export function lowerMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** Lower median of the comparable totals of active offerings in the brief's categories. */
export function categoryMedianMinor(catalogue: readonly PricedOffering[], categories: readonly string[], groupSize: number | null): number | null {
  const wanted = new Set(categories.map((c) => c.toLowerCase()));
  const totals = catalogue
    .filter((o) => wanted.has(o.category.toLowerCase()))
    .map((o) => comparableTotalMinor(o, groupSize))
    .filter((t): t is number => t !== null && t > 0);
  return lowerMedian(totals);
}

/** Brief amount first, then what the matching catalogue costs, then the historic default. */
export function chooseAnchor(input: Omit<BudgetOptionsInput, "suggestionMinor">): BudgetAnchor {
  const stated = statedTotalMinor(input.stated, input.groupSize);
  if (stated !== null) return { amountMinor: stated, basis: input.stated.unit === "TOTAL" ? "BRIEF_TOTAL" : "BRIEF_PER_PERSON" };
  const median = categoryMedianMinor(input.catalogue, input.categories, input.groupSize);
  if (median !== null) return { amountMinor: median, basis: "CATEGORY_MEDIAN" };
  return { amountMinor: DEFAULT_ANCHOR_MINOR, basis: "DEFAULT" };
}

/* ---------------------------------- Ladder --------------------------------- */

/** round(value x numerator / denominator) to the nearest $5 step, half up, in integer arithmetic. */
function scaleToStep(valueMinor: number, [numerator, denominator]: readonly [number, number]): number {
  const scaled = valueMinor * numerator;
  const unit = denominator * BUDGET_OPTION_STEP_MINOR;
  return Math.floor((2 * scaled + unit) / (2 * unit)) * BUDGET_OPTION_STEP_MINOR;
}

/** anchor x [0.5, 0.75, 1, 1.5, 2], each rounded to $5, forced strictly increasing and >= $5. */
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

/** Why an AI suggestion cannot be used, or null when it can. */
function rejectSuggestion(suggestion: readonly number[], statedTotal: number | null): string | null {
  const validation = validateBudgetOptions(suggestion);
  if (!validation.ok) return `The AI's suggested vote amounts were not used: ${validation.reason}.`;
  // The model may not move the vote away from the budget the organizer wrote down.
  const [smallest, largest] = [suggestion[0], suggestion[suggestion.length - 1]];
  if (statedTotal !== null && (statedTotal < smallest || statedTotal > largest)) {
    return "The AI's suggested vote amounts were not used: they do not include the budget stated in the brief.";
  }
  return null;
}

/**
 * Final options = the validated AI suggestion, else the deterministic ladder,
 * else the historic fixed list (only reachable if the ladder were invalid).
 */
export function chooseBudgetOptions(input: BudgetOptionsInput): BudgetOptionsDecision {
  const statedTotal = statedTotalMinor(input.stated, input.groupSize);
  const notes: string[] = [];
  if (input.suggestionMinor !== null) {
    const rejection = rejectSuggestion(input.suggestionMinor, statedTotal);
    if (rejection === null) {
      return { optionsMinor: [...input.suggestionMinor], basis: "AI_SUGGESTION", statedTotalMinor: statedTotal, anchorMinor: null, notes };
    }
    notes.push(rejection);
  }
  const anchor = chooseAnchor(input);
  const ladder = validateBudgetOptions(fallbackLadder(anchor.amountMinor));
  if (ladder.ok) return { optionsMinor: ladder.optionsMinor, basis: anchor.basis, statedTotalMinor: statedTotal, anchorMinor: anchor.amountMinor, notes };
  return { optionsMinor: [...DEFAULT_BUDGET_OPTIONS_MINOR], basis: "FIXED_LIST", statedTotalMinor: statedTotal, anchorMinor: null, notes };
}
