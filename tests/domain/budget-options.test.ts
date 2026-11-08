import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_OPTIONS_MINOR,
  MAX_BUDGET_MINOR,
  categoryMedianMinor,
  chooseBudgetOptions,
  fallbackLadder,
  validateBudgetOptions,
  type BudgetOptionsInput,
  type PricedOffering,
} from "@/lib/domain/budget-options";

const catalogue: PricedOffering[] = [
  { category: "karaoke", pricingModel: "FIXED_TOTAL", priceMinor: 10_000 },
  { category: "karaoke", pricingModel: "FIXED_TOTAL", priceMinor: 18_000 },
  { category: "wine-tasting", pricingModel: "FIXED_TOTAL", priceMinor: 24_000 },
  { category: "pottery", pricingModel: "PER_ATTENDEE", priceMinor: 2_500 },
];

const input = (over: Partial<BudgetOptionsInput> = {}): BudgetOptionsInput => ({
  suggestionMinor: null,
  stated: { amountMinor: null, unit: "UNKNOWN" },
  groupSize: null,
  categories: [],
  catalogue,
  ...over,
});

describe("validateBudgetOptions", () => {
  it("accepts five whole-$5, strictly increasing amounts within the spread", () => {
    expect(validateBudgetOptions([5000, 7500, 10_000, 15_000, 20_000])).toEqual({ ok: true, optionsMinor: [5000, 7500, 10_000, 15_000, 20_000] });
    expect(validateBudgetOptions([500, 1000, 2000, 3000, 5000]).ok).toBe(true);
  });

  it.each([
    ["four amounts", [5000, 7500, 10_000, 15_000]],
    ["six amounts", [5000, 7500, 10_000, 15_000, 20_000, 25_000]],
    ["not an array", "5000,7500"],
    ["a float", [5000, 7500, 10_000.5, 15_000, 20_000]],
    ["not a multiple of $5", [5000, 7600, 10_000, 15_000, 20_000]],
    ["not increasing", [5000, 7500, 7500, 15_000, 20_000]],
    ["descending", [20_000, 15_000, 10_000, 7500, 5000]],
    ["below $5", [0, 500, 1000, 1500, 2000]],
    ["above the maximum", [MAX_BUDGET_MINOR - 2000, MAX_BUDGET_MINOR - 1500, MAX_BUDGET_MINOR - 1000, MAX_BUDGET_MINOR - 500, MAX_BUDGET_MINOR + 500]],
    ["spread above 10x", [1000, 2000, 5000, 8000, 10_500]],
  ])("rejects %s", (_label, values) => {
    expect(validateBudgetOptions(values).ok).toBe(false);
  });
});

describe("fallbackLadder", () => {
  it("reproduces the historic list for the default $100 anchor", () => {
    expect(fallbackLadder(10_000)).toEqual([...DEFAULT_BUDGET_OPTIONS_MINOR]);
  });

  it("rounds each rung to the nearest $5 (half up) with integer maths", () => {
    // $90: 45, 67.50 -> 70, 90, 135, 180
    expect(fallbackLadder(9_000)).toEqual([4500, 7000, 9000, 13_500, 18_000]);
    // $123.45: 61.725 -> 60, 92.59 -> 95, 123.45 -> 125, 185.18 -> 185, 246.90 -> 245
    expect(fallbackLadder(12_345)).toEqual([6000, 9500, 12_500, 18_500, 24_500]);
  });

  it("stays strictly increasing and at least $5 for tiny anchors", () => {
    expect(fallbackLadder(0)).toEqual([500, 1000, 1500, 2000, 2500]);
    expect(fallbackLadder(700)).toEqual([500, 1000, 1500, 2000, 2500]);
  });

  it("caps huge anchors so the top rung stays within the maximum", () => {
    const ladder = fallbackLadder(MAX_BUDGET_MINOR);
    expect(ladder[4]).toBe(MAX_BUDGET_MINOR);
    expect(validateBudgetOptions(ladder).ok).toBe(true);
  });

  it("always produces a valid set", () => {
    for (let anchor = 0; anchor <= 400_000; anchor += 137) expect(validateBudgetOptions(fallbackLadder(anchor)).ok, `anchor ${anchor}`).toBe(true);
  });
});

describe("categoryMedianMinor", () => {
  it("uses the lower median of fixed totals in the brief's categories", () => {
    expect(categoryMedianMinor(catalogue, ["karaoke"], 6)).toBe(10_000);
    expect(categoryMedianMinor(catalogue, ["Wine-Tasting"], null)).toBe(24_000);
  });

  it("prices per-attendee offerings for the whole group, and skips them when the size is unknown", () => {
    expect(categoryMedianMinor(catalogue, ["pottery"], 8)).toBe(20_000);
    expect(categoryMedianMinor(catalogue, ["pottery"], null)).toBeNull();
    expect(categoryMedianMinor(catalogue, ["padel"], 4)).toBeNull();
  });
});

describe("chooseBudgetOptions", () => {
  it("uses a valid AI suggestion that includes the stated total", () => {
    const d = chooseBudgetOptions(input({ suggestionMinor: [15_000, 20_000, 30_000, 40_000, 50_000], stated: { amountMinor: 30_000, unit: "TOTAL" } }));
    expect(d).toMatchObject({ basis: "AI_SUGGESTION", optionsMinor: [15_000, 20_000, 30_000, 40_000, 50_000], anchorMinor: null, notes: [] });
  });

  it("drops an invalid AI suggestion with a note and falls back to the ladder", () => {
    const d = chooseBudgetOptions(input({ suggestionMinor: [1, 2, 3, 4, 5], stated: { amountMinor: 9000, unit: "TOTAL" } }));
    expect(d.basis).toBe("BRIEF_TOTAL");
    expect(d.optionsMinor).toEqual([4500, 7000, 9000, 13_500, 18_000]);
    expect(d.notes[0]).toMatch(/not used: every amount must be a multiple of \$5/);
  });

  it("drops an AI suggestion that moves the vote away from the budget the brief states", () => {
    const d = chooseBudgetOptions(input({ suggestionMinor: [50_000, 60_000, 70_000, 80_000, 90_000], stated: { amountMinor: 6000, unit: "TOTAL" } }));
    expect(d.basis).toBe("BRIEF_TOTAL");
    expect(d.optionsMinor).toEqual([3000, 4500, 6000, 9000, 12_000]);
    expect(d.notes[0]).toMatch(/do not include the budget stated/);
  });

  it("anchors on PER_PERSON x group size when both are known", () => {
    const d = chooseBudgetOptions(input({ stated: { amountMinor: 5000, unit: "PER_PERSON" }, groupSize: 6 }));
    expect(d).toMatchObject({ basis: "BRIEF_PER_PERSON", anchorMinor: 30_000, statedTotalMinor: 30_000, optionsMinor: [15_000, 22_500, 30_000, 45_000, 60_000] });
  });

  it("falls back to the category median, then to the $100 default", () => {
    expect(chooseBudgetOptions(input({ stated: { amountMinor: 5000, unit: "PER_PERSON" }, categories: ["wine-tasting"] }))).toMatchObject({
      basis: "CATEGORY_MEDIAN",
      anchorMinor: 24_000,
      optionsMinor: [12_000, 18_000, 24_000, 36_000, 48_000],
    });
    expect(chooseBudgetOptions(input({ stated: { amountMinor: 9000, unit: "UNKNOWN" } }))).toMatchObject({
      basis: "DEFAULT",
      optionsMinor: [...DEFAULT_BUDGET_OPTIONS_MINOR],
    });
  });
});
